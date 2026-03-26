import type { Feature, ContextHandoff } from '../agents/types.js'
import { writeContextHandoff } from '../sprint/contracts.js'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk'

const execAsync = promisify(exec)

const CONTEXT_WINDOW_TOKENS = 200_000
/** Trigger context reset at 75% of the context window */
const RESET_THRESHOLD = Math.floor(CONTEXT_WINDOW_TOKENS * 0.75) // 150,000

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

  /** Build a structured handoff prompt for the next fresh session */
  async buildHandoffPrompt(
    projectDir: string,
    feature: Feature,
    completedSteps: string[],
    partialNotes: string,
  ): Promise<string> {
    const remainingCriteria = feature.acceptanceCriteria.filter(
      c => !completedSteps.some(s => s.toLowerCase().includes(c.toLowerCase().slice(0, 20))),
    )

    let modifiedFiles: string[] = []
    try {
      const { stdout } = await execAsync('git diff --name-only HEAD', { cwd: projectDir })
      modifiedFiles = stdout.trim().split('\n').filter(Boolean)
    } catch {
      // git may not be initialized yet
    }

    const handoff: ContextHandoff = {
      featureId: feature.id,
      featureName: feature.name,
      completedSteps,
      remainingCriteria,
      modifiedFiles,
      partialNotes,
      handoffAt: new Date().toISOString(),
      resetCount: this.resetCount,
    }

    await writeContextHandoff(projectDir, handoff)

    return [
      `CONTEXT RESET: Session context limit reached (reset #${this.resetCount}).`,
      ``,
      `Feature: ${feature.id} — ${feature.name}`,
      ``,
      `Completed steps so far:`,
      ...completedSteps.map(s => `  - ${s}`),
      ``,
      `Remaining acceptance criteria not yet implemented:`,
      ...remainingCriteria.map(c => `  - ${c}`),
      ``,
      `Files modified so far: ${modifiedFiles.join(', ') || 'none'}`,
      ``,
      `Read sprint-context-handoff.json and sprint-completion-partial.json for full context.`,
      `Continue implementing feature: ${feature.id}`,
    ].join('\n')
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
