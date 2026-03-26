import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import chalk from 'chalk'

import type { Feature, OrchestratorOptions, ProgressState, WorkerResult } from './agents/types.js'
import type { ProjectPlan } from './planner.js'
import { runInitializerAgent } from './agents/initializer.js'
import { runCoderAgent, ContextResetNeededError } from './agents/coder.js'
import { runEvaluatorAgent } from './agents/evaluator.js'
import { ContextManager } from './context/manager.js'
import { readFeaturesFile, getNextFeature, countPassing } from './state/features.js'
import { readProgress, writeProgress, createInitialProgress } from './state/progress.js'
import {
  buildSprintContract,
  writeSprintContract,
  writeCurrentFeature,
  readEvalReport,
  cleanSprintArtifacts,
  writeSprintCompletion,
} from './sprint/contracts.js'
import { printAgentBanner } from './logger.js'
import { initEventLog, emit } from './events.js'
import {
  createWorktree,
  removeWorktree,
  cherryPickToMain,
  getWorktreeSha,
  syncFilesToWorktree,
  cleanupAllWorktrees,
} from './worktree.js'

const execAsync = promisify(exec)

export class Orchestrator {
  private opts: Required<OrchestratorOptions>

  constructor(opts: OrchestratorOptions) {
    this.opts = {
      maxFeatures: Infinity,
      retryLimit: 2,
      maxContextResets: 5,
      dryRun: false,
      model: 'claude-sonnet-4-6',
      concurrency: 1,
      ...opts,
    }
  }

