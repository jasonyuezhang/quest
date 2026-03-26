#!/usr/bin/env node
import { program } from 'commander'
import chalk from 'chalk'
import { resolve, basename } from 'node:path'
import { existsSync } from 'node:fs'

import { Orchestrator } from './orchestrator.js'
import { readFeaturesFile, getNextFeature, countPassing } from './state/features.js'
import { readProgress } from './state/progress.js'
import { runCoderAgent } from './agents/coder.js'
import { runEvaluatorAgent } from './agents/evaluator.js'
import { ContextManager } from './context/manager.js'
import { buildSprintContract, writeSprintContract, readEvalReport } from './sprint/contracts.js'

program
  .name('quest')
  .description('Coding agent harness — implements features using Claude agents')
  .version('0.1.0')

/**
 * quest init [project-dir]
 *
 * Run the initializer agent to set up scaffold files in a project directory.
 * Creates init.sh, features.json, and claude-progress.txt.
 */
program
  .command('init [project-dir]')
  .description('Initialize a project with the Quest harness (creates init.sh, features.json, claude-progress.txt)')
  .option('-n, --project-name <name>', 'Project name (default: directory name)')
  .option('-d, --description <description>', 'Project description for feature generation', '')
  .action(async (projectDirArg: string | undefined, opts: { projectName?: string; description: string }) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())

    if (!existsSync(projectDir)) {
      console.error(chalk.red(`Directory does not exist: ${projectDir}`))
      process.exit(1)
    }

    const projectName = opts.projectName ?? basename(projectDir)
    const orch = new Orchestrator({ projectDir })

    try {
      await orch.initialize(opts.description, projectName)
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
  .description('Run the full orchestration loop (init if needed, then implement features)')
  .option('-n, --max-features <n>', 'Stop after N features', (v) => parseInt(v, 10), Infinity)
  .option('-r, --retry-limit <n>', 'Max retries per failed feature', (v) => parseInt(v, 10), 2)
  .option('--max-resets <n>', 'Max context resets per feature before giving up', (v) => parseInt(v, 10), 5)
  .option('--dry-run', 'Print plan without running agents', false)
  .action(async (projectDirArg: string | undefined, opts: { maxFeatures: number; retryLimit: number; maxResets: number; dryRun: boolean }) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())
    const orch = new Orchestrator({
      projectDir,
      maxFeatures: opts.maxFeatures,
      retryLimit: opts.retryLimit,
      maxContextResets: opts.maxResets,
      dryRun: opts.dryRun,
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
  .description('Resume the orchestration loop from last known progress')
  .option('-n, --max-features <n>', 'Stop after N more features', (v) => parseInt(v, 10), Infinity)
  .action(async (projectDirArg: string | undefined, opts: { maxFeatures: number }) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())
    const orch = new Orchestrator({ projectDir, maxFeatures: opts.maxFeatures })

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
  .action(async (projectDirArg: string | undefined, opts: { showAll: boolean }) => {
    const projectDir = resolve(projectDirArg ?? process.cwd())

    try {
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

program.parse()
