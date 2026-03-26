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
  .option('--no-transcripts', 'Disable session transcript capture to save disk space', false)
  .option('--skip-regression', 'Skip regression checks in evaluator for speed during development', false)
  .option('--tdd', 'Enable Test-Driven Development mode: coder writes failing tests first, then implements (red-green-refactor)', false)
  .option('--no-evidence', 'Disable evidence capture (screenshots, console/network errors) to speed up evaluation', false)
  .option('--coder-model <model>', 'Model to use for the coder agent (claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5)')
  .option('--evaluator-model <model>', 'Model to use for the evaluator agent (claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5)')
  .option('--webhook <url>', 'Send POST notifications on feature_done and run_complete events to this URL')
  .option('--notify <channel>', 'Send formatted notifications to a channel (currently: slack). Slack URL read from QUEST_SLACK_WEBHOOK env var')
  .action(async (projectDirArg: string | undefined, opts: { maxFeatures: number; retryLimit: number; maxConcurrency: number; maxResets: number; maxContext: number; dryRun: boolean; review: boolean; skipInit: boolean; healthTimeout: number; noTranscripts: boolean; skipRegression: boolean; tdd: boolean; evidence: boolean; coderModel?: string; evaluatorModel?: string; webhook?: string; notify?: string }) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())

    // Validate models if provided
    const { SUPPORTED_MODELS } = await import('./agents/types.js')
    if (opts.coderModel && !SUPPORTED_MODELS.includes(opts.coderModel as typeof SUPPORTED_MODELS[number])) {
      console.error(chalk.red(`Unsupported coder model: ${opts.coderModel}`))
      console.error(chalk.gray(`Supported models: ${SUPPORTED_MODELS.join(', ')}`))
      process.exit(1)
    }
    if (opts.evaluatorModel && !SUPPORTED_MODELS.includes(opts.evaluatorModel as typeof SUPPORTED_MODELS[number])) {
      console.error(chalk.red(`Unsupported evaluator model: ${opts.evaluatorModel}`))
      console.error(chalk.gray(`Supported models: ${SUPPORTED_MODELS.join(', ')}`))
      process.exit(1)
    }

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
      noTranscripts: opts.noTranscripts,
      skipRegression: opts.skipRegression,
      tdd: opts.tdd,
      noEvidence: !opts.evidence,
      coderModel: opts.coderModel,
      evaluatorModel: opts.evaluatorModel,
      webhookUrl: opts.webhook,
      notify: opts.notify,
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
  .option('--config', 'Show active model configuration for each agent', false)
  .action(async (projectDirArg: string | undefined, opts: { showAll: boolean; failures: boolean; cost: boolean; config: boolean }) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())

    try {
      if (opts.config) {
        // Show active model configuration from .quest/config.json + defaults
        const { join } = await import('node:path')
        const configPath = join(projectDir, '.quest', 'config.json')
        let fileConfig: { models?: { coder?: string; evaluator?: string; reviewer?: string; planner?: string } } = {}
        if (existsSync(configPath)) {
          try {
            fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
          } catch {
            fileConfig = {}
          }
        }
        const models = fileConfig.models ?? {}
        const defaultModel = 'claude-sonnet-4-6'

        console.log(chalk.bold('\nActive Model Configuration\n'))
        const agents = [
          { name: 'coder', model: models.coder ?? defaultModel, source: models.coder ? 'config' : 'default' },
          { name: 'evaluator', model: models.evaluator ?? defaultModel, source: models.evaluator ? 'config' : 'default' },
          { name: 'reviewer', model: models.reviewer ?? defaultModel, source: models.reviewer ? 'config' : 'default' },
          { name: 'planner', model: models.planner ?? defaultModel, source: models.planner ? 'config' : 'default' },
        ]
        for (const a of agents) {
          const sourceTag = a.source === 'config' ? chalk.green(' (from .quest/config.json)') : chalk.gray(' (default)')
          console.log(`  ${chalk.cyan(a.name.padEnd(10))} ${a.model}${sourceTag}`)
        }
        if (existsSync(configPath)) {
          console.log(chalk.gray(`\n  Config file: ${configPath}`))
        } else {
          console.log(chalk.gray(`\n  No .quest/config.json found — using defaults`))
          console.log(chalk.gray(`  Create ${join(projectDir, '.quest', 'config.json')} to customize models:`))
          console.log(chalk.gray('  { "models": { "coder": "claude-opus-4-6", "evaluator": "claude-haiku-4-5" } }'))
        }
        console.log()
        return
      }

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

      // Show refined features section (features created by quest refine)
      const refinedFeatures = featuresData.features.filter(f => f.refinedFrom !== undefined)
      if (refinedFeatures.length > 0) {
        console.log(`\nRefined (${refinedFeatures.length}):`)
        for (const f of refinedFeatures) {
          const icon = f.passes ? chalk.green('✓') : chalk.gray('○')
          const actionColor =
            f.refinedAction === 'split' ? chalk.yellow :
            f.refinedAction === 'merge' ? chalk.cyan :
            chalk.magenta
          const action = actionColor(f.refinedAction ?? 'refined')
          console.log(`  ${icon} ${f.id} ${chalk.gray('←')} ${action} from ${chalk.gray(f.refinedFrom)}`)
        }
      }

      if (opts.showAll) {
        console.log('\nAll features:')
        for (const f of featuresData.features) {
          const icon = f.passes ? chalk.green('✓') : chalk.gray('○')
          const pri = f.priority === 'high' ? chalk.red(f.priority) : f.priority === 'medium' ? chalk.yellow(f.priority) : chalk.gray(f.priority)
          const refinedTag = f.refinedFrom ? chalk.gray(` [${f.refinedAction ?? 'refined'} from ${f.refinedFrom}]`) : ''
          console.log(`  ${icon} [${pri}] ${f.id}${refinedTag}`)
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
  .option('--no-evidence', 'Disable evidence capture (screenshots, console/network errors) to speed up evaluation', false)
  .action(async (featureId: string, projectDirArg: string | undefined, opts: { evidence: boolean }) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())
    const noEvidence = !opts.evidence

    console.log(chalk.blue(`Evaluating: ${featureId}`))
    if (noEvidence) {
      console.log(chalk.gray('  Evidence capture disabled (--no-evidence)'))
    }

    const ctxMgr = new ContextManager()
    const result = await runEvaluatorAgent(projectDir, featureId, ctxMgr, undefined, { noEvidence })

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
 * quest inspect <feature-id|session-id> [project-dir]
 *
 * Show the latest transcript for a feature, or the full LLM trace for a session.
 *
 * If the argument matches a feature ID (transcript found), the transcript is shown.
 * Otherwise falls back to LLM trace lookup by session ID.
 */
program
  .command('inspect <feature-id> [project-dir]')
  .description('Show latest transcript for a feature, or full LLM trace for a session ID')
  .action(async (featureIdOrSessionId: string, projectDirArg: string | undefined) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())
    const { TranscriptCapture, formatTranscript } = await import('./transcript.js')

    // Try to find a transcript for this feature ID first
    const transcriptPath = TranscriptCapture.findLatest(projectDir, featureIdOrSessionId)
    if (transcriptPath) {
      // Extract agent name from filename: <featureId>-<agent>-<timestamp>.jsonl
      const filename = transcriptPath.split('/').pop() ?? ''
      const parts = filename.replace('.jsonl', '').split('-')
      // feature-id may have dashes, so agent is the second-to-last part before timestamp
      // filename format: <featureId>-<agent>-<YYYY>-<MM>-...
      // Find agent by matching known agent labels
      const agentLabels = ['coder', 'eval', 'planner', 'init', 'reviewer']
      const agentPart = parts.find(p => agentLabels.includes(p)) ?? 'unknown'

      console.log('\n' + formatTranscript(transcriptPath, featureIdOrSessionId, agentPart) + '\n')

      // Show evidence (screenshots and error logs) if available
      const evidenceDir = resolve(projectDir, '.quest', 'evidence', featureIdOrSessionId)
      if (existsSync(evidenceDir)) {
        const { readdirSync } = await import('node:fs')
        const files = readdirSync(evidenceDir)
        if (files.length > 0) {
          console.log(chalk.bold(`\nEvidence: .quest/evidence/${featureIdOrSessionId}/`))
          for (const file of files.sort()) {
            const filePath = resolve(evidenceDir, file)
            if (file.endsWith('.png') || file.endsWith('.jpg')) {
              console.log(chalk.cyan(`  📷 ${file}`) + chalk.gray(` — ${filePath}`))
            } else if (file.endsWith('.json') || file.endsWith('.txt') || file.endsWith('.log')) {
              const { readFileSync } = await import('node:fs')
              const content = readFileSync(filePath, 'utf-8')
              console.log(chalk.yellow(`  📋 ${file}:`))
              console.log(chalk.gray(content.split('\n').map(l => `    ${l}`).join('\n')))
            } else {
              console.log(chalk.gray(`  ${file}`))
            }
          }
          console.log()
        }
      }

      // Also show consoleErrors and networkErrors from eval-report.json if available
      const evalReport = await readEvalReport(projectDir)
      if (evalReport && evalReport.featureId === featureIdOrSessionId) {
        if (evalReport.consoleErrors && evalReport.consoleErrors.length > 0) {
          console.log(chalk.bold('Console Errors:'))
          for (const err of evalReport.consoleErrors) {
            console.log(chalk.red(`  ✗ ${err}`))
          }
          console.log()
        }
        if (evalReport.networkErrors && evalReport.networkErrors.length > 0) {
          console.log(chalk.bold('Network Errors:'))
          for (const err of evalReport.networkErrors) {
            console.log(chalk.red(`  ✗ ${err}`))
          }
          console.log()
        }
      }

      return
    }

    // Fall back to LLM trace lookup
    const { Tracer, formatSessionTrace } = await import('./trace.js')
    const tracer = new Tracer(projectDir)

    // Allow partial session ID match
    const index = tracer.readIndex()
    const match = index.find(s => s.sessionId === featureIdOrSessionId || s.sessionId.startsWith(featureIdOrSessionId))
    if (!match) {
      console.error(chalk.red(`No transcript or session found for: ${featureIdOrSessionId}`))
      console.error(chalk.gray('Transcripts are stored in .quest/transcripts/'))
      console.error(chalk.gray('Run quest traces to see available LLM sessions.'))
      process.exit(1)
    }

    const entries = tracer.readSession(match.sessionId)
    if (entries.length === 0) {
      console.error(chalk.red(`No trace entries found for session: ${match.sessionId}`))
      process.exit(1)
    }

    console.log('\n' + formatSessionTrace(match, entries) + '\n')
  })

/**
 * quest clean [project-dir]
 *
 * Remove all session transcripts from .quest/transcripts/.
 */
program
  .command('clean [project-dir]')
  .description('Remove all session transcripts from .quest/transcripts/')
  .action(async (projectDirArg: string | undefined) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())
    const { TranscriptCapture } = await import('./transcript.js')
    const count = TranscriptCapture.cleanAll(projectDir)
    if (count === 0) {
      console.log(chalk.gray('No transcripts to clean.'))
    } else {
      console.log(chalk.green(`✓ Removed ${count} transcript${count === 1 ? '' : 's'} from .quest/transcripts/`))
    }

    // Also clean up evidence directory
    const evidenceDir = resolve(projectDir, '.quest', 'evidence')
    if (existsSync(evidenceDir)) {
      const { rmSync } = await import('node:fs')
      rmSync(evidenceDir, { recursive: true, force: true })
      console.log(chalk.green(`✓ Removed evidence directory .quest/evidence/`))
    }
  })

