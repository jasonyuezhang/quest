/**
 * Shared base for SQLite-backed DB classes.
 *
 * Provides the common constructor pattern (accept optional shared connection)
 * and lifecycle management (ownsConnection guard on close).
 */

import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createQuestDB } from './quest-db.js'

/**
 * Base class for DB modules that share a quest.db connection.
 *
 * Subclasses call `super(projectDir, db)` and then `this.db.exec(SCHEMA)`.
 */
export abstract class QuestDBBase {
  protected db: Database.Database
  private ownsConnection: boolean

  constructor(projectDir: string, db?: Database.Database) {
    if (db) {
      this.db = db
      this.ownsConnection = false
    } else {
      this.db = createQuestDB(projectDir)
      this.ownsConnection = true
    }
  }

  close(): void {
    if (this.ownsConnection) this.db.close()
  }
}

/**
 * Resolve a file path with store-first fallback.
 *
 * Checks `.quest/store/<filename>` first, then `<projectDir>/<filename>`.
 * Returns null if neither exists.
 */
export function resolveStorePath(projectDir: string, filename: string): string | null {
  const storePath = join(projectDir, '.quest', 'store', filename)
  if (existsSync(storePath)) return storePath
  const rootPath = join(projectDir, filename)
  if (existsSync(rootPath)) return rootPath
  return null
}