  /**
   * Run the initializer agent to set up the project scaffold.
   * Called once when init.sh does not exist.
   */
  async initialize(projectDescription: string, projectName: string, plan?: ProjectPlan): Promise<void> {
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

    initEventLog(projectDir)
    // If a plan was produced by the planner, use its rich context for feature generation
    const effectiveName = plan?.projectName ?? projectName
    const effectiveDescription = plan?.featureGenerationContext ?? projectDescription
    printAgentBanner('init', 1, 1, effectiveName)

    const ctxMgr = new ContextManager()
    const result = await runInitializerAgent(projectDir, effectiveDescription, effectiveName, ctxMgr)

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
   * Delegates to runParallel when concurrency > 1.
   */
  async run(): Promise<void> {
    const { projectDir, maxFeatures, dryRun, concurrency } = this.opts
    const runStart = Date.now()

    initEventLog(projectDir)

    if (concurrency > 1) {
      await this.runParallel()
      return
    }

    let implemented = 0
    let failed = 0

    while (implemented + failed < maxFeatures) {
      const featuresData = await readFeaturesFile(projectDir)
      const next = getNextFeature(featuresData.features)

      if (!next) {
        console.log(chalk.green('\n✅ All features implemented!'))
        const total = featuresData.features.length
        emit({ type: 'run_complete', passing: countPassing(featuresData.features), total, durationMs: Date.now() - runStart })
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
      emit({ type: 'feature_start', featureId: next.id, featureName: next.name, priority: next.priority, index: passing + 1, total })

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
        await this.markFeatureSkipped(next)
      }
      emit({ type: 'feature_done', featureId: next.id, verdict, attempt: this.opts.retryLimit + 1, durationMs: 0 })
    }

    const summary = await this.getStatus()
    console.log(
      chalk.bold(`\nSummary: ${summary.passing}/${summary.total} features passing`),
    )
  }

  /**
   * Parallel orchestration: dispatch features to isolated git worktrees.
   * Each worker runs coder → evaluator independently. Passing features are
   * cherry-picked back onto the main branch.
   */
  private async runParallel(): Promise<void> {
    const { projectDir, maxFeatures, concurrency, dryRun } = this.opts
    const runStart = Date.now()

    console.log(chalk.bold(`\n⚡ Parallel mode: ${concurrency} workers`))

    // Clean up stale worktrees from previous crashed runs
    await cleanupAllWorktrees(projectDir)

    const featuresData = await readFeaturesFile(projectDir)
    const pending = featuresData.features
      .filter(f => !f.passes)
      .slice(0, maxFeatures)

    if (pending.length === 0) {
      console.log(chalk.green('\n✅ All features already implemented!'))
      emit({ type: 'run_complete', passing: countPassing(featuresData.features), total: featuresData.features.length, durationMs: 0 })
      return
    }

    const total = featuresData.features.length
    console.log(chalk.gray(`  ${pending.length} features pending, ${total} total`))
    emit({ type: 'run_start', projectName: featuresData.projectName, total, concurrency })

    if (dryRun) {
      console.log(chalk.gray('\n[dry-run] Would dispatch in parallel:'))
      for (let i = 0; i < pending.length; i++) {
        const f = pending[i]
        const wId = (i % concurrency) + 1
        console.log(chalk.gray(`  [W${wId}] ${f.id} (${f.priority})`))
      }
      return
    }

    // Create worktrees
    console.log(chalk.gray(`  Creating ${concurrency} worktrees...`))
    const worktrees = await Promise.all(
      Array.from({ length: concurrency }, (_, i) => createWorktree(projectDir, i + 1)),
    )

    let implemented = 0
    let failed = 0
    let cursor = 0
    const retryQueue: Feature[] = []

    try {
      while (cursor < pending.length || retryQueue.length > 0) {
        // Fill a batch from pending features (or retry queue)
        const batch: Feature[] = []
        while (batch.length < concurrency && cursor < pending.length) {
          batch.push(pending[cursor])
          cursor++
        }
        while (batch.length < concurrency && retryQueue.length > 0) {
          batch.push(retryQueue.shift()!)
        }

        if (batch.length === 0) break

        // Print batch header
        console.log(chalk.bold(`\n◆ Batch: ${batch.map(f => f.id).join(', ')}`))
        for (let i = 0; i < batch.length; i++) {
          const f = batch[i]
          const wt = worktrees[i]
          emit({ type: 'feature_start', featureId: f.id, featureName: f.name, priority: f.priority, index: cursor - batch.length + i + 1, total, workerId: wt.workerId })
          console.log(chalk.gray(`  [W${wt.workerId}] ${f.id} — ${f.description.slice(0, 60)}`))
        }

        // Dispatch batch in parallel
        const results = await Promise.allSettled(
          batch.map((feature, i) => this.runFeatureInWorktree(worktrees[i], feature)),
        )

        // Process results sequentially (writes to main must be serialized)
        for (let i = 0; i < results.length; i++) {
          const result = results[i]
          const feature = batch[i]

          if (result.status === 'rejected') {
            failed++
            console.log(chalk.red(`\n✗ [W${worktrees[i].workerId}] ${feature.id} — worker error: ${result.reason}`))
            emit({ type: 'feature_done', featureId: feature.id, verdict: 'fail', attempt: 1, durationMs: 0, workerId: worktrees[i].workerId })
            continue
          }

          const wr = result.value

          if (wr.verdict === 'pass' && wr.commitSha) {
            // Cherry-pick the passing commit onto main
            const picked = await cherryPickToMain(projectDir, wr.commitSha)
            if (picked) {
              implemented++
              console.log(chalk.green(`\n✓ [W${wr.workerId}] ${feature.id} passed (${(wr.durationMs / 1000).toFixed(0)}s)`))
            } else {
              // Cherry-pick conflict — queue for sequential retry
              console.log(chalk.yellow(`\n⚠ [W${wr.workerId}] ${feature.id} passed but cherry-pick conflicted — queued for retry`))
              retryQueue.push(feature)
            }
          } else {
            failed++
            console.log(chalk.red(`\n✗ [W${wr.workerId}] ${feature.id} failed${wr.error ? `: ${wr.error}` : ''}`))
          }

          emit({ type: 'feature_done', featureId: feature.id, verdict: wr.verdict, attempt: 1, durationMs: wr.durationMs, workerId: wr.workerId })
        }

        // Reset worktrees to latest main HEAD for next batch
        for (const wt of worktrees) {
          try {
            // Get current main HEAD
            const { stdout } = await execAsync('git rev-parse HEAD', { cwd: projectDir })
            const mainHead = stdout.trim()
            // Reset worktree branch to main HEAD so next batch starts from latest
            await execAsync(`git reset --hard ${mainHead}`, { cwd: wt.dir })
          } catch {
            // Best-effort sync — feature isolation still works per-batch
          }
        }
      }

      // Process retry queue sequentially in main worktree
      for (const feature of retryQueue) {
        console.log(chalk.yellow(`\n↻ Sequential retry: ${feature.id}`))
        const verdict = await this.implementFeature(feature)
        if (verdict === 'pass') {
          implemented++
        } else {
          failed++
        }
      }
    } finally {
      // Always clean up worktrees
      console.log(chalk.gray('\n  Cleaning up worktrees...'))
      await Promise.all(worktrees.map(wt => removeWorktree(projectDir, wt)))
    }

    const summary = await this.getStatus()
    const elapsed = ((Date.now() - runStart) / 1000).toFixed(0)
    console.log(
      chalk.bold(`\nSummary: ${summary.passing}/${summary.total} features passing (${elapsed}s, ${concurrency} workers)`),
    )
    emit({ type: 'run_complete', passing: summary.passing, total: summary.total, durationMs: Date.now() - runStart })
  }

  /**
   * Run coder → evaluator for a single feature inside an isolated worktree.
   * Returns the result without modifying the main branch.
   */
  private async runFeatureInWorktree(
    worktree: { dir: string; branch: string; workerId: number },
    feature: Feature,
  ): Promise<WorkerResult> {
    const startTime = Date.now()
    const { retryLimit } = this.opts
    const wId = worktree.workerId
    const worktreeDir = worktree.dir

    // Sync necessary files from main
    await syncFilesToWorktree(this.opts.projectDir, worktreeDir)

    // Clean and write sprint artifacts in the worktree
    await cleanSprintArtifacts(worktreeDir)
    const contract = buildSprintContract(feature)
    await Promise.all([
      writeSprintContract(worktreeDir, contract),
      writeCurrentFeature(worktreeDir, feature),
    ])

    for (let attempt = 0; attempt <= retryLimit; attempt++) {
      const attemptLabel = attempt > 0 ? ` retry ${attempt}` : ''

      if (attempt > 0) {
        console.log(chalk.yellow(`  [W${wId}] ↻ Retry ${attempt}/${retryLimit} for ${feature.id}`))
        await cleanSprintArtifacts(worktreeDir)
        await writeSprintContract(worktreeDir, { ...contract, startedAt: new Date().toISOString() })
      }

      // Run coder in worktree
      printAgentBanner('coder', 1, 2, `${feature.id}${attemptLabel}`, wId)
      const ctxMgr = new ContextManager()
      try {
        await runCoderAgent(worktreeDir, feature.id, ctxMgr)
      } catch (err) {
        if (!(err instanceof ContextResetNeededError)) {
          console.log(chalk.red(`  [W${wId}] ✗ Coder failed: ${err instanceof Error ? err.message : err}`))
          continue
        }
        // Context resets in parallel mode: just retry from scratch
        console.log(chalk.yellow(`  [W${wId}] ↺ Context reset — retrying`))
        continue
      }

      // Run evaluator in worktree
      printAgentBanner('eval', 2, 2, feature.id, wId)
      const evalCtx = new ContextManager()
      const evalResult = await runEvaluatorAgent(worktreeDir, feature.id, evalCtx)

      if (!evalResult.success) {
        console.log(chalk.red(`  [W${wId}] ✗ Evaluator failed: ${evalResult.error}`))
        continue
      }

      const report = await readEvalReport(worktreeDir)
      if (!report) {
        console.log(chalk.red(`  [W${wId}] ✗ No eval-report.json`))
        continue
      }

      if (report.verdict === 'pass') {
        // Commit in the worktree branch
        try {
          await execAsync(
            `git add -A && git commit -m "feat: implement ${feature.id} [eval:pass]"`,
            { cwd: worktreeDir },
          )
        } catch {
          // Coder may have already committed
        }

        const commitSha = await getWorktreeSha(worktreeDir)
        return {
          workerId: wId,
          feature,
          verdict: 'pass',
          commitSha,
          durationMs: Date.now() - startTime,
        }
      }

      // Log failing criteria
      for (const cr of report.criteriaResults.filter(r => r.result === 'fail')) {
        console.log(chalk.red(`    [W${wId}] ✗ ${cr.criterion}`))
      }
    }

    return {
      workerId: wId,
      feature,
      verdict: 'fail',
      durationMs: Date.now() - startTime,
      error: `Failed after ${retryLimit + 1} attempts`,
    }
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
    await Promise.all([
      writeSprintContract(projectDir, contract),
      // Write current-feature.json so coder reads one feature, not all 200+
      writeCurrentFeature(projectDir, feature),
    ])

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
      emit({ type: 'eval_verdict', featureId: feature.id, verdict: report.verdict, criteriaResults: report.criteriaResults })

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
   *
   * On each reset: captures git log/diff since the session started, writes a rich
   * sprint-context-handoff.json, then starts a fresh session with a structured prompt.
   * The fresh session reads current-feature.json (not all of features.json) to save
   * startup tokens for actual coding work.
   */
  private async runCoderWithResets(
    feature: Feature,
  ): Promise<{ success: boolean; error?: string; durationMs: number; totalInputTokens: number }> {
    const { projectDir, maxContextResets } = this.opts
    const startTime = Date.now()
    let totalInputTokens = 0
    // Record git SHA before the coder starts so we can show exactly what it committed
    let startingSha = await this.getCurrentSha()

    for (let resetCount = 0; resetCount <= maxContextResets; resetCount++) {
      const ctxMgr = new ContextManager()

      try {
        let isReset = resetCount > 0
        let resetPrompt: string | undefined

        if (isReset) {
          console.log(chalk.yellow(`\n  ↺ Context reset #${resetCount}/${maxContextResets} — starting fresh session`))
          printAgentBanner('coder', 1, 2, `${feature.id} (context reset #${resetCount})`)
          emit({ type: 'context_reset', featureId: feature.id, resetCount })
          resetPrompt = await ctxMgr.buildHandoffPrompt(
            projectDir,
            feature,
            [], // remaining steps are in sprint-context-handoff.json for the agent to read
            `Reset ${resetCount}: continuing from previous session`,
            startingSha,
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
          // Write partial completion record before resetting
          await writeSprintCompletion(projectDir, {
            featureId: feature.id,
            commitSha: await this.getCurrentSha() ?? 'pending',
            testsPassed: false,
            notes: `Context reset #${resetCount}: hit context limit, continuing in next session`,
            completedAt: new Date().toISOString(),
            sessionId: 'unknown',
            isPartial: true,
          })

          const stats = ctxMgr.getStats()
          totalInputTokens += stats.totalInput
          // Don't update startingSha — keep the original so git diff spans the whole feature
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
      error: `Exceeded maximum context resets (${maxContextResets}). Consider splitting this feature into smaller pieces.`,
      durationMs: Date.now() - startTime,
      totalInputTokens,
    }
  }

  private async getCurrentSha(): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync('git log --format=%H -1', { cwd: this.opts.projectDir })
      return stdout.trim() || undefined
    } catch {
      return undefined
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
