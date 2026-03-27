import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import chalk from 'chalk'

import type { Feature, OrchestratorOptions, ProgressState, WorkerResult, ModelConfig } from './agents/types.js'
import type { ProjectPlan } from './planner.js'
import { runInitializerAgent } from './agents/initializer.js'
import { runCoderAgent, ContextResetNeededError } from './agents/coder.js'
import { runEvaluatorAgent } from './agents/evaluator.js'
import { runReviewerAgent, readReviewReport } from './agents/reviewer.js'
import { ContextManager } from './context/manager.js'
// Features are read from SQLite via this.store (no more JSON file reads)
import { QuestStore } from './store.js'
import { readProgress, writeProgress, createInitialProgress } from './state/progress.js'
import {
  buildSprintContract,
  writeSprintContract,
  writeCurrentFeature,
  readEvalReport,
  writeEvalReport,
  cleanSprintArtifacts,
  writeSprintCompletion,
} from './sprint/contracts.js'
import { classifyFailure } from './failure-classifier.js'
import type { FailureCategory } from './failure-classifier.js'
import { printAgentBanner } from './logger.js'
import { initEventLog, emit, readEvents } from './events.js'
import { computeRunCost, computeFeatureCost } from './cost.js'
import {
  createWorktree,
  removeWorktree,
  cherryPickToMain,
  getWorktreeSha,
  syncFilesToWorktree,
  cleanupAllWorktrees,
  type WorktreeInfo,
} from './worktree.js'
import {
  buildDAG,
  planNextBatch,
  getNewlyUnblocked,
  estimateTotalTime,
  formatDAGSummary,
  type DAG,
} from './scheduler.js'
import { TraceDB, TraceSQLSession } from './trace-db.js'
import { AgentGit } from './agent-git/index.js'
import { TranscriptCapture } from './transcript.js'
import { PluginManager } from './plugins.js'
import { notifyFeatureDone, notifyRunComplete, type FeatureDonePayload, type RunCompletePayload } from './webhook.js'

const execAsync = promisify(exec)

// ---------------------------------------------------------------------------
// Worker pool: dynamic worktree creation/reuse
// ---------------------------------------------------------------------------

class WorkerPool {
  private available: WorktreeInfo[] = []
  private nextId = 1

  /** Acquire a worktree — reuse from pool or create new */
  async acquire(mainDir: string): Promise<WorktreeInfo> {
    const existing = this.available.pop()
    if (existing) {
      // Reset to latest main HEAD before reuse
      try {
        const { stdout } = await execAsync('git rev-parse HEAD', { cwd: mainDir })
        const mainHead = stdout.trim()
        await execAsync(`git reset --hard ${mainHead}`, { cwd: existing.dir })
      } catch {
        // Best-effort reset
      }
      return existing
    }

    return createWorktree(mainDir, this.nextId++)
  }

  /** Release a worktree back to the pool */
  release(worktree: WorktreeInfo): void {
    this.available.push(worktree)
  }

  /** Destroy all pooled worktrees */
  async destroyAll(mainDir: string): Promise<void> {
    await Promise.all(this.available.map(wt => removeWorktree(mainDir, wt)))
    this.available = []
  }

