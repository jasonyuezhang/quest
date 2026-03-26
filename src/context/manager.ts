import type { Feature, ContextHandoff } from '../agents/types.js'
import { writeContextHandoff } from '../sprint/contracts.js'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk'

const execAsync = promisify(exec)

const CONTEXT_WINDOW_TOKENS = 200_000
/** Trigger context reset at 75% of the context window */
const RESET_THRESHOLD = Math.floor(CONTEXT_WINDOW_TOKENS * 0.75) // 150,000

async function gitExec(cmd: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, { cwd })
    return stdout.trim()
  } catch {
    return ''
  }
}

export class ContextManager {
  private totalInputTokens = 0
  private totalOutputTokens = 0
  private peakContextTokens = 0
  private resetCount = 0

  /**
   * Record token usage from an SDK result message's modelUsage.
   * Usage is available on result messages (type === 'result') not assistant messages.
   * Uses ModelUsage.contextWindow for accurate context fill tracking.
   */
  recordUsage(usage: ModelUsage): void {
    this.totalInputTokens += usage.inputTokens
    this.totalOutputTokens += usage.outputTokens
    // contextWindow tracks actual context fill — more accurate than inputTokens alone
    if (usage.contextWindow > this.peakContextTokens) {
      this.peakContextTokens = usage.contextWindow
    }
  }

  /**
   * Returns true when input tokens are approaching the context window limit.
   * At this point, the orchestrator should end the session and start a fresh one
   * with a structured handoff — NOT use SDK session resumption (which reattaches
   * to the same full context window).
   */
  shouldReset(): boolean {
    return this.peakContextTokens >= RESET_THRESHOLD
  }

  /** Reset token counters for a new session */
  resetForNewSession(): void {
    this.totalInputTokens = 0
    this.totalOutputTokens = 0
    this.peakContextTokens = 0
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
      c => !completedSteps.some(s => s.toLowerCase().includes(c.toLowerCase().slice(0, 20))),
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
    peakContext: number
    resetThreshold: number
    resetCount: number
  } {
    return {
      totalInput: this.totalInputTokens,
      totalOutput: this.totalOutputTokens,
      peakContext: this.peakContextTokens,
      resetThreshold: RESET_THRESHOLD,
      resetCount: this.resetCount,
    }
  }
}

export type { ModelUsage }
