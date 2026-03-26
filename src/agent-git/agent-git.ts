/**
 * AgentGit — the main public API for agent version control.
 *
 * Composes checkpoint, session, branch, and rollback managers into
 * a single facade. This is what consumers import and use.
 *
 * Usage:
 *   const ag = new AgentGit('/path/to/project')
 *   await ag.init()
 *
 *   const ext = await ag.createExternalSession('implement-user-auth')
 *   const session = await ag.startSession(ext.id, { featureId: 'user-auth' })
 *
 *   // ... agent does work ...
 *   const cp1 = await ag.checkpoint({ description: 'Added login form component' })
 *
 *   // ... agent does more work that fails ...
 *   await ag.rollbackTo(cp1.id)  // revert to known good state
 *
 *   // ... try alternative approach ...
 *   const branch = await ag.branch(cp1.id, { branchName: 'alt/oauth-approach' })
 */

import type {
  Checkpoint,
  CheckpointOptions,
  CheckpointDiff,
  Session,
  ExternalSession,
  Branch,
  BranchOptions,
  RollbackOptions,
  ToolRecord,
  AgentGitState,
} from './types.js'
import { Store } from './store.js'
import { CheckpointManager } from './checkpoint.js'
import { SessionManager } from './session.js'
import { BranchManager } from './branch.js'
import { RollbackManager, type RollbackResult } from './rollback.js'

export class AgentGit {
  private readonly store: Store
  private readonly checkpointMgr: CheckpointManager
  private readonly sessionMgr: SessionManager
  private readonly branchMgr: BranchManager
  private readonly rollbackMgr: RollbackManager

  constructor(private readonly projectDir: string) {
    this.store = new Store(projectDir)
    this.checkpointMgr = new CheckpointManager(this.store, projectDir)
    this.sessionMgr = new SessionManager(this.store, projectDir)
    this.branchMgr = new BranchManager(this.store, this.sessionMgr, projectDir)
    this.rollbackMgr = new RollbackManager(this.store, this.branchMgr, this.checkpointMgr, projectDir)
  }

  /** Initialize the store. Must be called before any other method. */
  async init(): Promise<void> {
    await this.store.init()
  }

  // ── External Sessions ──────────────────────────────────────────────

  /** Create a new external session (groups related agent sessions) */
  async createExternalSession(name: string, baseBranch?: string): Promise<ExternalSession> {
    return this.sessionMgr.createExternalSession(name, baseBranch)
  }

  // ── Sessions ───────────────────────────────────────────────────────

  /** Start a new session within an external session */
  async startSession(
    externalSessionId: string,
    options?: { branch?: string; featureId?: string },
  ): Promise<Session> {
    return this.sessionMgr.startSession(externalSessionId, options)
  }

  /** End the current session */
  async endSession(sessionId?: string): Promise<void> {
    const id = sessionId ?? this.sessionMgr.getActive()?.id
    if (!id) throw new Error('No active session to end')
    return this.sessionMgr.endSession(id)
  }

  /** Get the currently active session */
  getActiveSession(): Session | undefined {
    return this.sessionMgr.getActive()
  }

  /** List all sessions */
  listSessions(externalSessionId?: string): readonly Session[] {
    return this.sessionMgr.list(externalSessionId)
  }

  /** Switch to a different session */
  async switchSession(sessionId: string): Promise<void> {
    return this.sessionMgr.switchTo(sessionId)
  }

  // ── Checkpoints ────────────────────────────────────────────────────

  /**
   * Create a checkpoint at the current state.
   * Automatically stages and commits changes unless autoCommit is false.
   */
  async checkpoint(options: CheckpointOptions): Promise<Checkpoint> {
    const session = this.sessionMgr.getActive()
    if (!session) throw new Error('No active session. Call startSession() first.')
    return this.checkpointMgr.create(session.id, options)
  }

  /** Get a checkpoint by ID */
  getCheckpoint(id: string): Checkpoint | undefined {
    return this.checkpointMgr.get(id)
  }

  /** List checkpoints for the active session (or a specific session) */
  listCheckpoints(sessionId?: string): readonly Checkpoint[] {
    const id = sessionId ?? this.sessionMgr.getActive()?.id
    if (!id) return []
    return this.checkpointMgr.list(id)
  }

  /** Get the most recent checkpoint */
  latestCheckpoint(sessionId?: string): Checkpoint | undefined {
    const id = sessionId ?? this.sessionMgr.getActive()?.id
    if (!id) return undefined
    return this.checkpointMgr.latest(id)
  }

  /** Compare two checkpoints */
  async diffCheckpoints(fromId: string, toId: string): Promise<CheckpointDiff> {
    return this.checkpointMgr.diff(fromId, toId)
  }

  // ── Branching ──────────────────────────────────────────────────────

  /**
   * Create a branch from a checkpoint for parallel exploration.
   * The original timeline is preserved — branching is non-destructive.
   */
  async branch(checkpointId: string, options: BranchOptions): Promise<Branch> {
    return this.branchMgr.createFromCheckpoint(checkpointId, options)
  }

  /** List all agent-git branches */
  listBranches(): readonly Branch[] {
    return this.branchMgr.list()
  }

  /** Switch to a branch */
  async switchBranch(branchName: string): Promise<void> {
    return this.branchMgr.switchTo(branchName)
  }

  // ── Rollback ───────────────────────────────────────────────────────

  /**
   * Roll back to a previous checkpoint.
   * By default preserves the current timeline on an abandoned branch.
   */
  async rollbackTo(checkpointId: string, options?: RollbackOptions): Promise<RollbackResult> {
    return this.rollbackMgr.rollbackTo(checkpointId, options)
  }

  /** Undo the last checkpoint */
  async rollbackOne(options?: RollbackOptions): Promise<RollbackResult | null> {
    const session = this.sessionMgr.getActive()
    if (!session) throw new Error('No active session')
    return this.rollbackMgr.rollbackOne(session.id, options)
  }

  /** Check if rollback to a checkpoint is possible */
  async canRollbackTo(checkpointId: string): Promise<boolean> {
    return this.rollbackMgr.canRollbackTo(checkpointId)
  }

  /** Get tool records that would need reversal */
  getToolsToReverse(targetCheckpointId: string): readonly ToolRecord[] {
    const latest = this.latestCheckpoint()
    if (!latest) return []
    return this.rollbackMgr.getToolsToReverse(latest.id, targetCheckpointId)
  }

  // ── Timeline ───────────────────────────────────────────────────────

  /** Get the full checkpoint timeline for the active session */
  getTimeline(sessionId?: string): readonly Checkpoint[] {
    const id = sessionId ?? this.sessionMgr.getActive()?.id
    if (!id) return []
    return this.sessionMgr.getTimeline(id)
  }

  // ── Debugging ──────────────────────────────────────────────────────

  /** Get the full internal state (for debugging/export) */
  getState(): Readonly<AgentGitState> {
    return this.store.getFullState()
  }

  /** Reset all agent-git state (destructive — for testing) */
  async reset(): Promise<void> {
    return this.store.reset()
  }
}
