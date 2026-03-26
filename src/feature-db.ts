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

  CREATE INDEX IF NOT EXISTS idx_features_priority ON features(priority);
  CREATE INDEX IF NOT EXISTS idx_features_passes ON features(passes);
  CREATE INDEX IF NOT EXISTS idx_features_category ON features(category);
`

export class FeatureDB {
  private db: Database.Database

  constructor(projectDir: string) {
    const dbPath = join(projectDir, '.quest', 'store', 'features.db')
    mkdirSync(dirname(dbPath), { recursive: true })

    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')

    this.db.exec(SCHEMA)
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

  stats(): { total: number; passing: number; pending: number; categories: string[] } {
    const total = (this.db.prepare('SELECT COUNT(*) as c FROM features').get() as { c: number }).c
    const passing = (this.db.prepare('SELECT COUNT(*) as c FROM features WHERE passes = 1').get() as { c: number }).c
    const cats = this.db.prepare('SELECT DISTINCT category FROM features ORDER BY category').all() as Array<{ category: string }>
    return { total, passing, pending: total - passing, categories: cats.map(c => c.category) }
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
    this.db.close()
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
  passes: number
  implemented_at: string | null
  session_id: string | null
  sort_order: number
  created_at: string
  updated_at: string
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
