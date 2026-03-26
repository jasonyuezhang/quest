import type { Feature, ContextHandoff } from '../agents/types.js'
import { writeContextHandoff } from '../sprint/contracts.js'
import { emit } from '../events.js'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk'

const execAsync = promisify(exec)

const DEFAULT_MAX_CONTEXT_TOKENS = 200_000
const WARNING_THRESHOLD_PCT = 0.60

export interface ContextManagerOptions {
  /** Maximum context window tokens (default: 200000) */
  maxContextTokens?: number
  /** Feature ID for event labeling */
  featureId?: string
  /** Worker ID for parallel mode */
  workerId?: number
}

/**
 * Calculate the reset threshold percentage based on feature complexity.
 * - Simple features (<=3 criteria): 85%
 * - Complex features (>5 criteria): 65%
 * - Medium features (4-5 criteria): 75%
 */
export function calculateResetThresholdPct(criteriaCount: number): number {
  if (criteriaCount <= 3) return 0.85
  if (criteriaCount > 5) return 0.65
  return 0.75
}

async function gitExec(cmd: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, { cwd })
    return stdout.trim()
  } catch {
    return ''
  }
}

export class ContextManager {
  private maxContextTokens: number
  private featureId: string | undefined
  private workerId: number | undefined
  private totalInputTokens = 0
  private totalOutputTokens = 0
  private totalCacheReadTokens = 0
  private peakContextTokens = 0
  private resetCount = 0
  private warningEmitted = false
  private criteriaCount = 0

  constructor(opts: ContextManagerOptions = {}) {
    this.maxContextTokens = opts.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS
    this.featureId = opts.featureId
    this.workerId = opts.workerId
  }

  /**
   * Set the feature complexity so the reset threshold is calculated dynamically.
   * Call this before recording any usage for accurate thresholding.
   */
  setFeatureComplexity(criteriaCount: number): void {
    this.criteriaCount = criteriaCount
  }

  /**
   * Returns the reset threshold in tokens based on feature complexity.
   */
  getResetThreshold(): number {
    const pct = calculateResetThresholdPct(this.criteriaCount)
    return Math.floor(this.maxContextTokens * pct)
  }

  /**
   * Record token usage from an SDK result message's modelUsage.
   * Usage is available on result messages (type === 'result') not assistant messages.
   * Uses ModelUsage.contextWindow for accurate context fill tracking.
   *
   * Emits a context_warning event at 60% usage as an early signal.
   */
  recordUsage(usage: ModelUsage): void {
    this.totalInputTokens += usage.inputTokens
    this.totalOutputTokens += usage.outputTokens
    this.totalCacheReadTokens += usage.cacheReadInputTokens
    // contextWindow tracks actual context fill — more accurate than inputTokens alone
    if (usage.contextWindow > this.peakContextTokens) {
      this.peakContextTokens = usage.contextWindow
    }

    // Emit early warning at 60% context usage
    const warningThreshold = Math.floor(this.maxContextTokens * WARNING_THRESHOLD_PCT)
    if (!this.warningEmitted && this.peakContextTokens >= warningThreshold) {
      this.warningEmitted = true
      const usagePct = Math.round((this.peakContextTokens / this.maxContextTokens) * 100)
      emit({
        type: 'context_warning',
        featureId: this.featureId,
        usagePct,
        contextTokens: this.peakContextTokens,
        workerId: this.workerId,
      })
    }
  }

  /**
   * Returns true when input tokens are approaching the context window limit.
   * Threshold is dynamic based on feature complexity (set via setFeatureComplexity).
   * At this point, the orchestrator should end the session and start a fresh one
   * with a structured handoff — NOT use SDK session resumption (which reattaches
   * to the same full context window).
   */
  shouldReset(): boolean {
    return this.peakContextTokens >= this.getResetThreshold()
  }

  /** Reset token counters for a new session */
  resetForNewSession(): void {
    this.totalInputTokens = 0
    this.totalOutputTokens = 0
    this.totalCacheReadTokens = 0
    this.peakContextTokens = 0
    this.warningEmitted = false
    this.resetCount++
  }

  /**
   * Build a structured handoff prompt for the next fresh session.
   *
   * @param startingSha - the git SHA recorded before the coder started this attempt,
   *   used to capture only commits made during this feature's work.
   */
  async buildHandoffPrompt(
    projectDir: string,
    feature: Feature,
    completedSteps: string[],
    partialNotes: string,
    startingSha?: string,
  ): Promise<string> {
    const remainingCriteria = feature.acceptanceCriteria.filter(
      c => !completedSteps.some(s => c.toLowerCase().includes(s.toLowerCase().slice(0, 20))),
    )

    // Get files changed since the feature started (both committed and uncommitted)
    const [modifiedUncommitted, modifiedCommitted] = await Promise.all([
      gitExec('git diff --name-only HEAD', projectDir),
      startingSha
        ? gitExec(`git diff --name-only ${startingSha}..HEAD`, projectDir)
        : gitExec('git diff --name-only HEAD~3..HEAD', projectDir),
    ])
    const modifiedFiles = [
      ...new Set([
        ...modifiedUncommitted.split('\n'),
        ...modifiedCommitted.split('\n'),
      ].filter(Boolean)),
    ]

    // Capture commits made during this feature's work
    const recentCommits = startingSha
      ? await gitExec(`git log --oneline ${startingSha}..HEAD`, projectDir)
      : await gitExec('git log --oneline -5', projectDir)

    // Get a diff stat to show what changed
    const diffStat = startingSha
      ? await gitExec(`git diff --stat ${startingSha}..HEAD`, projectDir)
      : await gitExec('git show --stat HEAD', projectDir)

    const handoff: ContextHandoff = {
      featureId: feature.id,
      featureName: feature.name,
      completedSteps,
      remainingCriteria,
      modifiedFiles,
      recentCommits,
      diffStat,
      partialNotes,
      handoffAt: new Date().toISOString(),
      resetCount: this.resetCount,
    }

    await writeContextHandoff(projectDir, handoff)

    const lines = [
      `CONTEXT RESET: Session context limit reached (reset #${this.resetCount}).`,
      ``,
      `Feature: ${feature.id} — ${feature.name}`,
      ``,
    ]

    if (recentCommits) {
      lines.push(`Commits made during this feature's work:`)
      for (const line of recentCommits.split('\n')) {
        lines.push(`  ${line}`)
      }
      lines.push(``)
    }

    if (diffStat) {
      lines.push(`Files changed:`)
      for (const line of diffStat.split('\n').slice(0, 15)) {
        lines.push(`  ${line}`)
      }
      lines.push(``)
    }

    if (completedSteps.length > 0) {
      lines.push(`Completed steps:`)
      for (const s of completedSteps) {
        lines.push(`  - ${s}`)
      }
      lines.push(``)
    }

    lines.push(`Remaining acceptance criteria to implement:`)
    for (const c of remainingCriteria) {
      lines.push(`  - ${c}`)
    }
    lines.push(``)
    lines.push(`Read sprint-context-handoff.json for full context.`)
    lines.push(`Continue implementing feature: ${feature.id}`)

    return lines.join('\n')
  }

  getStats(): {
    totalInput: number
    totalOutput: number
    cacheReadTokens: number
    peakContext: number
    resetThreshold: number
    resetCount: number
  } {
    return {
      totalInput: this.totalInputTokens,
      totalOutput: this.totalOutputTokens,
      cacheReadTokens: this.totalCacheReadTokens,
      peakContext: this.peakContextTokens,
      resetThreshold: this.getResetThreshold(),
      resetCount: this.resetCount,
    }
  }
}

export type { ModelUsage }
