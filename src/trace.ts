/**
 * LLM Observability — captures all API call inputs/outputs grouped into sessions.
 *
 * Each agent invocation (coder, evaluator, initializer, planner) gets its own
 * session with a descriptive topic. Every LLM turn is recorded with:
 *   - System prompt (first turn only)
 *   - User prompt
 *   - Assistant response (text + tool calls)
 *   - Tool results
 *   - Token usage
 *
 * Sessions are written as JSONL to .quest/traces/<session-id>.jsonl for audit.
 * A session index at .quest/traces/index.jsonl maps session IDs to topics/metadata.
 *
 * Usage:
 *   const session = tracer.startSession('coder', 'Implement user-auth-login')
 *   // ... in the for-await loop:
 *   session.recordMessage(sdkMessage)
 *   // ... when done:
 *   session.end()
 */

import { mkdirSync, appendFileSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentLabel } from './logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TraceEntry {
  /** Monotonic sequence within the session */
  seq: number
  ts: string
  /** SDK message type: system, assistant, tool_progress, result */
  type: string
  /** For assistant messages: the full content blocks */
  content?: ContentBlock[]
  /** For result messages: session-level token usage */
  usage?: TraceUsage
  /** For result messages: whether the session errored */
  isError?: boolean
  /** For system/init messages: the session ID from the SDK */
  sessionId?: string
  /** For tool_progress messages */
  toolName?: string
  elapsedSeconds?: number
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result'
  /** Text content (for type=text) */
  text?: string
  /** Tool name (for type=tool_use) */
  name?: string
  /** Tool input, truncated to maxInputLength (for type=tool_use) */
  input?: unknown
  /** Tool result content, truncated (for type=tool_result) */
  resultContent?: string
}

export interface TraceUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  contextWindow?: number
}

