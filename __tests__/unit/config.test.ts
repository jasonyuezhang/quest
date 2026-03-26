import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  readConfigFile,
  writeConfigFile,
  createDefaultConfig,
  mergeConfig,
  setConfigKey,
  getConfigPath,
  getQuestDir,
  CONFIG_DEFAULTS,
  SETTABLE_KEYS,
} from '../../src/config.js'
import { createBasicScaffold } from '../../src/scaffold.js'
import { makeTempDir, cleanTempDir } from '../helpers/tempDir.js'

describe('config.ts', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeTempDir()
  })

  afterEach(async () => {
    await cleanTempDir(dir)
  })

  describe('getConfigPath', () => {
    it('returns the correct path', () => {
      const p = getConfigPath('/some/project')
      expect(p).toBe('/some/project/.quest/config.json')
    })
  })

  describe('getQuestDir', () => {
    it('returns the correct .quest directory path', () => {
      const p = getQuestDir('/some/project')
      expect(p).toBe('/some/project/.quest')
    })
  })

  describe('readConfigFile', () => {
    it('returns empty object when config file does not exist', () => {
      const cfg = readConfigFile(dir)
      expect(cfg).toEqual({})
    })

    it('returns parsed config when file exists', async () => {
      await writeConfigFile(dir, { maxConcurrency: 8, retryLimit: 3 })
      const cfg = readConfigFile(dir)
      expect(cfg.maxConcurrency).toBe(8)
      expect(cfg.retryLimit).toBe(3)
    })

    it('returns empty object for invalid JSON', async () => {
      const questDir = getQuestDir(dir)
      await import('node:fs/promises').then(fs => fs.mkdir(questDir, { recursive: true }))
      await import('node:fs/promises').then(fs => fs.writeFile(getConfigPath(dir), 'not-json', 'utf-8'))
      const cfg = readConfigFile(dir)
      expect(cfg).toEqual({})
    })
  })

  describe('writeConfigFile', () => {
    it('creates .quest directory if it does not exist', async () => {
      await writeConfigFile(dir, { maxConcurrency: 4 })
      expect(existsSync(getQuestDir(dir))).toBe(true)
    })

    it('creates config.json with the provided values', async () => {
      await writeConfigFile(dir, { maxConcurrency: 6, tddMode: true })
      const content = JSON.parse(await readFile(getConfigPath(dir), 'utf-8'))
      expect(content.maxConcurrency).toBe(6)
      expect(content.tddMode).toBe(true)
    })
  })

  describe('createDefaultConfig', () => {
    it('creates .quest/config.json with sensible defaults', async () => {
      await createDefaultConfig(dir)
      expect(existsSync(getConfigPath(dir))).toBe(true)
    })

    it('config has all expected fields', async () => {
      await createDefaultConfig(dir)
      const cfg = readConfigFile(dir)
      expect(cfg.maxConcurrency).toBeDefined()
      expect(cfg.retryLimit).toBeDefined()
      expect(cfg.maxResets).toBeDefined()
      expect(cfg.maxContext).toBeDefined()
      expect(cfg.models).toBeDefined()
      expect(cfg.tddMode).toBeDefined()
      expect(cfg.reviewMode).toBeDefined()
    })

    it('default maxConcurrency matches CONFIG_DEFAULTS', async () => {
      await createDefaultConfig(dir)
      const cfg = readConfigFile(dir)
      expect(cfg.maxConcurrency).toBe(CONFIG_DEFAULTS.maxConcurrency)
    })

    it('default models contain all agent types', async () => {
      await createDefaultConfig(dir)
      const cfg = readConfigFile(dir)
      expect(cfg.models?.coder).toBeDefined()
      expect(cfg.models?.evaluator).toBeDefined()
      expect(cfg.models?.reviewer).toBeDefined()
      expect(cfg.models?.planner).toBeDefined()
    })
  })

  describe('mergeConfig', () => {
    it('returns defaults when no config file and no overrides', () => {
      const cfg = mergeConfig(dir)
      expect(cfg.maxConcurrency).toBe(CONFIG_DEFAULTS.maxConcurrency)
      expect(cfg.retryLimit).toBe(CONFIG_DEFAULTS.retryLimit)
      expect(cfg.maxResets).toBe(CONFIG_DEFAULTS.maxResets)
      expect(cfg.maxContext).toBe(CONFIG_DEFAULTS.maxContext)
      expect(cfg.tddMode).toBe(false)
      expect(cfg.reviewMode).toBe(false)
    })

    it('uses config file values over defaults', async () => {
      await writeConfigFile(dir, { maxConcurrency: 8, retryLimit: 5 })
      const cfg = mergeConfig(dir)
      expect(cfg.maxConcurrency).toBe(8)
      expect(cfg.retryLimit).toBe(5)
    })

    it('CLI overrides take precedence over config file', async () => {
      await writeConfigFile(dir, { maxConcurrency: 8 })
      const cfg = mergeConfig(dir, { maxConcurrency: 2 })
      expect(cfg.maxConcurrency).toBe(2)
    })

    it('CLI overrides take precedence over defaults', () => {
      const cfg = mergeConfig(dir, { retryLimit: 10 })
      expect(cfg.retryLimit).toBe(10)
    })

    it('merges models correctly (CLI > file > default)', async () => {
      await writeConfigFile(dir, { models: { coder: 'claude-opus-4-6' } })
      const cfg = mergeConfig(dir, { models: { evaluator: 'claude-haiku-4-5' } })
      expect(cfg.models?.coder).toBe('claude-opus-4-6') // from file
      expect(cfg.models?.evaluator).toBe('claude-haiku-4-5') // CLI override
      expect(cfg.models?.reviewer).toBe(CONFIG_DEFAULTS.models.reviewer) // default
    })

    it('supports all config keys from spec', async () => {
      await writeConfigFile(dir, {
        maxConcurrency: 2,
        retryLimit: 1,
        maxResets: 3,
        maxContext: 100_000,
        models: { coder: 'claude-haiku-4-5' },
        browserTestUrl: 'http://localhost:3000',
        webhookUrl: 'https://example.com/hook',
        tddMode: true,
        reviewMode: true,
      })
      const cfg = mergeConfig(dir)
      expect(cfg.maxConcurrency).toBe(2)
      expect(cfg.retryLimit).toBe(1)
      expect(cfg.maxResets).toBe(3)
      expect(cfg.maxContext).toBe(100_000)
      expect(cfg.models?.coder).toBe('claude-haiku-4-5')
      expect(cfg.browserTestUrl).toBe('http://localhost:3000')
      expect(cfg.webhookUrl).toBe('https://example.com/hook')
      expect(cfg.tddMode).toBe(true)
      expect(cfg.reviewMode).toBe(true)
    })
  })

  describe('setConfigKey', () => {
    it('creates .quest/config.json if it does not exist', async () => {
      await setConfigKey(dir, 'maxConcurrency', '6')
      expect(existsSync(getConfigPath(dir))).toBe(true)
    })

    it('sets a numeric key', async () => {
      await setConfigKey(dir, 'maxConcurrency', '8')
      const cfg = readConfigFile(dir)
      expect(cfg.maxConcurrency).toBe(8)
    })

    it('sets a boolean key to true', async () => {
      await setConfigKey(dir, 'tddMode', 'true')
      const cfg = readConfigFile(dir)
      expect(cfg.tddMode).toBe(true)
    })

    it('sets a boolean key to false', async () => {
      await writeConfigFile(dir, { tddMode: true })
      await setConfigKey(dir, 'tddMode', 'false')
      const cfg = readConfigFile(dir)
      expect(cfg.tddMode).toBe(false)
    })

    it('sets a nested model key (models.coder)', async () => {
      await setConfigKey(dir, 'models.coder', 'claude-opus-4-6')
      const cfg = readConfigFile(dir)
      expect(cfg.models?.coder).toBe('claude-opus-4-6')
    })

    it('preserves existing keys when setting a new one', async () => {
      await writeConfigFile(dir, { maxConcurrency: 4, retryLimit: 2 })
      await setConfigKey(dir, 'maxConcurrency', '8')
      const cfg = readConfigFile(dir)
      expect(cfg.maxConcurrency).toBe(8)
      expect(cfg.retryLimit).toBe(2)
    })

    it('throws for unknown key', async () => {
      await expect(setConfigKey(dir, 'unknownKey', 'value')).rejects.toThrow('Unknown config key')
    })

    it('throws for invalid numeric value', async () => {
      await expect(setConfigKey(dir, 'maxConcurrency', 'notanumber')).rejects.toThrow()
    })

    it('throws for invalid boolean value', async () => {
      await expect(setConfigKey(dir, 'tddMode', 'yes')).rejects.toThrow()
    })

    it('sets webhookUrl as string', async () => {
      await setConfigKey(dir, 'webhookUrl', 'https://example.com/hook')
      const cfg = readConfigFile(dir)
      expect(cfg.webhookUrl).toBe('https://example.com/hook')
    })

    it('sets browserTestUrl as string', async () => {
      await setConfigKey(dir, 'browserTestUrl', 'http://localhost:3000')
      const cfg = readConfigFile(dir)
      expect(cfg.browserTestUrl).toBe('http://localhost:3000')
    })
  })

  describe('SETTABLE_KEYS', () => {
    it('includes all expected keys', () => {
      expect(SETTABLE_KEYS).toContain('maxConcurrency')
      expect(SETTABLE_KEYS).toContain('retryLimit')
      expect(SETTABLE_KEYS).toContain('maxResets')
      expect(SETTABLE_KEYS).toContain('maxContext')
      expect(SETTABLE_KEYS).toContain('models.coder')
      expect(SETTABLE_KEYS).toContain('models.evaluator')
      expect(SETTABLE_KEYS).toContain('models.reviewer')
      expect(SETTABLE_KEYS).toContain('models.planner')
      expect(SETTABLE_KEYS).toContain('browserTestUrl')
      expect(SETTABLE_KEYS).toContain('webhookUrl')
      expect(SETTABLE_KEYS).toContain('tddMode')
      expect(SETTABLE_KEYS).toContain('reviewMode')
    })
  })

  describe('createBasicScaffold integration', () => {
    it('creates .quest/config.json during init', async () => {
      await createBasicScaffold(dir, 'test-project')
      expect(existsSync(getConfigPath(dir))).toBe(true)
    })

    it('config.json has sensible defaults after init', async () => {
      await createBasicScaffold(dir, 'test-project')
      const cfg = readConfigFile(dir)
      expect(cfg.maxConcurrency).toBe(CONFIG_DEFAULTS.maxConcurrency)
      expect(cfg.retryLimit).toBe(CONFIG_DEFAULTS.retryLimit)
      expect(cfg.maxResets).toBe(CONFIG_DEFAULTS.maxResets)
      expect(cfg.maxContext).toBe(CONFIG_DEFAULTS.maxContext)
    })

    it('adds .quest/ to .gitignore during init', async () => {
      await createBasicScaffold(dir, 'test-project')
      const gitignorePath = join(dir, '.gitignore')
      expect(existsSync(gitignorePath)).toBe(true)
      const content = await readFile(gitignorePath, 'utf-8')
      expect(content).toContain('.quest/')
    })

    it('does not duplicate .quest/ in existing .gitignore', async () => {
      // Pre-create a .gitignore with .quest/ already in it
      const gitignorePath = join(dir, '.gitignore')
      await import('node:fs/promises').then(fs => fs.writeFile(gitignorePath, '.quest/\n', 'utf-8'))
      await createBasicScaffold(dir, 'test-project')
      const content = await readFile(gitignorePath, 'utf-8')
      const matches = content.split('\n').filter(l => l.trim() === '.quest/')
      expect(matches.length).toBe(1)
    })

    it('appends .quest/ to existing .gitignore that does not have it', async () => {
      const gitignorePath = join(dir, '.gitignore')
      await import('node:fs/promises').then(fs => fs.writeFile(gitignorePath, 'node_modules/\n', 'utf-8'))
      await createBasicScaffold(dir, 'test-project')
      const content = await readFile(gitignorePath, 'utf-8')
      expect(content).toContain('node_modules/')
      expect(content).toContain('.quest/')
    })
  })
})
