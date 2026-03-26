#!/usr/bin/env node
import { program } from 'commander'
import chalk from 'chalk'
import { resolve, basename, dirname } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8')) as { version: string }

import { mkdir } from 'node:fs/promises'
import { Orchestrator } from './orchestrator.js'
import { createBasicScaffold } from './scaffold.js'
import { readFeaturesFile, getNextFeature, countPassing } from './state/features.js'
import { readProgress } from './state/progress.js'
import { runCoderAgent } from './agents/coder.js'
import { runEvaluatorAgent } from './agents/evaluator.js'
import { ContextManager } from './context/manager.js'
import { buildSprintContract, writeSprintContract, readEvalReport } from './sprint/contracts.js'
import { detectProjectState } from './detect.js'
import { readEvents, type QuestEvent } from './events.js'
import { computeRunCost } from './cost.js'

program
  .name('quest')
  .description('Coding agent harness — implements features using Claude agents\n\n  Run with no subcommand to auto-detect: init → run → resume based on project state.')
  .version(pkg.version)

/**
 * Default action when `quest` is run with no subcommand.
 *
 * Detects project state and dispatches to the right workflow:
 *   - No features.json       → auto init (with --plan if interactive)
 *   - Interrupted mid-feature → auto resume
 *   - Pending features        → auto run
 *   - All features pass       → print status
 */
program
  .argument('[project-dir]', 'Project directory (default: cwd)')
  .option('-c, --max-concurrency <n>', 'Maximum parallel workers (scheduler auto-adjusts)', (v) => parseInt(v, 10), 4)
  .option('-n, --max-features <n>', 'Stop after N features', (v) => parseInt(v, 10), Infinity)
  .option('-r, --retry-limit <n>', 'Max retries per failed feature', (v) => parseInt(v, 10), 2)
  .option('--plan', 'Use interactive planning for init (when auto-detected)')
  .option('-d, --description <description>', 'Project description for auto-init', '')
  .option('--dry-run', 'Print what would happen without running agents', false)
  .action(async (projectDirArg: string | undefined, opts: {
    maxConcurrency: number
    maxFeatures: number
    retryLimit: number
    plan: boolean
    description: string
    dryRun: boolean
  }) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())
    const state = await detectProjectState(projectDir)

    if (opts.dryRun) {
      console.log(chalk.gray(`[dry-run] Detected state: ${state.status}`))
      if (state.status === 'interrupted') {
        console.log(chalk.gray(`  Feature: ${state.featureId}, handoff: ${state.hasHandoff}, resets: ${state.resetCount}`))
      }
      if (state.status === 'pending' || state.status === 'complete') {
        console.log(chalk.gray(`  Progress: ${state.passing}/${state.total}`))
      }
      return
    }

    switch (state.status) {
      case 'uninitialized': {
        console.log(chalk.blue('No features.json found — initializing project...\n'))
        const projectName = basename(projectDir)
        const orch = new Orchestrator({ projectDir })

        if (opts.plan) {
          const { runPlanningSession } = await import('./planner.js')
          const plan = await runPlanningSession(opts.description || undefined)
          await orch.initialize(plan.featureGenerationContext, plan.projectName, plan)
        } else {
          await createBasicScaffold(projectDir, projectName)
          console.log(chalk.green(`✓ Initialized project "${projectName}" in ${projectDir}`))
          console.log(chalk.gray('  Created: init.sh, features.json, claude-progress.txt'))
        }

        // After init, check if we should continue to run
        const postInit = await detectProjectState(projectDir)
        if (postInit.status === 'pending') {
          console.log(chalk.blue('\nStarting feature implementation...\n'))
          const runOrch = new Orchestrator({
            projectDir,
            maxFeatures: opts.maxFeatures,
            retryLimit: opts.retryLimit,
            maxConcurrency: opts.maxConcurrency,
          })
          await runOrch.run()
        }
        break
      }

      case 'interrupted': {
        const resumeMsg = state.hasHandoff
          ? `Resuming interrupted feature: ${state.featureId} (context reset #${state.resetCount})`
          : `Resuming interrupted feature: ${state.featureId}`
        console.log(chalk.yellow(`${resumeMsg}\n`))

        const orch = new Orchestrator({
          projectDir,
          maxFeatures: opts.maxFeatures,
          retryLimit: opts.retryLimit,
          maxConcurrency: opts.maxConcurrency,
        })
        await orch.resume()
        break
      }

      case 'pending': {
        console.log(chalk.blue(`${state.passing}/${state.total} features passing — continuing...\n`))
        const orch = new Orchestrator({
          projectDir,
          maxFeatures: opts.maxFeatures,
          retryLimit: opts.retryLimit,
          maxConcurrency: opts.maxConcurrency,
        })
        await orch.run()
        break
      }

      case 'complete': {
        console.log(chalk.green(`\n✅ All ${state.total} features passing. Nothing to do.`))
        console.log(chalk.gray('  Run quest status --show-all for details.'))
        break
      }
    }
  })