export interface SessionMeta {
  sessionId: string
  agent: AgentLabel | 'planner'
  topic: string
  featureId?: string
  workerId?: number
  model: string
  startedAt: string
  endedAt?: string
  turns: number
  totalInputTokens: number
  totalOutputTokens: number
  systemPrompt?: string
  userPrompt?: string
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class TraceSession {
  readonly sessionId: string
  readonly meta: SessionMeta
  private seq = 0
  private filePath: string
  private ended = false

  constructor(
    private tracesDir: string,
    agent: AgentLabel | 'planner',
    topic: string,
    opts: {
      featureId?: string
      workerId?: number
      model?: string
      systemPrompt?: string
      userPrompt?: string
    } = {},
  ) {
    this.sessionId = `${agent}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.filePath = join(tracesDir, `${this.sessionId}.jsonl`)

    this.meta = {
      sessionId: this.sessionId,
      agent,
      topic,
      featureId: opts.featureId,
      workerId: opts.workerId,
      model: opts.model ?? 'unknown',
      startedAt: new Date().toISOString(),
      turns: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      systemPrompt: opts.systemPrompt,
      userPrompt: opts.userPrompt,
    }

    // Write the session header as first line
    this.appendEntry({
      seq: this.seq++,
      ts: this.meta.startedAt,
      type: 'session_start',
    })
  }

  /**
   * Record an SDK message from the query() async generator.
   * Extracts relevant content from each message type.
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

    if (message.type === 'system' && message.subtype === 'init') {
      this.appendEntry({
        seq: this.seq++,
        ts: new Date().toISOString(),
        type: 'system_init',
        sessionId: message.session_id,
      })
      return
    }

    if (message.type === 'assistant' && message.message) {
      this.meta.turns++
      const content: ContentBlock[] = message.message.content.map(block => {
        if (block.type === 'tool_use') {
          return {
            type: 'tool_use' as const,
            name: block.name,
            input: truncateValue(block.input, 2000),
          }
        }
        if (block.type === 'text') {
          return {
            type: 'text' as const,
            text: truncateString(block.text ?? '', 5000),
          }
        }
        return { type: block.type as 'text' }
      })

      this.appendEntry({
        seq: this.seq++,
        ts: new Date().toISOString(),
        type: 'assistant',
        content,
      })
      return
    }

    if (message.type === 'tool_progress') {
      this.appendEntry({
        seq: this.seq++,
        ts: new Date().toISOString(),
        type: 'tool_progress',
        toolName: message.tool_name,
        elapsedSeconds: message.elapsed_time_seconds,
      })
      return
    }

    if (message.type === 'result') {
      const modelKey = message.modelUsage ? Object.keys(message.modelUsage)[0] : undefined
      const usage = modelKey ? message.modelUsage![modelKey] : undefined

      if (usage) {
        this.meta.totalInputTokens += usage.inputTokens
        this.meta.totalOutputTokens += usage.outputTokens
      }

      this.appendEntry({
        seq: this.seq++,
        ts: new Date().toISOString(),
        type: 'result',
        isError: message.is_error,
        usage: usage ? {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          contextWindow: usage.contextWindow,
        } : undefined,
      })
      return
    }
  }

  /**
   * Record a direct API call (used by planner which doesn't use the agent SDK).
   */
  recordAPICall(
    role: 'user' | 'assistant',
    content: string,
    usage?: { inputTokens: number; outputTokens: number },
  ): void {
    if (this.ended) return

    if (role === 'assistant') this.meta.turns++
    if (usage) {
      this.meta.totalInputTokens += usage.inputTokens
      this.meta.totalOutputTokens += usage.outputTokens
    }

    this.appendEntry({
      seq: this.seq++,
      ts: new Date().toISOString(),
      type: role,
      content: [{ type: 'text', text: truncateString(content, 5000) }],
      usage: usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : undefined,
    })
  }

  /** Mark session as ended and write final metadata to the index. */
  end(): void {
    if (this.ended) return
    this.ended = true
    this.meta.endedAt = new Date().toISOString()

    this.appendEntry({
      seq: this.seq++,
      ts: this.meta.endedAt,
      type: 'session_end',
    })
  }

  private appendEntry(entry: TraceEntry): void {
    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8')
    } catch {
      // Non-fatal — tracing should never break the harness
    }
  }
}

// ---------------------------------------------------------------------------
// Tracer (singleton-ish, one per project)
// ---------------------------------------------------------------------------

export class Tracer {
  private tracesDir: string
  private indexPath: string
  private sessions: TraceSession[] = []
  private enabled: boolean

  constructor(projectDir: string, enabled = true) {
    this.tracesDir = join(projectDir, '.quest', 'traces')
    this.indexPath = join(this.tracesDir, 'index.jsonl')
    this.enabled = enabled

    if (enabled) {
      mkdirSync(this.tracesDir, { recursive: true })
    }
  }

  /** Start a new trace session for an agent invocation. */
  startSession(
    agent: AgentLabel | 'planner',
    topic: string,
    opts: {
      featureId?: string
      workerId?: number
      model?: string
      systemPrompt?: string
      userPrompt?: string
    } = {},
  ): TraceSession | null {
    if (!this.enabled) return null

    const session = new TraceSession(this.tracesDir, agent, topic, opts)
    this.sessions.push(session)
    return session
  }

  /** End a session and write its metadata to the index. */
  endSession(session: TraceSession | null): void {
    if (!session || !this.enabled) return
    session.end()
    this.writeToIndex(session.meta)
  }

  /** Read the session index for audit/inspection. */
  readIndex(): SessionMeta[] {
    if (!existsSync(this.indexPath)) return []
    try {
      return readFileSync(this.indexPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as SessionMeta)
    } catch {
      return []
    }
  }

  /** Read all trace entries for a specific session. */
  readSession(sessionId: string): TraceEntry[] {
    const filePath = join(this.tracesDir, `${sessionId}.jsonl`)
    if (!existsSync(filePath)) return []
    try {
      return readFileSync(filePath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as TraceEntry)
    } catch {
      return []
    }
  }

  private writeToIndex(meta: SessionMeta): void {
    try {
      // Write a compact version without system/user prompts (those are in the session file)
      const indexEntry: SessionMeta = {
        ...meta,
        systemPrompt: undefined,
        userPrompt: undefined,
      }
      appendFileSync(this.indexPath, JSON.stringify(indexEntry) + '\n', 'utf-8')
    } catch {
      // Non-fatal
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateString(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s
  return s.slice(0, maxLen) + `… [truncated, ${s.length} chars total]`
}

function truncateValue(v: unknown, maxLen: number): unknown {
  if (v === null || v === undefined) return v
  if (typeof v === 'string') return truncateString(v, maxLen)
  const s = JSON.stringify(v)
  if (s.length <= maxLen) return v
  return truncateString(s, maxLen)
}

// ---------------------------------------------------------------------------
// Formatting (for quest inspect)
// ---------------------------------------------------------------------------

/** Format a session's traces as a human-readable string. */
export function formatSessionTrace(meta: SessionMeta, entries: TraceEntry[]): string {
  const lines: string[] = []

  const duration = meta.endedAt
    ? `${((new Date(meta.endedAt).getTime() - new Date(meta.startedAt).getTime()) / 1000).toFixed(1)}s`
    : 'in-progress'

  lines.push(`Session: ${meta.sessionId}`)
  lines.push(`Agent: ${meta.agent} | Model: ${meta.model} | Duration: ${duration}`)
  lines.push(`Topic: ${meta.topic}`)
  if (meta.featureId) lines.push(`Feature: ${meta.featureId}`)
  lines.push(`Turns: ${meta.turns} | Tokens: ${meta.totalInputTokens}↑ ${meta.totalOutputTokens}↓`)
  lines.push('─'.repeat(60))

  for (const entry of entries) {
    if (entry.type === 'session_start' || entry.type === 'session_end') continue

    const ts = entry.ts.split('T')[1]?.split('.')[0] ?? entry.ts
    const prefix = `[${ts}]`

    if (entry.type === 'system_init') {
      lines.push(`${prefix} SESSION INIT (sdk session: ${entry.sessionId ?? 'unknown'})`)
    }

    if (entry.type === 'assistant' && entry.content) {
      for (const block of entry.content) {
        if (block.type === 'text' && block.text) {
          const preview = block.text.length > 200 ? block.text.slice(0, 200) + '…' : block.text
          lines.push(`${prefix} ASSISTANT: ${preview}`)
        }
        if (block.type === 'tool_use') {
          const inputPreview = typeof block.input === 'string'
            ? block.input.slice(0, 100)
            : JSON.stringify(block.input)?.slice(0, 100) ?? ''
          lines.push(`${prefix} TOOL_CALL: ${block.name}(${inputPreview})`)
        }
      }
    }

    if (entry.type === 'user' && entry.content) {
      const text = entry.content[0]?.text ?? ''
      const preview = text.length > 200 ? text.slice(0, 200) + '…' : text
      lines.push(`${prefix} USER: ${preview}`)
    }

    if (entry.type === 'tool_progress') {
      lines.push(`${prefix} TOOL_PROGRESS: ${entry.toolName} (${entry.elapsedSeconds?.toFixed(1)}s)`)
    }

    if (entry.type === 'result') {
      const status = entry.isError ? 'ERROR' : 'OK'
      const tokens = entry.usage ? ` | ${entry.usage.inputTokens}↑ ${entry.usage.outputTokens}↓` : ''
      lines.push(`${prefix} RESULT: ${status}${tokens}`)
    }
  }

  return lines.join('\n')
}
