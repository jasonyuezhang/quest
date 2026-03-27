/**
 * Shared SQLite database factory for the Quest harness.
 *
 * Creates a single `quest.db` connection with standard pragmas, and migrates
 * data from legacy per-module database files (features.db, events.db, traces.db)
 * on first run.
 */

import Database from 'better-sqlite3'
import { mkdirSync, existsSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'

/**
 * Create (or open) the shared quest.db and return the connection.
 * On first run, migrates data from legacy DB files via ATTACH DATABASE.
 */
export function createQuestDB(projectDir: string): Database.Database {
  const dbPath = join(projectDir, '.quest', 'store', 'quest.db')
  mkdirSync(dirname(dbPath), { recursive: true })

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')

  migrateLegacyDatabases(db, projectDir)

  return db
}

// ---------------------------------------------------------------------------
// Legacy migration — copies tables from old per-module .db files into quest.db
// ---------------------------------------------------------------------------

interface LegacyMigration {
  path: string
  alias: string
  /** Table to check for existing data in quest.db (emptiness gate) */
  checkTable: string
  /** Tables to copy: { source: legacyTableName, target: questDbTableName } */
  tables: Array<{ source: string; target: string }>
}

function migrateLegacyDatabases(db: Database.Database, projectDir: string): void {
  const migrations: LegacyMigration[] = [
    {
      path: join(projectDir, '.quest', 'store', 'features.db'),
      alias: 'legacy_features',
      checkTable: 'features',
      tables: [
        { source: 'features', target: 'features' },
        { source: 'feature_meta', target: 'feature_meta' },
        { source: 'attempts', target: 'attempts' },
      ],
    },
    {
      path: join(projectDir, '.quest', 'store', 'events.db'),
      alias: 'legacy_events',
      checkTable: 'events',
      tables: [
        { source: 'events', target: 'events' },
        { source: 'progress', target: 'progress' },
      ],
    },
    {
      path: join(projectDir, '.quest', 'traces.db'),
      alias: 'legacy_traces',
      checkTable: 'sessions',
      tables: [
        { source: 'sessions', target: 'sessions' },
        { source: 'events', target: 'trace_events' },
      ],
    },
  ]

  for (const m of migrations) {
    migrateLegacyDB(db, m)
  }
}

function migrateLegacyDB(db: Database.Database, m: LegacyMigration): void {
  if (!existsSync(m.path)) return

  try {
    const hasTable = (db.prepare(
      "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name=?"
    ).get(m.checkTable) as { c: number }).c > 0

    const isEmpty = !hasTable || (db.prepare(`SELECT COUNT(*) as c FROM ${m.checkTable}`).get() as { c: number }).c === 0
    if (!isEmpty) return

    db.exec(`ATTACH DATABASE '${m.path.replace(/'/g, "''")}' AS ${m.alias}`)
    try {
      for (const { source, target } of m.tables) {
        const exists = (db.prepare(
          `SELECT COUNT(*) as c FROM ${m.alias}.sqlite_master WHERE type='table' AND name=?`
        ).get(source) as { c: number }).c > 0

        if (exists) {
          db.exec(`CREATE TABLE IF NOT EXISTS ${target} AS SELECT * FROM ${m.alias}.${source}`)
        }
      }
    } finally {
      db.exec(`DETACH DATABASE ${m.alias}`)
    }

    renameSync(m.path, m.path + '.migrated')
    if (existsSync(m.path + '-wal')) renameSync(m.path + '-wal', m.path + '-wal.migrated')
    if (existsSync(m.path + '-shm')) renameSync(m.path + '-shm', m.path + '-shm.migrated')
  } catch {
    // Non-fatal — legacy migration should never crash
  }
}
