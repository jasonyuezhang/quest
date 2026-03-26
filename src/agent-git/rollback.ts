/**
 * Rollback management — revert agent state to a previous checkpoint.
 *
 * Rollbacks are non-destructive by default: the current timeline is
 * preserved on a branch before reverting. This ensures no work is lost.
 */

import type { RollbackOptions, Checkpoint } from './types.js'
import type { Store } from './store.js'
import type { BranchManager } from './branch.js'
import type { CheckpointManager } from './checkpoint.js'
import * as git from './git.js'

export interface RollbackResult {
  /** The checkpoint we rolled back to */
  targetCheckpoint: Checkpoint
  /** Branch name where the abandoned timeline was preserved (if preserveTimeline was true) */
  preservedBranch?: string
  /** The new HEAD commit SHA after rollback */
  newHead: string
  /** Number of checkpoints that were rolled past */
  checkpointsRolledBack: number
}

export class RollbackManager {
  constructor(
    private readonly store: Store,
    private readonly branches: BranchManager,
    private readonly checkpoints: CheckpointManager,
    private readonly cwd: string,
  ) {}

  /**
   * Roll back to a specific checkpoint.
   *
   * By default, creates a branch to preserve the current timeline before
   * resetting. This ensures the agent can always return to abandoned work.
   */
  async rollbackTo(
    checkpointId: string,
    options: RollbackOptions = {},
  ): Promise<RollbackResult> {
    const target = this.store.getCheckpoint(checkpointId)
    if (!target) {
      throw new Error(`Checkpoint not found: ${checkpointId}`)
    }

    // Verify the commit still exists
    const exists = await git.commitExists(this.cwd, target.commitSha)
    if (!exists) {
      throw new Error(`Commit ${target.commitSha} no longer exists`)
    }

    const currentSession = this.store.getActiveSession()
    const currentCheckpoints = currentSession
      ? this.store.listCheckpoints(currentSession.id)
      : []

    // Count how many checkpoints we're rolling back past
    const targetIdx = currentCheckpoints.findIndex(c => c.id === checkpointId)
    const checkpointsRolledBack = targetIdx >= 0
      ? currentCheckpoints.length - targetIdx - 1
      : 0

    let preservedBranch: string | undefined

    // Preserve current timeline on a branch before resetting
    if (options.preserveTimeline !== false && checkpointsRolledBack > 0) {
      const branchName = options.preserveBranchName ??
        `abandoned/${target.sessionId}/${Date.now()}`

      try {
        const currentHead = await git.getHead(this.cwd)
        await git.createBranch(this.cwd, branchName, currentHead)
        preservedBranch = branchName
      } catch {
        // Non-fatal — we can still rollback even if preservation fails
      }
    }

    // Hard reset to the target checkpoint's commit
    await git.resetHard(this.cwd, target.commitSha)
    const newHead = await git.getHead(this.cwd)

    // Trim session checkpoint list to exclude rolled-past checkpoints
    if (currentSession && targetIdx >= 0) {
      const trimmedIds = currentCheckpoints.slice(0, targetIdx + 1).map(c => c.id)
      await this.store.updateSession(currentSession.id, {
        checkpointIds: trimmedIds,
        updatedAt: new Date().toISOString(),
      })
    }

    return {
      targetCheckpoint: target,
      preservedBranch,
      newHead,
      checkpointsRolledBack,
    }
  }

  /**
   * Rollback to the previous checkpoint (undo last checkpoint).
   * Convenience method for the common case.
   */
  async rollbackOne(
    sessionId: string,
    options: RollbackOptions = {},
  ): Promise<RollbackResult | null> {
    const checkpoints = this.store.listCheckpoints(sessionId)
    if (checkpoints.length < 2) {
      return null // Nothing to roll back to
    }

    const previous = checkpoints[checkpoints.length - 2]!
    return this.rollbackTo(previous.id, options)
  }

  /**
   * Check if rollback to a checkpoint is possible.
   * Validates that the target commit still exists.
   */
  async canRollbackTo(checkpointId: string): Promise<boolean> {
    const checkpoint = this.store.getCheckpoint(checkpointId)
    if (!checkpoint) return false
    return git.commitExists(this.cwd, checkpoint.commitSha)
  }

  /**
   * Get the list of tool records that would need reversal if rolling
   * back from the current state to a target checkpoint.
   */
  getToolsToReverse(
    currentCheckpointId: string,
    targetCheckpointId: string,
  ): readonly import('./types.js').ToolRecord[] {
    return this.checkpoints
      .getToolHistoryBetween(targetCheckpointId, currentCheckpointId)
      .filter(t => t.hasSideEffects)
      .reverse() // Reverse order for proper undo
  }
}