/**
 * quest init [project-dir]
 *
 * Run the initializer agent to set up scaffold files in a project directory.
 * Creates init.sh, features.json, and claude-progress.txt.
 */
program
  .command('init [project-dir]')
  .description('Initialize a project explicitly (auto-detected by default `quest` command)')
  .option('-n, --project-name <name>', 'Project name (default: directory name)')
  .option('-d, --description <description>', 'Project description for feature generation', '')
  .option('--plan', 'Run interactive planning session before generating features')
  .action(async (projectDirArg: string | undefined, opts: { projectName?: string; description: string; plan: boolean }) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())

    // Create directory if it doesn't exist
    if (!existsSync(projectDir)) {
      await mkdir(projectDir, { recursive: true })
    }

    const projectName = opts.projectName ?? basename(projectDir)
    const orch = new Orchestrator({ projectDir })

    try {
      if (opts.plan) {
        // Interactive planning phase — Claude asks questions until human approves
        const { runPlanningSession } = await import('./planner.js')
        const plan = await runPlanningSession(opts.description || undefined)
        await orch.initialize(plan.featureGenerationContext, plan.projectName, plan)
      } else {
        // Default: create scaffold files directly (no AI agent required)
        await createBasicScaffold(projectDir, projectName)
        console.log(chalk.green(`✓ Initialized project "${projectName}" in ${projectDir}`))
        console.log(chalk.gray('  Created: init.sh, features.json, claude-progress.txt'))
        console.log(chalk.gray('  Run `quest run` to start implementing features.'))
      }
    } catch (err) {
      console.error(chalk.red('Initialization failed:'), err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })

/**
 * quest run [project-dir]
 *
 * Start the full orchestration loop. Implements features one at a time
 * until all pass or limits are reached.
 */
program
  .command('run [project-dir]')
  .description('Run the orchestration loop explicitly (auto-inits if needed)')
  .option('-n, --max-features <n>', 'Stop after N features', (v) => parseInt(v, 10), Infinity)
  .option('-r, --retry-limit <n>', 'Max retries per failed feature', (v) => parseInt(v, 10), 2)
  .option('-c, --max-concurrency <n>', 'Maximum parallel workers (scheduler auto-adjusts)', (v) => parseInt(v, 10), 4)
  .option('--max-resets <n>', 'Max context resets per feature before giving up', (v) => parseInt(v, 10), 5)
  .option('--max-context <tokens>', 'Maximum context window tokens for dynamic budgeting (default: 200000)', (v) => parseInt(v, 10), 200_000)
  .option('--dry-run', 'Print plan without running agents', false)
  .option('--review', 'Run code review between coder and evaluator (checks security, error handling, duplication, naming, style)', false)
  .option('--skip-init', 'Skip running init.sh (for environments where setup is manual)', false)
  .option('--health-timeout <seconds>', 'Timeout in seconds for health check polling after init.sh (default: 30)', (v) => parseInt(v, 10), 30)
  .action(async (projectDirArg: string | undefined, opts: { maxFeatures: number; retryLimit: number; maxConcurrency: number; maxResets: number; maxContext: number; dryRun: boolean; review: boolean; skipInit: boolean; healthTimeout: number }) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())

    // Auto-init if project has no features.json
    const state = await detectProjectState(projectDir)
    if (state.status === 'uninitialized') {
      console.log(chalk.blue('No features.json found — running scaffold init first...\n'))
      const projectName = basename(projectDir)
      await createBasicScaffold(projectDir, projectName)
      console.log(chalk.green(`✓ Initialized "${projectName}"\n`))
    }

    const orch = new Orchestrator({
      projectDir,
      maxFeatures: opts.maxFeatures,
      retryLimit: opts.retryLimit,
      maxConcurrency: opts.maxConcurrency,
      maxContextResets: opts.maxResets,
      maxContextTokens: opts.maxContext,
      dryRun: opts.dryRun,
      review: opts.review,
      skipInit: opts.skipInit,
      healthTimeout: opts.healthTimeout,
    })

    try {
      await orch.run()
    } catch (err) {
      console.error(chalk.red('Run failed:'), err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })

/**
 * quest resume [project-dir]
 *
 * Resume from the last known progress (reads claude-progress.txt).
 */
