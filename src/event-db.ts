/**
 * SQLite-backed event storage.
 *
 * Replaces quest-events.jsonl as the source of truth for structured events.
 * Provides indexed queries by type, feature, worker, and time range.
 * Uses WAL mode for concurrent-safe writes from parallel workers.
 *
 * On first run, migrates existing quest-events.jsonl into the database.
 */

import { readFileSync } from 'node:fs'
import type { QuestEvent } from './events.js'
import { QuestDBBase, resolveStorePath } from './db-base.js'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL,
    type        TEXT NOT NULL,
    feature_id  TEXT,
    worker_id   INTEGER,
    data        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
  CREATE INDEX IF NOT EXISTS idx_events_feature ON events(feature_id);
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
  CREATE INDEX IF NOT EXISTS idx_events_worker ON events(worker_id);

  CREATE TABLE IF NOT EXISTS progress (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`

export interface EventRow {
  id: number
  ts: string
  type: string
  feature_id: string | null
  worker_id: number | null
  data: string
  created_at: string
}

export class EventDB extends QuestDBBase {
  constructor(projectDir: string, db?: import('better-sqlite3').Database) {
    super(projectDir, db)
    this.db.exec(SCHEMA)
  }

  // ── Event Writes ─────────────────────────────────────────────────────

  /**
   * Insert a structured event. Extracts featureId and workerId from the
   * event payload for indexed lookups.
   */
  emit(event: Record<string, unknown>): void {
    const ts = (event.ts as string) || new Date().toISOString()
    const type = event.type as string
    const featureId = (event.featureId ?? event.feature_id ?? null) as string | null
    const workerId = (event.workerId ?? event.worker_id ?? null) as number | null

    this.db.prepare(`
      INSERT INTO events (ts, type, feature_id, worker_id, data)
      VALUES (@ts, @type, @feature_id, @worker_id, @data)
    `).run({
      ts,
      type,
      feature_id: featureId,
      worker_id: workerId,
      data: JSON.stringify(event),
    })
  }

  /**
   * Clear all events (used at the start of a new run).
   */
  clearEvents(): void {
    this.db.prepare('DELETE FROM events').run()
  }

  // ── Event Reads ──────────────────────────────────────────────────────

  /**
   * Read all events, ordered chronologically.
   */
  readAll(): QuestEvent[] {
    const rows = this.db.prepare('SELECT data FROM events ORDER BY id ASC').all() as Array<{ data: string }>
    return rows.map(r => JSON.parse(r.data) as QuestEvent)
  }

  /**
   * Read events after a given row ID (for incremental polling).
   * Returns new events and the new cursor position.
   */
  readAfter(afterId: number): { events: QuestEvent[]; lastId: number } {
    const rows = this.db.prepare(
      'SELECT id, data FROM events WHERE id > ? ORDER BY id ASC'
    ).all(afterId) as Array<{ id: number; data: string }>

    if (rows.length === 0) return { events: [], lastId: afterId }

    return {
      events: rows.map(r => JSON.parse(r.data) as QuestEvent),
      lastId: rows[rows.length - 1].id,
    }
  }

  /**
   * Read events filtered by type.
   */
  readByType(type: string): QuestEvent[] {
    const rows = this.db.prepare(
      'SELECT data FROM events WHERE type = ? ORDER BY id ASC'
    ).all(type) as Array<{ data: string }>
    return rows.map(r => JSON.parse(r.data) as QuestEvent)
  }

  /**
   * Read events for a specific feature.
   */
  readByFeature(featureId: string): QuestEvent[] {
    const rows = this.db.prepare(
      'SELECT data FROM events WHERE feature_id = ? ORDER BY id ASC'
    ).all(featureId) as Array<{ data: string }>
    return rows.map(r => JSON.parse(r.data) as QuestEvent)
  }

  /**
   * Count events by type (useful for stats).
   */
  countByType(): Array<{ type: string; count: number }> {
    return this.db.prepare(
      'SELECT type, COUNT(*) as count FROM events GROUP BY type ORDER BY count DESC'
    ).all() as Array<{ type: string; count: number }>
  }

  /**
   * Get the latest event ID (cursor for incremental reads).
   */
  lastEventId(): number {
    const row = this.db.prepare('SELECT MAX(id) as maxId FROM events').get() as { maxId: number | null }
    return row.maxId ?? 0
  }

  /**
   * Get total event count.
   */
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) as c FROM events').get() as { c: number }).c
  }

  // ── Progress (key-value) ─────────────────────────────────────────────

  /**
   * Read the full progress state from the progress table.
   */
  readProgress(): Record<string, unknown> | null {
    const rows = this.db.prepare('SELECT key, value FROM progress').all() as Array<{ key: string; value: string }>
    if (rows.length === 0) return null
    const result: Record<string, unknown> = {}
    for (const row of rows) {
      try { result[row.key] = JSON.parse(row.value) } catch { result[row.key] = row.value }
    }
    return result
  }

  /**
   * Write the full progress state to the progress table.
   * Each top-level key becomes a row for atomic field-level updates.
   */
  writeProgress(state: Record<string, unknown>): void {
    const upsert = this.db.prepare(
      'INSERT OR REPLACE INTO progress (key, value) VALUES (@key, @value)'
    )
    const writeAll = this.db.transaction((entries: Array<[string, unknown]>) => {
      for (const [key, value] of entries) {
        upsert.run({ key, value: JSON.stringify(value) })
      }
    })
    writeAll(Object.entries(state))
  }

  /**
   * Update a single progress field.
   */
  setProgressField(key: string, value: unknown): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO progress (key, value) VALUES (@key, @value)'
    ).run({ key, value: JSON.stringify(value) })
  }

  /**
   * Read a single progress field.
   */
  getProgressField(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM progress WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) return undefined
    try { return JSON.parse(row.value) } catch { return row.value }
  }

  // ── Migration ────────────────────────────────────────────────────────

  /**
   * Import events from a quest-events.jsonl file if the events table is empty.
   * Returns the number of events imported.
   */
  migrateFromJsonl(projectDir: string): number {
    const eventCount = this.count()
    if (eventCount > 0) return 0

    const jsonlPath = resolveStorePath(projectDir, 'quest-events.jsonl')

    if (!jsonlPath) return 0

    const content = readFileSync(jsonlPath, 'utf-8')
    const lines = content.split('\n').filter(Boolean)

    const insert = this.db.prepare(`
      INSERT INTO events (ts, type, feature_id, worker_id, data)
      VALUES (@ts, @type, @feature_id, @worker_id, @data)
    `)

    const insertAll = this.db.transaction((eventLines: string[]) => {
      for (const line of eventLines) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>
          const ts = (event.ts as string) || new Date().toISOString()
          const type = event.type as string
          const featureId = (event.featureId ?? event.feature_id ?? null) as string | null
          const workerId = (event.workerId ?? event.worker_id ?? null) as number | null
          insert.run({ ts, type, feature_id: featureId, worker_id: workerId, data: line })
        } catch {
          // Skip malformed lines
        }
      }
    })

    insertAll(lines)
    return lines.length
  }

  /**
   * Import progress from claude-progress.txt if the progress table is empty.
   */
  migrateProgressFromJson(projectDir: string): boolean {
    const existing = this.readProgress()
    if (existing && Object.keys(existing).length > 0) return false

    const jsonPath = resolveStorePath(projectDir, 'claude-progress.txt')

    if (!jsonPath) return false

    try {
      const content = readFileSync(jsonPath, 'utf-8')
      const state = JSON.parse(content) as Record<string, unknown>
      this.writeProgress(state)
      return true
    } catch {
      return false
    }
  }

}
