import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  initEventLog,
  emit,
  readEvents,
  readNewEvents,
  setCurrentAgent,
  getCurrentAgent,
} from '../../src/events.js'
import { makeTempDir, cleanTempDir } from '../helpers/tempDir.js'

describe('events.ts', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeTempDir()
    // Initialize event log for each test to ensure clean state
    initEventLog(dir)
  })

  afterEach(async () => {
    await cleanTempDir(dir)
  })

  describe('initEventLog', () => {
    it('creates quest-events.jsonl in the project dir', () => {
      expect(existsSync(join(dir, 'quest-events.jsonl'))).toBe(true)
    })

    it('creates an empty file', () => {
      const content = readFileSync(join(dir, 'quest-events.jsonl'), 'utf-8')
      expect(content).toBe('')
    })

    it('overwrites any existing content', () => {
      writeFileSync(join(dir, 'quest-events.jsonl'), 'old data\n')
      initEventLog(dir)
      const content = readFileSync(join(dir, 'quest-events.jsonl'), 'utf-8')
      expect(content).toBe('')
    })
  })

  describe('emit', () => {
    it('appends a JSONL event to the log file', () => {
      emit({ type: 'run_complete', passing: 5, total: 10, durationMs: 1000 })
      const content = readFileSync(join(dir, 'quest-events.jsonl'), 'utf-8')
      expect(content.trim()).not.toBe('')
      const parsed = JSON.parse(content.trim())
      expect(parsed.type).toBe('run_complete')
      expect(parsed.passing).toBe(5)
    })

    it('adds a ts field to each event', () => {
      const before = new Date()
      emit({ type: 'run_complete', passing: 0, total: 0, durationMs: 0 })
      const content = readFileSync(join(dir, 'quest-events.jsonl'), 'utf-8')
      const parsed = JSON.parse(content.trim())
      expect(parsed.ts).toBeDefined()
      const ts = new Date(parsed.ts)
      expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime())
    })

    it('appends multiple events as separate JSONL lines', () => {
      emit({ type: 'run_complete', passing: 1, total: 3, durationMs: 100 })
      emit({ type: 'run_complete', passing: 2, total: 3, durationMs: 200 })
      const content = readFileSync(join(dir, 'quest-events.jsonl'), 'utf-8')
      const lines = content.trim().split('\n').filter(Boolean)
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]).passing).toBe(1)
      expect(JSON.parse(lines[1]).passing).toBe(2)
    })

    it('can emit run_start event', () => {
      emit({ type: 'run_start', projectName: 'my-project', total: 10, concurrency: 2 })
      const events = readEvents(dir)
      expect(events[0].type).toBe('run_start')
      const event = events[0] as { type: 'run_start'; projectName: string; total: number }
      expect(event.projectName).toBe('my-project')
      expect(event.total).toBe(10)
    })

    it('can emit feature_start event', () => {
      emit({
        type: 'feature_start',
        featureId: 'feat-1',
        featureName: 'Feature One',
        priority: 'high',
        index: 1,
        total: 5,
      })
      const events = readEvents(dir)
      expect(events[0].type).toBe('feature_start')
      const e = events[0] as { type: 'feature_start'; featureId: string }
      expect(e.featureId).toBe('feat-1')
    })

    it('can emit eval_verdict event', () => {
      emit({
        type: 'eval_verdict',
        featureId: 'feat-1',
        verdict: 'pass',
        criteriaResults: [{ criterion: 'A', result: 'pass', evidence: 'ok' }],
      })
      const events = readEvents(dir)
      const e = events[0] as { type: 'eval_verdict'; verdict: string }
      expect(e.verdict).toBe('pass')
    })

    it('can emit context_reset event', () => {
      emit({ type: 'context_reset', featureId: 'f1', resetCount: 2 })
      const events = readEvents(dir)
      const e = events[0] as { type: 'context_reset'; resetCount: number }
      expect(e.resetCount).toBe(2)
    })
  })

  describe('readEvents', () => {
    it('returns empty array when file does not exist', async () => {
      const { makeTempDir: mkTmp, cleanTempDir: cleanTmp } = await import('../helpers/tempDir.js')
      const emptyDir = await mkTmp()
      expect(readEvents(emptyDir)).toEqual([])
      await cleanTmp(emptyDir)
    })

    it('returns empty array for empty file', () => {
      expect(readEvents(dir)).toEqual([])
    })

    it('reads all emitted events', () => {
      emit({ type: 'run_start', projectName: 'p', total: 1 })
      emit({ type: 'run_complete', passing: 1, total: 1, durationMs: 100 })
      const events = readEvents(dir)
      expect(events).toHaveLength(2)
      expect(events[0].type).toBe('run_start')
      expect(events[1].type).toBe('run_complete')
    })

    it('preserves event data correctly', () => {
      emit({ type: 'feature_done', featureId: 'feat-x', verdict: 'pass', attempt: 1, durationMs: 500 })
      const events = readEvents(dir)
      const e = events[0] as { featureId: string; verdict: string; durationMs: number }
      expect(e.featureId).toBe('feat-x')
      expect(e.verdict).toBe('pass')
      expect(e.durationMs).toBe(500)
    })
  })

  describe('readNewEvents', () => {
    it('returns empty array and offset 0 when file does not exist', async () => {
      const { makeTempDir: mkTmp, cleanTempDir: cleanTmp } = await import('../helpers/tempDir.js')
      const emptyDir = await mkTmp()
      const result = readNewEvents(emptyDir, 0)
      expect(result.events).toEqual([])
      expect(result.newOffset).toBe(0)
      await cleanTmp(emptyDir)
    })

    it('returns all events when offset is 0', () => {
      emit({ type: 'run_complete', passing: 1, total: 1, durationMs: 0 })
      const result = readNewEvents(dir, 0)
      expect(result.events).toHaveLength(1)
      expect(result.newOffset).toBeGreaterThan(0)
    })

    it('returns only new events after a byte offset', () => {
      emit({ type: 'run_start', projectName: 'p', total: 5 })
      const first = readNewEvents(dir, 0)
      expect(first.events).toHaveLength(1)

      emit({ type: 'run_complete', passing: 5, total: 5, durationMs: 1000 })
      const second = readNewEvents(dir, first.newOffset)
      expect(second.events).toHaveLength(1)
      expect(second.events[0].type).toBe('run_complete')
    })

    it('returns empty events when offset is at end of file', () => {
      emit({ type: 'run_complete', passing: 0, total: 0, durationMs: 0 })
      const first = readNewEvents(dir, 0)
      const second = readNewEvents(dir, first.newOffset)
      expect(second.events).toEqual([])
      expect(second.newOffset).toBe(first.newOffset)
    })

    it('advances offset correctly across multiple reads', () => {
      emit({ type: 'run_start', projectName: 'p', total: 3 })
      emit({ type: 'run_complete', passing: 1, total: 3, durationMs: 0 })
      emit({ type: 'run_complete', passing: 2, total: 3, durationMs: 0 })

      const r1 = readNewEvents(dir, 0)
      expect(r1.events).toHaveLength(3)

      const r2 = readNewEvents(dir, r1.newOffset)
      expect(r2.events).toHaveLength(0)
    })
  })

  describe('setCurrentAgent / getCurrentAgent', () => {
    it('gets undefined when not set', () => {
      setCurrentAgent(undefined)
      expect(getCurrentAgent()).toBeUndefined()
    })

    it('sets and gets current agent', () => {
      setCurrentAgent('coder')
      expect(getCurrentAgent()).toBe('coder')
    })

    it('can update current agent', () => {
      setCurrentAgent('coder')
      setCurrentAgent('eval')
      expect(getCurrentAgent()).toBe('eval')
    })

    it('can clear current agent', () => {
      setCurrentAgent('init')
      setCurrentAgent(undefined)
      expect(getCurrentAgent()).toBeUndefined()
    })
  })
})
