/**
 * JSON-file persistence layer for agent-git state.
 *
 * All state lives in `.agent-git/` within the project directory.
 * Uses atomic writes (write to tmp, then rename) to prevent corruption.
 * All mutations produce new state objects (immutable pattern).
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type {
  AgentGitState,
  Checkpoint,
  Session,
  ExternalSession,
  Branch,
} from './types.js'

const STORE_DIR = '.agent-git'
const STATE_FILE = 'state.json'

function emptyState(): AgentGitState {
  return {
    externalSessions: [],
    sessions: [],
    checkpoints: [],
    branches: [],
    activeSessionId: null,
    version: 1,
  }
}

export class Store {
  private readonly storeDir: string
  private readonly statePath: string
  private state: AgentGitState | null = null

  constructor(projectDir: string) {
    this.storeDir = join(projectDir, STORE_DIR)
    this.statePath = join(this.storeDir, STATE_FILE)
  }

  /** Initialize store directory and load or create state */
  async init(): Promise<void> {
    if (!existsSync(this.storeDir)) {
      await mkdir(this.storeDir, { recursive: true })
    }
    this.state = await this.load()
  }

  private async load(): Promise<AgentGitState> {
    if (!existsSync(this.statePath)) {
      const initial = emptyState()
      await this.persist(initial)
      return initial
    }

    const raw = await readFile(this.statePath, 'utf-8')
    return JSON.parse(raw) as AgentGitState
  }

  /** Atomic write: write to temp file, then rename */
  private async persist(newState: AgentGitState): Promise<void> {
    const tmpPath = `${this.statePath}.${Date.now()}.tmp`
    await writeFile(tmpPath, JSON.stringify(newState, null, 2), 'utf-8')
    await rename(tmpPath, this.statePath)
  }

  private getState(): AgentGitState {
    if (!this.state) {
      throw new Error('Store not initialized. Call init() first.')
    }
    return this.state
  }

  private async save(): Promise<void> {
    await this.persist(this.getState())
  }

  /** Replace in-memory state immutably and persist */
  private async update(fn: (current: AgentGitState) => AgentGitState): Promise<void> {
    this.state = fn(this.getState())
    await this.save()
  }

  // ── External Sessions ──────────────────────────────────────────────

  async createExternalSession(session: ExternalSession): Promise<void> {
    await this.update(s => ({
      ...s,
      externalSessions: [...s.externalSessions, session],
    }))
  }

  getExternalSession(id: string): ExternalSession | undefined {
    return this.getState().externalSessions.find(s => s.id === id)
  }

  async updateExternalSession(id: string, update: Partial<ExternalSession>): Promise<void> {
    await this.update(s => ({
      ...s,
      externalSessions: s.externalSessions.map(es =>
        es.id === id ? { ...es, ...update } : es,
      ),
    }))
  }

  // ── Sessions ───────────────────────────────────────────────────────

  async createSession(session: Session): Promise<void> {
    await this.update(s => ({
      ...s,
      sessions: [...s.sessions, session],
      activeSessionId: session.id,
    }))
  }

  getSession(id: string): Session | undefined {
    return this.getState().sessions.find(s => s.id === id)
  }

  getActiveSession(): Session | undefined {
    const state = this.getState()
    if (!state.activeSessionId) return undefined
    return this.getSession(state.activeSessionId)
  }

  async updateSession(id: string, update: Partial<Session>): Promise<void> {
    await this.update(s => ({
      ...s,
      sessions: s.sessions.map(sess =>
        sess.id === id ? { ...sess, ...update } : sess,
      ),
    }))
  }

  async setActiveSession(id: string | null): Promise<void> {
    await this.update(s => ({
      ...s,
      activeSessionId: id,
    }))
  }

  listSessions(externalSessionId?: string): readonly Session[] {
    const sessions = this.getState().sessions
    if (!externalSessionId) return sessions
    return sessions.filter(s => s.externalSessionId === externalSessionId)
  }

  // ── Checkpoints ────────────────────────────────────────────────────

  async addCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await this.update(s => ({
      ...s,
      checkpoints: [...s.checkpoints, checkpoint],
      sessions: s.sessions.map(sess =>
        sess.id === checkpoint.sessionId
          ? { ...sess, checkpointIds: [...sess.checkpointIds, checkpoint.id], updatedAt: checkpoint.createdAt }
          : sess,
      ),
    }))
  }

  getCheckpoint(id: string): Checkpoint | undefined {
    return this.getState().checkpoints.find(c => c.id === id)
  }

  listCheckpoints(sessionId?: string): readonly Checkpoint[] {
    const checkpoints = this.getState().checkpoints
    if (!sessionId) return checkpoints
    return checkpoints.filter(c => c.sessionId === sessionId)
  }

  getLatestCheckpoint(sessionId: string): Checkpoint | undefined {
    const sessionCheckpoints = this.listCheckpoints(sessionId)
    return sessionCheckpoints[sessionCheckpoints.length - 1]
  }

  // ── Branches ───────────────────────────────────────────────────────

  async addBranch(branch: Branch): Promise<void> {
    await this.update(s => ({
      ...s,
      branches: [...s.branches, branch],
    }))
  }

  getBranch(name: string): Branch | undefined {
    return this.getState().branches.find(b => b.name === name)
  }

  listBranches(): readonly Branch[] {
    return this.getState().branches
  }

  // ── Queries ────────────────────────────────────────────────────────

  /** Get the full checkpoint history for a session as a timeline */
  getTimeline(sessionId: string): readonly Checkpoint[] {
    return this.listCheckpoints(sessionId)
  }

  /** Get all checkpoints on a specific branch */
  getCheckpointsByBranch(branch: string): readonly Checkpoint[] {
    return this.getState().checkpoints.filter(c => c.branch === branch)
  }

  /** Get the complete state (deep copy for safety) */
  getFullState(): Readonly<AgentGitState> {
    return JSON.parse(JSON.stringify(this.getState())) as AgentGitState
  }

  /** Reset all state (destructive — for testing) */
  async reset(): Promise<void> {
    this.state = emptyState()
    await this.save()
  }

  /** Get the store directory path */
  get dir(): string {
    return this.storeDir
  }
}
