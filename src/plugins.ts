/**
 * Plugin System for Quest
 *
 * Plugins are .ts or .js files in .quest/plugins/ that export a default object
 * implementing the QuestPlugin interface. They hook into orchestrator lifecycle
 * events for custom integrations.
 */

import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve, extname } from 'node:path'
import chalk from 'chalk'

import type { Feature, SprintContract } from './agents/types.js'

// ---------------------------------------------------------------------------
// Context types for each lifecycle hook
// ---------------------------------------------------------------------------

export interface RunStartContext {
  projectDir: string
  totalFeatures: number
  concurrency: number
}

export interface FeatureStartContext {
  projectDir: string
  feature: Feature
  index: number
  total: number
}

export interface AgentDoneContext {
  projectDir: string
  featureId: string
  agentType: 'coder' | 'evaluator' | 'reviewer' | string
  success: boolean
  durationMs: number
}

export interface EvalVerdictContext {
  projectDir: string
  featureId: string
  verdict: 'pass' | 'fail'
  criteriaResults: Array<{ criterion: string; result: 'pass' | 'fail'; evidence: string }>
}

export interface FeatureDoneContext {
  projectDir: string
  featureId: string
  featureName: string
  verdict: 'pass' | 'fail'
  attempt: number
  durationMs: number
  failureCategory?: string
}

export interface RunCompleteContext {
  projectDir: string
  passing: number
  total: number
  durationMs: number
  totalCostUsd?: number
}

/** A custom agent step that a plugin can inject between coder and evaluator */
export interface CustomAgentStep {
  /** Short label shown in agent banner */
  name: string
  /** Called after coder completes, before evaluator runs */
  run(projectDir: string, feature: Feature): Promise<void>
}

// ---------------------------------------------------------------------------
// Plugin interface
// ---------------------------------------------------------------------------

/**
 * The QuestPlugin interface. All methods are optional — implement only the
 * hooks you need.
 *
 * Export a default object implementing this interface from your plugin file:
 *   export default { name: 'my-plugin', hooks: ['onFeatureDone'], onFeatureDone: ... }
 */
export interface QuestPlugin {
  /** Human-readable plugin name shown in `quest plugin list` */
  name: string

  /** Optional description shown in `quest plugin list` */
  description?: string

  /** Lifecycle hooks this plugin implements (used by `quest plugin list`) */
  hooks: Array<
    | 'onRunStart'
    | 'onFeatureStart'
    | 'onAgentDone'
    | 'onEvalVerdict'
    | 'onFeatureDone'
    | 'onRunComplete'
    | 'modifySprintContract'
    | 'customAgentSteps'
  >

  // Lifecycle hooks

  /** Called once when the orchestration run starts */
  onRunStart?(ctx: RunStartContext): Promise<void>

  /** Called when a feature is about to be implemented */
  onFeatureStart?(ctx: FeatureStartContext): Promise<void>

  /** Called when any agent (coder, evaluator, reviewer) finishes */
  onAgentDone?(ctx: AgentDoneContext): Promise<void>

  /** Called after the evaluator writes its verdict */
  onEvalVerdict?(ctx: EvalVerdictContext): Promise<void>

  /** Called when a feature is fully done (pass or fail after all retries) */
  onFeatureDone?(ctx: FeatureDoneContext): Promise<void>

  /** Called when the entire run is complete */
  onRunComplete?(ctx: RunCompleteContext): Promise<void>

  /**
   * Called before the coder runs — can modify the sprint contract.
   * Return the (possibly modified) contract.
   */
  modifySprintContract?(contract: SprintContract, feature: Feature): Promise<SprintContract>

  /**
   * Return custom agent steps to inject between the coder and evaluator.
   * Steps run in order, after coder and before evaluator.
   */
  customAgentSteps?(): CustomAgentStep[]
}

// ---------------------------------------------------------------------------
// PluginManager
// ---------------------------------------------------------------------------

export class PluginManager {
  private plugins: Array<{ plugin: QuestPlugin; file: string }> = []
  private projectDir: string

  constructor(projectDir: string) {
    this.projectDir = projectDir
  }