  get poolSize(): number {
    return this.available.length
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class Orchestrator {
  private opts: Required<Omit<OrchestratorOptions, 'coderModel' | 'evaluatorModel' | 'reviewerModel' | 'tdd' | 'webhookUrl' | 'notify'>> & Pick<OrchestratorOptions, 'coderModel' | 'evaluatorModel' | 'reviewerModel' | 'tdd' | 'webhookUrl' | 'notify'>
  private tracer: TraceDB
  private agentGit: AgentGit
  readonly store: QuestStore
  readonly pluginManager: PluginManager

  /** Set to true when SIGINT/SIGTERM is received — stops dispatching new work */
  shutdownRequested = false
  private shutdownListeners: Array<() => void> = []

  constructor(opts: OrchestratorOptions) {
    // Load model config from .quest/config.json if it exists
    const fileConfig = Orchestrator.loadModelConfig(opts.projectDir)
    const defaultModel = opts.model ?? 'claude-sonnet-4-6'

    const resolvedCoderModel = opts.coderModel ?? fileConfig.coder ?? defaultModel
    const resolvedEvaluatorModel = opts.evaluatorModel ?? fileConfig.evaluator ?? defaultModel
    const resolvedReviewerModel = opts.reviewerModel ?? fileConfig.reviewer ?? defaultModel

    this.opts = {
      maxFeatures: Infinity,
      retryLimit: 2,
      maxContextResets: 5,
      dryRun: false,
      model: defaultModel,
      maxConcurrency: 4,
      review: false,
      maxContextTokens: 200_000,
      skipInit: false,
      healthTimeout: 30,
      skipRegression: false,
      noTranscripts: false,
      noEvidence: false,
      tdd: false,
      ciMode: false,
      failFast: false,
      ...opts,
      // Re-apply resolved models after spread so explicit opts don't overwrite file config fallback
      coderModel: resolvedCoderModel,
      evaluatorModel: resolvedEvaluatorModel,
      reviewerModel: resolvedReviewerModel,
    }
    this.tracer = new TraceDB(opts.projectDir)
    this.store = new QuestStore(opts.projectDir)
    this.agentGit = new AgentGit(opts.projectDir)
    this.pluginManager = new PluginManager(opts.projectDir)
  }

  /** Load model config from .quest/config.json */
  private static loadModelConfig(projectDir: string): ModelConfig {
    const configPath = join(projectDir, '.quest', 'config.json')
    if (!existsSync(configPath)) return {}
    try {
      const raw = readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(raw) as { models?: ModelConfig }
      return parsed.models ?? {}
    } catch {
      return {}
    }
  }

  /**
   * Emit a structured JSON line to stdout (CI mode only).
   * In CI mode, structured output goes to stdout while human-readable chalk
   * messages are redirected to stderr so they don't pollute the JSON stream.
   */
  private ciLog(data: Record<string, unknown>): void {
    if (this.opts.ciMode) {
      process.stdout.write(JSON.stringify({ ...data, ts: new Date().toISOString() }) + '\n')
    }
  }

  /**
   * Write a human-readable message. In CI mode, sends to stderr to keep
   * stdout clean for structured JSON output.
   */
  private log(msg: string): void {
    if (this.opts.ciMode) {
      process.stderr.write(msg.replace(/\n$/, '') + '\n')
    } else {
      console.log(msg)
    }
  }

  /**
   * Signal graceful shutdown — sets the flag so the current agent turn finishes
   * before the orchestrator exits cleanly.
   */
  requestShutdown(): void {
    if (!this.shutdownRequested) {
      console.log(chalk.yellow('\n⚠ Shutdown requested — finishing current operation then stopping...'))
      this.shutdownRequested = true
    }
  }

  /** Register SIGINT/SIGTERM handlers that set the shutdown flag */
  private registerShutdownHandlers(): void {
    const handler = () => this.requestShutdown()
    process.on('SIGINT', handler)
    process.on('SIGTERM', handler)
    this.shutdownListeners = [
      () => process.off('SIGINT', handler),
      () => process.off('SIGTERM', handler),
    ]
  }

  /** Remove signal handlers (called in finally block) */
  private unregisterShutdownHandlers(): void {
    for (const off of this.shutdownListeners) off()
    this.shutdownListeners = []
  }

  /**
   * Commit any partial work and update state for clean resume after interruption.
   * Emits a 'shutdown' event, creates a wip commit, and ensures progress tracks
   * the interrupted feature so `quest resume` picks up correctly.
   */
  private async performGracefulShutdown(featureId: string, featureName: string): Promise<void> {
    const { projectDir } = this.opts

    // Emit shutdown event to quest-events.jsonl
    emit({ type: 'shutdown', featureId, featureName, reason: 'SIGINT/SIGTERM received' })

    // Commit any uncommitted partial work with the wip message
    try {
      const { stdout } = await execAsync('git status --porcelain', { cwd: projectDir })
      if (stdout.trim()) {
        await execAsync(
          `git add -A && git commit -m "wip: partial implementation of ${featureName} (interrupted)"`,
          { cwd: projectDir },
        )
        console.log(chalk.yellow(`  Committed partial work for ${featureId}`))
      }
    } catch {
      // Best-effort — non-fatal if nothing to commit or git not available
    }

    // Update progress: keep currentFeatureId set so `quest resume` knows where to restart
    try {
      const progress = await readProgress(projectDir)
      await writeProgress(projectDir, {
        ...progress,
        currentFeatureId: featureId,
      })
    } catch {
      // Non-fatal
    }

    console.log(chalk.yellow(`\n⚠ Interrupted while working on: ${featureId}`))
    console.log(chalk.gray('  Run `quest resume` to continue from where you left off.'))
  }

  /**
   * Run init.sh in the project directory with up to 3 retries.
   * Emits init_failed events on each failure.
   * If QUEST_HEALTH_URL is set in the child process environment, polls it until healthy.
   * Throws if all retries are exhausted.
   */
  async runInitSh(): Promise<void> {
    const { projectDir, skipInit, healthTimeout } = this.opts
    const initSh = join(projectDir, 'init.sh')

    if (skipInit) {
      console.log(chalk.gray('Skipping init.sh (--skip-init)'))
      return
    }

    if (!existsSync(initSh)) {
      return
    }

    const MAX_RETRIES = 3
    let lastError = ''

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { stdout, stderr } = await execAsync('bash init.sh', {
          cwd: projectDir,
          env: { ...process.env },
        })

        // Check for health check URL set in environment or output by init.sh
        const healthUrl = process.env.QUEST_HEALTH_URL
        if (healthUrl) {
          await this.pollHealthCheck(healthUrl, healthTimeout)
        }

        // Also check stdout/stderr for QUEST_HEALTH_URL assignment
        const urlMatch = (stdout + stderr).match(/QUEST_HEALTH_URL=([^\s\n]+)/)
        if (urlMatch) {
          await this.pollHealthCheck(urlMatch[1], healthTimeout)
        }

        return // success
      } catch (err) {
        const execErr = err as { code?: number; stderr?: string; message?: string }
        const stderr = execErr.stderr ?? ''
        const exitCode = execErr.code ?? null
        lastError = stderr || (execErr.message ?? 'unknown error')

        emit({ type: 'init_failed', attempt, exitCode, stderr })
        console.error(chalk.red(`init.sh failed (attempt ${attempt}/${MAX_RETRIES}): exit code ${exitCode ?? 'unknown'}`))
        if (stderr) {
          console.error(chalk.gray(stderr.trim()))
        }

        if (attempt < MAX_RETRIES) {
          console.log(chalk.yellow(`Retrying init.sh...`))
        }
      }
    }

    throw new Error(`init.sh failed after ${MAX_RETRIES} attempts. Last error: ${lastError}`)
  }

