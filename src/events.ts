/**
 * Structured event log for the Quest harness.
 *
 * Events are stored in SQLite (quest.db) for indexed queries and concurrent-safe writes.
 * Falls back to JSONL append if the database is not initialized (e.g., during early init).
 *
 * The `quest dashboard` Activity tab reads events from the database.
 */

import type { AgentLabel } from './logger.js'
import { EventDB } from './event-db.js'

export type QuestEvent =
  | { ts: string; type: 'run_start'; projectName: string; total: number; concurrency?: number; models?: Record<string, string> }
  | { ts: string; type: 'feature_start'; featureId: string; featureName: string; priority: string; index: number; total: number; workerId?: number }
  | { ts: string; type: 'agent_start'; agent: AgentLabel; featureId?: string; resetCount?: number; workerId?: number; model?: string }
  | { ts: string; type: 'tool_use'; agent: AgentLabel; tool: string; summary: string; turn: number; workerId?: number }
  | { ts: string; type: 'tool_progress'; agent: AgentLabel; tool: string; elapsedSeconds: number; workerId?: number }
  | { ts: string; type: 'agent_done'; agent: AgentLabel; featureId?: string; turns: number; durationMs: number; success: boolean; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; workerId?: number; model?: string }
  | { ts: string; type: 'context_reset'; featureId: string; resetCount: number; completedCount: number; remainingCount: number; workerId?: number }
  | { ts: string; type: 'context_warning'; featureId?: string; usagePct: number; contextTokens: number; workerId?: number }
  | { ts: string; type: 'session_token_usage'; featureId?: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; workerId?: number }
  | { ts: string; type: 'eval_verdict'; featureId: string; verdict: 'pass' | 'fail'; criteriaResults: Array<{ criterion: string; result: 'pass' | 'fail'; evidence: string }>; workerId?: number }
  | { ts: string; type: 'feature_done'; featureId: string; verdict: 'pass' | 'fail'; attempt: number; durationMs: number; failureCategory?: string; workerId?: number }
  | { ts: string; type: 'dag_built'; levels: number; criticalPath: string[]; maxParallelism: number; totalFeatures: number }
  | { ts: string; type: 'batch_plan'; ready: number; dispatching: number; inFlight: number; reason: string }
  | { ts: string; type: 'feature_unblocked'; featureId: string; unblockedBy: string }
  | { ts: string; type: 'conflict_detected'; sourceFeatureId: string; targetFeatureId: string; conflictingFiles?: string[] }
  | { ts: string; type: 'run_complete'; passing: number; total: number; durationMs: number; totalCostUsd?: number; costByAgent?: Array<{ agent: string; estimatedUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }> }
  | { ts: string; type: 'init_failed'; attempt: number; exitCode: number | null; stderr: string }
  | { ts: string; type: 'shutdown'; featureId: string; featureName: string; reason: string }

let eventDb: EventDB | undefined
let currentAgent: AgentLabel | undefined

/**
 * Initialize the event log for a project.
 * Call this once at the start of `quest run` / `quest init`.
 * Creates a new SQLite database (or clears existing events for a fresh run).
 */
export function initEventLog(projectDir: string): void {
  eventDb = new EventDB(projectDir)
  // Migrate any existing JSONL events on first use
  eventDb.migrateFromJsonl(projectDir)
  // Start fresh for each run
  eventDb.clearEvents()
}

/**
 * Get (or create) the EventDB for a project directory.
 * Used by read-only consumers (dashboard, CLI status, reports).
 */
export function getEventDb(projectDir: string): EventDB {
  if (!eventDb) {
    eventDb = new EventDB(projectDir)
  }
  return eventDb
}

/** Set the current agent so tool events are labeled correctly */
export function setCurrentAgent(agent: AgentLabel | undefined): void {
  currentAgent = agent
}

export function getCurrentAgent(): AgentLabel | undefined {
  return currentAgent
}

/** Distributive Omit — works correctly on discriminated unions */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Append a structured event to the SQLite event log */
export function emit(event: DistributiveOmit<QuestEvent, 'ts'>): void {
  if (!eventDb) return
  const fullEvent = { ...event, ts: new Date().toISOString() }
  try {
    eventDb.emit(fullEvent as Record<string, unknown>)
  } catch {
    // Non-fatal — dashboard just won't see this event
  }
}

/** Read all events from the event log */
export function readEvents(projectDir: string): QuestEvent[] {
  const db = getEventDb(projectDir)
  return db.readAll()
}

/** Read new events after a cursor position. Returns new events and new cursor. */
export function readNewEvents(projectDir: string, fromCursor: number): { events: QuestEvent[]; newOffset: number } {
  const db = getEventDb(projectDir)
  const { events, lastId } = db.readAfter(fromCursor)
  return { events, newOffset: lastId }
}
