/**
 * Branch management — create parallel exploration paths from any checkpoint.
 *
 * Branching is non-destructive: the original timeline is preserved and
 * a new session is created on the branch for independent exploration.
 */

import type { Branch, BranchOptions } from './types.js'
import type { Store } from './store.js'
import type { SessionManager } from './session.js'
import * as git from './git.js'

export class BranchManager {
  constructor(
    private readonly store: Store,
    private readonly sessions: SessionManager,
    private readonly cwd: string,
  ) {}

  /**
   * Create a new branch from a checkpoint.
   *
   * This creates a git branch at the checkpoint's commit and optionally
   * starts a new session on that branch for further work.
   */
  async createFromCheckpoint(
    checkpointId: string,
    options: BranchOptions,
  ): Promise<Branch> {
    const checkpoint = this.store.getCheckpoint(checkpointId)
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${checkpointId}`)
    }

    // Verify the commit still exists
    const exists = await git.commitExists(this.cwd, checkpoint.commitSha)
    if (!exists) {
      throw new Error(`Commit ${checkpoint.commitSha} no longer exists in the repository`)
    }

    // Check if branch name is already taken
    const existingBranch = await git.branchExists(this.cwd, options.branchName)
    if (existingBranch) {
      throw new Error(`Branch already exists: ${options.branchName}`)
    }

    // Create the git branch
    await git.createBranch(this.cwd, options.branchName, checkpoint.commitSha)

    const branch: Branch = {
      name: options.branchName,
      fromCheckpointId: checkpointId,
      sessionId: checkpoint.sessionId,
      createdAt: new Date().toISOString(),
    }

    await this.store.addBranch(branch)

    // Optionally start a new session on the branch
    if (options.startSession !== false) {
      const session = this.store.getSession(checkpoint.sessionId)
      if (session) {
        const newSession = await this.sessions.startSession(
          session.externalSessionId,
          { branch: options.branchName, featureId: session.featureId },
        )

        // Checkout the new branch and switch to the new session
        await git.checkoutBranch(this.cwd, options.branchName)
        await this.sessions.switchTo(newSession.id)
      }
    }

    return branch
  }

  /** List all branches tracked by agent-git */
  list(): readonly Branch[] {
    return this.store.listBranches()
  }

  /** Get branch info by name */
  get(branchName: string): Branch | undefined {
    return this.store.getBranch(branchName)
  }

  /** Get all checkpoints on a specific branch */
  getCheckpoints(branchName: string) {
    return this.store.getCheckpointsByBranch(branchName)
  }

  /**
   * Switch to a branch, checking out the git branch and activating
   * the associated session.
   */
  async switchTo(branchName: string): Promise<void> {
    const branch = this.store.getBranch(branchName)
    if (!branch) {
      throw new Error(`Branch not tracked by agent-git: ${branchName}`)
    }

    await git.checkoutBranch(this.cwd, branchName)

    // Find and activate the session for this branch
    const sessions = this.store.listSessions()
    const branchSession = sessions.find(s => s.branch === branchName && s.active)
    if (branchSession) {
      await this.sessions.switchTo(branchSession.id)
    }
  }
}
