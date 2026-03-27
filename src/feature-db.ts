/**
 * SQLite-backed feature storage.
 *
 * Replaces features.json as the source of truth for feature state.
 * Provides atomic updates, concurrent-safe writes, and query support.
 *
 * On first run, migrates existing features.json into the database.
 * The QuestStore and orchestrator read from here instead of JSON files.
 */

import Database from 'better-sqlite3'
import { mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { Feature, FeaturesFile } from './agents/types.js'
import { createQuestDB } from './quest-db.js'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS features (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    description       TEXT NOT NULL,
    category          TEXT NOT NULL,
    priority          TEXT NOT NULL CHECK(priority IN ('high', 'medium', 'low')),
    acceptance_criteria TEXT NOT NULL,
    browser_test_url  TEXT,
    depends_on        TEXT,
    status            TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'passed', 'failed', 'wont_do')),
    worker_id         INTEGER,
    passes            INTEGER NOT NULL DEFAULT 0,
    implemented_at    TEXT,
    session_id        TEXT,
    sort_order        INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS feature_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS attempts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    feature_id      TEXT NOT NULL,
    attempt_num     INTEGER NOT NULL,
    phase           TEXT NOT NULL,
    worker_id       INTEGER,
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER,
    verdict         TEXT,
    failure_reason  TEXT,
    failure_category TEXT,
    eval_evidence   TEXT,
    files_changed   TEXT,
    commit_sha      TEXT,
    input_tokens    INTEGER DEFAULT 0,
    output_tokens   INTEGER DEFAULT 0,
    context_resets  INTEGER DEFAULT 0,
    turns           INTEGER DEFAULT 0,
    FOREIGN KEY (feature_id) REFERENCES features(id)
  );

  CREATE INDEX IF NOT EXISTS idx_features_priority ON features(priority);
  CREATE INDEX IF NOT EXISTS idx_features_passes ON features(passes);
  CREATE INDEX IF NOT EXISTS idx_features_category ON features(category);
  CREATE INDEX IF NOT EXISTS idx_attempts_feature ON attempts(feature_id, attempt_num);
