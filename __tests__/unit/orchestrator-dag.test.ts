/**
 * Unit tests for Orchestrator DAG scheduler path (maxConcurrency > 1).
 * Covers runDAGScheduled and runFeatureInWorktree private methods.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeTempDir, cleanTempDir, makeFeature, makeTempProject } from '../helpers/tempDir.js'
import type { AgentResult, EvalReport } from '../../src/agents/types.js'
import { readEvents, initEventLog } from '../../src/events.js'

// ── Mock all external dependencies ──────────────────────────────────────────
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
  buildDAG: vi.fn().mockReturnValue({
    nodes: new Map(),
    order: [],
    maxParallelism: 2,
    maxLevel: 0,
    criticalPath: [],
    estimatedMs: 0,
  }),
  planNextBatch: vi.fn().mockReturnValue({ features: [], workerCount: 0, reason: 'done' }),
  getNewlyUnblocked: vi.fn().mockReturnValue([]),
  estimateTotalTime: vi.fn().mockReturnValue({ estimatedMs: 60_000, criticalPathMs: 30_000, parallelEfficiency: 0.8 }),
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
import { runCoderAgent, ContextResetNeededError } from '../../src/agents/coder.js'
import { runEvaluatorAgent } from '../../src/agents/evaluator.js'
import { createWorktree, getWorktreeSha, cherryPickToMain, syncFilesToWorktree } from '../../src/worktree.js'
import { buildDAG, planNextBatch, getNewlyUnblocked } from '../../src/scheduler.js'

const mockCoder = vi.mocked(runCoderAgent)
const mockEval = vi.mocked(runEvaluatorAgent)
const mockCreateWorktree = vi.mocked(createWorktree)
const mockGetWorktreeSha = vi.mocked(getWorktreeSha)
const mockCherryPickToMain = vi.mocked(cherryPickToMain)
const mockSyncFilesToWorktree = vi.mocked(syncFilesToWorktree)
const mockBuildDAG = vi.mocked(buildDAG)
const mockPlanNextBatch = vi.mocked(planNextBatch)
const mockGetNewlyUnblocked = vi.mocked(getNewlyUnblocked)

function makeAgentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    sessionId: 'session-dag',
    totalInputTokens: 100,
    totalOutputTokens: 50,
    peakContextTokens: 1000,
    success: true,
    durationMs: 200,
    ...overrides,
  }
}

async function writeEvalReport(dir: string, verdict: 'pass' | 'fail', featureId = 'dag-feature') {
  const report: EvalReport = {
    featureId,
    verdict,
    criteriaResults: [{ criterion: 'A', result: verdict, evidence: 'mock' }],
    notes: 'Mock DAG eval',
    evaluatedAt: new Date().toISOString(),
    sessionId: 'eval-dag',
  }
  await writeFile(join(dir, 'eval-report.json'), JSON.stringify(report, null, 2))
}

describe('Orchestrator DAG scheduler (maxConcurrency > 1)', () => {
  let worktreeDir: string

  beforeEach(async () => {
    worktreeDir = await makeTempDir()
    vi.clearAllMocks()

    // Default mock: DAG with parallelism 2
    mockBuildDAG.mockReturnValue({
      nodes: new Map(),
      order: [],
      maxParallelism: 2,
      maxLevel: 0,
      criticalPath: [],
      estimatedMs: 0,
    } as any)

    // Default: empty batch (no features to dispatch)
    mockPlanNextBatch.mockReturnValue({ features: [], workerCount: 0, reason: 'done' })
    mockGetNewlyUnblocked.mockReturnValue([])

    // Default worktree mock
    mockCreateWorktree.mockResolvedValue({ dir: worktreeDir, branch: 'test-branch', workerId: 1 })
    mockGetWorktreeSha.mockResolvedValue('sha-abc123')
    mockCherryPickToMain.mockResolvedValue(true)
    mockSyncFilesToWorktree.mockResolvedValue(undefined as any)
  })

  afterEach(async () => {
    await cleanTempDir(worktreeDir)
  })

  it('exits early when all features already pass', async () => {
    const dir = await makeTempProject([makeFeature({ id: 'done-feat', passes: true })])

    const orch = new Orchestrator({ projectDir: dir, maxConcurrency: 2 })
    await orch.run()

    expect(mockCoder).not.toHaveBeenCalled()
    expect(mockEval).not.toHaveBeenCalled()

    await cleanTempDir(dir)
  })

  it('dry-run mode prints estimate without running agents', async () => {
    const dir = await makeTempProject([makeFeature({ id: 'dry-feat', passes: false })])

    const orch = new Orchestrator({ projectDir: dir, maxConcurrency: 2, dryRun: true })
    await orch.run()

    expect(mockCoder).not.toHaveBeenCalled()
    expect(mockEval).not.toHaveBeenCalled()

    await cleanTempDir(dir)
  })

  it('dispatches a feature and completes it (pass verdict)', async () => {
    const feature = makeFeature({ id: 'dag-pass-feat', passes: false })
    const dir = await makeTempProject([feature])

    let planCount = 0
    mockPlanNextBatch.mockImplementation(() => {
      planCount++
      if (planCount === 1) {
        return { features: [feature], workerCount: 1, reason: 'dispatching 1' }
      }
      return { features: [], workerCount: 0, reason: 'done' }
    })

    mockCoder.mockResolvedValue(makeAgentResult())
    mockEval.mockImplementation(async (projDir: string) => {
      await writeEvalReport(projDir, 'pass', feature.id)
      return makeAgentResult()
    })

    const orch = new Orchestrator({ projectDir: dir, maxConcurrency: 2, retryLimit: 0 })
    await orch.run()

    expect(mockCoder).toHaveBeenCalledOnce()
    expect(mockEval).toHaveBeenCalledOnce()
    expect(mockCherryPickToMain).toHaveBeenCalledWith(dir, 'sha-abc123')

    await cleanTempDir(dir)
  })

  it('dispatches a feature and handles fail verdict (no cherry-pick)', async () => {
    const feature = makeFeature({ id: 'dag-fail-feat', passes: false })
    const dir = await makeTempProject([feature])

    let planCount = 0
    mockPlanNextBatch.mockImplementation(() => {
      planCount++
      if (planCount === 1) {
        return { features: [feature], workerCount: 1, reason: 'dispatching 1' }
      }
      return { features: [], workerCount: 0, reason: 'done' }
    })

    mockCoder.mockResolvedValue(makeAgentResult())
    mockEval.mockImplementation(async (projDir: string) => {
      await writeEvalReport(projDir, 'fail', feature.id)
      return makeAgentResult()
    })

    const orch = new Orchestrator({ projectDir: dir, maxConcurrency: 2, retryLimit: 0 })
    await orch.run()

    expect(mockCherryPickToMain).not.toHaveBeenCalled()

    await cleanTempDir(dir)
  })

  it('handles cherry-pick conflict (queues for sequential retry)', async () => {
    const feature = makeFeature({ id: 'cherry-conflict-feat', passes: false })
    const dir = await makeTempProject([feature])

    let planCount = 0
    mockPlanNextBatch.mockImplementation(() => {
      planCount++
      if (planCount === 1) {
        return { features: [feature], workerCount: 1, reason: 'dispatching 1' }
      }
      return { features: [], workerCount: 0, reason: 'done' }
    })

    mockCoder.mockResolvedValue(makeAgentResult())
    mockEval.mockImplementation(async (projDir: string) => {
      await writeEvalReport(projDir, 'pass', feature.id)
      return makeAgentResult()
    })
    // Simulate cherry-pick conflict: returns false
    mockCherryPickToMain.mockResolvedValue(false)

    // Sequential retry will call implementFeature which calls coder+eval again
    let retryEvalCalled = false
    const origEval = mockEval.getMockImplementation()!
    mockEval.mockImplementation(async (projDir: string) => {
      retryEvalCalled = true
      await writeEvalReport(projDir, 'pass', feature.id)
      return makeAgentResult()
    })

    const orch = new Orchestrator({ projectDir: dir, maxConcurrency: 2, retryLimit: 0 })
    await orch.run()

    // Cherry-pick was attempted
    expect(mockCherryPickToMain).toHaveBeenCalled()

    await cleanTempDir(dir)
  })

  it('handles coder throwing a generic error in worktree', async () => {
    const feature = makeFeature({ id: 'coder-throw-dag', passes: false })
    const dir = await makeTempProject([feature])

    let planCount = 0
    mockPlanNextBatch.mockImplementation(() => {
      planCount++
      if (planCount === 1) {
        return { features: [feature], workerCount: 1, reason: 'dispatching 1' }
      }
      return { features: [], workerCount: 0, reason: 'done' }
    })

    mockCoder.mockRejectedValue(new Error('network timeout'))

    const orch = new Orchestrator({ projectDir: dir, maxConcurrency: 2, retryLimit: 0 })
    await orch.run()

    expect(mockCoder).toHaveBeenCalledOnce()
    expect(mockCherryPickToMain).not.toHaveBeenCalled()

    await cleanTempDir(dir)
  })

  it('handles ContextResetNeededError in worktree (retries the attempt)', async () => {
    const feature = makeFeature({ id: 'ctx-reset-dag', passes: false })
    const dir = await makeTempProject([feature])

    let planCount = 0
    mockPlanNextBatch.mockImplementation(() => {
      planCount++
      if (planCount === 1) {
        return { features: [feature], workerCount: 1, reason: 'dispatching 1' }
      }
      return { features: [], workerCount: 0, reason: 'done' }
    })

    let coderCallCount = 0
    mockCoder.mockImplementation(async () => {
      coderCallCount++
      if (coderCallCount === 1) {
        throw new ContextResetNeededError('context limit in worktree')
      }
      return makeAgentResult()
    })
    mockEval.mockImplementation(async (projDir: string) => {
      await writeEvalReport(projDir, 'pass', feature.id)
      return makeAgentResult()
    })

    const orch = new Orchestrator({ projectDir: dir, maxConcurrency: 2, retryLimit: 2 })
    await orch.run()

    // Coder should have been called at least twice (once for context reset, once successful)
    expect(coderCallCount).toBeGreaterThan(1)

    await cleanTempDir(dir)
  })

  it('handles missing eval-report.json in worktree (continues to next attempt)', async () => {
    const feature = makeFeature({ id: 'no-report-dag', passes: false })
    const dir = await makeTempProject([feature])

    let planCount = 0
    mockPlanNextBatch.mockImplementation(() => {
      planCount++
      if (planCount === 1) {
        return { features: [feature], workerCount: 1, reason: 'dispatching 1' }
      }
      return { features: [], workerCount: 0, reason: 'done' }
    })

    mockCoder.mockResolvedValue(makeAgentResult())
    // Eval succeeds but does NOT write eval-report.json
    mockEval.mockResolvedValue(makeAgentResult())

    const orch = new Orchestrator({ projectDir: dir, maxConcurrency: 2, retryLimit: 0 })
    await orch.run()

    expect(mockCoder).toHaveBeenCalledOnce()
    expect(mockCherryPickToMain).not.toHaveBeenCalled()

    await cleanTempDir(dir)
  })

  it('handles eval agent failure (non-success) in worktree', async () => {
    const feature = makeFeature({ id: 'eval-agent-fail-dag', passes: false })
    const dir = await makeTempProject([feature])

    let planCount = 0
    mockPlanNextBatch.mockImplementation(() => {
      planCount++
      if (planCount === 1) {
        return { features: [feature], workerCount: 1, reason: 'dispatching 1' }
      }
      return { features: [], workerCount: 0, reason: 'done' }
    })

    mockCoder.mockResolvedValue(makeAgentResult())
    mockEval.mockResolvedValue(makeAgentResult({ success: false, error: 'eval agent crashed' }))

    const orch = new Orchestrator({ projectDir: dir, maxConcurrency: 2, retryLimit: 0 })
    await orch.run()

    expect(mockCherryPickToMain).not.toHaveBeenCalled()

    await cleanTempDir(dir)
  })

  it('emits dag_built and feature_done events', async () => {
    const feature = makeFeature({ id: 'dag-events-feat', passes: false })
    const dir = await makeTempProject([feature])
    initEventLog(dir)

    let planCount = 0
    mockPlanNextBatch.mockImplementation(() => {
      planCount++
      if (planCount === 1) {
        return { features: [feature], workerCount: 1, reason: 'dispatching 1' }
      }
      return { features: [], workerCount: 0, reason: 'done' }
    })

    mockCoder.mockResolvedValue(makeAgentResult())
    mockEval.mockImplementation(async (projDir: string) => {
      await writeEvalReport(projDir, 'pass', feature.id)
      return makeAgentResult()
    })

    const orch = new Orchestrator({ projectDir: dir, maxConcurrency: 2, retryLimit: 0 })
    await orch.run()

    const events = readEvents(dir)
    expect(events.some(e => e.type === 'dag_built')).toBe(true)
    expect(events.some(e => e.type === 'feature_done')).toBe(true)

    await cleanTempDir(dir)
  })

  it('emits feature_unblocked when dependency is resolved', async () => {
    const feature = makeFeature({ id: 'blocker-feat', passes: false })
    const dir = await makeTempProject([feature])
    initEventLog(dir)

    let planCount = 0
    mockPlanNextBatch.mockImplementation(() => {
      planCount++
      if (planCount === 1) {
        return { features: [feature], workerCount: 1, reason: 'dispatching 1' }
      }
      return { features: [], workerCount: 0, reason: 'done' }
    })

    // Simulate a newly unblocked feature
    mockGetNewlyUnblocked.mockReturnValue(['unblocked-feat'])

    mockCoder.mockResolvedValue(makeAgentResult())
    mockEval.mockImplementation(async (projDir: string) => {
      await writeEvalReport(projDir, 'pass', feature.id)
      return makeAgentResult()
    })

    const orch = new Orchestrator({ projectDir: dir, maxConcurrency: 2, retryLimit: 0 })
    await orch.run()

    const events = readEvents(dir)
    expect(events.some(e => e.type === 'feature_unblocked')).toBe(true)

    await cleanTempDir(dir)
  })

  it('dispatches two features concurrently and waits for both', async () => {
    const feat1 = makeFeature({ id: 'concurrent-1', passes: false })
    const feat2 = makeFeature({ id: 'concurrent-2', passes: false })
    const dir = await makeTempProject([feat1, feat2])

    const worktreeDir2 = await makeTempDir()
    mockCreateWorktree
      .mockResolvedValueOnce({ dir: worktreeDir, branch: 'branch-1', workerId: 1 })
      .mockResolvedValueOnce({ dir: worktreeDir2, branch: 'branch-2', workerId: 2 })

    let planCount = 0
    mockPlanNextBatch.mockImplementation(() => {
      planCount++
      if (planCount === 1) {
        return { features: [feat1, feat2], workerCount: 2, reason: 'dispatching 2' }
      }
      return { features: [], workerCount: 0, reason: 'done' }
    })

    mockCoder.mockResolvedValue(makeAgentResult())
    mockEval.mockImplementation(async (projDir: string) => {
      // Write to whatever dir was passed
      await writeEvalReport(projDir, 'pass', 'some-feat')
      return makeAgentResult()
    })

    const orch = new Orchestrator({ projectDir: dir, maxConcurrency: 2, retryLimit: 0 })
    await orch.run()

    // Both features should have been processed
    expect(mockCoder).toHaveBeenCalledTimes(2)

    await cleanTempDir(dir)
    await cleanTempDir(worktreeDir2)
  })
})
