/**
 * Centralized state store for the Quest harness.
 *
 * Prevents state desync between the main repo and git worktrees by storing
 * all shared mutable state in a single directory (.quest/store/) that workers
 * access via absolute path rather than worktree-local copies.
 *
 * Shared state (lives in store):
 *   - features.json — feature definitions and pass/fail status
 *   - claude-progress.txt — orchestrator progress tracking
 *   - quest-events.jsonl — structured event log
 *
 * Per-worker state (lives in worktree):
 *   - sprint-contract.json, current-feature.json, sprint-completion.json,
 *     eval-report.json, sprint-context-handoff.json
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  copyFileSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
  constants,
} from 'node:fs'
import { join } from 'node:path'
import type { Feature, FeaturesFile, ProgressState } from './agents/types.js'

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class QuestStore {
  readonly storeDir: string
  readonly mainDir: string

  constructor(mainDir: string) {
    this.mainDir = mainDir
    this.storeDir = join(mainDir, '.quest', 'store')
  }

  // ── Initialization & Migration ──────────────────────────────────────────

  /**
   * Initialize the store directory. If shared state files exist at the repo
   * root but not in the store, copy them in (migration).
   */
  init(): void {
    mkdirSync(this.storeDir, { recursive: true })

    // Migrate existing root-level files into the store
    const migrations: Array<{ filename: string; rootPath: string; storePath: string }> = [
      { filename: 'features.json', rootPath: this.rootFeaturesPath, storePath: this.featuresPath },
      { filename: 'claude-progress.txt', rootPath: this.rootProgressPath, storePath: this.progressPath },
      { filename: 'quest-events.jsonl', rootPath: this.rootEventsPath, storePath: this.eventsPath },
    ]

    for (const { filename, rootPath, storePath } of migrations) {
      if (existsSync(rootPath) && !existsSync(storePath)) {
        copyFileSync(rootPath, storePath)
      }
    }
  }

  /** Check if the store has been initialized */
  get initialized(): boolean {
    return existsSync(this.storeDir)
  }

  // ── Path Getters ────────────────────────────────────────────────────────

  get featuresPath(): string {
    return join(this.storeDir, 'features.json')
  }

  get progressPath(): string {
    return join(this.storeDir, 'claude-progress.txt')
  }

  get eventsPath(): string {
    return join(this.storeDir, 'quest-events.jsonl')
  }

  /** Root-level paths (for migration detection) */
  private get rootFeaturesPath(): string {
    return join(this.mainDir, 'features.json')
  }

  private get rootProgressPath(): string {
    return join(this.mainDir, 'claude-progress.txt')
  }

  private get rootEventsPath(): string {
    return join(this.mainDir, 'quest-events.jsonl')
  }

  // ── Features ────────────────────────────────────────────────────────────

  readFeatures(): FeaturesFile {
    const path = this.resolveFeaturesPath()
    const content = readFileSync(path, 'utf-8')
    return JSON.parse(content) as FeaturesFile
  }

  writeFeatures(data: FeaturesFile): void {
    this.ensureInit()
    writeFileSync(this.featuresPath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  }

  /**
   * Atomically mark a feature as passing with file-based locking.
   * Safe for concurrent evaluators in parallel mode.
   */
  markFeaturePassing(featureId: string, sessionId: string): void {
    this.withLock(() => {
      const data = this.readFeatures()
      const feature = data.features.find(f => f.id === featureId)
      if (!feature) throw new Error(`Feature not found: ${featureId}`)

      const updated: Feature = {
        ...feature,
        passes: true,
        implementedAt: new Date().toISOString(),
        sessionId,
      }

      const updatedData: FeaturesFile = {
        ...data,
        features: data.features.map(f => f.id === featureId ? updated : f),
      }

      writeFileSync(this.featuresPath, JSON.stringify(updatedData, null, 2) + '\n', 'utf-8')
    })
  }

  getNextFeature(): Feature | null {
    const data = this.readFeatures()
    const pending = data.features.filter(f => !f.passes)
    if (pending.length === 0) return null

    const byPriority: Record<string, number> = { high: 0, medium: 1, low: 2 }
    return [...pending].sort((a, b) => (byPriority[a.priority] ?? 2) - (byPriority[b.priority] ?? 2))[0]!
  }

  countPassing(): number {
    const data = this.readFeatures()
    return data.features.filter(f => f.passes).length
  }

  // ── Progress ────────────────────────────────────────────────────────────

  readProgress(): ProgressState {
    const path = this.resolveProgressPath()
    const content = readFileSync(path, 'utf-8')
    return JSON.parse(content) as ProgressState
  }

  writeProgress(state: ProgressState): void {
    this.ensureInit()
    const updated: ProgressState = { ...state, lastUpdated: new Date().toISOString() }
    writeFileSync(this.progressPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8')
  }

  // ── Events ──────────────────────────────────────────────────────────────

  /** Initialize a fresh event log for this run. */
  initEventLog(): void {
    this.ensureInit()
    writeFileSync(this.eventsPath, '', 'utf-8')
  }

  /** Append a structured event to the JSONL log. */
  emitEvent(event: Record<string, unknown>): void {
    const line = JSON.stringify({ ...event, ts: new Date().toISOString() }) + '\n'
    try {
      appendFileSync(this.eventsPath, line, 'utf-8')
    } catch {
      // Non-fatal
    }
  }

  /** Read all events from the log. */
  readEvents(): Array<Record<string, unknown>> {
    const path = this.resolveEventsPath()
    if (!existsSync(path)) return []
    try {
      return readFileSync(path, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as Record<string, unknown>)
    } catch {
      return []
    }
  }

  /** Read new events starting at a byte offset. */
  readNewEvents(fromOffset: number): { events: Array<Record<string, unknown>>; newOffset: number } {
    const path = this.resolveEventsPath()
    if (!existsSync(path)) return { events: [], newOffset: fromOffset }
    try {
      const content = readFileSync(path, 'utf-8')
      if (content.length <= fromOffset) return { events: [], newOffset: fromOffset }
      const newContent = content.slice(fromOffset)
      const events = newContent
        .split('\n')
        .filter(Boolean)
        .map(line => {
          try { return JSON.parse(line) as Record<string, unknown> }
          catch { return null }
        })
        .filter((e): e is Record<string, unknown> => e !== null)
      return { events, newOffset: content.length }
    } catch {
      return { events: [], newOffset: fromOffset }
    }
  }

  // ── File Resolution (store path with root fallback) ─────────────────────

  /**
   * Resolve features path: prefer store, fall back to repo root.
   * This enables backward compatibility with projects that haven't migrated.
   */
  private resolveFeaturesPath(): string {
    if (existsSync(this.featuresPath)) return this.featuresPath
    if (existsSync(this.rootFeaturesPath)) return this.rootFeaturesPath
    throw new Error(`features.json not found in store or project root: ${this.mainDir}`)
  }

  private resolveProgressPath(): string {
    if (existsSync(this.progressPath)) return this.progressPath
    if (existsSync(this.rootProgressPath)) return this.rootProgressPath
    throw new Error(`claude-progress.txt not found in store or project root: ${this.mainDir}`)
  }

  private resolveEventsPath(): string {
    if (existsSync(this.eventsPath)) return this.eventsPath
    if (existsSync(this.rootEventsPath)) return this.rootEventsPath
    return this.eventsPath // default to store path even if it doesn't exist yet
  }

  // ── Internal Helpers ────────────────────────────────────────────────────

  private ensureInit(): void {
    if (!this.initialized) {
      this.init()
    }
  }

  /**
   * Simple file-based locking using O_CREAT | O_EXCL.
   * Atomic on macOS (APFS/HFS+) and Linux (ext4/btrfs).
   */
  private withLock(fn: () => void): void {
    const lockPath = join(this.storeDir, '.features.lock')
    const maxWaitMs = 10_000
    const retryIntervalMs = 50
    const staleThresholdMs = 60_000
    let acquired = false
    const deadline = Date.now() + maxWaitMs

    while (!acquired && Date.now() < deadline) {
      try {
        const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY)
        closeSync(fd)
        acquired = true
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          // Check for stale lock
          try {
            const { mtimeMs } = statSync(lockPath)
            if (Date.now() - mtimeMs > staleThresholdMs) {
              unlinkSync(lockPath)
              continue
            }
          } catch {
            // Can't check staleness, just wait
          }

          // Wait and retry
          const waitTime = Math.min(retryIntervalMs, deadline - Date.now())
          if (waitTime > 0) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitTime)
          }
        } else {
          throw err
        }
      }
    }

    if (!acquired) {
      throw new Error(`Failed to acquire lock on ${lockPath} after ${maxWaitMs}ms`)
    }

    try {
      fn()
    } finally {
      try {
        unlinkSync(lockPath)
      } catch {
        // Best-effort unlock
      }
    }
  }
}
