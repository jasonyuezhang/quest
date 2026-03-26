/**
 * Checkpoint management — create, list, and compare snapshots of agent state.
 *
 * Each checkpoint wraps a git commit with metadata about what the agent
 * accomplished, which tools it used, and what files changed.
 */

import { randomUUID } from 'node:crypto'

import type { Checkpoint, CheckpointOptions, CheckpointDiff, ToolRecord } from './types.js'
import type { Store } from './store.js'
import * as git from './git.js'

export class CheckpointManager {
  constructor(
    private readonly store: Store,
    private readonly cwd: string,
  ) {}

  /**
   * Create a checkpoint at the current state.
   *
   * By default, stages and commits all changes before snapshotting.
   * The checkpoint records the commit SHA, modified files, and tool history.
   */
  async create(sessionId: string, options: CheckpointOptions): Promise<Checkpoint> {
    const session = this.store.getSession(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const autoCommit = options.autoCommit ?? true
    let commitSha: string

    if (autoCommit && await git.hasChanges(this.cwd)) {
      const message = options.commitMessage ?? `checkpoint: ${options.description}`
      commitSha = await git.commitAll(this.cwd, message)
    } else {
      commitSha = await git.getHead(this.cwd)
    }

    // Determine parent checkpoint and modified files
    const parent = this.store.getLatestCheckpoint(sessionId)
    const parentId = parent?.id ?? null
    const modifiedFiles = parent
      ? await git.getModifiedFiles(this.cwd, parent.commitSha)
      : []

    const checkpoint: Checkpoint = {
      id: randomUUID(),
      commitSha,
      description: options.description,
      sessionId,
      branch: session.branch,
      parentId,
      modifiedFiles,
      toolHistory: options.toolHistory ?? [],
      createdAt: new Date().toISOString(),
      metadata: options.metadata ?? {},
    }

    await this.store.addCheckpoint(checkpoint)
    return checkpoint
  }

  /** Get a checkpoint by ID */
  get(checkpointId: string): Checkpoint | undefined {
    return this.store.getCheckpoint(checkpointId)
  }

  /** List all checkpoints for a session */
  list(sessionId: string): readonly Checkpoint[] {
    return this.store.listCheckpoints(sessionId)
  }

  /** Get the most recent checkpoint for a session */
  latest(sessionId: string): Checkpoint | undefined {
    return this.store.getLatestCheckpoint(sessionId)
  }

  /** Compare two checkpoints to see what changed */
  async diff(fromId: string, toId: string): Promise<CheckpointDiff> {
    const from = this.store.getCheckpoint(fromId)
    const to = this.store.getCheckpoint(toId)

    if (!from) throw new Error(`Checkpoint not found: ${fromId}`)
    if (!to) throw new Error(`Checkpoint not found: ${toId}`)

    const { added, modified, deleted } = await git.getDiffNameStatus(
      this.cwd,
      from.commitSha,
      to.commitSha,
    )
    const diffStat = await git.getDiffStat(this.cwd, from.commitSha, to.commitSha)
    const commitCount = await git.getCommitCount(this.cwd, from.commitSha, to.commitSha)

    return {
      fromCheckpointId: fromId,
      toCheckpointId: toId,
      added,
      modified,
      deleted,
      diffStat,
      commitCount,
    }
  }

  /**
   * Get all tool records between two checkpoints (inclusive of `to`).
   * Useful for determining which tool effects need reversal on rollback.
   */
  getToolHistoryBetween(fromId: string, toId: string): readonly ToolRecord[] {
    // Scope to the session of the target checkpoint
    const fromCheckpoint = this.store.getCheckpoint(fromId)
    const sessionId = fromCheckpoint?.sessionId
    const allCheckpoints = this.store.listCheckpoints(sessionId)

    // Build the chain from `from` to `to`
    const fromIdx = allCheckpoints.findIndex(c => c.id === fromId)
    const toIdx = allCheckpoints.findIndex(c => c.id === toId)

    if (fromIdx === -1 || toIdx === -1 || fromIdx >= toIdx) {
      return []
    }

    // Collect tool records from checkpoints after `from` up to and including `to`
    return allCheckpoints
      .slice(fromIdx + 1, toIdx + 1)
      .flatMap(c => c.toolHistory)
  }
}
