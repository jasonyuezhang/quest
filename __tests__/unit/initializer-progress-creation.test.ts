/**
 * Tests for the initializer agent's claude-progress.txt creation.
 *
 * Acceptance criteria:
 * - claude-progress.txt is created with totalFeatures matching the generated feature count
 * - passedFeatures is set to 0
 * - currentFeatureId is null
 * - lastCommitSha is null
 * - contextResets is 0
 * - lastUpdated is a valid ISO timestamp
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createInitialProgress, writeProgress, readProgress } from '../../src/state/progress.js'
import { readFeaturesFile } from '../../src/state/features.js'
import { createBasicScaffold } from '../../src/scaffold.js'
import { makeTempDir, cleanTempDir } from '../helpers/tempDir.js'

describe('initializer-agent-progress-creation', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeTempDir()
  })

  afterEach(async () => {
    await cleanTempDir(dir)
  })

  describe('initializer system prompt includes progress creation instructions', () => {
    it('INITIALIZER_SYSTEM_PROMPT includes claude-progress.txt creation instructions', async () => {
      const { readFileSync } = await import('node:fs')
      const initializerSrc = readFileSync(
        new URL('../../src/agents/initializer.ts', import.meta.url),
        'utf-8',
      )
      expect(initializerSrc).toContain('claude-progress.txt')
    })

    it('INITIALIZER_SYSTEM_PROMPT specifies passedFeatures: 0', async () => {
      const { readFileSync } = await import('node:fs')
      const initializerSrc = readFileSync(
        new URL('../../src/agents/initializer.ts', import.meta.url),
        'utf-8',
      )
      expect(initializerSrc).toContain('passedFeatures')
      expect(initializerSrc).toContain('"passedFeatures": 0')
    })

    it('INITIALIZER_SYSTEM_PROMPT specifies currentFeatureId: null', async () => {
      const { readFileSync } = await import('node:fs')
      const initializerSrc = readFileSync(
        new URL('../../src/agents/initializer.ts', import.meta.url),
        'utf-8',
      )
      expect(initializerSrc).toContain('currentFeatureId')
      expect(initializerSrc).toContain('"currentFeatureId": null')
    })

    it('INITIALIZER_SYSTEM_PROMPT specifies lastCommitSha: null', async () => {
      const { readFileSync } = await import('node:fs')
      const initializerSrc = readFileSync(
        new URL('../../src/agents/initializer.ts', import.meta.url),
        'utf-8',
      )
      expect(initializerSrc).toContain('lastCommitSha')
      expect(initializerSrc).toContain('"lastCommitSha": null')
    })

    it('INITIALIZER_SYSTEM_PROMPT specifies contextResets: 0', async () => {
      const { readFileSync } = await import('node:fs')
      const initializerSrc = readFileSync(
        new URL('../../src/agents/initializer.ts', import.meta.url),
        'utf-8',
      )
      expect(initializerSrc).toContain('contextResets')
      expect(initializerSrc).toContain('"contextResets": 0')
    })

    it('INITIALIZER_SYSTEM_PROMPT specifies lastUpdated as ISO timestamp', async () => {
      const { readFileSync } = await import('node:fs')
      const initializerSrc = readFileSync(
        new URL('../../src/agents/initializer.ts', import.meta.url),
        'utf-8',
      )
      expect(initializerSrc).toContain('lastUpdated')
      expect(initializerSrc).toContain('ISO timestamp')
    })

    it('INITIALIZER_SYSTEM_PROMPT specifies totalFeatures field', async () => {
      const { readFileSync } = await import('node:fs')
      const initializerSrc = readFileSync(
        new URL('../../src/agents/initializer.ts', import.meta.url),
        'utf-8',
      )
      expect(initializerSrc).toContain('totalFeatures')
    })
  })

  describe('createInitialProgress produces correct initial values', () => {
    it('sets passedFeatures to 0', () => {
      const progress = createInitialProgress('test-project', 42)
      expect(progress.passedFeatures).toBe(0)
    })

    it('sets currentFeatureId to null', () => {
      const progress = createInitialProgress('test-project', 42)
      expect(progress.currentFeatureId).toBeNull()
    })

    it('sets lastCommitSha to null', () => {
      const progress = createInitialProgress('test-project', 42)
      expect(progress.lastCommitSha).toBeNull()
    })

    it('sets contextResets to 0', () => {
      const progress = createInitialProgress('test-project', 42)
      expect(progress.contextResets).toBe(0)
    })

    it('sets lastUpdated to a valid ISO timestamp', () => {
      const before = new Date()
      const progress = createInitialProgress('test-project', 42)
      const after = new Date()
      const ts = new Date(progress.lastUpdated)
      expect(isNaN(ts.getTime())).toBe(false)
      expect(ts.toISOString()).toBe(progress.lastUpdated)
      expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(ts.getTime()).toBeLessThanOrEqual(after.getTime())
    })

    it('sets totalFeatures to the provided count', () => {
      const progress = createInitialProgress('test-project', 99)
      expect(progress.totalFeatures).toBe(99)
    })
  })

  describe('createBasicScaffold writes claude-progress.txt with correct initial values', () => {
    it('claude-progress.txt has passedFeatures set to 0', async () => {
      await createBasicScaffold(dir, 'my-project')
      const progress = await readProgress(dir)
      expect(progress.passedFeatures).toBe(0)
    })

    it('claude-progress.txt has currentFeatureId set to null', async () => {
      await createBasicScaffold(dir, 'my-project')
      const progress = await readProgress(dir)
      expect(progress.currentFeatureId).toBeNull()
    })

    it('claude-progress.txt has lastCommitSha set to null', async () => {
      await createBasicScaffold(dir, 'my-project')
      const progress = await readProgress(dir)
      expect(progress.lastCommitSha).toBeNull()
    })

    it('claude-progress.txt has contextResets set to 0', async () => {
      await createBasicScaffold(dir, 'my-project')
      const progress = await readProgress(dir)
      expect(progress.contextResets).toBe(0)
    })

    it('claude-progress.txt has lastUpdated as a valid ISO timestamp', async () => {
      const before = new Date()
      await createBasicScaffold(dir, 'my-project')
      const after = new Date()
      const progress = await readProgress(dir)
      const ts = new Date(progress.lastUpdated)
      expect(isNaN(ts.getTime())).toBe(false)
      expect(ts.toISOString()).toBe(progress.lastUpdated)
      expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(ts.getTime()).toBeLessThanOrEqual(after.getTime())
    })

    it('claude-progress.txt has totalFeatures matching generated feature count', async () => {
      await createBasicScaffold(dir, 'my-project')
      const featuresFile = await readFeaturesFile(dir)
      const progress = await readProgress(dir)
      expect(progress.totalFeatures).toBe(featuresFile.features.length)
    })
  })
})