program
  .command('resume [project-dir]')
  .description('Resume from last progress explicitly (auto-detected by default `quest` command)')
  .option('-n, --max-features <n>', 'Stop after N more features', (v) => parseInt(v, 10), Infinity)
  .option('-c, --max-concurrency <n>', 'Maximum parallel workers (scheduler auto-adjusts)', (v) => parseInt(v, 10), 4)
  .action(async (projectDirArg: string | undefined, opts: { maxFeatures: number; maxConcurrency: number }) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())
    const orch = new Orchestrator({ projectDir, maxFeatures: opts.maxFeatures, maxConcurrency: opts.maxConcurrency })

    try {
      await orch.resume()
    } catch (err) {
      console.error(chalk.red('Resume failed:'), err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })

/**
 * quest status [project-dir]
 *
 * Print a summary of the current project state.
 */
program
  .command('status [project-dir]')
  .description('Show progress summary (features passing, current feature, etc.)')
  .option('--show-all', 'Show all features, not just pending', false)
  .option('--failures', 'Show a summary table of failures grouped by category', false)
  .option('--cost', 'Show total estimated API cost for the run, broken down by agent type', false)
  .action(async (projectDirArg: string | undefined, opts: { showAll: boolean; failures: boolean; cost: boolean }) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())

    try {
      if (opts.cost) {
        // Show cost breakdown from quest-events.jsonl
        const costEvents = readEvents(projectDir)
        const costSummary = computeRunCost(costEvents)

        if (costSummary.byAgent.length === 0) {
          console.log(chalk.gray('\nNo cost data found in quest-events.jsonl.\n'))
          console.log(chalk.gray('Run `quest run` to generate cost data.'))
          return
        }

        console.log(chalk.bold(`\nEstimated API Cost\n`))
        console.log(chalk.bold(`Total: ${chalk.green(`$${costSummary.totalCostUsd.toFixed(4)}`)} USD\n`))

        // Print table header
        const colW = [10, 14, 14, 14, 12]
        const header = [
          'Agent'.padEnd(colW[0]),
          'Input Tokens'.padEnd(colW[1]),
          'Output Tokens'.padEnd(colW[2]),
          'Cache Reads'.padEnd(colW[3]),
          'Cost (USD)',
        ].join('  ')
        console.log(chalk.bold(header))
        console.log('-'.repeat(header.length))

        for (const breakdown of costSummary.byAgent) {
          const agentColor =
            breakdown.agent === 'coder' ? chalk.cyan :
            breakdown.agent === 'eval' ? chalk.magenta :
            breakdown.agent === 'init' ? chalk.blue :
            chalk.gray
          console.log(
            agentColor(breakdown.agent.padEnd(colW[0])) + '  ' +
            String(breakdown.inputTokens).padEnd(colW[1]) + '  ' +
            String(breakdown.outputTokens).padEnd(colW[2]) + '  ' +
            String(breakdown.cacheReadTokens).padEnd(colW[3]) + '  ' +
            chalk.green(`$${breakdown.estimatedUsd.toFixed(4)}`),
          )
        }
        console.log()
        return
      }

      if (opts.failures) {
        // Show failures grouped by category from quest-events.jsonl
        const events = readEvents(projectDir)
        type FeatureDoneEvent = Extract<QuestEvent, { type: 'feature_done' }>
        const failEvents = events.filter(
          (e): e is FeatureDoneEvent => e.type === 'feature_done' && e.verdict === 'fail',
        )

        if (failEvents.length === 0) {
          console.log(chalk.green('\nNo failures recorded in quest-events.jsonl.\n'))
          return
        }

        // Group by category
        const byCategory = new Map<string, string[]>()
        for (const ev of failEvents) {
          const cat = ev.failureCategory ?? 'unknown'
          if (!byCategory.has(cat)) byCategory.set(cat, [])
          byCategory.get(cat)!.push(ev.featureId)
        }

        console.log(chalk.bold(`\nFailure Summary (${failEvents.length} total)\n`))

        // Print table header
        const colW = [20, 8, 40]
        const header = [
          'Category'.padEnd(colW[0]),
          'Count'.padEnd(colW[1]),
          'Features',
        ].join('  ')
        console.log(chalk.bold(header))
        console.log('-'.repeat(header.length))

        const categoryOrder = ['timeout', 'tool_error', 'logic_bug', 'external_dep', 'context_exhaustion', 'unknown']
        const sortedCategories = [...byCategory.keys()].sort(
          (a, b) => categoryOrder.indexOf(a) - categoryOrder.indexOf(b),
        )

        for (const cat of sortedCategories) {
          const featureIds = byCategory.get(cat)!
          const countStr = String(featureIds.length).padEnd(colW[1])
          const featuresStr = featureIds.slice(0, 3).join(', ') + (featureIds.length > 3 ? ` +${featureIds.length - 3} more` : '')
          const catColor =
            cat === 'timeout' ? chalk.yellow :
            cat === 'tool_error' ? chalk.magenta :
            cat === 'logic_bug' ? chalk.red :
            cat === 'external_dep' ? chalk.cyan :
            cat === 'context_exhaustion' ? chalk.blue :
            chalk.gray
          console.log(
            catColor(cat.padEnd(colW[0])) + '  ' +
            countStr + '  ' +
            chalk.gray(featuresStr),
          )
        }
        console.log()
        return
      }

      const featuresData = await readFeaturesFile(projectDir)
      const progress = await readProgress(projectDir).catch(() => null)
      const passing = countPassing(featuresData.features)
      const total = featuresData.features.length
      const pct = total > 0 ? Math.round((passing / total) * 100) : 0

      console.log(chalk.bold(`\n${featuresData.projectName}`))
      console.log(`Progress: ${chalk.green(passing)}/${chalk.white(total)} features (${pct}%)`)

      if (progress?.currentFeatureId) {
        console.log(`Current:  ${chalk.yellow(progress.currentFeatureId)}`)
      }
      if (progress?.contextResets) {
        console.log(`Resets:   ${progress.contextResets}`)
      }

      const pending = featuresData.features.filter(f => !f.passes)
      const next = getNextFeature(featuresData.features)
      if (next) {
        console.log(`\nNext up:  ${chalk.blue(next.id)} (${next.priority} priority)`)
        console.log(`          ${next.description}`)
      }

      if (opts.showAll) {
        console.log('\nAll features:')
        for (const f of featuresData.features) {
          const icon = f.passes ? chalk.green('✓') : chalk.gray('○')
          const pri = f.priority === 'high' ? chalk.red(f.priority) : f.priority === 'medium' ? chalk.yellow(f.priority) : chalk.gray(f.priority)
          console.log(`  ${icon} [${pri}] ${f.id}`)
        }
      } else if (pending.length > 0) {
        console.log(`\nPending (${pending.length}):`)
        for (const f of pending.slice(0, 10)) {
          const pri = f.priority === 'high' ? chalk.red(f.priority) : f.priority === 'medium' ? chalk.yellow(f.priority) : chalk.gray(f.priority)
          console.log(`  ○ [${pri}] ${f.id}`)
        }
        if (pending.length > 10) {
          console.log(chalk.gray(`  ... and ${pending.length - 10} more`))
        }
      }
      console.log()
    } catch (err) {
      console.error(chalk.red('Status failed:'), err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })

