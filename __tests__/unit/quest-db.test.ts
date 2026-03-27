import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempDir, cleanTempDir } from '../helpers/tempDir.js'
import { createQuestDB } from '../../src/quest-db.js'
import { FeatureDB } from '../../src/feature-db.js'
import { EventDB } from '../../src/event-db.js'
import { TraceDB } from '../../src/trace-db.js'

describe('quest-db consolidation', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeTempDir()
  })

  afterEach(async () => {
    await cleanTempDir(dir)
  })

  describe('createQuestDB', () => {
    it('creates quest.db in .quest/store/', () => {
      const db = createQuestDB(dir)
      expect(existsSync(join(dir, '.quest', 'store', 'quest.db'))).toBe(true)
      db.close()
    })

    it('sets WAL journal mode', () => {
      const db = createQuestDB(dir)
      const mode = db.pragma('journal_mode', { simple: true })
      expect(mode).toBe('wal')
      db.close()
    })

    it('returns a working database connection', () => {
      const db = createQuestDB(dir)
      db.exec('CREATE TABLE test_tbl (id INTEGER PRIMARY KEY)')
      db.prepare('INSERT INTO test_tbl (id) VALUES (1)').run()
      const row = db.prepare('SELECT id FROM test_tbl').get() as { id: number }
      expect(row.id).toBe(1)
      db.close()
    })
  })

  describe('shared connection across DB classes', () => {
    it('FeatureDB and EventDB share the same quest.db file', () => {
      const sharedDb = createQuestDB(dir)
      const featureDb = new FeatureDB(dir, sharedDb)
      const eventDb = new EventDB(dir, sharedDb)

      // Write via featureDb, verify table exists via eventDb's connection (same db)
      featureDb.addFeature({
        id: 'f1',
        name: 'Feature 1',
        description: 'desc',
        category: 'api',
        priority: 'high',
        acceptanceCriteria: ['AC1'],
      })

      eventDb.emit({ type: 'test_event', ts: new Date().toISOString() })

      // Both tables should exist in the same database
      const tables = sharedDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all() as Array<{ name: string }>
      const tableNames = tables.map(t => t.name)

      expect(tableNames).toContain('features')
      expect(tableNames).toContain('events')

      featureDb.close() // should NOT close the shared connection
      eventDb.close()   // should NOT close the shared connection

      // Shared connection should still work
      const count = (sharedDb.prepare('SELECT COUNT(*) as c FROM features').get() as { c: number }).c
      expect(count).toBe(1)

      sharedDb.close()
    })

    it('TraceDB creates trace_events table (not events)', () => {
      const sharedDb = createQuestDB(dir)
      const traceDb = new TraceDB(dir, sharedDb)
      const eventDb = new EventDB(dir, sharedDb)

      // Both trace_events and events should coexist
      const tables = sharedDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all() as Array<{ name: string }>
      const tableNames = tables.map(t => t.name)

      expect(tableNames).toContain('trace_events')
      expect(tableNames).toContain('events')
      expect(tableNames).toContain('sessions')

      traceDb.close()
      eventDb.close()
      sharedDb.close()
    })
  })

  describe('standalone mode (no shared db)', () => {
    it('FeatureDB creates its own quest.db when no db passed', () => {
      const featureDb = new FeatureDB(dir)
      featureDb.addFeature({
        id: 'standalone-f1',
        name: 'Standalone',
        description: 'desc',
        category: 'api',
        priority: 'high',
        acceptanceCriteria: ['AC1'],
      })
      const feature = featureDb.getFeature('standalone-f1')
      expect(feature).toBeDefined()
      expect(feature!.name).toBe('Standalone')
      featureDb.close()
    })

    it('EventDB creates its own quest.db when no db passed', () => {
      const eventDb = new EventDB(dir)
      eventDb.emit({ type: 'standalone_test', ts: new Date().toISOString() })
      expect(eventDb.count()).toBe(1)
      eventDb.close()
    })

    it('TraceDB creates its own quest.db when no db passed', () => {
      const traceDb = new TraceDB(dir)
      const session = traceDb.startSession('coder' as any, 'test topic', { model: 'test-model' })
      session.end()
      const sessions = traceDb.listSessions()
      expect(sessions.length).toBe(1)
      traceDb.close()
    })
  })

  describe('ownsConnection guards close()', () => {
    it('shared db stays open after FeatureDB.close()', () => {
      const sharedDb = createQuestDB(dir)
      const featureDb = new FeatureDB(dir, sharedDb)
      featureDb.close()

      // Should not throw — connection is still open
      const result = sharedDb.prepare('SELECT 1 as x').get() as { x: number }
      expect(result.x).toBe(1)
      sharedDb.close()
    })

    it('standalone db is closed after FeatureDB.close()', () => {
      const featureDb = new FeatureDB(dir)
      featureDb.close()

      // Attempting to use the closed db would throw if we had a reference,
      // but we just verify it didn't throw during close()
    })
  })

  describe('legacy migration', () => {
    it('migrates data from legacy features.db', () => {
      // Create a legacy features.db
      const legacyDir = join(dir, '.quest', 'store')
      mkdirSync(legacyDir, { recursive: true })
      const legacyDb = new Database(join(legacyDir, 'features.db'))
      legacyDb.exec(`
        CREATE TABLE features (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          category TEXT NOT NULL,
          priority TEXT NOT NULL,
          acceptance_criteria TEXT NOT NULL,
          browser_test_url TEXT,
          depends_on TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          worker_id INTEGER,
          passes INTEGER NOT NULL DEFAULT 0,
          implemented_at TEXT,
          session_id TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      legacyDb.prepare(
        "INSERT INTO features (id, name, description, category, priority, acceptance_criteria, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run('legacy-feat', 'Legacy Feature', 'desc', 'api', 'high', '["AC1"]', 0)
      legacyDb.close()

      // Now create quest.db — migration should copy data
      const questDb = createQuestDB(dir)

      const row = questDb.prepare('SELECT * FROM features WHERE id = ?').get('legacy-feat') as any
      expect(row).toBeDefined()
      expect(row.name).toBe('Legacy Feature')

      // Legacy file should be renamed
      expect(existsSync(join(legacyDir, 'features.db'))).toBe(false)
      expect(existsSync(join(legacyDir, 'features.db.migrated'))).toBe(true)

      questDb.close()
    })

    it('migrates data from legacy events.db', () => {
      const legacyDir = join(dir, '.quest', 'store')
      mkdirSync(legacyDir, { recursive: true })
      const legacyDb = new Database(join(legacyDir, 'events.db'))
      legacyDb.exec(`
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          type TEXT NOT NULL,
          feature_id TEXT,
          worker_id INTEGER,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      legacyDb.prepare(
        "INSERT INTO events (ts, type, data) VALUES (?, ?, ?)"
      ).run('2025-01-01T00:00:00Z', 'test_event', '{"type":"test_event"}')
      legacyDb.close()

      const questDb = createQuestDB(dir)

      const row = questDb.prepare('SELECT * FROM events WHERE type = ?').get('test_event') as any
      expect(row).toBeDefined()
      expect(row.ts).toBe('2025-01-01T00:00:00Z')

      expect(existsSync(join(legacyDir, 'events.db'))).toBe(false)
      expect(existsSync(join(legacyDir, 'events.db.migrated'))).toBe(true)

      questDb.close()
    })

    it('migrates traces.db with events renamed to trace_events', () => {
      // Legacy traces.db lives at .quest/traces.db (not in store/)
      const questDir = join(dir, '.quest')
      mkdirSync(questDir, { recursive: true })
      const legacyDb = new Database(join(questDir, 'traces.db'))
      legacyDb.exec(`
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          agent TEXT NOT NULL,
          topic TEXT NOT NULL,
          feature_id TEXT,
          worker_id INTEGER,
          model TEXT NOT NULL,
          system_prompt TEXT,
          user_prompt TEXT,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          turns INTEGER DEFAULT 0,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          status TEXT DEFAULT 'running'
        );
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          ts INTEGER NOT NULL,
          type TEXT NOT NULL,
          tool_name TEXT,
          file_path TEXT,
          content_text TEXT,
          input_json TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          context_window INTEGER,
          duration_ms INTEGER,
          is_error INTEGER
        )
      `)
      legacyDb.prepare(
        "INSERT INTO sessions (session_id, agent, topic, model, started_at) VALUES (?, ?, ?, ?, ?)"
      ).run('session-1', 'coder', 'test topic', 'test-model', Date.now())
      legacyDb.prepare(
        "INSERT INTO events (session_id, seq, ts, type) VALUES (?, ?, ?, ?)"
      ).run('session-1', 1, Date.now(), 'tool_call')
      legacyDb.close()

      const questDb = createQuestDB(dir)

      // sessions copied as-is
      const session = questDb.prepare('SELECT * FROM sessions WHERE session_id = ?').get('session-1') as any
      expect(session).toBeDefined()
      expect(session.agent).toBe('coder')

      // events renamed to trace_events
      const traceEvent = questDb.prepare('SELECT * FROM trace_events WHERE session_id = ?').get('session-1') as any
      expect(traceEvent).toBeDefined()
      expect(traceEvent.type).toBe('tool_call')

      // Legacy file should be renamed
      expect(existsSync(join(questDir, 'traces.db'))).toBe(false)
      expect(existsSync(join(questDir, 'traces.db.migrated'))).toBe(true)

      questDb.close()
    })

    it('migration is idempotent — skips if data already exists', () => {
      // First run: creates quest.db with features table having data
      const sharedDb = createQuestDB(dir)
      const featureDb = new FeatureDB(dir, sharedDb)
      featureDb.addFeature({
        id: 'existing',
        name: 'Existing',
        description: 'desc',
        category: 'api',
        priority: 'high',
        acceptanceCriteria: ['AC1'],
      })
      featureDb.close()
      sharedDb.close()

      // Create a legacy features.db AFTER quest.db has data
      const legacyDir = join(dir, '.quest', 'store')
      const legacyDb = new Database(join(legacyDir, 'features.db'))
      legacyDb.exec(`
        CREATE TABLE features (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          category TEXT NOT NULL,
          priority TEXT NOT NULL,
          acceptance_criteria TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      legacyDb.prepare(
        "INSERT INTO features (id, name, description, category, priority, acceptance_criteria, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run('should-not-appear', 'Should Not Appear', 'desc', 'api', 'high', '[]', 0)
      legacyDb.close()

      // Second run: should skip migration since quest.db already has data
      const db2 = createQuestDB(dir)
      const row = db2.prepare("SELECT * FROM features WHERE id = 'should-not-appear'").get()
      expect(row).toBeUndefined()

      const existing = db2.prepare("SELECT * FROM features WHERE id = 'existing'").get() as any
      expect(existing).toBeDefined()

      db2.close()
    })
  })

  describe('TraceDB trace_events table', () => {
    it('inserts and queries events in trace_events table', () => {
      const traceDb = new TraceDB(dir)

      traceDb.insertSession({
        sessionId: 'test-session',
        agent: 'coder' as any,
        topic: 'test',
        model: 'test-model',
      })

      traceDb.insertEvent({
        session_id: 'test-session',
        seq: 1,
        ts: Date.now(),
        type: 'tool_call',
        tool_name: 'Read',
        file_path: '/test/file.ts',
        content_text: null,
        input_json: '{}',
        input_tokens: null,
        output_tokens: null,
        context_window: null,
        duration_ms: null,
        is_error: null,
      })

      const events = traceDb.getSessionEvents('test-session')
      expect(events).toHaveLength(1)
      expect(events[0].tool_name).toBe('Read')
      expect(events[0].file_path).toBe('/test/file.ts')

      const stats = traceDb.stats()
      expect(stats.sessions).toBe(1)
      expect(stats.events).toBe(1)

      traceDb.close()
    })

    it('topTools queries trace_events correctly', () => {
      const traceDb = new TraceDB(dir)

      traceDb.insertSession({
        sessionId: 's1',
        agent: 'coder' as any,
        topic: 'test',
        model: 'test-model',
      })

      for (let i = 0; i < 3; i++) {
        traceDb.insertEvent({
          session_id: 's1',
          seq: i,
          ts: Date.now(),
          type: 'tool_call',
          tool_name: 'Edit',
          file_path: null,
          content_text: null,
          input_json: null,
          input_tokens: null,
          output_tokens: null,
          context_window: null,
          duration_ms: null,
          is_error: null,
        })
      }

      const tools = traceDb.topTools()
      expect(tools).toHaveLength(1)
      expect(tools[0].tool_name).toBe('Edit')
      expect(tools[0].count).toBe(3)

      traceDb.close()
    })

    it('queryByFile searches trace_events', () => {
      const traceDb = new TraceDB(dir)

      traceDb.insertSession({
        sessionId: 's1',
        agent: 'coder' as any,
        topic: 'test',
        model: 'test-model',
      })

      traceDb.insertEvent({
        session_id: 's1',
        seq: 0,
        ts: Date.now(),
        type: 'tool_call',
        tool_name: 'Read',
        file_path: '/src/quest-db.ts',
        content_text: null,
        input_json: null,
        input_tokens: null,
        output_tokens: null,
        context_window: null,
        duration_ms: null,
        is_error: null,
      })

      const results = traceDb.queryByFile('quest-db.ts')
      expect(results).toHaveLength(1)
      expect(results[0].agent).toBe('coder')

      traceDb.close()
    })
  })
})
