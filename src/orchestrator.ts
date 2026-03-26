import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import chalk from 'chalk'

import type { Feature, OrchestratorOptions, ProgressState } from './agents/types.js'
import { runInitializerAgent } from './agents/initializer.js'
import { runCoderAgent, ContextResetNeededError } from './agents/coder.js'
import { runEvaluatorAgent } from './agents/evaluator.js'
import { ContextManager } from './context/manager.js'
import { readFeaturesFile, getNextFeature, countPassing } from './state/features.js'
import { readProgress, writeProgress, createInitialProgress } from './state/progress.js'
import {
  buildSprintContract,
  writeSprintContract,
  readEvalReport,
  cleanSprintArtifacts,
  writeSprintCompletion,
} from './sprint/contracts.js'
import { printAgentBanner } from './logger.js'

const execAsync = promisify(exec)

const MAX_CONTEXT_RESETS = 3

export class Orchestrator {
  private opts: Required<OrchestratorOptions>

  constructor(opts: OrchestratorOptions) {
    this.opts = {
      maxFeatures: Infinity,
      retryLimit: 2,
      dryRun: false,
      model: 'claude-sonnet-4-6',
      ...opts,
    }
  }

  /**
   * Run the initializer agent to set up the project scaffold.
   * Called once when init.sh does not exist.
   */
  async initialize(projectDescription: string, projectName: string): Promise<void> {
    const { projectDir, dryRun } = this.opts
    const initSh = join(projectDir, 'init.sh')

    if (existsSync(initSh)) {
      console.log(chalk.yellow('⚠ init.sh already exists, skipping initialization'))
      return
    }

    if (dryRun) {
      console.log(chalk.gray('[dry-run] Would run initializer agent'))
      return
    }

    printAgentBanner('init', 1, 1, projectName)

    const ctxMgr = new ContextManager()
    const result = await runInitializerAgent(projectDir, projectDescription, projectName, ctxMgr)

    if (!result.success) {
      throw new Error(`Initializer failed: ${result.error}`)
    }

    const stats = ctxMgr.getStats()
    console.log(
      chalk.green(
        `✓ Initialized in ${(result.durationMs / 1000).toFixed(1)}s` +
          chalk.gray(` | ${stats.totalInput}↑ ${stats.totalOutput}↓ tokens`),
      ),
    )
  }

  /**
   * Full orchestration loop: implements features until all pass or limits are reached.
   */
  async run(): Promise<void> {
    const { projectDir, maxFeatures, dryRun } = this.opts

    let implemented = 0
    let failed = 0

    while (implemented + failed < maxFeatures) {
      const featuresData = await readFeaturesFile(projectDir)
      const next = getNextFeature(featuresData.features)

      if (!next) {
        console.log(chalk.green('\n✅ All features implemented!'))
        break
      }

      const total = featuresData.features.length
      const passing = countPassing(featuresData.features)
      const pct = Math.round((passing / total) * 100)
      console.log(
        chalk.bold(`\n◆ Feature ${passing + 1}/${total} (${pct}% done) — ${chalk.white(next.id)}`) +
          chalk.gray(` [${next.priority}]`),
      )
      console.log(chalk.gray(`  ${next.description}`))

      if (dryRun) {
        console.log(chalk.gray(`  [dry-run] Would implement: ${next.id}`))
        implemented++
        continue
      }

      const verdict = await this.implementFeature(next)

      if (verdict === 'pass') {
        implemented++
        console.log(chalk.green(`\n✓ ${next.id} passed`))
      } else {
        failed++
        console.log(chalk.red(`\n✗ ${next.id} failed after ${this.opts.retryLimit + 1} attempts`))
        // Skip this feature and move on (retry logic is inside implementFeature)
        await this.markFeatureSkipped(next)
      }
    }

    const summary = await this.getStatus()
    console.log(
      chalk.bold(`\nSummary: ${summary.passing}/${summary.total} features passing`),
    )
  }

  /**
   * Resume from last known progress (reads claude-progress.txt).
   */
  async resume(): Promise<void> {
    const { projectDir } = this.opts
    let progress: ProgressState

    try {
      progress = await readProgress(projectDir)
    } catch {
      throw new Error('No claude-progress.txt found. Run quest init first.')
    }

    console.log(
      chalk.blue(
        `Resuming ${progress.projectName}: ${progress.passedFeatures}/${progress.totalFeatures} features passing`,
      ),
    )

    await this.run()
  }