/**
 * quest report [project-dir]
 *
 * Generate a human-readable report from the latest run's quest-events.jsonl.
 * Supports markdown (default), JSON, and HTML formats.
 * Output is written to .quest/reports/<timestamp>.<ext>.
 */
program
  .command('report [project-dir]')
  .description('Generate a run summary report from quest-events.jsonl (markdown, json, or html)')
  .option('--format <fmt>', 'Output format: markdown (default), json, or html', 'markdown')
  .action(async (projectDirArg: string | undefined, opts: { format: string }) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())

    if (!existsSync(projectDir)) {
      console.error(chalk.red(`Directory does not exist: ${projectDir}`))
      process.exit(1)
    }

    const fmt = opts.format.toLowerCase()
    if (fmt !== 'markdown' && fmt !== 'json' && fmt !== 'html') {
      console.error(chalk.red(`Unsupported format: ${opts.format}`))
      console.error(chalk.gray('Supported formats: markdown, json, html'))
      process.exit(1)
    }

    const { generateReport } = await import('./report.js')

    try {
      const reportPath = generateReport(projectDir, fmt as 'markdown' | 'json' | 'html')
      console.log(chalk.green(`✓ Report written to: ${reportPath}`))
    } catch (err) {
      console.error(chalk.red('Report generation failed:'), err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })

