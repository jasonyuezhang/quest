/**
 * Project Configuration File (.quest/config.json)
 *
 * Provides persistent project-level settings so users don't need to
 * repeat CLI flags on every run. CLI flags always take precedence.
 */

import { existsSync, readFileSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

/** Shape of .quest/config.json */
export interface QuestConfig {
  /** Maximum parallel workers */
  maxConcurrency?: number
  /** Max retries per failed feature */
  retryLimit?: number
  /** Max context resets per feature before giving up */
  maxResets?: number
  /** Maximum context window tokens for dynamic budgeting */
  maxContext?: number
  /** Per-agent model overrides */
  models?: {
    coder?: string
    evaluator?: string
    reviewer?: string
    planner?: string
  }
  /** URL used by browser-based tests (e.g. Playwright) */
  browserTestUrl?: string
  /** Webhook URL to notify on feature completion */
  webhookUrl?: string
  /** Enable TDD mode by default */
  tddMode?: boolean
  /** Enable review mode by default */
  reviewMode?: boolean
  /** Enable full (untruncated) LLM capture to disk */
  fullCapture?: boolean
}

/** Sensible defaults for all config keys */
export const CONFIG_DEFAULTS: Required<Omit<QuestConfig, 'models' | 'browserTestUrl' | 'webhookUrl'>> & {
  models: Required<NonNullable<QuestConfig['models']>>
  browserTestUrl: string | undefined
  webhookUrl: string | undefined
} = {
  maxConcurrency: 4,
  retryLimit: 2,
  maxResets: 5,
  maxContext: 200_000,
  models: {
    coder: 'claude-sonnet-4-6',
    evaluator: 'claude-sonnet-4-6',
    reviewer: 'claude-sonnet-4-6',
    planner: 'claude-sonnet-4-6',
  },
  browserTestUrl: undefined,
  webhookUrl: undefined,
  tddMode: false,
  reviewMode: false,
  fullCapture: false,
}

/** Path to the config file for a given project directory */
export function getConfigPath(projectDir: string): string {
  return join(projectDir, '.quest', 'config.json')
}

/** Path to the .quest directory for a given project directory */
export function getQuestDir(projectDir: string): string {
  return join(projectDir, '.quest')
}

/** Read the raw config from disk, returning empty object if missing/invalid */
export function readConfigFile(projectDir: string): QuestConfig {
  const configPath = getConfigPath(projectDir)
  if (!existsSync(configPath)) return {}
  try {
    const raw = readFileSync(configPath, 'utf-8')
    return JSON.parse(raw) as QuestConfig
  } catch {
    return {}
  }
}

/** Write a config object to disk, creating .quest/ if needed */
export async function writeConfigFile(projectDir: string, config: QuestConfig): Promise<void> {
  const questDir = getQuestDir(projectDir)
  if (!existsSync(questDir)) {
    await mkdir(questDir, { recursive: true })
  }
  const configPath = getConfigPath(projectDir)
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

/** Create the initial .quest/config.json with sensible defaults */
export async function createDefaultConfig(projectDir: string): Promise<void> {
  const defaults: QuestConfig = {
    maxConcurrency: CONFIG_DEFAULTS.maxConcurrency,
    retryLimit: CONFIG_DEFAULTS.retryLimit,
    maxResets: CONFIG_DEFAULTS.maxResets,
    maxContext: CONFIG_DEFAULTS.maxContext,
    models: {
      coder: CONFIG_DEFAULTS.models.coder,
      evaluator: CONFIG_DEFAULTS.models.evaluator,
      reviewer: CONFIG_DEFAULTS.models.reviewer,
      planner: CONFIG_DEFAULTS.models.planner,
    },
    tddMode: CONFIG_DEFAULTS.tddMode,
    reviewMode: CONFIG_DEFAULTS.reviewMode,
  }
  await writeConfigFile(projectDir, defaults)
}

/**
 * Merge config from three sources (lowest to highest precedence):
 *   1. Hardcoded defaults (CONFIG_DEFAULTS)
 *   2. .quest/config.json file values
 *   3. CLI flag overrides (only keys that are not undefined)
 */
export function mergeConfig(
  projectDir: string,
  cliOverrides: Partial<QuestConfig> = {},
): QuestConfig {
  const fileConfig = readConfigFile(projectDir)

  // Merge models separately since it's nested
  const mergedModels = {
    ...CONFIG_DEFAULTS.models,
    ...(fileConfig.models ?? {}),
    ...(cliOverrides.models ?? {}),
  }

  return {
    maxConcurrency: cliOverrides.maxConcurrency ?? fileConfig.maxConcurrency ?? CONFIG_DEFAULTS.maxConcurrency,
    retryLimit: cliOverrides.retryLimit ?? fileConfig.retryLimit ?? CONFIG_DEFAULTS.retryLimit,
    maxResets: cliOverrides.maxResets ?? fileConfig.maxResets ?? CONFIG_DEFAULTS.maxResets,
    maxContext: cliOverrides.maxContext ?? fileConfig.maxContext ?? CONFIG_DEFAULTS.maxContext,
    models: mergedModels,
    browserTestUrl: cliOverrides.browserTestUrl ?? fileConfig.browserTestUrl ?? CONFIG_DEFAULTS.browserTestUrl,
    webhookUrl: cliOverrides.webhookUrl ?? fileConfig.webhookUrl ?? CONFIG_DEFAULTS.webhookUrl,
    tddMode: cliOverrides.tddMode ?? fileConfig.tddMode ?? CONFIG_DEFAULTS.tddMode,
    reviewMode: cliOverrides.reviewMode ?? fileConfig.reviewMode ?? CONFIG_DEFAULTS.reviewMode,
    fullCapture: cliOverrides.fullCapture ?? fileConfig.fullCapture ?? CONFIG_DEFAULTS.fullCapture,
  }
}

/** Valid top-level and nested dotpath keys that can be set via `quest config set` */
export const SETTABLE_KEYS = [
  'maxConcurrency',
  'retryLimit',
  'maxResets',
  'maxContext',
  'models.coder',
  'models.evaluator',
  'models.reviewer',
  'models.planner',
  'browserTestUrl',
  'webhookUrl',
  'tddMode',
  'reviewMode',
  'fullCapture',
] as const

export type SettableKey = typeof SETTABLE_KEYS[number]

/** Parse a string value into the appropriate type based on the key */
function parseValue(key: SettableKey, value: string): unknown {
  // Numeric fields
  if (['maxConcurrency', 'retryLimit', 'maxResets', 'maxContext'].includes(key)) {
    const n = parseInt(value, 10)
    if (isNaN(n)) throw new Error(`Value for ${key} must be a number, got: ${value}`)
    return n
  }
  // Boolean fields
  if (['tddMode', 'reviewMode', 'fullCapture'].includes(key)) {
    if (value === 'true') return true
    if (value === 'false') return false
    throw new Error(`Value for ${key} must be true or false, got: ${value}`)
  }
  // String fields (models.*, browserTestUrl, webhookUrl)
  return value
}

/**
 * Set a single config key (supports dotpath like "models.coder").
 * Reads existing config, sets the key, and writes it back.
 */
export async function setConfigKey(projectDir: string, key: string, value: string): Promise<void> {
  if (!SETTABLE_KEYS.includes(key as SettableKey)) {
    throw new Error(`Unknown config key: ${key}\nValid keys: ${SETTABLE_KEYS.join(', ')}`)
  }

  const typedKey = key as SettableKey
  const parsed = parseValue(typedKey, value)
  const config = readConfigFile(projectDir)

  if (typedKey.startsWith('models.')) {
    const modelKey = typedKey.slice('models.'.length) as keyof NonNullable<QuestConfig['models']>
    config.models = config.models ?? {}
    config.models[modelKey] = parsed as string
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (config as any)[typedKey] = parsed
  }

  await writeConfigFile(projectDir, config)
}
