import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import type { QuestPlugin } from '../../src/plugins.js'
import { PluginManager } from '../../src/plugins.js'
import { makeTempDir, cleanTempDir, makeFeature } from '../helpers/tempDir.js'

describe('PluginManager', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeTempDir()
  })

  afterEach(async () => {
    await cleanTempDir(dir)
  })

  // ── Directory scanning ────────────────────────────────────────────────────

  describe('load()', () => {
    it('does nothing if .quest/plugins/ does not exist', async () => {
      const mgr = new PluginManager(dir)
      await mgr.load()
      expect(mgr.getPlugins()).toHaveLength(0)
    })

    it('does nothing if .quest/plugins/ is empty', async () => {
      await mkdir(join(dir, '.quest', 'plugins'), { recursive: true })
      const mgr = new PluginManager(dir)
      await mgr.load()
      expect(mgr.getPlugins()).toHaveLength(0)
    })

    it('ignores non-.js/.ts files in .quest/plugins/', async () => {
      await mkdir(join(dir, '.quest', 'plugins'), { recursive: true })
      await writeFile(join(dir, '.quest', 'plugins', 'readme.md'), '# readme')
      await writeFile(join(dir, '.quest', 'plugins', 'data.json'), '{}')
      const mgr = new PluginManager(dir)
      await mgr.load()
      expect(mgr.getPlugins()).toHaveLength(0)
    })

    it('logs warning and skips plugin with no default export', async () => {
      await mkdir(join(dir, '.quest', 'plugins'), { recursive: true })
      // Write a valid JS file but with no default export
      await writeFile(
        join(dir, '.quest', 'plugins', 'bad-plugin.js'),
        `export const foo = 42\n`,
      )
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const mgr = new PluginManager(dir)
      await mgr.load()
      expect(mgr.getPlugins()).toHaveLength(0)
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('loads a valid .js plugin', async () => {
      await mkdir(join(dir, '.quest', 'plugins'), { recursive: true })
      await writeFile(
        join(dir, '.quest', 'plugins', 'my-plugin.js'),
        `export default { name: 'my-plugin', hooks: ['onRunStart'] }\n`,
      )
      const mgr = new PluginManager(dir)
      await mgr.load()
      expect(mgr.getPlugins()).toHaveLength(1)
      expect(mgr.getPlugins()[0].plugin.name).toBe('my-plugin')
      expect(mgr.getPlugins()[0].file).toBe('my-plugin.js')
    })

    it('sets hasPlugins correctly', async () => {
      const mgr = new PluginManager(dir)
      await mgr.load()
      expect(mgr.hasPlugins).toBe(false)

      await mkdir(join(dir, '.quest', 'plugins'), { recursive: true })
      await writeFile(
        join(dir, '.quest', 'plugins', 'p.js'),
        `export default { name: 'p', hooks: [] }\n`,
      )
      const mgr2 = new PluginManager(dir)
      await mgr2.load()
      expect(mgr2.hasPlugins).toBe(true)
    })
  })

  // ── Lifecycle hooks ───────────────────────────────────────────────────────

  describe('lifecycle hooks', () => {
    function makePlugin(overrides: Partial<QuestPlugin> = {}): QuestPlugin {
      return {
        name: 'test-plugin',
        hooks: [],
        ...overrides,
      }
    }

    it('onRunStart calls plugin.onRunStart', async () => {
      const called: unknown[] = []
      const plugin = makePlugin({
        hooks: ['onRunStart'],
        onRunStart: async (ctx) => { called.push(ctx) },
      })
      const mgr = new PluginManager(dir)
      ;(mgr as unknown as { plugins: unknown[] }).plugins = [{ plugin, file: 'test.js' }]
      await mgr.onRunStart({ projectDir: dir, totalFeatures: 5, concurrency: 2 })
      expect(called).toHaveLength(1)
      expect(called[0]).toMatchObject({ totalFeatures: 5, concurrency: 2 })
    })

    it('onFeatureStart calls plugin.onFeatureStart', async () => {
      const called: unknown[] = []
      const plugin = makePlugin({
        hooks: ['onFeatureStart'],
        onFeatureStart: async (ctx) => { called.push(ctx) },
      })
      const mgr = new PluginManager(dir)
      ;(mgr as unknown as { plugins: unknown[] }).plugins = [{ plugin, file: 'test.js' }]
      const feature = makeFeature()
      await mgr.onFeatureStart({ projectDir: dir, feature, index: 1, total: 3 })
      expect(called).toHaveLength(1)
    })

    it('onAgentDone calls plugin.onAgentDone', async () => {
      const called: unknown[] = []
      const plugin = makePlugin({
        hooks: ['onAgentDone'],
        onAgentDone: async (ctx) => { called.push(ctx) },
      })
      const mgr = new PluginManager(dir)
      ;(mgr as unknown as { plugins: unknown[] }).plugins = [{ plugin, file: 'test.js' }]
      await mgr.onAgentDone({ projectDir: dir, featureId: 'feat-1', agentType: 'coder', success: true, durationMs: 100 })
      expect(called).toHaveLength(1)
    })

    it('onEvalVerdict calls plugin.onEvalVerdict', async () => {
      const called: unknown[] = []
      const plugin = makePlugin({
        hooks: ['onEvalVerdict'],
        onEvalVerdict: async (ctx) => { called.push(ctx) },
      })
      const mgr = new PluginManager(dir)
      ;(mgr as unknown as { plugins: unknown[] }).plugins = [{ plugin, file: 'test.js' }]
      await mgr.onEvalVerdict({ projectDir: dir, featureId: 'feat-1', verdict: 'pass', criteriaResults: [] })
      expect(called).toHaveLength(1)
    })

    it('onFeatureDone calls plugin.onFeatureDone', async () => {
      const called: unknown[] = []
      const plugin = makePlugin({
        hooks: ['onFeatureDone'],
        onFeatureDone: async (ctx) => { called.push(ctx) },
      })
      const mgr = new PluginManager(dir)
      ;(mgr as unknown as { plugins: unknown[] }).plugins = [{ plugin, file: 'test.js' }]
      await mgr.onFeatureDone({ projectDir: dir, featureId: 'feat-1', featureName: 'Feature 1', verdict: 'pass', attempt: 1, durationMs: 500 })
      expect(called).toHaveLength(1)
    })

    it('onRunComplete calls plugin.onRunComplete', async () => {
      const called: unknown[] = []
      const plugin = makePlugin({
        hooks: ['onRunComplete'],
        onRunComplete: async (ctx) => { called.push(ctx) },
      })
      const mgr = new PluginManager(dir)
      ;(mgr as unknown as { plugins: unknown[] }).plugins = [{ plugin, file: 'test.js' }]
      await mgr.onRunComplete({ projectDir: dir, passing: 3, total: 5, durationMs: 10000 })
      expect(called).toHaveLength(1)
    })
  })

  // ── modifySprintContract ──────────────────────────────────────────────────

  describe('modifySprintContract()', () => {
    it('returns contract unchanged when no plugins have modifySprintContract', async () => {
      const mgr = new PluginManager(dir)
      const feature = makeFeature()
      const contract = {
        featureId: 'feat-1',
        featureName: 'Feature 1',
        description: 'desc',
        acceptanceCriteria: ['crit A'],
        startedAt: new Date().toISOString(),
      }
      const result = await mgr.modifySprintContract(contract, feature)
      expect(result).toEqual(contract)
    })

    it('allows plugin to add custom acceptance criteria', async () => {
      const plugin: QuestPlugin = {
        name: 'criteria-adder',
        hooks: ['modifySprintContract'],
        modifySprintContract: async (contract) => ({
          ...contract,
          acceptanceCriteria: [...contract.acceptanceCriteria, 'Custom criterion from plugin'],
        }),
      }
      const mgr = new PluginManager(dir)
      ;(mgr as unknown as { plugins: unknown[] }).plugins = [{ plugin, file: 'test.js' }]
      const feature = makeFeature()
      const contract = {
        featureId: 'feat-1',
        featureName: 'Feature 1',
        description: 'desc',
        acceptanceCriteria: ['Original criterion'],
        startedAt: new Date().toISOString(),
      }
      const result = await mgr.modifySprintContract(contract, feature)
      expect(result.acceptanceCriteria).toContain('Original criterion')
      expect(result.acceptanceCriteria).toContain('Custom criterion from plugin')
    })

    it('chains multiple plugin modifySprintContract calls', async () => {
      const plugin1: QuestPlugin = {
        name: 'p1',
        hooks: ['modifySprintContract'],
        modifySprintContract: async (c) => ({ ...c, acceptanceCriteria: [...c.acceptanceCriteria, 'from p1'] }),
      }
      const plugin2: QuestPlugin = {
        name: 'p2',
        hooks: ['modifySprintContract'],
        modifySprintContract: async (c) => ({ ...c, acceptanceCriteria: [...c.acceptanceCriteria, 'from p2'] }),
      }
      const mgr = new PluginManager(dir)
      ;(mgr as unknown as { plugins: unknown[] }).plugins = [
        { plugin: plugin1, file: 'p1.js' },
        { plugin: plugin2, file: 'p2.js' },
      ]
      const feature = makeFeature()
      const contract = {
        featureId: 'feat-1',
        featureName: 'Feature 1',
        description: 'desc',
        acceptanceCriteria: ['original'],
        startedAt: new Date().toISOString(),
      }
      const result = await mgr.modifySprintContract(contract, feature)
      expect(result.acceptanceCriteria).toEqual(['original', 'from p1', 'from p2'])
    })
  })

  // ── customAgentSteps ──────────────────────────────────────────────────────

  describe('getCustomAgentSteps()', () => {
    it('returns empty array when no plugins have customAgentSteps', () => {
      const mgr = new PluginManager(dir)
      expect(mgr.getCustomAgentSteps()).toEqual([])
    })

    it('returns steps from plugin customAgentSteps', () => {
      const step = { name: 'lint', run: async () => {} }
      const plugin: QuestPlugin = {
        name: 'linter',
        hooks: ['customAgentSteps'],
        customAgentSteps: () => [step],
      }
      const mgr = new PluginManager(dir)
      ;(mgr as unknown as { plugins: unknown[] }).plugins = [{ plugin, file: 'test.js' }]
      const steps = mgr.getCustomAgentSteps()
      expect(steps).toHaveLength(1)
      expect(steps[0].name).toBe('lint')
    })

    it('concatenates steps from multiple plugins', () => {
      const p1: QuestPlugin = {
        name: 'p1',
        hooks: ['customAgentSteps'],
        customAgentSteps: () => [{ name: 'step-a', run: async () => {} }],
      }
      const p2: QuestPlugin = {
        name: 'p2',
        hooks: ['customAgentSteps'],
        customAgentSteps: () => [{ name: 'step-b', run: async () => {} }, { name: 'step-c', run: async () => {} }],
      }
      const mgr = new PluginManager(dir)
      ;(mgr as unknown as { plugins: unknown[] }).plugins = [
        { plugin: p1, file: 'p1.js' },
        { plugin: p2, file: 'p2.js' },
      ]
      const steps = mgr.getCustomAgentSteps()
      expect(steps.map(s => s.name)).toEqual(['step-a', 'step-b', 'step-c'])
    })
  })

  // ── Error handling ────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('catches and logs plugin errors without throwing', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const plugin: QuestPlugin = {
        name: 'broken-plugin',
        hooks: ['onRunStart'],
        onRunStart: async () => { throw new Error('boom') },
      }
      const mgr = new PluginManager(dir)
      ;(mgr as unknown as { plugins: unknown[] }).plugins = [{ plugin, file: 'broken.js' }]

      // Should not throw
      await expect(mgr.onRunStart({ projectDir: dir, totalFeatures: 1, concurrency: 1 })).resolves.toBeUndefined()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('boom'))
      warnSpy.mockRestore()
    })

    it('continues to next plugin after one throws', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const called: string[] = []
      const brokenPlugin: QuestPlugin = {
        name: 'broken',
        hooks: ['onFeatureDone'],
        onFeatureDone: async () => { throw new Error('fail') },
      }
      const goodPlugin: QuestPlugin = {
        name: 'good',
        hooks: ['onFeatureDone'],
        onFeatureDone: async () => { called.push('good') },
      }
      const mgr = new PluginManager(dir)
      ;(mgr as unknown as { plugins: unknown[] }).plugins = [
        { plugin: brokenPlugin, file: 'broken.js' },
        { plugin: goodPlugin, file: 'good.js' },
      ]
      await mgr.onFeatureDone({ projectDir: dir, featureId: 'f', featureName: 'F', verdict: 'pass', attempt: 1, durationMs: 0 })
      expect(called).toContain('good')
      warnSpy.mockRestore()
    })

    it('catches modifySprintContract errors and returns last good contract', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const brokenPlugin: QuestPlugin = {
        name: 'broken',
        hooks: ['modifySprintContract'],
        modifySprintContract: async () => { throw new Error('contract error') },
      }
      const mgr = new PluginManager(dir)
      ;(mgr as unknown as { plugins: unknown[] }).plugins = [{ plugin: brokenPlugin, file: 'broken.js' }]
      const feature = makeFeature()
      const contract = {
        featureId: 'feat-1',
        featureName: 'Feature 1',
        description: 'desc',
        acceptanceCriteria: ['crit'],
        startedAt: new Date().toISOString(),
      }
      const result = await mgr.modifySprintContract(contract, feature)
      // Should return original contract unchanged
      expect(result).toEqual(contract)
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })
})