/**
 * quest eval <feature-id> [project-dir]
 *
 * Run only the evaluator for a specific feature.
 * Useful for debugging or re-evaluating after manual fixes.
 */
program
  .command('eval <feature-id> [project-dir]')
  .description('Run the evaluator for a specific feature (useful for debugging)')
  .action(async (featureId: string, projectDirArg: string | undefined) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())

    console.log(chalk.blue(`Evaluating: ${featureId}`))

    const ctxMgr = new ContextManager()
    const result = await runEvaluatorAgent(projectDir, featureId, ctxMgr)

    if (!result.success) {
      console.error(chalk.red('Evaluator failed:'), result.error)
      process.exit(1)
    }

    const report = await readEvalReport(projectDir)
    if (!report) {
      console.error(chalk.red('Evaluator did not write eval-report.json'))
      process.exit(1)
    }

    const verdictColor = report.verdict === 'pass' ? chalk.green : chalk.red
    console.log(`\nVerdict: ${verdictColor(report.verdict.toUpperCase())}`)
    console.log(`Notes: ${report.notes}`)
    console.log('\nCriteria:')
    for (const cr of report.criteriaResults) {
      const icon = cr.result === 'pass' ? chalk.green('✓') : chalk.red('✗')
      console.log(`  ${icon} ${cr.criterion}`)
      console.log(chalk.gray(`    ${cr.evidence}`))
    }
  })

/**
 * quest feature <feature-id> [project-dir]
 *
 * Implement a single feature without running the evaluator.
 * Useful for manual inspection and debugging.
 */
