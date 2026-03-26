#!/usr/bin/env npx tsx
/**
 * Replace all features in SQLite with the contents of features.json
 */
import Database from 'better-sqlite3'
import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { FeaturesFile, Feature } from './agents/types.js'

const projectDir = process.argv[2] || process.cwd()
const jsonPath = join(projectDir, 'features.json')

const data = JSON.parse(readFileSync(jsonPath, 'utf-8')) as FeaturesFile
console.log(`Read ${data.features.length} features from features.json (project: ${data.projectName})`)

const dbPath = join(projectDir, '.quest', 'store', 'features.db')
mkdirSync(join(projectDir, '.quest', 'store'), { recursive: true })

const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')

// Clear and re-insert
db.exec('DELETE FROM features')
db.exec('DELETE FROM feature_meta')

db.prepare('INSERT OR REPLACE INTO feature_meta (key, value) VALUES (?, ?)').run('projectName', data.projectName)
db.prepare('INSERT OR REPLACE INTO feature_meta (key, value) VALUES (?, ?)').run('version', data.version)

const insert = db.prepare(`
  INSERT INTO features (id, name, description, category, priority, acceptance_criteria, browser_test_url, depends_on, passes, implemented_at, session_id, sort_order)
  VALUES (@id, @name, @description, @category, @priority, @acceptance_criteria, @browser_test_url, @depends_on, @passes, @implemented_at, @session_id, @sort_order)
`)

const tx = db.transaction((features: Feature[]) => {
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

tx(data.features)

const count = (db.prepare('SELECT COUNT(*) as c FROM features').get() as { c: number }).c
const cats = db.prepare('SELECT DISTINCT category FROM features ORDER BY category').all() as Array<{ category: string }>

console.log(`Imported ${count} features into SQLite`)
console.log(`Categories: ${cats.map(c => c.category).join(', ')}`)
console.log(`DB: ${dbPath}`)

db.close()
