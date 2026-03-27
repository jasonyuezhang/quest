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

function migrateLegacyDatabases(db: Database.Database, projectDir: string): void {
  const legacyFeatures = join(projectDir, '.quest', 'store', 'features.db')
  const legacyEvents = join(projectDir, '.quest', 'store', 'events.db')
  const legacyTraces = join(projectDir, '.quest', 'traces.db')

  // Migrate features.db
  if (existsSync(legacyFeatures)) {
    try {
      const hasData = (db.prepare(
        "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='features'"
      ).get() as { c: number }).c > 0

      const isEmpty = !hasData || (db.prepare('SELECT COUNT(*) as c FROM features').get() as { c: number }).c === 0

      if (isEmpty) {
        db.exec(`ATTACH DATABASE '${legacyFeatures.replace(/'/g, "''")}' AS legacy_features`)
        try {
          // Copy each table if it exists in the legacy DB
          const tables = db.prepare(
            "SELECT name FROM legacy_features.sqlite_master WHERE type='table' AND name IN ('features', 'feature_meta', 'attempts')"
          ).all() as Array<{ name: string }>

          for (const { name } of tables) {
            db.exec(`CREATE TABLE IF NOT EXISTS ${name} AS SELECT * FROM legacy_features.${name}`)
          }
        } finally {
          db.exec('DETACH DATABASE legacy_features')
        }
        renameSync(legacyFeatures, legacyFeatures + '.migrated')
        // Also rename WAL/SHM files if they exist
        if (existsSync(legacyFeatures + '-wal')) renameSync(legacyFeatures + '-wal', legacyFeatures + '-wal.migrated')
        if (existsSync(legacyFeatures + '-shm')) renameSync(legacyFeatures + '-shm', legacyFeatures + '-shm.migrated')
      }
    } catch {
      // Non-fatal — legacy migration should never crash
    }
  }

  // Migrate events.db
  if (existsSync(legacyEvents)) {
    try {
      const hasData = (db.prepare(
        "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='events'"
      ).get() as { c: number }).c > 0

      const isEmpty = !hasData || (db.prepare('SELECT COUNT(*) as c FROM events').get() as { c: number }).c === 0

      if (isEmpty) {
        db.exec(`ATTACH DATABASE '${legacyEvents.replace(/'/g, "''")}' AS legacy_events`)
        try {
          const tables = db.prepare(
            "SELECT name FROM legacy_events.sqlite_master WHERE type='table' AND name IN ('events', 'progress')"
          ).all() as Array<{ name: string }>

          for (const { name } of tables) {
            db.exec(`CREATE TABLE IF NOT EXISTS ${name} AS SELECT * FROM legacy_events.${name}`)
          }
        } finally {
          db.exec('DETACH DATABASE legacy_events')
        }
        renameSync(legacyEvents, legacyEvents + '.migrated')
        if (existsSync(legacyEvents + '-wal')) renameSync(legacyEvents + '-wal', legacyEvents + '-wal.migrated')
        if (existsSync(legacyEvents + '-shm')) renameSync(legacyEvents + '-shm', legacyEvents + '-shm.migrated')
      }
    } catch {
      // Non-fatal
    }
  }

  // Migrate traces.db
  if (existsSync(legacyTraces)) {
    try {
      const hasData = (db.prepare(
        "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='sessions'"
      ).get() as { c: number }).c > 0

      const isEmpty = !hasData || (db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }).c === 0

      if (isEmpty) {
        db.exec(`ATTACH DATABASE '${legacyTraces.replace(/'/g, "''")}' AS legacy_traces`)
        try {
          // Copy sessions as-is
          const hasSessions = (db.prepare(
            "SELECT COUNT(*) as c FROM legacy_traces.sqlite_master WHERE type='table' AND name='sessions'"
          ).get() as { c: number }).c > 0

          if (hasSessions) {
            db.exec('CREATE TABLE IF NOT EXISTS sessions AS SELECT * FROM legacy_traces.sessions')
          }

          // Copy events as trace_events (rename to avoid collision)
          const hasEvents = (db.prepare(
            "SELECT COUNT(*) as c FROM legacy_traces.sqlite_master WHERE type='table' AND name='events'"
          ).get() as { c: number }).c > 0

          if (hasEvents) {
            db.exec('CREATE TABLE IF NOT EXISTS trace_events AS SELECT * FROM legacy_traces.events')
          }
        } finally {
          db.exec('DETACH DATABASE legacy_traces')
        }
        renameSync(legacyTraces, legacyTraces + '.migrated')
        if (existsSync(legacyTraces + '-wal')) renameSync(legacyTraces + '-wal', legacyTraces + '-wal.migrated')
        if (existsSync(legacyTraces + '-shm')) renameSync(legacyTraces + '-shm', legacyTraces + '-shm.migrated')
      }
    } catch {
      // Non-fatal
    }
  }
}