/**
 * quest refine [project-dir]
 *
 * Launch an interactive feature refinement session using the current features.json.
 * Uses Claude to analyse the feature list and failure patterns, then suggests:
 *   - Splitting large features into focused sub-features (parent ID as prefix)
 *   - Merging small related features (combining acceptance criteria)
 *   - Reordering priorities based on failure patterns
 *
 * Passing features (passes:true) are never modified.
 */
program
  .command('refine [project-dir]')
  .description('Iteratively refine the feature list: split, merge, and reorder features using AI analysis')
  .option('--non-interactive', 'Apply refinements without asking for confirmation', false)
  .action(async (projectDirArg: string | undefined, opts: { nonInteractive: boolean }) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())

    if (!existsSync(projectDir)) {
      console.error(chalk.red(`Directory does not exist: ${projectDir}`))
      process.exit(1)
    }

    const featuresPath = resolve(projectDir, 'features.json')
    if (!existsSync(featuresPath)) {
      console.error(chalk.red(`No features.json found in: ${projectDir}`))
      console.error(chalk.gray('Run quest init first to generate features.'))
      process.exit(1)
    }

    try {
      const { runRefinementSession } = await import('./refiner.js')
      await runRefinementSession(projectDir, { nonInteractive: opts.nonInteractive })
    } catch (err) {
      console.error(chalk.red('Refinement failed:'), err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })

