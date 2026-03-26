import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createBasicScaffold } from '../../src/scaffold.js'
import { readFeaturesFile } from '../../src/state/features.js'
import { readProgress } from '../../src/state/progress.js'
import { makeTempDir, cleanTempDir } from '../helpers/tempDir.js'

describe('scaffold.ts', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeTempDir()
  })

  afterEach(async () => {
    await cleanTempDir(dir)
  })

  describe('createBasicScaffold', () => {
    it('creates init.sh', async () => {
      await createBasicScaffold(dir, 'my-project')
      expect(existsSync(join(dir, 'init.sh'))).toBe(true)
    })

    it('creates features.json', async () => {
      await createBasicScaffold(dir, 'my-project')
      expect(existsSync(join(dir, 'features.json'))).toBe(true)
    })

    it('creates claude-progress.txt', async () => {
      await createBasicScaffold(dir, 'my-project')
      expect(existsSync(join(dir, 'claude-progress.txt'))).toBe(true)
    })

    it('init.sh is a bash script', async () => {
      await createBasicScaffold(dir, 'my-project')
      const content = await readFile(join(dir, 'init.sh'), 'utf-8')
      expect(content).toContain('#!/bin/bash')
    })

    it('init.sh contains npm install command', async () => {
      await createBasicScaffold(dir, 'my-project')
      const content = await readFile(join(dir, 'init.sh'), 'utf-8')
      expect(content).toContain('npm install')
    })

    it('features.json has valid structure', async () => {
      await createBasicScaffold(dir, 'my-project')
      const data = await readFeaturesFile(dir)
      expect(data.projectName).toBe('my-project')
      expect(Array.isArray(data.features)).toBe(true)
      expect(data.features.length).toBeGreaterThan(0)
    })

    it('features have required fields', async () => {
      await createBasicScaffold(dir, 'my-project')
      const data = await readFeaturesFile(dir)
      for (const feature of data.features) {
        expect(feature.id).toBeDefined()
        expect(feature.name).toBeDefined()
        expect(feature.description).toBeDefined()
        expect(feature.category).toBeDefined()
        expect(feature.priority).toMatch(/^(high|medium|low)$/)
        expect(Array.isArray(feature.acceptanceCriteria)).toBe(true)
        expect(feature.passes).toBe(false)
      }
    })

    it('features have no passes:true', async () => {
      await createBasicScaffold(dir, 'my-project')
      const data = await readFeaturesFile(dir)
      for (const feature of data.features) {
        expect(feature.passes).toBe(false)
      }
    })

    it('claude-progress.txt has valid progress state', async () => {
      await createBasicScaffold(dir, 'my-project')
      const progress = await readProgress(dir)
      expect(progress.projectName).toBe('my-project')
      expect(progress.passedFeatures).toBe(0)
      expect(progress.contextResets).toBe(0)
    })

    it('progress totalFeatures matches number of features', async () => {
      await createBasicScaffold(dir, 'my-project')
      const data = await readFeaturesFile(dir)
      const progress = await readProgress(dir)
      expect(progress.totalFeatures).toBe(data.features.length)
    })

    it('generates at least 10 placeholder features', async () => {
      await createBasicScaffold(dir, 'test-proj')
      const data = await readFeaturesFile(dir)
      expect(data.features.length).toBeGreaterThanOrEqual(10)
    })

    it('all features have unique ids', async () => {
      await createBasicScaffold(dir, 'my-project')
      const data = await readFeaturesFile(dir)
      const ids = data.features.map(f => f.id)
      const unique = new Set(ids)
      expect(unique.size).toBe(ids.length)
    })

    it('all features have acceptance criteria', async () => {
      await createBasicScaffold(dir, 'my-project')
      const data = await readFeaturesFile(dir)
      for (const feature of data.features) {
        expect(feature.acceptanceCriteria.length).toBeGreaterThan(0)
      }
    })
  })
})
