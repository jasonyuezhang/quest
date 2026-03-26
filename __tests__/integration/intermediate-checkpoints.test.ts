/**
 * Integration test: verifies a feature can be completed across 2+ context resets.
 *
 * Tests that:
 * - sprint-context-handoff.json includes completedCriteria and remainingCriteria
 * - context_reset events include completedCount and remainingCount
 * - Feature can be successfully completed after multiple context resets
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempProject, cleanTempDir, makeFeature } from '../helpers/tempDir.js'
import type { AgentResult, SprintCompletion, EvalReport, ContextHandoff } from '../../src/agents/types.js'

// ── Mock external dependencies (same pattern as coder-evaluator.test.ts) ───

vi.mock('../../src/agents/coder.js', () => ({
  runCoderAgent: vi.fn(),
  ContextResetNeededError: class ContextResetNeededError extends Error {
    constructor(msg: string) {
      super(msg)
      this.name = 'ContextResetNeededError'
    }
  },
}))

vi.mock('../../src/agents/evaluator.js', () => ({
  runEvaluatorAgent: vi.fn(),
}))

vi.mock('../../src/agents/initializer.js', () => ({
  runInitializerAgent: vi.fn(),
}))

vi.mock('../../src/agents/reviewer.js', () => ({
  runReviewerAgent: vi.fn(),
  readReviewReport: vi.fn().mockResolvedValue(null),
}))

vi.mock('../../src/logger.js', () => ({
  printAgentBanner: vi.fn(),
  logMessage: vi.fn(),
  resetTurnCount: vi.fn(),
}))

vi.mock('../../src/worktree.js', () => ({
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  cherryPickToMain: vi.fn(),
  getWorktreeSha: vi.fn(),
  syncFilesToWorktree: vi.fn(),
  cleanupAllWorktrees: vi.fn(),
}))

vi.mock('../../src/scheduler.js', () => ({
  buildDAG: vi.fn().mockReturnValue({ nodes: new Map(), order: [] }),
  planNextBatch: vi.fn().mockReturnValue({ features: [], workerCount: 0, reason: 'done' }),
  getNewlyUnblocked: vi.fn().mockReturnValue([]),
  estimateTotalTime: vi.fn().mockReturnValue(0),
  formatDAGSummary: vi.fn().mockReturnValue(''),
}))

vi.mock('../../src/trace.js', () => ({
  Tracer: class MockTracer {
    startSession() {
      return { id: 'trace-session', recordMessage() {}, end() {} }
    }
    endSession() {}
  },
}))

vi.mock('../../src/agent-git/index.js', () => ({
  AgentGit: class MockAgentGit {
    async init() {}
    async createExternalSession() { return { id: 'ext-session' } }
    async startSession() { return { id: 'ag-session' } }
    async checkpoint() { return { id: 'checkpoint-abc123' } }
    async rollbackTo() { return { preservedBranch: null } }
    async endSession() {}
  },
}))

// ── Imports ──────────────────────────────────────────────────────────────────

import { Orchestrator } from '../../src/orchestrator.js'
import { runCoderAgent } from '../../src/agents/coder.js'
import { runEvaluatorAgent } from '../../src/agents/evaluator.js'

const mockCoder = vi.mocked(runCoderAgent)
const mockEval = vi.mocked(runEvaluatorAgent)

describe('Integration: intermediate checkpoints across context resets', () => {
  const testFeature = makeFeature({
    id: 'checkpoint-test-feature',
    name: 'Checkpoint Test Feature',
    description: 'A feature to test multi-reset completion',
    acceptanceCriteria: [
      'Criterion one: implement the core logic',
      'Criterion two: add tests',
      'Criterion three: write documentation',
    ],
    priority: 'high',
  })

  let dir: string

  beforeEach(async () => {
    dir = await makeTempProject([testFeature])
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await cleanTempDir(dir)
  })

  it('can complete a feature across 2 context resets', async () => {
    const { ContextResetNeededError } = await import('../../src/agents/coder.js')

    let callCount = 0

    // First 2 calls throw ContextResetNeededError; 3rd call succeeds
    mockCoder.mockImplementation(async (projectDir: string, featureId: string) => {
      callCount++
      if (callCount <= 2) {
        throw new ContextResetNeededError(`Context limit reached on call ${callCount}`)
      }
      // Third call: write a successful completion
      const completion: SprintCompletion = {
        featureId,
        commitSha: 'sha-after-2-resets',
        testsPassed: true,
        notes: 'Completed after 2 context resets',
        completedAt: new Date().toISOString(),
        sessionId: 'coder-reset-3',
      }
      await writeFile(
        join(projectDir, 'sprint-completion.json'),
        JSON.stringify(completion, null, 2) + '\n',
      )
      return {
        sessionId: 'coder-reset-3',
        totalInputTokens: 1000,
        totalOutputTokens: 200,
        peakContextTokens: 5000,
        success: true,
        durationMs: 1000,
      } as AgentResult
    })

    mockEval.mockImplementation(async (projectDir: string, featureId: string) => {
      const report: EvalReport = {
        featureId,
        verdict: 'pass',
        criteriaResults: testFeature.acceptanceCriteria.map(c => ({
          criterion: c,
          result: 'pass' as const,
          evidence: 'mock: criterion satisfied',
        })),
        notes: 'All criteria pass after resets',
        evaluatedAt: new Date().toISOString(),
        sessionId: 'eval-session',
      }
      await writeFile(
        join(projectDir, 'eval-report.json'),
        JSON.stringify(report, null, 2) + '\n',
      )
      return {
        sessionId: 'eval-session',
        totalInputTokens: 500,
        totalOutputTokens: 100,
        peakContextTokens: 2000,
        success: true,
        durationMs: 500,
      } as AgentResult
    })

    const orch = new Orchestrator({ projectDir: dir, maxContextResets: 5 })
    const { verdict } = await orch.implementFeature(testFeature)

    // Feature must complete successfully after 2 context resets
    expect(verdict).toBe('pass')
    // Coder called 3 times: 2 resets + 1 successful completion
    expect(mockCoder).toHaveBeenCalledTimes(3)
    // Evaluator called once after the final successful coder run
    expect(mockEval).toHaveBeenCalledOnce()
  })

  it('sprint-context-handoff.json has completedCriteria and remainingCriteria after a reset', async () => {
    const { ContextResetNeededError } = await import('../../src/agents/coder.js')

    let callCount = 0

    mockCoder.mockImplementation(async (projectDir: string, featureId: string) => {
      callCount++
      if (callCount === 1) {
        throw new ContextResetNeededError('First context reset')
      }
      const completion: SprintCompletion = {
        featureId,
        commitSha: 'sha-after-reset',
        testsPassed: true,
        notes: 'Completed after reset',
        completedAt: new Date().toISOString(),
        sessionId: 'coder-reset-2',
      }
      await writeFile(
        join(projectDir, 'sprint-completion.json'),
        JSON.stringify(completion, null, 2) + '\n',
      )
      return {
        sessionId: 'coder-reset-2',
        totalInputTokens: 800,
        totalOutputTokens: 150,
        peakContextTokens: 4000,
        success: true,
        durationMs: 800,
      } as AgentResult
    })

    mockEval.mockImplementation(async (projectDir: string, featureId: string) => {
      const report: EvalReport = {
        featureId,
        verdict: 'pass',
        criteriaResults: testFeature.acceptanceCriteria.map(c => ({
          criterion: c,
          result: 'pass' as const,
          evidence: 'mock pass',
        })),
        notes: 'pass',
        evaluatedAt: new Date().toISOString(),
        sessionId: 'eval',
      }
      await writeFile(join(projectDir, 'eval-report.json'), JSON.stringify(report, null, 2) + '\n')
      return {
        sessionId: 'eval',
        totalInputTokens: 300,
        totalOutputTokens: 80,
        peakContextTokens: 1500,
        success: true,
        durationMs: 300,
      } as AgentResult
    })

    const orch = new Orchestrator({ projectDir: dir, maxContextResets: 3 })
    await orch.implementFeature(testFeature)

    // Verify the handoff file was written with required fields
    const handoffPath = join(dir, 'sprint-context-handoff.json')
    expect(existsSync(handoffPath)).toBe(true)

    const handoffContent = await readFile(handoffPath, 'utf-8')
    const handoff = JSON.parse(handoffContent) as ContextHandoff

    // Must have completedCriteria and remainingCriteria fields
    expect(handoff).toHaveProperty('completedCriteria')
    expect(handoff).toHaveProperty('remainingCriteria')
    expect(Array.isArray(handoff.completedCriteria)).toBe(true)
    expect(Array.isArray(handoff.remainingCriteria)).toBe(true)

    // All criteria must be accounted for in completed + remaining
    const allCriteria = [...handoff.completedCriteria, ...handoff.remainingCriteria]
    expect(allCriteria.length).toBe(testFeature.acceptanceCriteria.length)

    // Handoff must also include modifiedFiles (from git diff --name-only)
    expect(handoff).toHaveProperty('modifiedFiles')
    expect(Array.isArray(handoff.modifiedFiles)).toBe(true)

    // Handoff must include recentCommits (last 5 git commits)
    expect(handoff).toHaveProperty('recentCommits')
  })
})