/**
 * quest config <subcommand> [project-dir]
 *
 * Manage the .quest/config.json project configuration file.
 *
 *   quest config set <key> <value>    Update a config key
 *   quest config show                 Show merged configuration
 */
const configCmd = program
  .command('config')
  .description('Manage .quest/config.json project configuration')

configCmd
  .command('set <key> <value> [project-dir]')
  .description('Set a config key in .quest/config.json (e.g. quest config set maxConcurrency 8)')
  .action(async (key: string, value: string, projectDirArg: string | undefined) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())
    const { setConfigKey, SETTABLE_KEYS } = await import('./config.js')
    try {
      await setConfigKey(projectDir, key, value)
      console.log(chalk.green(`✓ Set ${key} = ${value} in .quest/config.json`))
    } catch (err) {
      console.error(chalk.red('Config set failed:'), err instanceof Error ? err.message : err)
      console.error(chalk.gray(`Valid keys: ${SETTABLE_KEYS.join(', ')}`))
      process.exit(1)
    }
  })

configCmd
  .command('show [project-dir]')
  .description('Display the merged configuration (defaults + .quest/config.json + CLI overrides)')
  .action(async (projectDirArg: string | undefined) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())
    const { mergeConfig, readConfigFile, getConfigPath, CONFIG_DEFAULTS } = await import('./config.js')
    const merged = mergeConfig(projectDir)
    const fileConfig = readConfigFile(projectDir)
    const configPath = getConfigPath(projectDir)
    const hasFile = existsSync(configPath)

    console.log(chalk.bold('\nMerged Configuration\n'))
    if (hasFile) {
      console.log(chalk.gray(`  Source: ${configPath}\n`))
    } else {
      console.log(chalk.gray('  No .quest/config.json found — showing defaults\n'))
    }

    const fields: Array<[string, unknown, unknown]> = [
      ['maxConcurrency', merged.maxConcurrency, CONFIG_DEFAULTS.maxConcurrency],
      ['retryLimit', merged.retryLimit, CONFIG_DEFAULTS.retryLimit],
      ['maxResets', merged.maxResets, CONFIG_DEFAULTS.maxResets],
      ['maxContext', merged.maxContext, CONFIG_DEFAULTS.maxContext],
      ['browserTestUrl', merged.browserTestUrl, CONFIG_DEFAULTS.browserTestUrl],
      ['webhookUrl', merged.webhookUrl, CONFIG_DEFAULTS.webhookUrl],
      ['tddMode', merged.tddMode, CONFIG_DEFAULTS.tddMode],
      ['reviewMode', merged.reviewMode, CONFIG_DEFAULTS.reviewMode],
    ]

    for (const [key, val, _defaultVal] of fields) {
      const fromFile = fileConfig[key as keyof typeof fileConfig] !== undefined
      const sourceTag = fromFile ? chalk.green(' (from config file)') : chalk.gray(' (default)')
      const display = val === undefined ? chalk.gray('(not set)') : String(val)
      console.log(`  ${chalk.cyan(key.padEnd(18))} ${display}${sourceTag}`)
    }

    // Show model config
    console.log(`\n  ${chalk.cyan('models')}`)
    const modelKeys = ['coder', 'evaluator', 'reviewer', 'planner'] as const
    for (const mk of modelKeys) {
      const val = merged.models?.[mk]
      const fromFile = fileConfig.models?.[mk] !== undefined
      const sourceTag = fromFile ? chalk.green(' (from config file)') : chalk.gray(' (default)')
      console.log(`    ${chalk.cyan(mk.padEnd(14))} ${val ?? chalk.gray('(not set)')}${sourceTag}`)
    }
    console.log()
  })