  /**
   * Scan .quest/plugins/ for .ts and .js files and load each as a plugin.
   * Errors during load are caught and logged — they do not crash the orchestrator.
   */
  async load(): Promise<void> {
    const pluginsDir = join(this.projectDir, '.quest', 'plugins')
    if (!existsSync(pluginsDir)) {
      return
    }

    let files: string[]
    try {
      files = await readdir(pluginsDir)
    } catch {
      return
    }

    const pluginFiles = files.filter(f => extname(f) === '.ts' || extname(f) === '.js')

    for (const file of pluginFiles.sort()) {
      const filePath = resolve(join(pluginsDir, file))
      try {
        // Dynamic import works for both .js and .ts (when run via tsx)
        const mod = await import(filePath) as { default?: QuestPlugin }
        const plugin = mod.default
        if (!plugin || typeof plugin !== 'object') {
          console.warn(chalk.yellow(`⚠ Plugin ${file}: no default export, skipping`))
          continue
        }
        if (!plugin.name) {
          console.warn(chalk.yellow(`⚠ Plugin ${file}: missing required 'name' field, skipping`))
          continue
        }
        if (!Array.isArray(plugin.hooks)) {
          console.warn(chalk.yellow(`⚠ Plugin ${file}: missing required 'hooks' array, skipping`))
          continue
        }
        this.plugins.push({ plugin, file })
        console.log(chalk.gray(`  plugin loaded: ${plugin.name} (${file})`))
      } catch (err) {
        console.warn(chalk.yellow(`⚠ Plugin ${file}: failed to load — ${err instanceof Error ? err.message : err}`))
      }
    }
  }

  /** Get all loaded plugins with their file paths */
  getPlugins(): Array<{ plugin: QuestPlugin; file: string }> {
    return this.plugins
  }

  /** Whether any plugins are loaded */
  get hasPlugins(): boolean {
    return this.plugins.length > 0
  }

  // ---------------------------------------------------------------------------
  // Hook dispatchers — each catches errors per-plugin to avoid crashing
  // ---------------------------------------------------------------------------

  async onRunStart(ctx: RunStartContext): Promise<void> {
    for (const { plugin, file } of this.plugins) {
      if (plugin.onRunStart) {
        await this.safeCall(file, 'onRunStart', () => plugin.onRunStart!(ctx))
      }
    }
  }

  async onFeatureStart(ctx: FeatureStartContext): Promise<void> {
    for (const { plugin, file } of this.plugins) {
      if (plugin.onFeatureStart) {
        await this.safeCall(file, 'onFeatureStart', () => plugin.onFeatureStart!(ctx))
      }
    }
  }

  async onAgentDone(ctx: AgentDoneContext): Promise<void> {
    for (const { plugin, file } of this.plugins) {
      if (plugin.onAgentDone) {
        await this.safeCall(file, 'onAgentDone', () => plugin.onAgentDone!(ctx))
      }
    }
  }

  async onEvalVerdict(ctx: EvalVerdictContext): Promise<void> {
    for (const { plugin, file } of this.plugins) {
      if (plugin.onEvalVerdict) {
        await this.safeCall(file, 'onEvalVerdict', () => plugin.onEvalVerdict!(ctx))
      }
    }
  }

  async onFeatureDone(ctx: FeatureDoneContext): Promise<void> {
    for (const { plugin, file } of this.plugins) {
      if (plugin.onFeatureDone) {
        await this.safeCall(file, 'onFeatureDone', () => plugin.onFeatureDone!(ctx))
      }
    }
  }

  async onRunComplete(ctx: RunCompleteContext): Promise<void> {
    for (const { plugin, file } of this.plugins) {
      if (plugin.onRunComplete) {
        await this.safeCall(file, 'onRunComplete', () => plugin.onRunComplete!(ctx))
      }
    }
  }

  /**
   * Run all modifySprintContract hooks in sequence.
   * Each plugin receives the contract returned by the previous plugin.
   */
  async modifySprintContract(contract: SprintContract, feature: Feature): Promise<SprintContract> {
    let current = contract
    for (const { plugin, file } of this.plugins) {
      if (plugin.modifySprintContract) {
        try {
          current = await plugin.modifySprintContract(current, feature)
        } catch (err) {
          console.warn(chalk.yellow(`⚠ Plugin ${file} modifySprintContract error — ${err instanceof Error ? err.message : err}`))
        }
      }
    }
    return current
  }

  /**
   * Collect all custom agent steps from all plugins, in plugin load order.
   */
  getCustomAgentSteps(): CustomAgentStep[] {
    const steps: CustomAgentStep[] = []
    for (const { plugin } of this.plugins) {
      if (plugin.customAgentSteps) {
        try {
          steps.push(...plugin.customAgentSteps())
        } catch {
          // non-fatal
        }
      }
    }
    return steps
  }

  // ---------------------------------------------------------------------------
  // Safe call helper
  // ---------------------------------------------------------------------------

  private async safeCall(file: string, hook: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
    } catch (err) {
      console.warn(chalk.yellow(`⚠ Plugin ${file} ${hook} error — ${err instanceof Error ? err.message : err}`))
    }
  }
}