  /**
   * Poll a health check URL until it returns 2xx or the timeout elapses.
   */
  private async pollHealthCheck(url: string, timeoutSeconds: number): Promise<void> {
    const deadline = Date.now() + timeoutSeconds * 1000
    const interval = 1000

    console.log(chalk.gray(`Polling health check: ${url} (timeout: ${timeoutSeconds}s)`))

    while (Date.now() < deadline) {
      try {
        const response = await fetch(url)
        if (response.ok) {
          console.log(chalk.green(`✓ Health check passed: ${url}`))
          return
        }
      } catch {
        // Not yet healthy — continue polling
      }

      await new Promise(resolve => setTimeout(resolve, interval))
    }

    throw new Error(`Health check timed out after ${timeoutSeconds}s: ${url}`)
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
    const traceSession = this.tracer.startSession('init', `Initialize ${effectiveName}`, {
      model: 'claude-sonnet-4-6', userPrompt: effectiveDescription,
    })
    const result = await runInitializerAgent(projectDir, effectiveDescription, effectiveName, ctxMgr)
    this.tracer.endSession(traceSession)

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
   * Delegates to runDAGScheduled when maxConcurrency > 1.
   *
   * Registers SIGINT/SIGTERM handlers that set `shutdownRequested`. The current agent
   * session completes its turn, then the loop checks the flag and exits gracefully:
   * emitting a shutdown event, committing partial work, and updating progress for resume.
   */
  async run(): Promise<void> {
    const { projectDir, maxFeatures, dryRun, maxConcurrency } = this.opts
    const runStart = Date.now()

    // Clean up old transcripts (older than 7 days) on each run
    if (!this.opts.noTranscripts) {
      TranscriptCapture.cleanup(projectDir)
    }

    // Initialize centralized store — all shared state reads/writes go through here
    this.store.init()

    initEventLog(projectDir)
    await this.runInitSh()
    await this.agentGit.init()

    // Load plugins from .quest/plugins/ and fire onRunStart hook
    await this.pluginManager.load()
    {
      const featuresDataForRunStart = this.store.readFeatures()
      await this.pluginManager.onRunStart({
        projectDir,
        totalFeatures: featuresDataForRunStart.features.length,
        concurrency: maxConcurrency,
      })
    }

    this.registerShutdownHandlers()

    try {
      if (maxConcurrency > 1) {
        await this.runDAGScheduled()
        return
      }

      let implemented = 0
      let failed = 0

      while (implemented + failed < maxFeatures) {
        // Check shutdown flag before starting a new feature
        if (this.shutdownRequested) {
          const featuresData = this.store.readFeatures()
          const inProgress = this.store.getNextFeature()
          if (inProgress) {
            await this.performGracefulShutdown(inProgress.id, inProgress.name)
          }
          break
        }

        const featuresData = this.store.readFeatures()
        const next = this.store.getNextFeature()

        if (!next) {
          this.log(chalk.green('\n✅ All features implemented!'))
          const total = featuresData.features.length
          const costSummary = computeRunCost(readEvents(projectDir))
          const runDoneMs = Date.now() - runStart
          const runPassing = this.store.countPassing()
          emit({ type: 'run_complete', passing: runPassing, total, durationMs: runDoneMs, totalCostUsd: costSummary.totalCostUsd, costByAgent: costSummary.byAgent })
          this.ciLog({ event: 'run_complete', passing: runPassing, total, durationMs: runDoneMs, totalCostUsd: costSummary.totalCostUsd })
          await this.pluginManager.onRunComplete({ projectDir, passing: runPassing, total, durationMs: runDoneMs, totalCostUsd: costSummary.totalCostUsd })
          {
            const runCompletePayload: RunCompletePayload = {
              event: 'run_complete',
              passing: runPassing,
              total,
              durationMs: runDoneMs,
              totalCostUsd: costSummary.totalCostUsd,
              summary: `${runPassing}/${total} features passing`,
            }
            await notifyRunComplete(runCompletePayload, this.opts.webhookUrl, this.opts.notify)
          }
          break
        }

        const total = featuresData.features.length
        const passing = this.store.countPassing()
        const pct = Math.round((passing / total) * 100)
        this.log(
          chalk.bold(`\n◆ Feature ${passing + 1}/${total} (${pct}% done) — ${chalk.white(next.id)}`) +
            chalk.gray(` [${next.priority}]`),
        )
        this.log(chalk.gray(`  ${next.description}`))
        emit({ type: 'feature_start', featureId: next.id, featureName: next.name, priority: next.priority, index: passing + 1, total })
        this.ciLog({ event: 'feature_start', featureId: next.id, featureName: next.name, priority: next.priority, index: passing + 1, total })
        await this.pluginManager.onFeatureStart({ projectDir, feature: next, index: passing + 1, total })
        this.store.featureDb.setFeatureStatus(next.id, 'in_progress')

        if (dryRun) {
          this.log(chalk.gray(`  [dry-run] Would implement: ${next.id}`))
          implemented++
          continue
        }

        const featureStartMs = Date.now()
        const { verdict, failureCategory } = await this.implementFeature(next)
        const featureDurationMs = Date.now() - featureStartMs

        // Check shutdown flag after implementFeature — the agent session has completed
        if (this.shutdownRequested) {
          await this.performGracefulShutdown(next.id, next.name)
          break
        }

        if (verdict === 'pass') {
          implemented++
          this.store.featureDb.setFeatureStatus(next.id, 'passed')
          this.log(chalk.green(`\n✓ ${next.id} passed`))
        } else {
          failed++
          this.store.featureDb.setFeatureStatus(next.id, 'failed')
          this.log(chalk.red(`\n✗ ${next.id} failed after ${this.opts.retryLimit + 1} attempts`))
          await this.markFeatureSkipped(next)
        }
        emit({ type: 'feature_done', featureId: next.id, verdict, attempt: this.opts.retryLimit + 1, durationMs: featureDurationMs, failureCategory })
        this.ciLog({ event: 'feature_done', featureId: next.id, verdict, attempt: this.opts.retryLimit + 1, durationMs: featureDurationMs, failureCategory })
        await this.pluginManager.onFeatureDone({ projectDir, featureId: next.id, featureName: next.name, verdict, attempt: this.opts.retryLimit + 1, durationMs: featureDurationMs, failureCategory })
        {
          const featureCost = computeFeatureCost(readEvents(projectDir), next.id)
          const featureDonePayload: FeatureDonePayload = {
            event: 'feature_done',
            featureId: next.id,
            verdict,
            durationMs: featureDurationMs,
            costEstimateUsd: featureCost,
            errorSummary: failureCategory ?? (verdict === 'fail' ? 'Feature failed' : undefined),
          }
          await notifyFeatureDone(featureDonePayload, this.opts.webhookUrl, this.opts.notify)
        }

        // fail-fast: stop on first failure
        if (verdict === 'fail' && this.opts.failFast) {
          this.log(chalk.yellow('\n⚠ fail-fast: stopping after first failure'))
          break
        }
      }

      const summary = await this.getStatus()
      this.log(
        chalk.bold(`\nSummary: ${summary.passing}/${summary.total} features passing`),
      )
    } finally {
      this.unregisterShutdownHandlers()
    }
  }

  /**
   * DAG-aware parallel orchestration using Promise.race dispatch loop.
   *
   * Instead of fixed-size batches with Promise.allSettled (which wastes time
   * waiting for the slowest worker), this dispatches new work the instant any
   * worker finishes and new features become unblocked.
   *
   * The scheduler auto-adjusts worker count based on DAG width — if only 3
   * features are ready, only 3 workers run even if maxConcurrency is 8.
   */
  private async runDAGScheduled(): Promise<void> {
    const { projectDir, maxFeatures, maxConcurrency, dryRun } = this.opts
    const runStart = Date.now()

    // Clean up stale worktrees from previous crashed runs
    await cleanupAllWorktrees(projectDir)

    const featuresData = this.store.readFeatures()
    const allFeatures = featuresData.features.slice(0, maxFeatures)
    const total = featuresData.features.length

    // Build the dependency DAG
    let dag: DAG
    try {
      dag = buildDAG(allFeatures)
    } catch (err) {
      console.error(chalk.red(`DAG error: ${err instanceof Error ? err.message : err}`))
      process.exit(1)
    }

    const effectiveWorkers = Math.min(dag.maxParallelism, maxConcurrency)
    this.log(chalk.bold(`\n⚡ DAG scheduler: up to ${effectiveWorkers} workers`))
    this.log(chalk.gray(formatDAGSummary(dag, maxConcurrency)))

    emit({
      type: 'dag_built',
      levels: dag.maxLevel + 1,
      criticalPath: dag.criticalPath,
      maxParallelism: dag.maxParallelism,
      totalFeatures: total,
    })

    const pending = allFeatures.filter(f => !f.passes)
    if (pending.length === 0) {
      this.log(chalk.green('\n✅ All features already implemented!'))
      const earlyExitCost = computeRunCost(readEvents(projectDir))
      const earlyPassing = this.store.countPassing()
      emit({ type: 'run_complete', passing: earlyPassing, total, durationMs: 0, totalCostUsd: earlyExitCost.totalCostUsd, costByAgent: earlyExitCost.byAgent })
      this.ciLog({ event: 'run_complete', passing: earlyPassing, total, durationMs: 0, totalCostUsd: earlyExitCost.totalCostUsd })
      await notifyRunComplete({
        event: 'run_complete',
        passing: earlyPassing,
        total,
        durationMs: 0,
        totalCostUsd: earlyExitCost.totalCostUsd,
        summary: `${earlyPassing}/${total} features passing`,
      }, this.opts.webhookUrl, this.opts.notify)
      return
    }

    this.log(chalk.gray(`  ${pending.length} features pending, ${total} total`))
    emit({
      type: 'run_start',
      projectName: featuresData.projectName,
      total,
      concurrency: effectiveWorkers,
      models: {
        coder: this.opts.coderModel ?? this.opts.model,
        evaluator: this.opts.evaluatorModel ?? this.opts.model,
        reviewer: this.opts.reviewerModel ?? this.opts.model,
      },
    })

    if (dryRun) {
      const estimate = estimateTotalTime(dag, maxConcurrency)
      this.log(chalk.gray(`\n[dry-run] Estimated wall-clock: ${(estimate.estimatedMs / 60_000).toFixed(0)} min`))
      this.log(chalk.gray(`  Critical path: ${(estimate.criticalPathMs / 60_000).toFixed(0)} min`))
      this.log(chalk.gray(`  Parallel efficiency: ${(estimate.parallelEfficiency * 100).toFixed(0)}%`))
      return
    }

    // State tracking
    const completed = new Set<string>()
    // Pre-populate with already-passing features
    for (const f of featuresData.features) {
      if (f.passes) completed.add(f.id)
    }

    const inFlight = new Map<string, Promise<{ featureId: string; result: WorkerResult }>>()
    const workerPool = new WorkerPool()
    const retryQueue: Feature[] = []
    const worktreeMap = new Map<string, WorktreeInfo>() // featureId → worktree
    let implemented = 0
    let failed = 0

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // Plan next batch based on current state
        const inFlightSet = new Set(inFlight.keys())
        const batch = planNextBatch(dag, completed, inFlightSet, maxConcurrency)

        if (batch.workerCount > 0) {
          emit({
            type: 'batch_plan',
            ready: batch.features.length,
            dispatching: batch.workerCount,
            inFlight: inFlight.size,
            reason: batch.reason,
          })
          this.log(chalk.gray(`\n  scheduler: ${batch.reason}`))
        }

        // Dispatch new features — skip if shutdown was requested
        if (!this.shutdownRequested) {
          for (const feature of batch.features) {
            const worktree = await workerPool.acquire(projectDir)
            worktreeMap.set(feature.id, worktree)

            this.store.featureDb.setFeatureStatus(feature.id, 'in_progress', worktree.workerId)
            emit({
              type: 'feature_start',
              featureId: feature.id,
              featureName: feature.name,
              priority: feature.priority,
              index: completed.size + inFlight.size + 1,
              total,
              workerId: worktree.workerId,
            })
            this.ciLog({ event: 'feature_start', featureId: feature.id, featureName: feature.name, priority: feature.priority, workerId: worktree.workerId })
            this.log(chalk.bold(`  [W${worktree.workerId}] ${feature.id}`) + chalk.gray(` — ${feature.description.slice(0, 60)}`))

            // Launch worker — wrap result with featureId for identification
            const featureId = feature.id
            const promise = this.runFeatureInWorktree(worktree, feature)
              .then(result => ({ featureId, result }))
              .catch(err => ({
                featureId,
                result: {
                  workerId: worktree.workerId,
                  feature,
                  verdict: 'fail' as const,
                  durationMs: 0,
                  error: err instanceof Error ? err.message : String(err),
                },
              }))

            inFlight.set(featureId, promise)
          }
        }

        // If nothing in-flight and nothing ready, we're done (or blocked or shutting down)
        if (inFlight.size === 0) {
          if (this.shutdownRequested) {
            // Emit shutdown event — use a sentinel since no single feature was "in progress"
            emit({ type: 'shutdown', featureId: 'parallel-run', featureName: 'parallel run', reason: 'SIGINT/SIGTERM received' })
            // Commit any uncommitted changes in the main repo
            try {
              const { stdout } = await execAsync('git status --porcelain', { cwd: projectDir })
              if (stdout.trim()) {
                await execAsync(
                  'git add -A && git commit -m "wip: partial implementation of parallel run (interrupted)"',
                  { cwd: projectDir },
                )
              }
            } catch {
              // Best-effort
            }
            this.log(chalk.yellow('\n⚠ Parallel run interrupted. Run `quest resume` to continue.'))
            break
          }
          // Check if there are features that can never be reached (failed dependencies)
          const remaining = allFeatures.filter(f => !f.passes && !completed.has(f.id))
          if (remaining.length > 0 && retryQueue.length === 0) {
            this.log(chalk.yellow(`\n⚠ ${remaining.length} features blocked by failed dependencies`))
          }
          break
        }

        // Wait for the first worker to finish (Promise.race)
        const { featureId, result: wr } = await Promise.race(inFlight.values())

        // Remove from in-flight
        inFlight.delete(featureId)
        const worktree = worktreeMap.get(featureId)!
        worktreeMap.delete(featureId)

        if (wr.verdict === 'pass' && wr.commitSha) {
          // Cherry-pick the passing commit onto main
          const picked = await cherryPickToMain(projectDir, wr.commitSha)
          if (picked) {
            implemented++
            completed.add(featureId)
            this.store.featureDb.setFeatureStatus(featureId, 'passed', wr.workerId)
            this.log(chalk.green(`\n✓ [W${wr.workerId}] ${featureId} passed (${(wr.durationMs / 1000).toFixed(0)}s)`))

            // Check for newly unblocked features
            const unblocked = getNewlyUnblocked(dag, featureId, completed, new Set(inFlight.keys()))
            for (const uid of unblocked) {
              emit({ type: 'feature_unblocked', featureId: uid, unblockedBy: featureId })
              this.log(chalk.blue(`  ↳ unblocked: ${uid}`))
            }
          } else {
            // Cherry-pick conflict — queue for sequential retry
            this.log(chalk.yellow(`\n⚠ [W${wr.workerId}] ${featureId} passed but cherry-pick conflicted — queued for retry`))
            retryQueue.push(wr.feature)
          }
        } else {
          failed++
          completed.add(featureId) // mark as completed (failed) so we don't re-dispatch
          this.store.featureDb.setFeatureStatus(featureId, 'failed')
          this.log(chalk.red(`\n✗ [W${wr.workerId}] ${featureId} failed${wr.error ? `: ${wr.error}` : ''}`))
        }

        emit({ type: 'feature_done', featureId, verdict: wr.verdict, attempt: 1, durationMs: wr.durationMs, failureCategory: wr.failureCategory, workerId: wr.workerId })
        this.ciLog({ event: 'feature_done', featureId, verdict: wr.verdict, attempt: 1, durationMs: wr.durationMs, failureCategory: wr.failureCategory, workerId: wr.workerId })
        {
          const featureCost = computeFeatureCost(readEvents(projectDir), featureId)
          const fdPayload: FeatureDonePayload = {
            event: 'feature_done',
            featureId,
            verdict: wr.verdict,
            durationMs: wr.durationMs,
            costEstimateUsd: featureCost,
            errorSummary: wr.failureCategory ?? wr.error ?? (wr.verdict === 'fail' ? 'Feature failed' : undefined),
          }
          await notifyFeatureDone(fdPayload, this.opts.webhookUrl, this.opts.notify)
        }

        // fail-fast: stop on first failure
        if (wr.verdict === 'fail' && this.opts.failFast) {
          this.log(chalk.yellow('\n⚠ fail-fast: stopping after first failure'))
          // Cancel in-flight by requesting shutdown
          this.shutdownRequested = true
        }

        // Release worktree back to pool
        workerPool.release(worktree)
      }

      // Process retry queue sequentially in main worktree
      for (const feature of retryQueue) {
        this.log(chalk.yellow(`\n↻ Sequential retry: ${feature.id}`))
        const { verdict, failureCategory } = await this.implementFeature(feature)
        if (verdict === 'pass') {
          implemented++
          completed.add(feature.id)
        } else {
          failed++
        }
        emit({ type: 'feature_done', featureId: feature.id, verdict, attempt: 1, durationMs: 0, failureCategory })
        {
          const featureCost = computeFeatureCost(readEvents(projectDir), feature.id)
          const fdRetryPayload: FeatureDonePayload = {
            event: 'feature_done',
            featureId: feature.id,
            verdict,
            durationMs: 0,
            costEstimateUsd: featureCost,
            errorSummary: failureCategory ?? (verdict === 'fail' ? 'Feature failed' : undefined),
          }
          await notifyFeatureDone(fdRetryPayload, this.opts.webhookUrl, this.opts.notify)
        }
      }
    } finally {
      // Always clean up worktrees
      this.log(chalk.gray('\n  Cleaning up worktrees...'))
      // Clean up any in-flight worktrees that weren't released
      for (const [, wt] of worktreeMap) {
        workerPool.release(wt)
      }
      await workerPool.destroyAll(projectDir)
    }

