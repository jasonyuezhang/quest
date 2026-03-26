import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import {
  readProgress,
  writeProgress,
  createInitialProgress,
} from '../../src/state/progress.js'
import { makeTempDir, cleanTempDir } from '../helpers/tempDir.js'

describe('state/progress.ts', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeTempDir()
  })

  afterEach(async () => {
    await cleanTempDir(dir)
  })

  describe('createInitialProgress', () => {
    it('creates a progress state with correct fields', () => {
      const progress = createInitialProgress('my-project', 42)
      expect(progress.projectName).toBe('my-project')
      expect(progress.totalFeatures).toBe(42)
      expect(progress.passedFeatures).toBe(0)
      expect(progress.currentFeatureId).toBeNull()
      expect(progress.lastCommitSha).toBeNull()
      expect(progress.lastSessionId).toBeNull()
      expect(progress.contextResets).toBe(0)
      expect(progress.lastUpdated).toBeDefined()
    })

    it('sets lastUpdated to a valid ISO timestamp', () => {
      const before = new Date()
      const progress = createInitialProgress('p', 1)
      const after = new Date()
      const ts = new Date(progress.lastUpdated)
      expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(ts.getTime()).toBeLessThanOrEqual(after.getTime())
    })
  })

  describe('writeProgress / readProgress', () => {
    it('round-trips progress state correctly', async () => {
      const progress = createInitialProgress('test-project', 10)
      await writeProgress(dir, progress)
      const result = await readProgress(dir)
      expect(result.projectName).toBe('test-project')
      expect(result.totalFeatures).toBe(10)
      expect(result.passedFeatures).toBe(0)
    })

    it('updates lastUpdated on write', async () => {
      const progress = createInitialProgress('p', 1)
      const before = new Date()
      await writeProgress(dir, progress)
      const after = new Date()
      const result = await readProgress(dir)
      const ts = new Date(result.lastUpdated)
      expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(ts.getTime()).toBeLessThanOrEqual(after.getTime())
    })

    it('persists non-default fields', async () => {
      const progress = createInitialProgress('p', 5)
      const modified = {
        ...progress,
        passedFeatures: 3,
        currentFeatureId: 'feat-x',
        lastCommitSha: 'abc123',
        lastSessionId: 'session-99',
        contextResets: 2,
      }
      await writeProgress(dir, modified)
      const result = await readProgress(dir)
      expect(result.passedFeatures).toBe(3)
      expect(result.currentFeatureId).toBe('feat-x')
      expect(result.lastCommitSha).toBe('abc123')
      expect(result.lastSessionId).toBe('session-99')
      expect(result.contextResets).toBe(2)
    })

    it('throws when claude-progress.txt does not exist', async () => {
      await expect(readProgress(dir)).rejects.toThrow()
    })

    it('writes JSON with trailing newline', async () => {
      const progress = createInitialProgress('p', 1)
      await writeProgress(dir, progress)
      const { readFile } = await import('node:fs/promises')
      const raw = await readFile(join(dir, 'claude-progress.txt'), 'utf-8')
      expect(raw.endsWith('\n')).toBe(true)
    })
  })
})
