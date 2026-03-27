#!/usr/bin/env npx tsx
/**
 * Replace all features in SQLite with the contents of features.json
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FeaturesFile, Feature } from './agents/types.js'
import { createQuestDB } from './quest-db.js'

const projectDir = process.argv[2] || process.cwd()
const jsonPath = join(projectDir, 'features.json')

const data = JSON.parse(readFileSync(jsonPath, 'utf-8')) as FeaturesFile
console.log(`Read ${data.features.length} features from features.json (project: ${data.projectName})`)

const db = createQuestDB(projectDir)

// Ensure schema exists
db.exec(`
  CREATE TABLE IF NOT EXISTS features (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
    category TEXT NOT NULL, priority TEXT NOT NULL, acceptance_criteria TEXT NOT NULL,
    browser_test_url TEXT, depends_on TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    worker_id INTEGER, passes INTEGER NOT NULL DEFAULT 0,
    implemented_at TEXT, session_id TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS feature_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`)

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
console.log(`DB: .quest/store/quest.db`)

db.close()