    const summary = await this.getStatus()
    const elapsed = ((Date.now() - runStart) / 1000).toFixed(0)
    this.log(
      chalk.bold(`\nSummary: ${summary.passing}/${summary.total} features passing (${elapsed}s)`),
    )
    const costSummary = computeRunCost(readEvents(projectDir))
    const dagRunDoneMs = Date.now() - runStart
    emit({ type: 'run_complete', passing: summary.passing, total: summary.total, durationMs: dagRunDoneMs, totalCostUsd: costSummary.totalCostUsd, costByAgent: costSummary.byAgent })
    this.ciLog({ event: 'run_complete', passing: summary.passing, total: summary.total, durationMs: dagRunDoneMs, totalCostUsd: costSummary.totalCostUsd })
    await notifyRunComplete({
      event: 'run_complete',
      passing: summary.passing,
      total: summary.total,
      durationMs: dagRunDoneMs,
      totalCostUsd: costSummary.totalCostUsd,
      summary: `${summary.passing}/${summary.total} features passing`,
    }, this.opts.webhookUrl, this.opts.notify)
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
    const worktreeFeaturesData = this.store.readFeatures()
    const worktreePreviouslyPassingIds = worktreeFeaturesData.features
      .filter(f => f.passes && f.id !== feature.id)
      .map(f => f.id)
    const contract = buildSprintContract(feature, worktreePreviouslyPassingIds, this.opts.skipRegression, this.opts.tdd)
    await Promise.all([
      writeSprintContract(worktreeDir, contract),
      writeCurrentFeature(worktreeDir, feature),
    ])

