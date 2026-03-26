/**
 * State shape and reducer for the Quest monitor TUI.
 * Events from quest-events.jsonl are replayed into this state.
 */

import type { QuestEvent } from '../events.js'
import type { AgentLabel } from '../logger.js'

export interface AgentSession {
  agent: AgentLabel
  startedAt: string
  completedAt?: string
  durationMs?: number
  turns: number
  lastTool?: string
  lastToolSummary?: string
  success?: boolean
  inputTokens?: number
  outputTokens?: number
  isContextReset: boolean
}

export interface FeatureRun {
  featureId: string
  featureName: string
  priority: string
  index: number
  total: number
  startedAt: string
  completedAt?: string
  verdict?: 'pass' | 'fail'
  attempt: number
  coderSessions: AgentSession[]   // may have multiple if context resets
  evalSession?: AgentSession
  criteriaResults?: Array<{ criterion: string; result: 'pass' | 'fail'; evidence: string }>
}

export interface MonitorState {
  projectName: string
  totalFeatures: number
  passingFeatures: number
  features: FeatureRun[]
  activeFeatureId: string | null
  /** Which agent phase is currently running (if any) */
  activeAgent: AgentLabel | null
  runStartedAt?: string
  runCompletedAt?: string
}

const INITIAL_STATE: MonitorState = {
  projectName: 'Quest',
  totalFeatures: 0,
  passingFeatures: 0,
  features: [],
  activeFeatureId: null,
  activeAgent: null,
}

function getOrCreateFeature(state: MonitorState, featureId: string): FeatureRun {
  let f = state.features.find(f => f.featureId === featureId)
  if (!f) {
    f = {
      featureId,
      featureName: featureId,
      priority: 'medium',
      index: 0,
      total: 0,
      startedAt: new Date().toISOString(),
      attempt: 0,
      coderSessions: [],
    }
    state.features.push(f)
  }
  return f
}

function activeCoderSession(feature: FeatureRun): AgentSession | undefined {
  const last = feature.coderSessions[feature.coderSessions.length - 1]
  return last && !last.completedAt ? last : undefined
}

/** Replay a single event into the mutable state object */
export function applyEvent(state: MonitorState, event: QuestEvent): MonitorState {
  // Clone top-level to trigger React re-render; features array is mutated in place
  const s = { ...state, features: [...state.features] }

  switch (event.type) {
    case 'run_start':
      s.projectName = event.projectName
      s.totalFeatures = event.total
      s.runStartedAt = event.ts
      break

    case 'feature_start': {
      s.projectName = s.projectName || 'Quest'
      s.totalFeatures = event.total
      s.activeFeatureId = event.featureId
      const existing = s.features.findIndex(f => f.featureId === event.featureId)
      const run: FeatureRun = {
        featureId: event.featureId,
        featureName: event.featureName,
        priority: event.priority,
        index: event.index,
        total: event.total,
        startedAt: event.ts,
        attempt: 0,
        coderSessions: [],
      }
      if (existing >= 0) {
        s.features[existing] = run
      } else {
        s.features = [...s.features, run]
      }
      break
    }

    case 'agent_start': {
      if (event.featureId) s.activeFeatureId = event.featureId
      s.activeAgent = event.agent
      const featureId = event.featureId ?? s.activeFeatureId
      if (!featureId) break
      const f = getOrCreateFeature(s, featureId)
      if (event.agent === 'coder') {
        f.coderSessions = [
          ...f.coderSessions,
          {
            agent: 'coder',
            startedAt: event.ts,
            turns: 0,
            isContextReset: (event.resetCount ?? 0) > 0,
          },
        ]
      } else if (event.agent === 'eval') {
        f.evalSession = { agent: 'eval', startedAt: event.ts, turns: 0, isContextReset: false }
      }
      break
    }

    case 'tool_use': {
      const featureId = s.activeFeatureId
      if (!featureId) break
      const f = s.features.find(f => f.featureId === featureId)
      if (!f) break
      if (event.agent === 'coder') {
        const session = activeCoderSession(f)
        if (session) {
          session.turns = event.turn
          session.lastTool = event.tool
          session.lastToolSummary = event.summary
        }
      } else if (event.agent === 'eval' && f.evalSession && !f.evalSession.completedAt) {
        f.evalSession.turns = event.turn
        f.evalSession.lastTool = event.tool
        f.evalSession.lastToolSummary = event.summary
      }
      break
    }

    case 'agent_done': {
      const featureId = s.activeFeatureId
      s.activeAgent = null
      if (!featureId) break
      const f = s.features.find(f => f.featureId === featureId)
      if (!f) break
      if (event.agent === 'coder') {
        const session = activeCoderSession(f)
        if (session) {
          session.completedAt = event.ts
          session.durationMs = event.durationMs
          session.turns = event.turns
          session.success = event.success
          session.inputTokens = event.inputTokens
          session.outputTokens = event.outputTokens
        }
      } else if (event.agent === 'eval' && f.evalSession) {
        f.evalSession.completedAt = event.ts
        f.evalSession.durationMs = event.durationMs
        f.evalSession.turns = event.turns
        f.evalSession.success = event.success
        f.evalSession.inputTokens = event.inputTokens
        f.evalSession.outputTokens = event.outputTokens
      }
      break
    }

    case 'context_reset': {
      // Context reset is already captured by the next agent_start event with resetCount > 0
      break
    }

    case 'eval_verdict': {
      const f = s.features.find(f => f.featureId === event.featureId)
      if (f) {
        f.criteriaResults = event.criteriaResults
      }
      break
    }

    case 'feature_done': {
      const f = s.features.find(f => f.featureId === event.featureId)
      if (f) {
        f.verdict = event.verdict
        f.completedAt = event.ts
        f.attempt = event.attempt
      }
      s.activeFeatureId = null
      if (event.verdict === 'pass') s.passingFeatures++
      break
    }

    case 'run_complete':
      s.passingFeatures = event.passing
      s.totalFeatures = event.total
      s.runCompletedAt = event.ts
      s.activeFeatureId = null
      s.activeAgent = null
      break
  }

  return s
}

/** Build state by replaying all events */
export function buildState(events: QuestEvent[]): MonitorState {
  return events.reduce(applyEvent, { ...INITIAL_STATE, features: [] })
}
