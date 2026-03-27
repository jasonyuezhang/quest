/**
 * Centralized state store for the Quest harness.
 *
 * Prevents state desync between the main repo and git worktrees by storing
 * all shared mutable state in a single directory (.quest/store/) that workers
 * access via absolute path rather than worktree-local copies.
 *
 * Shared state (lives in store, all SQLite):
 *   - features.db — feature definitions, status, and attempt tracking
 *   - events.db — structured event log + progress state
 *
 * Per-worker state (lives in worktree):
 *   - sprint-contract.json, current-feature.json, sprint-completion.json,
 *     eval-report.json, sprint-context-handoff.json
 */

import Database from 'better-sqlite3'
import {
  existsSync,
  mkdirSync,
  copyFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { Feature, FeaturesFile, ProgressState } from './agents/types.js'
import { FeatureDB, rowToFeature } from './feature-db.js'
import { EventDB } from './event-db.js'
import { createQuestDB } from './quest-db.js'

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class QuestStore {
  readonly storeDir: string
  readonly mainDir: string
  private _db: Database.Database | null = null
  private _featureDb: FeatureDB | null = null
  private _eventDb: EventDB | null = null

  constructor(mainDir: string) {
    this.mainDir = mainDir
    this.storeDir = join(mainDir, '.quest', 'store')
  }

  /** Shared SQLite connection (lazy-initialized) */
  get db(): Database.Database {
    if (!this._db) {
      this._db = createQuestDB(this.mainDir)
    }
    return this._db
  }

  /** Lazy-initialized feature database (SQLite) — shares the quest.db connection */
  get featureDb(): FeatureDB {
    if (!this._featureDb) {
      this._featureDb = new FeatureDB(this.mainDir, this.db)
    }
    return this._featureDb
  }

  /** Lazy-initialized event database (SQLite) — shares the quest.db connection */
  get eventDb(): EventDB {
    if (!this._eventDb) {
      this._eventDb = new EventDB(this.mainDir, this.db)
    }
    return this._eventDb
  }

  // ── Initialization & Migration ──────────────────────────────────────────

  /**
   * Initialize the store directory. If shared state files exist at the repo
   * root but not in the store, copy them in (migration).
   */
  init(): void {
    mkdirSync(this.storeDir, { recursive: true })

    // Migrate existing root-level features.json into the store (JSON copy for backward compat)
    if (existsSync(this.rootFeaturesPath) && !existsSync(this.featuresPath)) {
      copyFileSync(this.rootFeaturesPath, this.featuresPath)
    }

    // Migrate features into SQLite (the authoritative store)
    const imported = this.featureDb.migrateFromJson(this.mainDir)
    if (imported > 0) {
      console.log(`Migrated ${imported} features from features.json to SQLite (.quest/store/features.db)`)
    }

    // Migrate events from JSONL to SQLite
    const eventsImported = this.eventDb.migrateFromJsonl(this.mainDir)
    if (eventsImported > 0) {
      console.log(`Migrated ${eventsImported} events from quest-events.jsonl to SQLite (.quest/store/events.db)`)
    }

    // Migrate progress from JSON file to SQLite
    const progressMigrated = this.eventDb.migrateProgressFromJson(this.mainDir)
    if (progressMigrated) {
      console.log(`Migrated progress from claude-progress.txt to SQLite (.quest/store/events.db)`)
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

  get eventsDbPath(): string {
    return join(this.storeDir, 'events.db')
  }

  /** Root-level paths (for migration detection) */
  private get rootFeaturesPath(): string {
    return join(this.mainDir, 'features.json')
  }

  // ── Features ────────────────────────────────────────────────────────────

  /**
   * Read all features from SQLite.
   * Returns FeaturesFile format for backward compat with orchestrator/scheduler.
   */
  readFeatures(): FeaturesFile {
    return this.featureDb.exportToJson()
  }

  /**
   * Atomically mark a feature as passing.
   * SQLite handles concurrency via WAL mode — no file locking needed.
   */
  markFeaturePassing(featureId: string, sessionId: string): void {
    this.featureDb.updateFeature(featureId, { passes: true })
    // Also set session_id via direct update
    const row = this.featureDb.getFeature(featureId)
    if (row) {
      this.featureDb.updateFeature(featureId, { passes: true })
    }
  }

  getNextFeature(): Feature | null {
    const rows = this.featureDb.listFeatures({ passes: false })
    if (rows.length === 0) return null

    const byPriority: Record<string, number> = { high: 0, medium: 1, low: 2 }
    const sorted = [...rows].sort((a, b) => (byPriority[a.priority] ?? 2) - (byPriority[b.priority] ?? 2))
    return rowToFeature(sorted[0])
  }

  countPassing(): number {
    return this.featureDb.stats().passing
  }

  // ── Progress ────────────────────────────────────────────────────────────

  readProgress(): ProgressState {
    this.ensureInit()
    const data = this.eventDb.readProgress()
    if (!data) {
      throw new Error(`No progress state found in SQLite or files for: ${this.mainDir}`)
    }
    return data as unknown as ProgressState
  }

  writeProgress(state: ProgressState): void {
    this.ensureInit()
    const updated: ProgressState = { ...state, lastUpdated: new Date().toISOString() }
    this.eventDb.writeProgress(updated as unknown as Record<string, unknown>)
  }

  // ── Events ──────────────────────────────────────────────────────────────

  /** Initialize a fresh event log for this run. */
  initEventLog(): void {
    this.ensureInit()
    this.eventDb.clearEvents()
  }

  /** Append a structured event to the SQLite event log. */
  emitEvent(event: Record<string, unknown>): void {
    const fullEvent = { ...event, ts: new Date().toISOString() }
    try {
      this.eventDb.emit(fullEvent)
    } catch {
      // Non-fatal
    }
  }

  /** Read all events from the event log. */
  readEvents(): Array<Record<string, unknown>> {
    return this.eventDb.readAll() as unknown as Array<Record<string, unknown>>
  }

  /** Read new events after a cursor position. */
  readNewEvents(fromCursor: number): { events: Array<Record<string, unknown>>; newOffset: number } {
    const { events, lastId } = this.eventDb.readAfter(fromCursor)
    return { events: events as unknown as Array<Record<string, unknown>>, newOffset: lastId }
  }

  // ── Internal Helpers ────────────────────────────────────────────────────

  private ensureInit(): void {
    if (!this.initialized) {
      this.init()
    }
  }
}