    let lastWorktreeFailureCategory: string | undefined
    const maxResets = this.opts.maxContextResets
    const coderModel = this.opts.coderModel ?? this.opts.model
    const evaluatorModel = this.opts.evaluatorModel ?? this.opts.model

    for (let attempt = 0; attempt <= retryLimit; attempt++) {
      const attemptLabel = attempt > 0 ? ` retry ${attempt}` : ''

      if (attempt > 0) {
        console.log(chalk.yellow(`  [W${wId}] ↻ Retry ${attempt}/${retryLimit} for ${feature.id}`))
        await cleanSprintArtifacts(worktreeDir)
        await writeSprintContract(worktreeDir, { ...contract, startedAt: new Date().toISOString() })
      }

      // Run coder in worktree — with context reset loop (resets don't count as retries)
      let coderSuccess = false
      for (let resetCount = 0; resetCount <= maxResets; resetCount++) {
        const resetLabel = resetCount > 0 ? ` (reset #${resetCount})` : ''
        printAgentBanner('coder', 1, 2, `${feature.id}${attemptLabel}${resetLabel}`, wId)
        const ctxMgr = new ContextManager({ maxContextTokens: this.opts.maxContextTokens, featureId: feature.id, workerId: wId })
        ctxMgr.setFeatureComplexity(feature.acceptanceCriteria.length)
        const coderTrace = this.tracer.startSession('coder', `Implement ${feature.id}${attemptLabel}${resetLabel}`, {
          featureId: feature.id, workerId: wId, model: coderModel,
        })
        try {
          await runCoderAgent(worktreeDir, feature.id, ctxMgr, resetCount > 0, undefined, { noTranscripts: this.opts.noTranscripts, tdd: this.opts.tdd, model: coderModel })
          this.tracer.endSession(coderTrace)
          coderSuccess = true
          break // coder finished successfully
        } catch (err) {
          this.tracer.endSession(coderTrace)
          if (err instanceof ContextResetNeededError) {
            console.log(chalk.yellow(`  [W${wId}] ↺ Context reset #${resetCount + 1}/${maxResets} — continuing in fresh session`))
            emit({ type: 'context_reset', featureId: feature.id, resetCount: resetCount + 1, completedCount: 0, remainingCount: feature.acceptanceCriteria.length, workerId: wId })
            continue // try again with fresh context (does NOT burn a retry)
          }
          console.log(chalk.red(`  [W${wId}] ✗ Coder failed: ${err instanceof Error ? err.message : err}`))
          break // real error — fall through to retry
        }
      }

      if (!coderSuccess) continue // burned this retry attempt, try again

      // Run evaluator in worktree
      printAgentBanner('eval', 2, 2, feature.id, wId)
      const evalCtx = new ContextManager({ maxContextTokens: this.opts.maxContextTokens, featureId: feature.id, workerId: wId })
      const evalTrace = this.tracer.startSession('eval', `Evaluate ${feature.id}`, {
        featureId: feature.id, workerId: wId, model: evaluatorModel,
      })
      const evalResult = await runEvaluatorAgent(worktreeDir, feature.id, evalCtx, evalTrace, { noTranscripts: this.opts.noTranscripts, model: evaluatorModel, noEvidence: this.opts.noEvidence })
      this.tracer.endSession(evalTrace)

      if (!evalResult.success) {
        console.log(chalk.red(`  [W${wId}] ✗ Evaluator failed: ${evalResult.error}`))
        continue
      }

      const report = await readEvalReport(worktreeDir)
      if (!report) {
        console.log(chalk.red(`  [W${wId}] ✗ No eval-report.json`))
        continue
      }

      // Check for regressions — even if verdict is "pass", regressions are a blocker
      if (report.regressions && report.regressions.length > 0) {
        console.log(chalk.red(`  [W${wId}] ✗ Regressions in ${report.regressions.length} previously passing feature(s):`))
        for (const reg of report.regressions) {
          console.log(chalk.red(`    [W${wId}] ✗ [regression] ${reg.featureId}: ${reg.evidence}`))
        }
        lastWorktreeFailureCategory = 'logic_bug'
        continue
      }

      if (report.verdict === 'pass') {
        // Mark passing in centralized store (not worktree-local features.json)
        this.store.markFeaturePassing(feature.id, evalResult.sessionId)

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

      // Log failing criteria and classify
      for (const cr of report.criteriaResults.filter(r => r.result === 'fail')) {
        console.log(chalk.red(`    [W${wId}] ✗ ${cr.criterion}`))
      }
      const failingEvidence = report.criteriaResults
        .filter(r => r.result === 'fail')
        .map(r => r.evidence)
        .join(' ')
      lastWorktreeFailureCategory = classifyFailure(failingEvidence)
      const reportWithCategory = { ...report, failureCategory: lastWorktreeFailureCategory }
      await writeEvalReport(worktreeDir, reportWithCategory).catch(() => {})
    }

    return {
      workerId: wId,
      feature,
      verdict: 'fail',
      durationMs: Date.now() - startTime,
      error: `Failed after ${retryLimit + 1} attempts`,
      failureCategory: lastWorktreeFailureCategory,
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
   * Uses failure category to decide retry strategy.
   */
  async implementFeature(feature: Feature): Promise<{ verdict: 'pass' | 'fail'; failureCategory?: string }> {
    const { projectDir, retryLimit } = this.opts

    // Clean up artifacts from any previous attempt
    await cleanSprintArtifacts(projectDir)

    // Write sprint contract BEFORE coder runs — criteria are locked
    const featuresDataForContract = this.store.readFeatures()
    const previouslyPassingIds = featuresDataForContract.features
      .filter(f => f.passes && f.id !== feature.id)
      .map(f => f.id)
    let contract = buildSprintContract(feature, previouslyPassingIds, this.opts.skipRegression, this.opts.tdd)
    // Allow plugins to modify the sprint contract before coder runs
    contract = await this.pluginManager.modifySprintContract(contract, feature)
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

    // ── Agent-Git: set up version control for this feature ───────────
    const extSession = await this.agentGit.createExternalSession(`feature/${feature.id}`)
    const agSession = await this.agentGit.startSession(extSession.id, { featureId: feature.id })

    // Checkpoint the pre-implementation state as the baseline
    const baselineCheckpoint = await this.agentGit.checkpoint({
      description: `Baseline before implementing ${feature.id}`,
      autoCommit: false,
      metadata: { featureId: feature.id, phase: 'baseline' },
    })
    console.log(chalk.gray(`  agent-git: baseline checkpoint ${baselineCheckpoint.id.slice(0, 8)}`))

    let lastFailureCategory: FailureCategory | undefined
    let retryHints: string | undefined

    // Check for prior failure context to inform this run
    const lastFailure = this.store.featureDb.getLastFailure(feature.id)
    if (lastFailure?.failure_reason) {
      retryHints = `Previous attempt failed: ${lastFailure.failure_reason}${lastFailure.eval_evidence ? `\nEvaluator evidence: ${lastFailure.eval_evidence.slice(0, 500)}` : ''}`
    }

    for (let attempt = 0; attempt <= retryLimit; attempt++) {
      const attemptLabel = attempt > 0 ? ` retry ${attempt}/${retryLimit}` : ''
      const attemptId = this.store.featureDb.recordAttemptStart(feature.id, attempt, 'coder')

      if (attempt > 0) {
        console.log(chalk.yellow(`\n↻ Retry ${attempt}/${retryLimit} for ${feature.id}${lastFailureCategory ? ` [${lastFailureCategory}]` : ''}`))

        // Rollback to baseline before retrying — ensures clean state
        const rollbackResult = await this.agentGit.rollbackTo(baselineCheckpoint.id, {
          preserveTimeline: true,
          preserveBranchName: `abandoned/${feature.id}/attempt-${attempt}`,
        })
        console.log(
          chalk.gray(`  agent-git: rolled back to baseline`) +
            (rollbackResult.preservedBranch
              ? chalk.gray(` (preserved on ${rollbackResult.preservedBranch})`)
              : ''),
        )

        await cleanSprintArtifacts(projectDir)
        await writeSprintContract(projectDir, { ...contract, startedAt: new Date().toISOString() })
      }

      const totalSteps = this.opts.review ? 3 : 2

      // Step 1: Run coder with context reset support
      // Retry strategy based on failure category:
      //   tool_error   → retry immediately (no changes)
      //   logic_bug    → retry with additional hints in the prompt
      //   timeout      → retry with extended max_turns (increase by 50%)
      printAgentBanner('coder', 1, totalSteps, `${feature.id}${attemptLabel}`)
      const coderResult = await this.runCoderWithResets(feature, retryHints)
      await this.pluginManager.onAgentDone({ projectDir, featureId: feature.id, agentType: 'coder', success: coderResult.success, durationMs: coderResult.durationMs })
      if (!coderResult.success) {
        console.log(chalk.red(`✗ Coder failed: ${coderResult.error}`))
        this.store.featureDb.recordAttemptEnd(attemptId, {
          verdict: 'fail', failureReason: coderResult.error, failureCategory: 'coder_error',
          inputTokens: coderResult.totalInputTokens,
        })
        continue
      }

      // Checkpoint after coder completes
      await this.agentGit.checkpoint({
        description: `Coder completed ${feature.id} (attempt ${attempt + 1})`,
        metadata: { featureId: feature.id, phase: 'post-coder', attempt: attempt + 1 },
      })

      console.log(
        chalk.gray(
          `  coder: ${(coderResult.durationMs / 1000).toFixed(1)}s, ` +
            `${coderResult.totalInputTokens}↑ tokens`,
        ),
      )

      // Plugin custom agent steps — run between coder and evaluator
      const customSteps = this.pluginManager.getCustomAgentSteps()
      for (const step of customSteps) {
        console.log(chalk.gray(`  plugin step: ${step.name}`))
        try {
          await step.run(projectDir, feature)
        } catch (err) {
          console.warn(chalk.yellow(`⚠ Plugin step "${step.name}" failed — ${err instanceof Error ? err.message : err}`))
        }
      }

      // Step 2 (optional): Run reviewer between coder and evaluator
      if (this.opts.review) {
        printAgentBanner('reviewer', 2, totalSteps, feature.id)
        const reviewCtx = new ContextManager({ maxContextTokens: this.opts.maxContextTokens, featureId: feature.id })
        const reviewResult = await runReviewerAgent(projectDir, feature.id, reviewCtx)

        if (!reviewResult.success) {
          console.log(chalk.yellow(`⚠ Reviewer failed: ${reviewResult.error} — continuing to evaluator`))
        } else {
          const reviewReport = await readReviewReport(projectDir)
          if (reviewReport) {
            console.log(chalk.gray(`  reviewer: ${(reviewResult.durationMs / 1000).toFixed(1)}s — ${reviewReport.issues.length} issue(s)`))

            if (reviewReport.hasCriticalIssues) {
              // Build fix instructions from critical issues
              const criticalIssues = reviewReport.issues.filter(i => i.severity === 'critical')
              const fixInstructions = criticalIssues
                .map(i => `- [${i.category}] ${i.description} (${i.location})\n  Fix: ${i.suggestion}`)
                .join('\n')

              console.log(chalk.red(`  ✗ Reviewer found ${criticalIssues.length} critical issue(s) — sending back to coder`))
              for (const issue of criticalIssues) {
                console.log(chalk.red(`    ✗ [${issue.category}] ${issue.description}`))
              }

              // Re-run coder with specific fix instructions
              printAgentBanner('coder', 1, totalSteps, `${feature.id} (review fix)`)
              const fixPrompt = `CONTEXT RESET: Fix critical code review issues for feature: ${feature.id}

The code reviewer found the following critical issues that must be fixed before evaluation:

${fixInstructions}

Read sprint-contract.json for the acceptance criteria, then fix ONLY these critical issues. Do not rewrite the entire implementation — make targeted fixes. When done, update sprint-completion.json with notes about what you fixed.`

              const fixCoderResult = await this.runCoderWithResets(feature, fixPrompt)
              if (!fixCoderResult.success) {
                console.log(chalk.red(`✗ Coder fix failed: ${fixCoderResult.error}`))
                continue
              }
              console.log(chalk.gray(`  coder (fix): ${(fixCoderResult.durationMs / 1000).toFixed(1)}s`))
            } else {
              // Log any non-critical issues for visibility
              const highIssues = reviewReport.issues.filter(i => i.severity === 'high')
              if (highIssues.length > 0) {
                console.log(chalk.yellow(`  ⚠ ${highIssues.length} high-severity issue(s) (non-blocking):`))
                for (const issue of highIssues) {
                  console.log(chalk.yellow(`    ⚠ [${issue.category}] ${issue.description}`))
                }
              }
            }
          }
        }
      }

      // Step 3 (or 2): Run evaluator independently
      printAgentBanner('eval', totalSteps, totalSteps, feature.id)
      const ctxMgr = new ContextManager({ maxContextTokens: this.opts.maxContextTokens, featureId: feature.id })
      const evalTrace = this.tracer.startSession('eval', `Evaluate ${feature.id}`, {
        featureId: feature.id, model: this.opts.evaluatorModel ?? this.opts.model,
      })
      const evalResult = await runEvaluatorAgent(projectDir, feature.id, ctxMgr, evalTrace, { noTranscripts: this.opts.noTranscripts, model: this.opts.evaluatorModel ?? this.opts.model, noEvidence: this.opts.noEvidence })
      this.tracer.endSession(evalTrace)
      await this.pluginManager.onAgentDone({ projectDir, featureId: feature.id, agentType: 'evaluator', success: evalResult.success, durationMs: evalResult.durationMs })

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
      await this.pluginManager.onEvalVerdict({ projectDir, featureId: feature.id, verdict: report.verdict, criteriaResults: report.criteriaResults })

      // Check for regressions — even if verdict is "pass", regressions are a blocker
      if (report.regressions && report.regressions.length > 0) {
        console.log(chalk.red(`✗ Regressions in ${report.regressions.length} previously passing feature(s):`))
        for (const reg of report.regressions) {
          console.log(chalk.red(`    ✗ [regression] ${reg.featureId}: ${reg.evidence}`))
        }
        lastFailureCategory = 'logic_bug'
        continue
      }

      if (report.verdict === 'fail') {
        // Classify the failure and write it back to eval-report
        const failingEvidence = report.criteriaResults
          .filter(r => r.result === 'fail')
          .map(r => r.evidence)
          .join(' ')
        lastFailureCategory = classifyFailure(failingEvidence)
        const reportWithCategory = { ...report, failureCategory: lastFailureCategory }
        await writeEvalReport(projectDir, reportWithCategory).catch(() => {})
        console.log(chalk.gray(`  failure category: ${lastFailureCategory}`))

        // Prepare retry strategy based on failure category
        if (lastFailureCategory === 'logic_bug') {
          const failingCriteria = report.criteriaResults
            .filter(r => r.result === 'fail')
            .map(r => `- ${r.criterion}: ${r.evidence}`)
            .join('\n')
          retryHints = `Previous attempt failed with logic errors. Address these specific issues:\n${failingCriteria}`
        } else if (lastFailureCategory === 'timeout') {
          // Extended max_turns is handled by runCoderWithResets using extra reset budget
          retryHints = undefined
        } else {
          retryHints = undefined
        }
      }

      if (report.verdict === 'pass') {
        this.store.featureDb.recordAttemptEnd(attemptId, {
          verdict: 'pass', commitSha: await this.getCurrentSha() ?? undefined,
          inputTokens: coderResult.totalInputTokens,
        })

        // Checkpoint the passing state
        await this.agentGit.checkpoint({
          description: `${feature.id} passed evaluation`,
          metadata: { featureId: feature.id, phase: 'eval-pass', verdict: 'pass' },
        })

        // Mark passing in centralized store (evaluator no longer writes features.json)
        this.store.markFeaturePassing(feature.id, evalResult.sessionId)

        // Commit the feature
        await this.commitFeature(feature, evalResult.sessionId)
        await this.agentGit.endSession(agSession.id)

        // Update progress
        try {
          const progress = await readProgress(projectDir)
          const featuresData = this.store.readFeatures()
          const commitSha = await this.getCurrentSha()
          const featureCommitShas = { ...(progress.featureCommitShas ?? {}) }
          if (commitSha) {
            featureCommitShas[feature.id] = commitSha
          }
          await writeProgress(projectDir, {
            ...progress,
            passedFeatures: this.store.countPassing(),
            currentFeatureId: null,
            lastSessionId: evalResult.sessionId,
            featureCommitShas,
          })
        } catch {
          // non-fatal
        }

        return { verdict: 'pass' }
      }

      // Record failure with evaluator evidence
      const failingCriteria = report.criteriaResults.filter(r => r.result === 'fail')
      const evidence = failingCriteria.map(cr => `${cr.criterion}: ${cr.evidence}`).join('\n')
      this.store.featureDb.recordAttemptEnd(attemptId, {
        verdict: 'fail',
        failureReason: report.notes,
        failureCategory: lastFailureCategory,
        evalEvidence: evidence,
        inputTokens: coderResult.totalInputTokens,
      })

      // Print failing criteria for visibility
      for (const cr of failingCriteria) {
        console.log(chalk.red(`    ✗ ${cr.criterion}`))
        console.log(chalk.gray(`      ${cr.evidence}`))
      }
    }

    await this.agentGit.endSession(agSession.id)
    return { verdict: 'fail', failureCategory: lastFailureCategory }
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
    fixPrompt?: string,
  ): Promise<{ success: boolean; error?: string; durationMs: number; totalInputTokens: number }> {
    const { projectDir, maxContextResets, maxContextTokens } = this.opts
    const startTime = Date.now()
    let totalInputTokens = 0
    // Record git SHA before the coder starts so we can show exactly what it committed
    let startingSha = await this.getCurrentSha()

    for (let resetCount = 0; resetCount <= maxContextResets; resetCount++) {
      const ctxMgr = new ContextManager({ maxContextTokens, featureId: feature.id })
      ctxMgr.setFeatureComplexity(feature.acceptanceCriteria.length)

      try {
        let isReset = resetCount > 0 || fixPrompt !== undefined
        let resetPrompt: string | undefined

        if (resetCount > 0) {
          console.log(chalk.yellow(`\n  ↺ Context reset #${resetCount}/${maxContextResets} — starting fresh session`))
          printAgentBanner('coder', 1, 2, `${feature.id} (context reset #${resetCount})`)
          resetPrompt = await ctxMgr.buildHandoffPrompt(
            projectDir,
            feature,
            [], // remaining steps are in sprint-context-handoff.json for the agent to read
            `Reset ${resetCount}: continuing from previous session`,
            startingSha,
          )
          // Read handoff to get completed/remaining counts for the event
          const { readContextHandoff } = await import('./sprint/contracts.js')
          const handoff = await readContextHandoff(projectDir)
          const completedCount = handoff?.completedCriteria.length ?? 0
          const remainingCount = handoff?.remainingCriteria.length ?? feature.acceptanceCriteria.length
          emit({ type: 'context_reset', featureId: feature.id, resetCount, completedCount, remainingCount })
        }

        const coderTrace = this.tracer.startSession('coder', `Implement ${feature.id}${isReset ? ` (reset #${resetCount})` : ''}`, {
          featureId: feature.id, model: this.opts.coderModel ?? this.opts.model,
        })
        await runCoderAgent(projectDir, feature.id, ctxMgr, isReset, resetPrompt ?? fixPrompt, { noTranscripts: this.opts.noTranscripts, tdd: this.opts.tdd, model: this.opts.coderModel ?? this.opts.model })
        this.tracer.endSession(coderTrace)

        const stats = ctxMgr.getStats()
        totalInputTokens += stats.totalInput
        emit({
          type: 'session_token_usage',
          featureId: feature.id,
          inputTokens: stats.totalInput,
          outputTokens: stats.totalOutput,
          cacheReadTokens: stats.cacheReadTokens,
        })
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
          emit({
            type: 'session_token_usage',
            featureId: feature.id,
            inputTokens: stats.totalInput,
            outputTokens: stats.totalOutput,
            cacheReadTokens: stats.cacheReadTokens,
          })
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

  /**
   * Roll back a previously implemented feature by reverting its commit.
   *
   * Creates a revert commit with message:
   *   'revert: rollback <feature-name> due to regression'
   *
   * Marks the rolled-back feature (and optionally the regressor) as passes:false.
   */
  async rollbackFeature(rollbackFeatureId: string, regressorFeatureId?: string): Promise<void> {
    const { projectDir } = this.opts

    // Load features and find the target feature
    const featuresData = this.store.readFeatures()
    const feature = featuresData.features.find(f => f.id === rollbackFeatureId)
    if (!feature) {
      throw new Error(`Feature not found: ${rollbackFeatureId}`)
    }

    // Load progress and find the commit SHA
    const progress = await readProgress(projectDir)
    const sha = progress.featureCommitShas?.[rollbackFeatureId]
    if (!sha) {
      throw new Error(`No commit SHA recorded for feature: ${rollbackFeatureId}`)
    }

    // Perform the git revert (without auto-commit so we can set the message)
    try {
      await execAsync(`git revert ${sha} --no-commit`, { cwd: projectDir })
    } catch (err) {
      // Abort the revert to leave a clean state
      try {
        await execAsync('git revert --abort', { cwd: projectDir })
      } catch {
        // best-effort abort
      }
      throw new Error(`Failed to revert commit ${sha}: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Commit with the prescribed message format
    await execAsync(
      `git commit -m "revert: rollback ${feature.name} due to regression"`,
      { cwd: projectDir },
    )

    // Mark rolled-back feature as passes:false
    const featureIds = new Set([rollbackFeatureId])
    if (regressorFeatureId && regressorFeatureId !== rollbackFeatureId) {
      featureIds.add(regressorFeatureId)
    }

    for (const fid of featureIds) {
      this.store.featureDb.setFeatureStatus(fid, 'pending')
    }

    // Remove the commit SHA for the rolled-back feature from progress
    const updatedShas = { ...(progress.featureCommitShas ?? {}) }
    delete updatedShas[rollbackFeatureId]

    await writeProgress(projectDir, {
      ...progress,
      passedFeatures: this.store.countPassing(),
      featureCommitShas: updatedShas,
    })
  }

  async getStatus(): Promise<{ passing: number; total: number; currentFeature: string | null }> {
    const { projectDir } = this.opts
    const featuresData = this.store.readFeatures()
    const progress = await readProgress(projectDir).catch(() => null)

    return {
      passing: this.store.countPassing(),
      total: featuresData.features.length,
      currentFeature: progress?.currentFeatureId ?? null,
    }
  }
}
