/**
 * Session management — create and track agent execution timelines.
 *
 * An ExternalSession groups related sessions (e.g. all attempts at implementing
 * a feature). Each Session is a single timeline with its own checkpoints.
 */

import { randomUUID } from 'node:crypto'

import type { Session, ExternalSession } from './types.js'
import type { Store } from './store.js'
import * as git from './git.js'

export class SessionManager {
  constructor(
    private readonly store: Store,
    private readonly cwd: string,
  ) {}

  /**
   * Create a new external session (project-level container).
   * Typically one per feature implementation lifecycle.
   */
  async createExternalSession(name: string, baseBranch?: string): Promise<ExternalSession> {
    const branch = baseBranch ?? await git.getCurrentBranch(this.cwd)

    const externalSession: ExternalSession = {
      id: randomUUID(),
      name,
      sessionIds: [],
      baseBranch: branch,
      createdAt: new Date().toISOString(),
    }

    await this.store.createExternalSession(externalSession)
    return externalSession
  }

  /**
   * Start a new internal session within an external session.
   * Creates a new timeline that can diverge from others via branching.
   */
  async startSession(
    externalSessionId: string,
    options?: { branch?: string; featureId?: string },
  ): Promise<Session> {
    const external = this.store.getExternalSession(externalSessionId)
    if (!external) {
      throw new Error(`External session not found: ${externalSessionId}`)
    }

    const branch = options?.branch ?? await git.getCurrentBranch(this.cwd)

    const session: Session = {
      id: randomUUID(),
      externalSessionId,
      branch,
      checkpointIds: [],
      featureId: options?.featureId,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    await this.store.createSession(session)

    // Register with external session
    await this.store.updateExternalSession(externalSessionId, {
      sessionIds: [...external.sessionIds, session.id],
    })

    return session
  }

  /** End the current session */
  async endSession(sessionId: string): Promise<void> {
    await this.store.updateSession(sessionId, {
      active: false,
      updatedAt: new Date().toISOString(),
    })

    const active = this.store.getActiveSession()
    if (active?.id === sessionId) {
      await this.store.setActiveSession(null)
    }
  }

  /** Get the currently active session */
  getActive(): Session | undefined {
    return this.store.getActiveSession()
  }

  /** Get a session by ID */
  get(sessionId: string): Session | undefined {
    return this.store.getSession(sessionId)
  }

  /** List all sessions, optionally filtered by external session */
  list(externalSessionId?: string): readonly Session[] {
    return this.store.listSessions(externalSessionId)
  }

  /** Switch the active session */
  async switchTo(sessionId: string): Promise<void> {
    const session = this.store.getSession(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    await this.store.setActiveSession(sessionId)

    // Checkout the session's branch if different from current
    const currentBranch = await git.getCurrentBranch(this.cwd)
    if (currentBranch !== session.branch) {
      await git.checkoutBranch(this.cwd, session.branch)
    }
  }

  /** Get the full timeline (checkpoints) for a session */
  getTimeline(sessionId: string) {
    return this.store.getTimeline(sessionId)
  }
}
