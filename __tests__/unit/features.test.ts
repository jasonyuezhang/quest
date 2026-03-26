import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  readFeaturesFile,
  writeFeaturesFile,
  getNextFeature,
  markFeaturePassing,
  countPassing,
} from '../../src/state/features.js'
import type { Feature, FeaturesFile } from '../../src/agents/types.js'
import { makeTempDir, cleanTempDir, makeFeature } from '../helpers/tempDir.js'

describe('state/features.ts', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeTempDir()
  })

  afterEach(async () => {
    await cleanTempDir(dir)
  })

  const makeFile = (features: Feature[]): FeaturesFile => ({
    version: '1.0',
    projectName: 'test',
    generatedAt: new Date().toISOString(),
    features,
  })

  describe('readFeaturesFile / writeFeaturesFile', () => {
    it('writes and reads features.json correctly', async () => {
      const data = makeFile([makeFeature({ id: 'feat-1' })])
      await writeFeaturesFile(dir, data)
      const result = await readFeaturesFile(dir)
      expect(result.features).toHaveLength(1)
      expect(result.features[0].id).toBe('feat-1')
      expect(result.projectName).toBe('test')
    })

    it('persists all feature fields', async () => {
      const feature = makeFeature({
        id: 'my-feature',
        name: 'My Feature',
        description: 'A feature',
        category: 'auth',
        priority: 'medium',
        acceptanceCriteria: ['A', 'B'],
        passes: true,
        implementedAt: '2025-01-01T00:00:00.000Z',
        sessionId: 'session-abc',
      })
      await writeFeaturesFile(dir, makeFile([feature]))
      const result = await readFeaturesFile(dir)
      expect(result.features[0]).toMatchObject(feature)
    })

    it('throws when features.json does not exist', async () => {
      await expect(readFeaturesFile(dir)).rejects.toThrow()
    })

    it('writes JSON with trailing newline', async () => {
      await writeFeaturesFile(dir, makeFile([]))
      const { readFile } = await import('node:fs/promises')
      const raw = await readFile(join(dir, 'features.json'), 'utf-8')
      expect(raw.endsWith('\n')).toBe(true)
    })
  })

  describe('getNextFeature', () => {
    it('returns null for empty list', () => {
      expect(getNextFeature([])).toBeNull()
    })

    it('returns null when all features pass', () => {
      const features = [
        makeFeature({ id: 'a', passes: true }),
        makeFeature({ id: 'b', passes: true }),
      ]
      expect(getNextFeature(features)).toBeNull()
    })

    it('returns the only pending feature', () => {
      const features = [makeFeature({ id: 'only', passes: false })]
      const result = getNextFeature(features)
      expect(result?.id).toBe('only')
    })

    it('skips passing features and returns a pending one', () => {
      const features = [
        makeFeature({ id: 'done', passes: true }),
        makeFeature({ id: 'pending', passes: false }),
      ]
      const result = getNextFeature(features)
      expect(result?.id).toBe('pending')
    })

    it('sorts by priority: high before medium', () => {
      const features = [
        makeFeature({ id: 'medium-one', priority: 'medium', passes: false }),
        makeFeature({ id: 'high-one', priority: 'high', passes: false }),
      ]
      expect(getNextFeature(features)?.id).toBe('high-one')
    })

    it('sorts by priority: medium before low', () => {
      const features = [
        makeFeature({ id: 'low-one', priority: 'low', passes: false }),
        makeFeature({ id: 'medium-one', priority: 'medium', passes: false }),
      ]
      expect(getNextFeature(features)?.id).toBe('medium-one')
    })

    it('sorts by priority: high > medium > low', () => {
      const features = [
        makeFeature({ id: 'low', priority: 'low', passes: false }),
        makeFeature({ id: 'high', priority: 'high', passes: false }),
        makeFeature({ id: 'medium', priority: 'medium', passes: false }),
      ]
      expect(getNextFeature(features)?.id).toBe('high')
    })

    it('returns first feature among equal priorities', () => {
      const features = [
        makeFeature({ id: 'first', priority: 'medium', passes: false }),
        makeFeature({ id: 'second', priority: 'medium', passes: false }),
      ]
      expect(getNextFeature(features)?.id).toBe('first')
    })
  })

  describe('markFeaturePassing', () => {
    it('sets passes:true for the feature', async () => {
      const feature = makeFeature({ id: 'to-pass', passes: false })
      await writeFeaturesFile(dir, makeFile([feature]))

      await markFeaturePassing(dir, 'to-pass', 'session-123')

      const result = await readFeaturesFile(dir)
      const updated = result.features.find(f => f.id === 'to-pass')
      expect(updated?.passes).toBe(true)
    })

    it('sets implementedAt timestamp', async () => {
      const before = new Date()
      await writeFeaturesFile(dir, makeFile([makeFeature({ id: 'feat' })]))
      await markFeaturePassing(dir, 'feat', 'session-x')
      const result = await readFeaturesFile(dir)
      const updated = result.features[0]
      expect(updated.implementedAt).toBeDefined()
      const implementedAt = new Date(updated.implementedAt!)
      expect(implementedAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
    })

    it('sets sessionId on the feature', async () => {
      await writeFeaturesFile(dir, makeFile([makeFeature({ id: 'feat' })]))
      await markFeaturePassing(dir, 'feat', 'session-xyz')
      const result = await readFeaturesFile(dir)
      expect(result.features[0].sessionId).toBe('session-xyz')
    })

    it('throws when feature id does not exist', async () => {
      await writeFeaturesFile(dir, makeFile([makeFeature({ id: 'real' })]))
      await expect(markFeaturePassing(dir, 'nonexistent', 'session')).rejects.toThrow(
        'Feature not found: nonexistent',
      )
    })

    it('does not affect other features', async () => {
      const features = [
        makeFeature({ id: 'a', passes: false }),
        makeFeature({ id: 'b', passes: false }),
      ]
      await writeFeaturesFile(dir, makeFile(features))
      await markFeaturePassing(dir, 'a', 'session')
      const result = await readFeaturesFile(dir)
      expect(result.features.find(f => f.id === 'b')?.passes).toBe(false)
    })
  })

  describe('countPassing', () => {
    it('returns 0 for empty list', () => {
      expect(countPassing([])).toBe(0)
    })

    it('returns 0 when none pass', () => {
      expect(countPassing([makeFeature({ passes: false })])).toBe(0)
    })

    it('returns count of passing features', () => {
      const features = [
        makeFeature({ id: 'a', passes: true }),
        makeFeature({ id: 'b', passes: false }),
        makeFeature({ id: 'c', passes: true }),
      ]
      expect(countPassing(features)).toBe(2)
    })

    it('returns total when all pass', () => {
      const features = [
        makeFeature({ id: 'a', passes: true }),
        makeFeature({ id: 'b', passes: true }),
      ]
      expect(countPassing(features)).toBe(2)
    })
  })
})
