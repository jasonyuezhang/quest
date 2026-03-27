/**
 * SQLite-backed trace storage for LLM observability.
 *
 * Replaces JSONL trace files with a single .quest/traces.db that supports:
 *   - Concurrent writes from parallel workers (WAL mode + busy timeout)
 *   - SQL queries across sessions ("all tool calls touching file X")
 *   - Token/cost aggregation by agent, model, feature
 *   - Batch inserts via prepared statements for minimal lock contention
 *
 * Schema:
 *   sessions — one row per agent invocation (coder, eval, init, planner)
 *   events   — every turn/tool call/result within a session
 */

import Database from 'better-sqlite3'
import { mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { AgentLabel } from './logger.js'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    session_id    TEXT PRIMARY KEY,
    agent         TEXT NOT NULL,
    topic         TEXT NOT NULL,
    feature_id    TEXT,
    worker_id     INTEGER,
    model         TEXT NOT NULL,
    system_prompt TEXT,
    user_prompt   TEXT,
    started_at    INTEGER NOT NULL,
    ended_at      INTEGER,
    turns         INTEGER DEFAULT 0,
    input_tokens  INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    status        TEXT DEFAULT 'running'
  );

  CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    ts            INTEGER NOT NULL,
    type          TEXT NOT NULL,
    tool_name     TEXT,
    file_path     TEXT,
    content_text  TEXT,
    input_json    TEXT,
    input_tokens  INTEGER,
    output_tokens INTEGER,
    context_window INTEGER,
    duration_ms   INTEGER,
    is_error      INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
  );

  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, ts);
  CREATE INDEX IF NOT EXISTS idx_events_tool ON events(tool_name) WHERE tool_name IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_events_file ON events(file_path) WHERE file_path IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent);
  CREATE INDEX IF NOT EXISTS idx_sessions_feature ON sessions(feature_id) WHERE feature_id IS NOT NULL;
