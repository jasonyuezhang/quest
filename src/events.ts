/**
 * Structured event log for the Quest harness.
 *
 * Events are appended as JSONL to quest-events.jsonl in the project directory.
 * The `quest monitor` command tails this file and renders a live TUI.
 *
 * Using appendFileSync so events from the orchestrator and logger are written
 * atomically in order without async race conditions.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentLabel } from './logger.js'

export type QuestEvent =
  | { ts: string; type: 'run_start'; projectName: string; total: number }
  | { ts: string; type: 'feature_start'; featureId: string; featureName: string; priority: string; index: number; total: number }
  | { ts: string; type: 'agent_start'; agent: AgentLabel; featureId?: string; resetCount?: number }
  | { ts: string; type: 'tool_use'; agent: AgentLabel; tool: string; summary: string; turn: number }
  | { ts: string; type: 'tool_progress'; agent: AgentLabel; tool: string; elapsedSeconds: number }
  | { ts: string; type: 'agent_done'; agent: AgentLabel; featureId?: string; turns: number; durationMs: number; success: boolean; inputTokens?: number; outputTokens?: number }
  | { ts: string; type: 'context_reset'; featureId: string; resetCount: number }
  | { ts: string; type: 'eval_verdict'; featureId: string; verdict: 'pass' | 'fail'; criteriaResults: Array<{ criterion: string; result: 'pass' | 'fail'; evidence: string }> }
  | { ts: string; type: 'feature_done'; featureId: string; verdict: 'pass' | 'fail'; attempt: number; durationMs: number }
  | { ts: string; type: 'run_complete'; passing: number; total: number; durationMs: number }

const EVENT_LOG_FILE = 'quest-events.jsonl'

let logFilePath: string | undefined
let currentAgent: AgentLabel | undefined

/**
 * Initialize the event log for a project.
 * Call this once at the start of `quest run` / `quest init`.
 * Creates a new log file (overwrites previous run).
 */
export function initEventLog(projectDir: string): void {
  logFilePath = join(projectDir, EVENT_LOG_FILE)
  // Start fresh for each run
  writeFileSync(logFilePath, '', 'utf-8')
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

/** Append a structured event to the JSONL log */
export function emit(event: DistributiveOmit<QuestEvent, 'ts'>): void {
  if (!logFilePath) return
  const line = JSON.stringify({ ...event, ts: new Date().toISOString() }) + '\n'
  try {
    appendFileSync(logFilePath, line, 'utf-8')
  } catch {
    // Non-fatal — monitor just won't see this event
  }
}

/** Read all events from the log file */
export function readEvents(projectDir: string): QuestEvent[] {
  const path = join(projectDir, EVENT_LOG_FILE)
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as QuestEvent)
  } catch {
    return []
  }
}

/** Read new events starting at a byte offset. Returns new events and new offset. */
export function readNewEvents(projectDir: string, fromOffset: number): { events: QuestEvent[]; newOffset: number } {
  const path = join(projectDir, EVENT_LOG_FILE)
  if (!existsSync(path)) return { events: [], newOffset: fromOffset }
  try {
    const content = readFileSync(path, 'utf-8')
    if (content.length <= fromOffset) return { events: [], newOffset: fromOffset }
    const newContent = content.slice(fromOffset)
    const events = newContent
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line) as QuestEvent }
        catch { return null }
      })
      .filter((e): e is QuestEvent => e !== null)
    return { events, newOffset: content.length }
  } catch {
    return { events: [], newOffset: fromOffset }
  }
}