`

export class FeatureDB {
  private db: Database.Database
  private ownsConnection: boolean

  constructor(projectDir: string, db?: Database.Database) {
    if (db) {
      this.db = db
      this.ownsConnection = false
    } else {
      this.db = createQuestDB(projectDir)
      this.ownsConnection = true
    }

    this.db.exec(SCHEMA)

    // Add columns to existing databases (idempotent)
    try { this.db.exec("ALTER TABLE features ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'") } catch { /* already exists */ }
    try { this.db.exec('ALTER TABLE features ADD COLUMN worker_id INTEGER') } catch { /* already exists */ }
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_features_status ON features(status)') } catch { /* ignore */ }
  }

  // ── Status management (called by orchestrator) ──────────────────────────

  setFeatureStatus(id: string, status: 'pending' | 'in_progress' | 'passed' | 'failed' | 'wont_do', workerId?: number): void {
    const passes = status === 'passed' ? 1 : 0
    this.db.prepare(`
      UPDATE features SET status = @status, worker_id = @worker_id, passes = @passes, updated_at = datetime('now')
      ${status === 'passed' ? ", implemented_at = datetime('now')" : ''}
      WHERE id = @id
    `).run({ id, status, worker_id: workerId ?? null, passes })
  }

  // ── Migration ───────────────────────────────────────────────────────────

  /**
   * Import features from a features.json file if the database is empty.
   * Returns the number of features imported.
   */
  migrateFromJson(projectDir: string): number {
    const count = (this.db.prepare('SELECT COUNT(*) as c FROM features').get() as { c: number }).c
    if (count > 0) return 0

    // Try store path first, then root
    const storePath = join(projectDir, '.quest', 'store', 'features.json')
    const rootPath = join(projectDir, 'features.json')
    const jsonPath = existsSync(storePath) ? storePath : existsSync(rootPath) ? rootPath : null

    if (!jsonPath) return 0

    const raw = readFileSync(jsonPath, 'utf-8')
    const data = JSON.parse(raw) as FeaturesFile

    // Store metadata
    this.db.prepare('INSERT OR REPLACE INTO feature_meta (key, value) VALUES (?, ?)').run('projectName', data.projectName)
    this.db.prepare('INSERT OR REPLACE INTO feature_meta (key, value) VALUES (?, ?)').run('version', data.version)

    const insert = this.db.prepare(`
      INSERT INTO features (id, name, description, category, priority, acceptance_criteria, browser_test_url, depends_on, passes, implemented_at, session_id, sort_order)
      VALUES (@id, @name, @description, @category, @priority, @acceptance_criteria, @browser_test_url, @depends_on, @passes, @implemented_at, @session_id, @sort_order)
    `)

    const insertAll = this.db.transaction((features: Feature[]) => {
      for (let i = 0; i < features.length; i++) {
        const f = features[i]
        insert.run({
          id: f.id,
          name: f.name,
          description: f.description,
          category: f.category,
          priority: f.priority,
          acceptance_criteria: JSON.stringify(f.acceptanceCriteria),
          browser_test_url: f.browserTestUrl ?? null,
          depends_on: f.dependsOn ? JSON.stringify(f.dependsOn) : null,
          passes: f.passes ? 1 : 0,
          implemented_at: f.implementedAt ?? null,
          session_id: f.sessionId ?? null,
          sort_order: i,
        })
      }
    })

    insertAll(data.features)
    return data.features.length
  }

  // ── Reads ───────────────────────────────────────────────────────────────

  listFeatures(filters?: { priority?: string; category?: string; passes?: boolean }): FeatureRow[] {
    let sql = 'SELECT * FROM features WHERE 1=1'
    const params: Record<string, unknown> = {}

    if (filters?.priority) {
      sql += ' AND priority = @priority'
      params.priority = filters.priority
    }
    if (filters?.category) {
      sql += ' AND category = @category'
      params.category = filters.category
    }
    if (filters?.passes !== undefined) {
      sql += ' AND passes = @passes'
      params.passes = filters.passes ? 1 : 0
    }

    sql += ' ORDER BY sort_order ASC'
    return this.db.prepare(sql).all(params) as FeatureRow[]
  }

  getFeature(id: string): FeatureRow | undefined {
    return this.db.prepare('SELECT * FROM features WHERE id = ?').get(id) as FeatureRow | undefined
  }

  getProjectName(): string {
    const row = this.db.prepare('SELECT value FROM feature_meta WHERE key = ?').get('projectName') as { value: string } | undefined
    return row?.value ?? 'quest'
  }

  stats(): { total: number; passing: number; pending: number; inProgress: number; failed: number; wontDo: number; categories: string[] } {
    const total = (this.db.prepare('SELECT COUNT(*) as c FROM features').get() as { c: number }).c
    const passing = (this.db.prepare('SELECT COUNT(*) as c FROM features WHERE status = \'passed\'').get() as { c: number }).c
    const inProgress = (this.db.prepare('SELECT COUNT(*) as c FROM features WHERE status = \'in_progress\'').get() as { c: number }).c
    const failed = (this.db.prepare('SELECT COUNT(*) as c FROM features WHERE status = \'failed\'').get() as { c: number }).c
    const wontDo = (this.db.prepare('SELECT COUNT(*) as c FROM features WHERE status = \'wont_do\'').get() as { c: number }).c
    const pending = total - passing - inProgress - failed - wontDo
    const cats = this.db.prepare('SELECT DISTINCT category FROM features ORDER BY category').all() as Array<{ category: string }>
    return { total, passing, pending, inProgress, failed, wontDo, categories: cats.map(c => c.category) }
  }

  // ── Writes ──────────────────────────────────────────────────────────────

  updateFeature(id: string, updates: Partial<FeatureUpdate>): void {
    const fields: string[] = []
    const params: Record<string, unknown> = { id }

    if (updates.name !== undefined) { fields.push('name = @name'); params.name = updates.name }
    if (updates.description !== undefined) { fields.push('description = @description'); params.description = updates.description }
    if (updates.category !== undefined) { fields.push('category = @category'); params.category = updates.category }
    if (updates.priority !== undefined) { fields.push('priority = @priority'); params.priority = updates.priority }
    if (updates.acceptanceCriteria !== undefined) {
      fields.push('acceptance_criteria = @acceptance_criteria')
      params.acceptance_criteria = JSON.stringify(updates.acceptanceCriteria)
    }
    if (updates.dependsOn !== undefined) {
      fields.push('depends_on = @depends_on')
      params.depends_on = updates.dependsOn.length > 0 ? JSON.stringify(updates.dependsOn) : null
    }
    if (updates.passes !== undefined) {
      fields.push('passes = @passes')
      params.passes = updates.passes ? 1 : 0
      if (updates.passes) {
        fields.push("implemented_at = datetime('now')")
      }
    }
    if (updates.browserTestUrl !== undefined) {
      fields.push('browser_test_url = @browser_test_url')
      params.browser_test_url = updates.browserTestUrl || null
    }

    if (fields.length === 0) return

    fields.push("updated_at = datetime('now')")
    this.db.prepare(`UPDATE features SET ${fields.join(', ')} WHERE id = @id`).run(params)
  }

  addFeature(feature: {
    id: string; name: string; description: string; category: string
    priority: 'high' | 'medium' | 'low'; acceptanceCriteria: string[]
    dependsOn?: string[]; browserTestUrl?: string
  }): void {
    const maxOrder = (this.db.prepare('SELECT MAX(sort_order) as m FROM features').get() as { m: number | null }).m ?? -1

    this.db.prepare(`
      INSERT INTO features (id, name, description, category, priority, acceptance_criteria, depends_on, browser_test_url, sort_order)
      VALUES (@id, @name, @description, @category, @priority, @acceptance_criteria, @depends_on, @browser_test_url, @sort_order)
    `).run({
      id: feature.id,
      name: feature.name,
      description: feature.description,
      category: feature.category,
      priority: feature.priority,
      acceptance_criteria: JSON.stringify(feature.acceptanceCriteria),
      depends_on: feature.dependsOn ? JSON.stringify(feature.dependsOn) : null,
      browser_test_url: feature.browserTestUrl ?? null,
      sort_order: maxOrder + 1,
    })
  }

  deleteFeature(id: string): boolean {
    const result = this.db.prepare('DELETE FROM features WHERE id = ?').run(id)
    return result.changes > 0
  }

  // ── Attempt tracking ─────────────────────────────────────────────────

  /**
   * Record the start of a coder/evaluator attempt for a feature.
   * Returns the attempt ID for later updates.
   */
  recordAttemptStart(featureId: string, attemptNum: number, phase: 'coder' | 'evaluator' | 'reviewer', workerId?: number): number {
    const result = this.db.prepare(`
      INSERT INTO attempts (feature_id, attempt_num, phase, worker_id, started_at)
      VALUES (@feature_id, @attempt_num, @phase, @worker_id, @started_at)
    `).run({
      feature_id: featureId,
      attempt_num: attemptNum,
      phase,
      worker_id: workerId ?? null,
      started_at: Date.now(),
    })
    return Number(result.lastInsertRowid)
  }

  /**
   * Record the outcome of an attempt.
   */
  recordAttemptEnd(attemptId: number, result: {
    verdict?: 'pass' | 'fail'
    failureReason?: string
    failureCategory?: string
    evalEvidence?: string
    filesChanged?: string[]
    commitSha?: string
    inputTokens?: number
    outputTokens?: number
    contextResets?: number
    turns?: number
  }): void {
    this.db.prepare(`
      UPDATE attempts SET
        ended_at = @ended_at,
        verdict = @verdict,
        failure_reason = @failure_reason,
        failure_category = @failure_category,
        eval_evidence = @eval_evidence,
        files_changed = @files_changed,
        commit_sha = @commit_sha,
        input_tokens = @input_tokens,
        output_tokens = @output_tokens,
        context_resets = @context_resets,
        turns = @turns
      WHERE id = @id
    `).run({
      id: attemptId,
      ended_at: Date.now(),
      verdict: result.verdict ?? null,
      failure_reason: result.failureReason ?? null,
      failure_category: result.failureCategory ?? null,
      eval_evidence: result.evalEvidence ?? null,
      files_changed: result.filesChanged ? JSON.stringify(result.filesChanged) : null,
      commit_sha: result.commitSha ?? null,
      input_tokens: result.inputTokens ?? 0,
      output_tokens: result.outputTokens ?? 0,
      context_resets: result.contextResets ?? 0,
      turns: result.turns ?? 0,
    })
  }

  /**
   * Get all attempts for a feature, ordered chronologically.
   */
  getAttempts(featureId: string): AttemptRow[] {
    return this.db.prepare('SELECT * FROM attempts WHERE feature_id = ? ORDER BY started_at ASC')
      .all(featureId) as AttemptRow[]
  }

  /**
   * Get the latest failure evidence for a feature (used to inform the next attempt).
   */
  getLastFailure(featureId: string): AttemptRow | undefined {
    return this.db.prepare(`
      SELECT * FROM attempts
      WHERE feature_id = ? AND verdict = 'fail'
      ORDER BY started_at DESC LIMIT 1
    `).get(featureId) as AttemptRow | undefined
  }

  /**
   * Count total attempts across all runs for a feature.
   */
  totalAttempts(featureId: string): number {
    return (this.db.prepare('SELECT COUNT(*) as c FROM attempts WHERE feature_id = ?').get(featureId) as { c: number }).c
  }

  reorderFeatures(orderedIds: string[]): void {
    const update = this.db.prepare('UPDATE features SET sort_order = ? WHERE id = ?')
    const reorder = this.db.transaction((ids: string[]) => {
      for (let i = 0; i < ids.length; i++) {
        update.run(i, ids[i])
      }
    })
    reorder(orderedIds)
  }

  /** Export back to FeaturesFile format (for backward compat) */
  exportToJson(): FeaturesFile {
    const features = this.listFeatures()
    const projectName = this.getProjectName()
    return {
      version: '2.0',
      projectName,
      generatedAt: new Date().toISOString(),
      features: features.map(rowToFeature),
    }
  }

  close(): void {
    if (this.ownsConnection) this.db.close()
  }
}

// ── Types ─────────────────────────────────────────────────────────────────

export interface FeatureRow {
  id: string
  name: string
  description: string
  category: string
  priority: string
  acceptance_criteria: string
  browser_test_url: string | null
  depends_on: string | null
  status: string
  worker_id: number | null
  passes: number
  implemented_at: string | null
  session_id: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

export interface AttemptRow {
  id: number
  feature_id: string
  attempt_num: number
  phase: string
  worker_id: number | null
  started_at: number
  ended_at: number | null
  verdict: string | null
  failure_reason: string | null
  failure_category: string | null
  eval_evidence: string | null
  files_changed: string | null
  commit_sha: string | null
  input_tokens: number
  output_tokens: number
  context_resets: number
  turns: number
}

export interface FeatureUpdate {
  name: string
  description: string
  category: string
  priority: 'high' | 'medium' | 'low'
  acceptanceCriteria: string[]
  dependsOn: string[]
  passes: boolean
  browserTestUrl: string
}

export function rowToFeature(row: FeatureRow): Feature {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    priority: row.priority as 'high' | 'medium' | 'low',
    acceptanceCriteria: JSON.parse(row.acceptance_criteria),
    browserTestUrl: row.browser_test_url ?? undefined,
    dependsOn: row.depends_on ? JSON.parse(row.depends_on) : undefined,
    passes: row.passes === 1,
    implementedAt: row.implemented_at ?? undefined,
    sessionId: row.session_id ?? undefined,
  }
}