program
  .command('feature <feature-id> [project-dir]')
  .description('Implement a single feature without evaluation (for debugging)')
  .action(async (featureId: string, projectDirArg: string | undefined) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())

    // Write sprint contract from features.json
    const featuresData = await readFeaturesFile(projectDir)
    const feature = featuresData.features.find(f => f.id === featureId)
    if (!feature) {
      console.error(chalk.red(`Feature not found: ${featureId}`))
      process.exit(1)
    }

    const contract = buildSprintContract(feature)
    await writeSprintContract(projectDir, contract)

    console.log(chalk.blue(`Implementing: ${featureId}`))
    console.log(chalk.gray(`  ${feature.description}`))

    const ctxMgr = new ContextManager()
    const result = await runCoderAgent(projectDir, featureId, ctxMgr)

    if (!result.success) {
      console.error(chalk.red('Coder failed:'), result.error)
      process.exit(1)
    }

    const stats = ctxMgr.getStats()
    console.log(
      chalk.green(
        `✓ Done in ${(result.durationMs / 1000).toFixed(1)}s | tokens: ${stats.totalInput}↑ ${stats.totalOutput}↓`,
      ),
    )
    console.log(chalk.yellow('Note: evaluator not run — use quest eval to verify'))
  })

/**
 * quest monitor [project-dir]
 *
 * Live TUI dashboard showing agent activity and feature history.
 * Run in a separate terminal while `quest run` is executing.
 *
 * Historical runs: replays quest-events.jsonl from the project directory.
 * Live updates: polls quest-events.jsonl every 500ms for new events.
 */
program
  .command('monitor [project-dir]')
  .description('Live TUI dashboard — shows agent activity, tool calls, and feature history')
  .action(async (projectDirArg: string | undefined) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())

    if (!existsSync(projectDir)) {
      console.error(chalk.red(`Directory does not exist: ${projectDir}`))
      process.exit(1)
    }

    const { renderMonitor } = await import('./tui/monitor.js')
    renderMonitor(projectDir)
  })

/**
 * quest traces [project-dir]
 *
 * List all recorded LLM sessions with their topics, agents, token usage, and timing.
 */
program
  .command('traces [project-dir]')
  .description('List all recorded LLM sessions (agent, topic, tokens, duration)')
  .option('-a, --agent <type>', 'Filter by agent type (init, coder, eval, planner)')
  .option('-f, --feature <id>', 'Filter by feature ID')
  .action(async (projectDirArg: string | undefined, opts: { agent?: string; feature?: string }) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())
    const { Tracer } = await import('./trace.js')
    const tracer = new Tracer(projectDir)
    let sessions = tracer.readIndex()

    if (opts.agent) {
      sessions = sessions.filter(s => s.agent === opts.agent)
    }
    if (opts.feature) {
      sessions = sessions.filter(s => s.featureId === opts.feature)
    }

    if (sessions.length === 0) {
      console.log(chalk.gray('No trace sessions found.'))
      console.log(chalk.gray('Traces are recorded automatically during quest run.'))
      return
    }

    console.log(chalk.bold(`\n${sessions.length} LLM sessions:\n`))
    for (const s of sessions) {
      const duration = s.endedAt
        ? `${((new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 1000).toFixed(0)}s`
        : 'running'
      const tokens = `${s.totalInputTokens}↑ ${s.totalOutputTokens}↓`
      const worker = s.workerId ? chalk.yellow(` W${s.workerId}`) : ''
      const agentColor = s.agent === 'coder' ? chalk.cyan : s.agent === 'eval' ? chalk.magenta : chalk.blue
      console.log(
        `  ${agentColor(`[${s.agent}]`)}${worker} ${s.topic}` +
        chalk.gray(` — ${s.turns} turns, ${tokens}, ${duration}`),
      )
      console.log(chalk.gray(`    ${s.sessionId}`))
    }
    console.log()
  })

/**
 * quest inspect <session-id> [project-dir]
 *
 * Show the full LLM trace for a session — every turn, tool call, and response.
 */
program
  .command('inspect <session-id> [project-dir]')
  .description('Show full LLM trace for a session (all turns, tool calls, responses)')
  .action(async (sessionId: string, projectDirArg: string | undefined) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())
    const { Tracer, formatSessionTrace } = await import('./trace.js')
    const tracer = new Tracer(projectDir)

    // Allow partial session ID match
    const index = tracer.readIndex()
    const match = index.find(s => s.sessionId === sessionId || s.sessionId.startsWith(sessionId))
    if (!match) {
      console.error(chalk.red(`Session not found: ${sessionId}`))
      console.error(chalk.gray('Run quest traces to see available sessions.'))
      process.exit(1)
    }

    const entries = tracer.readSession(match.sessionId)
    if (entries.length === 0) {
      console.error(chalk.red(`No trace entries found for session: ${match.sessionId}`))
      process.exit(1)
    }

    console.log('\n' + formatSessionTrace(match, entries) + '\n')
  })

program.parse()
