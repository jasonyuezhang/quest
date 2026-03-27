# Plan: Consolidate Three SQLite Databases into One `quest.db`

## Overview

The Quest harness currently creates three separate SQLite database files (`features.db`, `events.db`, `traces.db`) each with their own `Database` connection, pragma setup, and lifecycle. This plan consolidates them into a single `.quest/store/quest.db` file, sharing one `better-sqlite3` connection.

## Current Layout

```
.quest/store/features.db   — features, attempts, metadata (src/feature-db.ts)
.quest/store/events.db     — structured events, progress (src/event-db.ts)
.quest/traces.db           — LLM sessions, trace events (src/trace-db.ts)
```

## Target Layout

```
.quest/store/quest.db      — all tables unified under one file
```

## Table Name Collision

Both `event-db.ts` and `trace-db.ts` define an `events` table with different schemas:

- **event-db.ts `events`**: `(id, ts, type, feature_id, worker_id, data, created_at)` — structured quest events
- **trace-db.ts `events`**: `(id, session_id, seq, ts, type, tool_name, file_path, ...)` — LLM trace events

**Decision**: Rename trace-db's `events` table to `trace_events`. Rationale:
1. The event-db `events` table is the more canonical events table
2. All trace-db SQL is internal to the class — no external consumers reference the raw table name
3. Rename `EventRow` export from trace-db to `TraceEventRow` for clarity

## Implementation Steps

### Phase 1: Create Shared Database Factory

**New file: `src/quest-db.ts`**

- Export `createQuestDB(projectDir: string): Database.Database`
- Creates `Database` at `.quest/store/quest.db`
- Sets pragmas: `journal_mode = WAL`, `busy_timeout = 5000`, `synchronous = NORMAL`, `foreign_keys = ON`
- Includes migration logic for legacy DB files via `ATTACH DATABASE`

### Phase 2: Modify Each DB Class Constructor

**Pattern for all three classes:**

```typescript
constructor(projectDir: string, db?: Database.Database) {
  if (db) {
    this.db = db
    this.ownsConnection = false
  } else {
    this.db = createQuestDB(projectDir)  // standalone: creates quest.db
    this.ownsConnection = true
  }
  this.db.exec(SCHEMA)  // always run (idempotent CREATE IF NOT EXISTS)
}

close(): void {
  if (this.ownsConnection) this.db.close()
}
```

**`src/feature-db.ts`**
- Change constructor: `constructor(projectDir: string, db?: Database.Database)`
- Add `ownsConnection` flag, guard `close()`
- DB path changes from `features.db` to `quest.db` (via createQuestDB)

**`src/event-db.ts`**
- Same pattern as FeatureDB
- DB path changes from `events.db` to `quest.db`

**`src/trace-db.ts`** (most changes)
- Same constructor pattern
- Rename table: `events` → `trace_events` in SCHEMA and all SQL strings
- Rename export: `EventRow` → `TraceEventRow`
- Add migration: `ALTER TABLE events RENAME TO trace_events` (try/catch for idempotency)
- DB path changes from `.quest/traces.db` to `.quest/store/quest.db`

SQL references in trace-db.ts to update (9 locations):
- `CREATE TABLE IF NOT EXISTS events` → `trace_events`
- 4 `CREATE INDEX ... ON events(...)` → `ON trace_events(...)`
- `INSERT INTO events` → `INSERT INTO trace_events`
- `SELECT * FROM events WHERE session_id = ?` → `FROM trace_events`
- `FROM events e JOIN sessions s` → `FROM trace_events e`
- `FROM events WHERE tool_name IS NOT NULL` → `FROM trace_events`
- `SELECT COUNT(*) as c FROM events` → `FROM trace_events`

### Phase 3: Update QuestStore

**`src/store.ts`**
- Import `createQuestDB`
- Add private `_db: Database.Database | null` with lazy getter
- Pass `this.db` to `new FeatureDB(this.mainDir, this.db)` and `new EventDB(this.mainDir, this.db)`
- Expose `get db()` so orchestrator can pass it to TraceDB

### Phase 4: Update Orchestrator

**`src/orchestrator.ts`**
- Pass shared connection: `new TraceDB(opts.projectDir, this.store.db)`
- Ensure store is initialized before tracer (may need to swap init order)

### Phase 5: Update Dashboard Server

**`src/dashboard/server.ts`**
- Create one shared connection: `const sharedDb = createQuestDB(projectDir)`
- Pass to all three: `new FeatureDB(projectDir, sharedDb)`, `new EventDB(projectDir, sharedDb)`, `new TraceDB(projectDir, sharedDb)`
- Simplify SIGINT/SIGTERM: only close `sharedDb` once

### Phase 6: Standalone Call Sites (No Changes Needed)

These construct standalone instances that will auto-use `quest.db` via the updated constructors:
- `src/detect.ts` — short-lived, read-only
- `src/events.ts` — module-level singleton
- `src/cli.ts` — various CLI commands (add, replan, traces, inspect)
- `src/replace-features.ts` — one-time migration script

### Phase 7: Data Migration

In `createQuestDB()`, after creating the connection:

1. Check if `quest.db` tables are empty AND legacy files exist
2. Use `ATTACH DATABASE` to copy tables from each legacy file:
   - `features.db` → copy `features`, `feature_meta`, `attempts` as-is
   - `events.db` → copy `events`, `progress` as-is
   - `traces.db` → copy `sessions` as-is, copy `events` as `trace_events`
3. Rename legacy files to `*.db.migrated` (don't delete, for safety)

Migration is idempotent — checks for existing data before copying.

### Phase 8: Update .gitignore

Add `.quest/store/quest.db*` entries.

## Files Changed Summary

| File | Change | Complexity |
|------|--------|------------|
| `src/quest-db.ts` | **New** — shared connection factory + migration | Low |
| `src/feature-db.ts` | Constructor accepts optional `db`, `ownsConnection` guard | Low |
| `src/event-db.ts` | Constructor accepts optional `db`, `ownsConnection` guard | Low |
| `src/trace-db.ts` | Constructor + rename `events` → `trace_events` + `TraceEventRow` | Medium |
| `src/store.ts` | Create shared connection, pass to FeatureDB/EventDB | Low |
| `src/orchestrator.ts` | Pass shared connection to TraceDB | Low |
| `src/dashboard/server.ts` | Shared connection for all three | Low |
| `src/detect.ts` | No changes needed | None |
| `src/events.ts` | No changes needed | None |
| `src/cli.ts` | No changes needed | None |
| `.gitignore` | Add quest.db entries | Low |

## Risks and Mitigations

- **Single-writer bottleneck**: WAL mode already serializes writes at DB level; one connection avoids WAL checkpoint contention between multiple connections. Net improvement.
- **Data loss during migration**: Legacy files renamed to `*.db.migrated`, not deleted. Migration is idempotent.
- **Table rename breaks external code**: Grep confirmed `EventRow` from trace-db has zero external imports. All SQL is internal.
- **close() semantics**: `ownsConnection` boolean is simple and deterministic.

## Success Criteria

- [ ] Only one `.db` file created at `.quest/store/quest.db` for new projects
- [ ] Existing projects have data migrated on first run
- [ ] All CLI commands continue to work
- [ ] Dashboard serves all data sources from one connection
- [ ] Orchestrator runs with shared connection without errors
- [ ] No table name collisions — `events` and `trace_events` coexist
- [ ] Each DB class still works standalone when constructed without a shared connection
- [ ] `npx tsc --noEmit` passes with zero errors