  /**
   * Implement a single feature: write sprint contract, run coder, run evaluator.
   * Retries up to retryLimit times on evaluator failure.
   */
  async implementFeature(feature: Feature): Promise<'pass' | 'fail'> {
    const { projectDir, retryLimit } = this.opts

    // Clean up artifacts from any previous attempt
    await cleanSprintArtifacts(projectDir)

    // Write sprint contract BEFORE coder runs — criteria are locked
    const contract = buildSprintContract(feature)
    await writeSprintContract(projectDir, contract)

    // Update progress: mark this feature as in-progress
    try {
      const progress = await readProgress(projectDir)
      await writeProgress(projectDir, {
        ...progress,
        currentFeatureId: feature.id,
      })
    } catch {
      // progress file may not exist yet
    }

    for (let attempt = 0; attempt <= retryLimit; attempt++) {
      const attemptLabel = attempt > 0 ? ` retry ${attempt}/${retryLimit}` : ''

      if (attempt > 0) {
        console.log(chalk.yellow(`\n↻ Retry ${attempt}/${retryLimit} for ${feature.id}`))
        await cleanSprintArtifacts(projectDir)
        // Re-write contract for fresh attempt
        await writeSprintContract(projectDir, { ...contract, startedAt: new Date().toISOString() })
      }

      // Step 1: Run coder with context reset support
      printAgentBanner('coder', 1, 2, `${feature.id}${attemptLabel}`)
      const coderResult = await this.runCoderWithResets(feature)
      if (!coderResult.success) {
        console.log(chalk.red(`✗ Coder failed: ${coderResult.error}`))
        continue
      }

      console.log(
        chalk.gray(
          `  coder: ${(coderResult.durationMs / 1000).toFixed(1)}s, ` +
            `${coderResult.totalInputTokens}↑ tokens`,
        ),
      )

      // Step 2: Run evaluator independently
      printAgentBanner('eval', 2, 2, feature.id)
      const ctxMgr = new ContextManager()
      const evalResult = await runEvaluatorAgent(projectDir, feature.id, ctxMgr)

      if (!evalResult.success) {
        console.log(chalk.red(`✗ Evaluator failed: ${evalResult.error}`))
        continue
      }

      // Read eval report written by evaluator
      const report = await readEvalReport(projectDir)
      if (!report) {
        console.log(chalk.red('✗ Evaluator did not write eval-report.json'))
        continue
      }

      const verdictStr = report.verdict === 'pass' ? chalk.green('PASS') : chalk.red('FAIL')
      console.log(
        chalk.gray(
          `  evaluator: ${(evalResult.durationMs / 1000).toFixed(1)}s — verdict: ${verdictStr}`,
        ),
      )

      if (report.verdict === 'pass') {
        // Evaluator already set passes:true in features.json
        // Commit the feature
        await this.commitFeature(feature, evalResult.sessionId)

        // Update progress
        try {
          const progress = await readProgress(projectDir)
          const featuresData = await readFeaturesFile(projectDir)
          await writeProgress(projectDir, {
            ...progress,
            passedFeatures: countPassing(featuresData.features),
            currentFeatureId: null,
            lastSessionId: evalResult.sessionId,
          })
        } catch {
          // non-fatal
        }

        return 'pass'
      }

      // Print failing criteria for visibility
      for (const cr of report.criteriaResults.filter(r => r.result === 'fail')) {
        console.log(chalk.red(`    ✗ ${cr.criterion}`))
        console.log(chalk.gray(`      ${cr.evidence}`))
      }
    }

    return 'fail'
  }

  /**
   * Run the coder agent, handling context resets transparently.
   */
  private async runCoderWithResets(
    feature: Feature,
  ): Promise<{ success: boolean; error?: string; durationMs: number; totalInputTokens: number }> {
    const { projectDir } = this.opts
    const startTime = Date.now()
    let totalInputTokens = 0

    for (let resetCount = 0; resetCount <= MAX_CONTEXT_RESETS; resetCount++) {
      const ctxMgr = new ContextManager()

      try {
        let isReset = resetCount > 0
        let resetPrompt: string | undefined

        if (isReset) {
          console.log(chalk.yellow(`\n  ↺ Context reset #${resetCount} — starting fresh session`))
          printAgentBanner('coder', 1, 2, `${feature.id} (context reset #${resetCount})`)
          resetPrompt = await ctxMgr.buildHandoffPrompt(
            projectDir,
            feature,
            [], // completed steps unknown — agent reads from partial file
            `Reset ${resetCount}: continuing from previous session`,
          )
        }

        await runCoderAgent(projectDir, feature.id, ctxMgr, isReset, resetPrompt)

        const stats = ctxMgr.getStats()
        totalInputTokens += stats.totalInput
        return {
          success: true,
          durationMs: Date.now() - startTime,
          totalInputTokens,
        }
      } catch (err) {
        if (err instanceof ContextResetNeededError) {
          // Write partial completion before resetting
          await writeSprintCompletion(projectDir, {
            featureId: feature.id,
            commitSha: 'pending',
            testsPassed: false,
            notes: `Context reset needed at reset #${resetCount}`,
            completedAt: new Date().toISOString(),
            sessionId: 'unknown',
            isPartial: true,
          })

          const stats = ctxMgr.getStats()
          totalInputTokens += stats.totalInput
          ctxMgr.resetForNewSession()
          continue
        }

        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startTime,
          totalInputTokens,
        }
      }
    }

    return {
      success: false,
      error: `Exceeded maximum context resets (${MAX_CONTEXT_RESETS})`,
      durationMs: Date.now() - startTime,
      totalInputTokens,
    }
  }

  private async commitFeature(feature: Feature, sessionId: string): Promise<void> {
    const { projectDir } = this.opts
    try {
      await execAsync(`git add -A && git commit -m "feat: implement ${feature.id} [eval:pass]"`, {
        cwd: projectDir,
      })
    } catch {
      // May fail if coder already committed — that is fine
    }
  }

  private async markFeatureSkipped(feature: Feature): Promise<void> {
    // For now, skip silently — the feature remains passes:false and will be retried
    // on next run. A more sophisticated harness could mark it as "skip" permanently.
  }

  async getStatus(): Promise<{ passing: number; total: number; currentFeature: string | null }> {
    const { projectDir } = this.opts
    const featuresData = await readFeaturesFile(projectDir)
    const progress = await readProgress(projectDir).catch(() => null)

    return {
      passing: countPassing(featuresData.features),
      total: featuresData.features.length,
      currentFeature: progress?.currentFeatureId ?? null,
    }
  }
}