`

// ---------------------------------------------------------------------------
// TraceDB
// ---------------------------------------------------------------------------

export class TraceDB {
  private db: Database.Database
  private insertEventStmt: Database.Statement
  private insertSessionStmt: Database.Statement
  private updateSessionStmt: Database.Statement
  private batchInsertEvents: Database.Transaction<(events: EventRow[]) => void>

  constructor(projectDir: string) {
    const dbPath = join(projectDir, '.quest', 'traces.db')
    mkdirSync(dirname(dbPath), { recursive: true })

    this.db = new Database(dbPath)

    // WAL mode: concurrent readers + serialized writers with automatic retry
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('wal_autocheckpoint = 1000')

    this.db.exec(SCHEMA)

    // Prepared statements
    this.insertSessionStmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions
        (session_id, agent, topic, feature_id, worker_id, model, system_prompt, user_prompt, started_at, turns, input_tokens, output_tokens, status)
      VALUES
        (@session_id, @agent, @topic, @feature_id, @worker_id, @model, @system_prompt, @user_prompt, @started_at, 0, 0, 0, 'running')
    `)

    this.updateSessionStmt = this.db.prepare(`
      UPDATE sessions SET
        ended_at = @ended_at,
        turns = @turns,
        input_tokens = @input_tokens,
        output_tokens = @output_tokens,
        status = @status
      WHERE session_id = @session_id
    `)

    this.insertEventStmt = this.db.prepare(`
      INSERT INTO events
        (session_id, seq, ts, type, tool_name, file_path, content_text, input_json, input_tokens, output_tokens, context_window, duration_ms, is_error)
      VALUES
        (@session_id, @seq, @ts, @type, @tool_name, @file_path, @content_text, @input_json, @input_tokens, @output_tokens, @context_window, @duration_ms, @is_error)
    `)

    // Batch insert wraps multiple inserts in a single transaction (one lock acquisition)
    this.batchInsertEvents = this.db.transaction((events: EventRow[]) => {
      for (const event of events) {
        this.insertEventStmt.run(event)
      }
    })
  }

  // ── Session lifecycle (low-level DB ops, called by TraceSQLSession) ─────

  insertSession(opts: {
    sessionId: string
    agent: AgentLabel | 'planner'
    topic: string
    featureId?: string
    workerId?: number
    model: string
    systemPrompt?: string
    userPrompt?: string
  }): void {
    this.insertSessionStmt.run({
      session_id: opts.sessionId,
      agent: opts.agent,
      topic: opts.topic,
      feature_id: opts.featureId ?? null,
      worker_id: opts.workerId ?? null,
      model: opts.model,
      system_prompt: opts.systemPrompt ? truncate(opts.systemPrompt, 10000) : null,
      user_prompt: opts.userPrompt ? truncate(opts.userPrompt, 5000) : null,
      started_at: Date.now(),
    })
  }

  updateSession(sessionId: string, stats: {
    turns: number
    inputTokens: number
    outputTokens: number
    status: 'completed' | 'failed' | 'interrupted'
  }): void {
    this.updateSessionStmt.run({
      session_id: sessionId,
      ended_at: Date.now(),
      turns: stats.turns,
      input_tokens: stats.inputTokens,
      output_tokens: stats.outputTokens,
      status: stats.status,
    })
  }

  // ── Convenience API (used by orchestrator) ────────────────────────────

  /** Create a TraceSQLSession that auto-records to this database */
  startSession(
    agent: AgentLabel | 'planner',
    topic: string,
    opts?: { featureId?: string; workerId?: number; model?: string; systemPrompt?: string; userPrompt?: string },
  ): TraceSQLSession {
    return new TraceSQLSession(this, {
      agent,
      topic,
      ...opts,
      model: opts?.model ?? 'claude-sonnet-4-6',
    })
  }

  /** End a TraceSQLSession */
  endSession(session: TraceSQLSession | null | undefined): void {
    session?.end()
  }

  // ── Event recording ─────────────────────────────────────────────────────

  insertEvent(event: EventRow): void {
    this.insertEventStmt.run(event)
  }

  insertEvents(events: EventRow[]): void {
    if (events.length === 0) return
    this.batchInsertEvents(events)
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  listSessions(filters?: {
    agent?: string
    featureId?: string
    limit?: number
  }): SessionRow[] {
    let sql = 'SELECT * FROM sessions WHERE 1=1'
    const params: Record<string, unknown> = {}

    if (filters?.agent) {
      sql += ' AND agent = @agent'
      params.agent = filters.agent
    }
    if (filters?.featureId) {
      sql += ' AND feature_id = @feature_id'
      params.feature_id = filters.featureId
    }

    sql += ' ORDER BY started_at DESC'

    if (filters?.limit) {
      sql += ' LIMIT @limit'
      params.limit = filters.limit
    }

    return this.db.prepare(sql).all(params) as SessionRow[]
  }

  getSession(sessionId: string): SessionRow | undefined {
    // Support partial session ID match
    const exact = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as SessionRow | undefined
    if (exact) return exact

    return this.db.prepare('SELECT * FROM sessions WHERE session_id LIKE ? LIMIT 1').get(`${sessionId}%`) as SessionRow | undefined
  }

  getSessionEvents(sessionId: string): EventRow[] {
    // Support partial match
    const session = this.getSession(sessionId)
    if (!session) return []

    return this.db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY seq').all(session.session_id) as EventRow[]
  }

  /** Find all events that touched a specific file path */
  queryByFile(filePath: string): Array<EventRow & { agent: string; topic: string }> {
    return this.db.prepare(`
      SELECT e.*, s.agent, s.topic
      FROM events e JOIN sessions s ON e.session_id = s.session_id
      WHERE e.file_path LIKE @pattern
      ORDER BY e.ts DESC
      LIMIT 100
    `).all({ pattern: `%${filePath}%` }) as Array<EventRow & { agent: string; topic: string }>
  }

  /** Token usage aggregated by agent type */
  costByAgent(): Array<{ agent: string; model: string; sessions: number; total_input: number; total_output: number; total_turns: number }> {
    return this.db.prepare(`
      SELECT agent, model,
        COUNT(*) as sessions,
        SUM(input_tokens) as total_input,
        SUM(output_tokens) as total_output,
        SUM(turns) as total_turns
      FROM sessions
      WHERE status != 'running'
      GROUP BY agent, model
      ORDER BY total_input + total_output DESC
    `).all() as Array<{ agent: string; model: string; sessions: number; total_input: number; total_output: number; total_turns: number }>
  }

  /** Token usage aggregated by feature */
  costByFeature(): Array<{ feature_id: string; sessions: number; total_input: number; total_output: number }> {
    return this.db.prepare(`
      SELECT feature_id,
        COUNT(*) as sessions,
        SUM(input_tokens) as total_input,
        SUM(output_tokens) as total_output
      FROM sessions
      WHERE feature_id IS NOT NULL AND status != 'running'
      GROUP BY feature_id
      ORDER BY total_input + total_output DESC
    `).all() as Array<{ feature_id: string; sessions: number; total_input: number; total_output: number }>
  }

  /** Most frequently used tools */
  topTools(limit = 20): Array<{ tool_name: string; count: number; sessions: number }> {
    return this.db.prepare(`
      SELECT tool_name,
        COUNT(*) as count,
        COUNT(DISTINCT session_id) as sessions
      FROM events
      WHERE tool_name IS NOT NULL
      GROUP BY tool_name
      ORDER BY count DESC
      LIMIT ?
    `).all(limit) as Array<{ tool_name: string; count: number; sessions: number }>
  }

  /** Database stats */
  stats(): { sessions: number; events: number; dbSizeBytes: number } {
    const sessions = (this.db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }).c
    const events = (this.db.prepare('SELECT COUNT(*) as c FROM events').get() as { c: number }).c
    const pageCount = (this.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count
    const pageSize = (this.db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size
    return { sessions, events, dbSizeBytes: pageCount * pageSize }
  }

  close(): void {
    this.db.close()
  }
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface SessionRow {
  session_id: string
  agent: string
  topic: string
  feature_id: string | null
  worker_id: number | null
  model: string
  system_prompt: string | null
  user_prompt: string | null
  started_at: number
  ended_at: number | null
  turns: number
  input_tokens: number
  output_tokens: number
  status: string
}

export interface EventRow {
  id?: number
  session_id: string
  seq: number
  ts: number
  type: string
  tool_name: string | null
  file_path: string | null
  content_text: string | null
  input_json: string | null
  input_tokens: number | null
  output_tokens: number | null
  context_window: number | null
  duration_ms: number | null
  is_error: number | null
}

// ---------------------------------------------------------------------------
// TraceSQLSession — per-agent session that buffers and flushes to DB
// ---------------------------------------------------------------------------

export class TraceSQLSession {
  readonly sessionId: string
  private db: TraceDB
  private seq = 0
  private buffer: EventRow[] = []
  private turns = 0
  private totalInput = 0
  private totalOutput = 0
  private ended = false
  private flushInterval: ReturnType<typeof setInterval>

  constructor(db: TraceDB, opts: {
    agent: AgentLabel | 'planner'
    topic: string
    featureId?: string
    workerId?: number
    model: string
    systemPrompt?: string
    userPrompt?: string
  }) {
    this.sessionId = `${opts.agent}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.db = db

    db.insertSession({
      sessionId: this.sessionId,
      ...opts,
    })

    // Auto-flush every 2 seconds
    this.flushInterval = setInterval(() => this.flush(), 2000)
  }

  /**
   * Record an SDK message from the query() async generator.
   */
  recordSDKMessage(message: {
    type: string
    subtype?: string
    session_id?: string
    message?: { content: Array<{ type: string; name?: string; input?: unknown; text?: string }> }
    tool_name?: string
    elapsed_time_seconds?: number
    is_error?: boolean
    modelUsage?: Record<string, { inputTokens: number; outputTokens: number; contextWindow?: number }>
  }): void {
    if (this.ended) return
    const now = Date.now()

    if (message.type === 'system' && message.subtype === 'init') {
      this.buffer.push({
        session_id: this.sessionId,
        seq: this.seq++,
        ts: now,
        type: 'system_init',
        tool_name: null,
        file_path: null,
        content_text: message.session_id ?? null,
        input_json: null,
        input_tokens: null,
        output_tokens: null,
        context_window: null,
        duration_ms: null,
        is_error: null,
      })
      return
    }

    if (message.type === 'assistant' && message.message) {
      this.turns++
      for (const block of message.message.content) {
        if (block.type === 'tool_use') {
          const filePath = extractFilePath(block.input)
          this.buffer.push({
            session_id: this.sessionId,
            seq: this.seq++,
            ts: now,
            type: 'tool_call',
            tool_name: block.name ?? null,
            file_path: filePath,
            content_text: null,
            input_json: truncate(JSON.stringify(block.input), 2000),
            input_tokens: null,
            output_tokens: null,
            context_window: null,
            duration_ms: null,
            is_error: null,
          })
        }
        if (block.type === 'text' && block.text) {
          this.buffer.push({
            session_id: this.sessionId,
            seq: this.seq++,
            ts: now,
            type: 'assistant_text',
            tool_name: null,
            file_path: null,
            content_text: truncate(block.text, 5000),
            input_json: null,
            input_tokens: null,
            output_tokens: null,
            context_window: null,
            duration_ms: null,
            is_error: null,
          })
        }
      }
      return
    }

    if (message.type === 'result') {
      const modelKey = message.modelUsage ? Object.keys(message.modelUsage)[0] : undefined
      const usage = modelKey ? message.modelUsage![modelKey] : undefined

      if (usage) {
        this.totalInput += usage.inputTokens
        this.totalOutput += usage.outputTokens
      }

      this.buffer.push({
        session_id: this.sessionId,
        seq: this.seq++,
        ts: now,
        type: 'result',
        tool_name: null,
        file_path: null,
        content_text: null,
        input_json: null,
        input_tokens: usage?.inputTokens ?? null,
        output_tokens: usage?.outputTokens ?? null,
        context_window: usage?.contextWindow ?? null,
        duration_ms: null,
        is_error: message.is_error ? 1 : 0,
      })
      return
    }
  }

  /**
   * Record a direct API call (planner uses @anthropic-ai/sdk, not agent SDK).
   */
  recordAPICall(
    role: 'user' | 'assistant',
    content: string,
    usage?: { inputTokens: number; outputTokens: number },
  ): void {
    if (this.ended) return

    if (role === 'assistant') this.turns++
    if (usage) {
      this.totalInput += usage.inputTokens
      this.totalOutput += usage.outputTokens
    }

    this.buffer.push({
      session_id: this.sessionId,
      seq: this.seq++,
      ts: Date.now(),
      type: role,
      tool_name: null,
      file_path: null,
      content_text: truncate(content, 5000),
      input_json: null,
      input_tokens: usage?.inputTokens ?? null,
      output_tokens: usage?.outputTokens ?? null,
      context_window: null,
      duration_ms: null,
      is_error: null,
    })
  }

  /** Flush buffered events to the database. */
  flush(): void {
    if (this.buffer.length === 0) return
    try {
      this.db.insertEvents(this.buffer)
      this.buffer = []
    } catch {
      // Non-fatal — trace writes should never crash the harness
    }
  }

  /** End the session: flush remaining events and update session metadata. */
  end(status: 'completed' | 'failed' | 'interrupted' = 'completed'): void {
    if (this.ended) return
    this.ended = true
    clearInterval(this.flushInterval)
    this.flush()

    try {
      this.db.updateSession(this.sessionId, {
        turns: this.turns,
        inputTokens: this.totalInput,
        outputTokens: this.totalOutput,
        status,
      })
    } catch {
      // Non-fatal
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s
  return s.slice(0, maxLen) + `... [${s.length} chars]`
}

/** Extract file_path from tool input for indexing */
function extractFilePath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const inp = input as Record<string, unknown>
  const path = inp['file_path'] ?? inp['path'] ?? inp['pattern']
  return typeof path === 'string' ? path : null
}

// ---------------------------------------------------------------------------
// Formatting (for quest inspect)
// ---------------------------------------------------------------------------

export function formatSessionFromDB(session: SessionRow, events: EventRow[]): string {
  const lines: string[] = []

  const duration = session.ended_at
    ? `${((session.ended_at - session.started_at) / 1000).toFixed(1)}s`
    : 'in-progress'

  lines.push(`Session: ${session.session_id}`)
  lines.push(`Agent: ${session.agent} | Model: ${session.model} | Duration: ${duration} | Status: ${session.status}`)
  lines.push(`Topic: ${session.topic}`)
  if (session.feature_id) lines.push(`Feature: ${session.feature_id}`)
  if (session.worker_id) lines.push(`Worker: W${session.worker_id}`)
  lines.push(`Turns: ${session.turns} | Tokens: ${session.input_tokens}↑ ${session.output_tokens}↓`)
  lines.push('─'.repeat(60))

  for (const event of events) {
    const time = new Date(event.ts).toISOString().split('T')[1]?.split('.')[0] ?? ''
    const prefix = `[${time}]`

    switch (event.type) {
      case 'system_init':
        lines.push(`${prefix} SESSION INIT`)
        break

      case 'tool_call':
        if (event.tool_name) {
          const inputPreview = event.input_json ? event.input_json.slice(0, 120) : ''
          const fileNote = event.file_path ? ` -> ${event.file_path}` : ''
          lines.push(`${prefix} TOOL: ${event.tool_name}${fileNote}`)
          if (inputPreview && event.tool_name === 'Bash') {
            const cmd = tryParseJson(inputPreview, 'command')
            if (cmd) lines.push(`         $ ${cmd.slice(0, 100)}`)
          }
        }
        break

      case 'assistant_text':
        if (event.content_text) {
          const preview = event.content_text.length > 200 ? event.content_text.slice(0, 200) + '...' : event.content_text
          lines.push(`${prefix} TEXT: ${preview}`)
        }
        break

      case 'user':
        if (event.content_text) {
          const preview = event.content_text.length > 200 ? event.content_text.slice(0, 200) + '...' : event.content_text
          lines.push(`${prefix} USER: ${preview}`)
        }
        break

      case 'result': {
        const status = event.is_error ? 'ERROR' : 'OK'
        const tokens = event.input_tokens != null ? ` | ${event.input_tokens}↑ ${event.output_tokens}↓` : ''
        lines.push(`${prefix} RESULT: ${status}${tokens}`)
        break
      }
    }
  }

  return lines.join('\n')
}

function tryParseJson(json: string, key: string): string | null {
  try {
    const obj = JSON.parse(json)
    return typeof obj[key] === 'string' ? obj[key] : null
  } catch {
    return null
  }
}
