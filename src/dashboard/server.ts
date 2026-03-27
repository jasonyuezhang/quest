/**
 * Dashboard server — Express API + static HTML for Trello-like feature board.
 *
 * API:
 *   GET  /api/features          — list all features
 *   GET  /api/features/:id      — get one feature
 *   PUT  /api/features/:id      — update a feature
 *   POST /api/features          — add a new feature
 *   DELETE /api/features/:id    — delete a feature
 *   PUT  /api/features/reorder  — reorder features
 *   GET  /api/stats             — feature stats
 *   GET  /                      — serve the dashboard HTML
 */

import express from 'express'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FeatureDB, rowToFeature } from '../feature-db.js'
import { TraceDB } from '../trace-db.js'
import { EventDB } from '../event-db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function startDashboard(projectDir: string, port: number): void {
  const db = new FeatureDB(projectDir)
  const imported = db.migrateFromJson(projectDir)
  if (imported > 0) {
    console.log(`Migrated ${imported} features from features.json to SQLite`)
  }

  const app = express()
  app.use(express.json())

  // ── Static HTML ───────────────────────────────────────────────────────

  app.get('/', (_req, res) => {
    // Try compiled dist/ first, fall back to src/ for dev mode
    const distPath = join(__dirname, 'app.html')
    const srcPath = join(__dirname, '..', '..', 'src', 'dashboard', 'app.html')
    const htmlPath = existsSync(distPath) ? distPath : srcPath
    const html = readFileSync(htmlPath, 'utf-8')
    res.type('html').send(html)
  })

  // ── API Routes ────────────────────────────────────────────────────────

  app.get('/api/stats', (_req, res) => {
    res.json(db.stats())
  })

  app.get('/api/features', (req, res) => {
    const filters: Record<string, unknown> = {}
    if (req.query.priority) filters.priority = req.query.priority
    if (req.query.category) filters.category = req.query.category
    if (req.query.passes !== undefined) filters.passes = req.query.passes === 'true'

    const rows = db.listFeatures(filters as Parameters<FeatureDB['listFeatures']>[0])
    // Return enriched data with status and worker_id for the dashboard
    res.json(rows.map(row => ({
      ...rowToFeature(row),
      status: row.status ?? (row.passes ? 'passed' : 'pending'),
      worker_id: row.worker_id,
    })))
  })

  app.get('/api/features/:id', (req, res) => {
    const row = db.getFeature(req.params.id)
    if (!row) return res.status(404).json({ error: 'Feature not found' })
    res.json(rowToFeature(row))
  })

  app.put('/api/features/reorder', (req, res) => {
    const { orderedIds } = req.body
    if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds must be an array' })
    db.reorderFeatures(orderedIds)
    res.json({ ok: true })
  })

  app.get('/api/features/:id/attempts', (req, res) => {
    res.json(db.getAttempts(req.params.id))
  })

  app.put('/api/features/:id', (req, res) => {
    const existing = db.getFeature(req.params.id)
    if (!existing) return res.status(404).json({ error: 'Feature not found' })
    db.updateFeature(req.params.id, req.body)
    const updated = db.getFeature(req.params.id)!
    res.json(rowToFeature(updated))
  })

  app.post('/api/features', (req, res) => {
    const { id, name, description, category, priority, acceptanceCriteria, dependsOn, browserTestUrl } = req.body
    if (!id || !name || !description) {
      return res.status(400).json({ error: 'id, name, description are required' })
    }
    if (db.getFeature(id)) {
      return res.status(409).json({ error: `Feature ${id} already exists` })
    }
    db.addFeature({
      id,
      name,
      description,
      category: category ?? 'general',
      priority: priority ?? 'medium',
      acceptanceCriteria: acceptanceCriteria ?? [],
      dependsOn,
      browserTestUrl,
    })
    const created = db.getFeature(id)!
    res.status(201).json(rowToFeature(created))
  })

  app.delete('/api/features/:id', (req, res) => {
    const deleted = db.deleteFeature(req.params.id)
    if (!deleted) return res.status(404).json({ error: 'Feature not found' })
    res.json({ ok: true })
  })

  // ── Events API ───────────────────────────────────────────────────────

  let evtDb: InstanceType<typeof EventDB> | null = null
  try { evtDb = new EventDB(projectDir) } catch { /* no events db yet */ }

  app.get('/api/events', (req, res) => {
    if (!evtDb) return res.json([])
    const afterId = parseInt(req.query.after as string, 10)
    if (!isNaN(afterId) && afterId > 0) {
      const { events, lastId } = evtDb.readAfter(afterId)
      return res.json({ events, lastId })
    }
    // Default: return all events
    const limit = parseInt(req.query.limit as string, 10)
    const events = evtDb.readAll()
    res.json(limit > 0 ? events.slice(-limit) : events)
  })

  app.get('/api/events/by-feature/:id', (req, res) => {
    if (!evtDb) return res.json([])
    res.json(evtDb.readByFeature(req.params.id))
  })

  app.get('/api/events/stats', (_req, res) => {
    if (!evtDb) return res.json({ total: 0, byType: [] })
    res.json({ total: evtDb.count(), byType: evtDb.countByType() })
  })

  app.get('/api/progress', (_req, res) => {
    if (!evtDb) return res.json(null)
    res.json(evtDb.readProgress())
  })

  // ── Trace/Log API ──────────────────────────────────────────────────────

  let traceDb: InstanceType<typeof TraceDB> | null = null
  try { traceDb = new TraceDB(projectDir) } catch { /* no traces yet */ }

  app.get('/api/traces/sessions', (_req, res) => {
    if (!traceDb) return res.json([])
    const filters: Record<string, unknown> = {}
    if (_req.query.agent) filters.agent = _req.query.agent
    if (_req.query.feature) filters.featureId = _req.query.feature
    res.json(traceDb.listSessions(filters as Parameters<TraceDB['listSessions']>[0]))
  })

  app.get('/api/traces/sessions/:id', (req, res) => {
    if (!traceDb) return res.status(404).json({ error: 'No trace database' })
    const session = traceDb.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: 'Session not found' })
    res.json(session)
  })

  app.get('/api/traces/sessions/:id/events', (req, res) => {
    if (!traceDb) return res.json([])
    res.json(traceDb.getSessionEvents(req.params.id))
  })

  app.get('/api/traces/cost-by-agent', (_req, res) => {
    if (!traceDb) return res.json([])
    res.json(traceDb.costByAgent())
  })

  app.get('/api/traces/cost-by-feature', (_req, res) => {
    if (!traceDb) return res.json([])
    res.json(traceDb.costByFeature())
  })

  app.get('/api/traces/top-tools', (_req, res) => {
    if (!traceDb) return res.json([])
    res.json(traceDb.topTools())
  })

  app.get('/api/traces/search', (req, res) => {
    if (!traceDb) return res.json([])
    const file = req.query.file as string | undefined
    if (file) return res.json(traceDb.queryByFile(file))
    res.json([])
  })

  app.get('/api/traces/stats', (_req, res) => {
    if (!traceDb) return res.json({ sessions: 0, events: 0, dbSizeBytes: 0 })
    res.json(traceDb.stats())
  })

  // ── Start ─────────────────────────────────────────────────────────────

  app.listen(port, () => {
    console.log(`\nQuest Dashboard: http://localhost:${port}\n`)
    console.log(`  Features:  http://localhost:${port}`)
    console.log(`  Traces:    http://localhost:${port}/#traces`)
    console.log()
  })

  // Cleanup on exit
  process.on('SIGINT', () => { db.close(); traceDb?.close(); evtDb?.close(); process.exit(0) })
  process.on('SIGTERM', () => { db.close(); traceDb?.close(); evtDb?.close(); process.exit(0) })
}