// ── quest rollback <feature-id> ──────────────────────────────────────────────

program
  .command('rollback <feature-id>')
  .description('Revert the implementation commit for a feature and re-queue it for re-implementation')
  .argument('[regressor-feature-id]', 'Optional: the feature that caused the regression (also re-queued)')
  .option('-d, --project-dir <dir>', 'Project directory (default: cwd)')
  .action(async (featureId: string, regressorId: string | undefined, opts: { projectDir?: string }) => {
    const projectDir = resolve(opts.projectDir ?? process.cwd())
    const orch = new Orchestrator({ projectDir })
    try {
      await orch.rollbackFeature(featureId, regressorId)
      console.log(chalk.green(`✓ Rolled back feature: ${featureId}`))
      if (regressorId && regressorId !== featureId) {
        console.log(chalk.yellow(`  Also re-queued regressor: ${regressorId}`))
      }
    } catch (err) {
      console.error(chalk.red('Rollback failed:'), err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })

/**
 * quest plugin list [project-dir]
 *
 * List installed plugins from .quest/plugins/ and show their hooks.
 */
const pluginCmd = program
  .command('plugin')
  .description('Manage Quest plugins')

pluginCmd
  .command('list [project-dir]')
  .description('List installed plugins from .quest/plugins/ and show their lifecycle hooks')
  .action(async (projectDirArg: string | undefined) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())
    const { PluginManager } = await import('./plugins.js')
    const mgr = new PluginManager(projectDir)
    await mgr.load()
    const plugins = mgr.getPlugins()

    if (plugins.length === 0) {
      console.log(chalk.gray('\nNo plugins installed.'))
      console.log(chalk.gray(`  Place .js or .ts files in ${projectDir}/.quest/plugins/ to install plugins.`))
      console.log(chalk.gray('  See docs/slack-notification-plugin.js for an example.'))
      return
    }

    console.log(chalk.bold(`\nInstalled Plugins (${plugins.length})\n`))
    for (const { plugin, file } of plugins) {
      console.log(`  ${chalk.cyan(plugin.name)}  ${chalk.gray(`(${file})`)}`)
      if (plugin.description) {
        console.log(`    ${chalk.gray(plugin.description)}`)
      }
      if (plugin.hooks.length > 0) {
        console.log(`    Hooks: ${plugin.hooks.map(h => chalk.yellow(h)).join(', ')}`)
      } else {
        console.log(`    ${chalk.gray('No hooks registered')}`)
      }
      console.log()
    }
  })

/**
 * quest retro [project-dir]
 *
 * Generate an AI-powered sprint retrospective analyzing what went well, what
 * failed, and recommendations for improving the feature list and harness config.
 * Reads quest-events.jsonl and uses Claude to produce a structured retrospective.
 * Output is written to .quest/retros/<timestamp>.md.
 */
program
  .command('retro [project-dir]')
  .description('Generate an AI-powered sprint retrospective from quest-events.jsonl')
  .action(async (projectDirArg: string | undefined) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())

    if (!existsSync(projectDir)) {
      console.error(chalk.red(`Directory does not exist: ${projectDir}`))
      process.exit(1)
    }

    const eventsPath = resolve(projectDir, 'quest-events.jsonl')
    if (!existsSync(eventsPath)) {
      console.error(chalk.red(`No quest-events.jsonl found in: ${projectDir}`))
      console.error(chalk.gray('Run quest run first to generate event data.'))
      process.exit(1)
    }

    console.log(chalk.blue('Generating sprint retrospective with Claude...'))

    const { generateRetro } = await import('./retro.js')

    try {
      const result = await generateRetro(projectDir)
      console.log(chalk.green(`✓ Retrospective written to: ${result.retroPath}`))
    } catch (err) {
      console.error(chalk.red('Retrospective generation failed:'), err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })

program.parse()
