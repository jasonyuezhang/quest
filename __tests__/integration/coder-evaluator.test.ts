/**
 * Integration test: runs a mock feature through the full coder -> evaluator loop.
 *
 * Both agents are mocked to simulate real behavior (writing sprint-completion.json
 * and eval-report.json) without making actual AI API calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeTempProject, cleanTempDir, makeFeature } from '../helpers/tempDir.js'
import type { AgentResult, SprintCompletion, EvalReport } from '../../src/agents/types.js'

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
import { markFeaturePassing } from '../../src/state/features.js'

const mockCoder = vi.mocked(runCoderAgent)
const mockEval = vi.mocked(runEvaluatorAgent)

describe('Integration: coder -> evaluator loop', () => {
  let dir: string
  const testFeature = makeFeature({
    id: 'integration-test-feature',
    name: 'Integration Test Feature',
    description: 'A feature for integration testing',
    acceptanceCriteria: [
      'The feature is implemented',
      'Tests pass',
    ],
    priority: 'high',
  })

  beforeEach(async () => {
    dir = await makeTempProject([testFeature])
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await cleanTempDir(dir)
  })

  it('runs a mock feature through the full loop and returns pass', async () => {
    // Mock coder: simulates implementing the feature and writing sprint-completion.json
    mockCoder.mockImplementation(async (projectDir: string, featureId: string) => {
      const completion: SprintCompletion = {
        featureId,
        commitSha: 'mock-commit-abc123',
        testsPassed: true,
        notes: 'Implemented the feature successfully',
        completedAt: new Date().toISOString(),
        sessionId: 'mock-coder-session',
      }
      await writeFile(
        join(projectDir, 'sprint-completion.json'),
        JSON.stringify(completion, null, 2) + '\n',
      )
      return {
        sessionId: 'mock-coder-session',
        totalInputTokens: 5000,
        totalOutputTokens: 1200,
        peakContextTokens: 10000,
        success: true,
        durationMs: 2000,
      } as AgentResult
    })

    // Mock evaluator: simulates evaluating and writing eval-report.json
    mockEval.mockImplementation(async (projectDir: string, featureId: string) => {
      const report: EvalReport = {
        featureId,
        verdict: 'pass',
        criteriaResults: [
          {
            criterion: 'The feature is implemented',
            result: 'pass',
            evidence: 'Mock: feature code was found in place',
          },
          {
            criterion: 'Tests pass',
            result: 'pass',
            evidence: 'Mock: all tests passed',
          },
        ],
        notes: 'All acceptance criteria satisfied',
        evaluatedAt: new Date().toISOString(),
        sessionId: 'mock-eval-session',
      }
      await writeFile(
        join(projectDir, 'eval-report.json'),
        JSON.stringify(report, null, 2) + '\n',
      )
      return {
        sessionId: 'mock-eval-session',
        totalInputTokens: 3000,
        totalOutputTokens: 800,
        peakContextTokens: 6000,
        success: true,
        durationMs: 1500,
      } as AgentResult
    })

    const orch = new Orchestrator({ projectDir: dir })
    const { verdict } = await orch.implementFeature(testFeature)

    expect(verdict).toBe('pass')
    expect(mockCoder).toHaveBeenCalledOnce()
    expect(mockEval).toHaveBeenCalledOnce()
  })

  it('coder is called with the project directory', async () => {
    mockCoder.mockImplementation(async (projectDir: string, featureId: string) => {
      expect(projectDir).toBe(dir)
      expect(featureId).toBe('integration-test-feature')
      return { sessionId: 's', totalInputTokens: 0, totalOutputTokens: 0, peakContextTokens: 0, success: true, durationMs: 100 } as AgentResult
    })
    mockEval.mockImplementation(async (projectDir: string, featureId: string) => {
      const report: EvalReport = {
        featureId,
        verdict: 'pass',
        criteriaResults: [],
        notes: '',
        evaluatedAt: new Date().toISOString(),
        sessionId: 'eval-s',
      }
      await writeFile(join(projectDir, 'eval-report.json'), JSON.stringify(report))
      return { sessionId: 'eval-s', totalInputTokens: 0, totalOutputTokens: 0, peakContextTokens: 0, success: true, durationMs: 100 } as AgentResult
    })

    const orch = new Orchestrator({ projectDir: dir })
    await orch.implementFeature(testFeature)
  })

  it('sprint-contract.json exists when coder is invoked', async () => {
    let sprintContractExists = false

    mockCoder.mockImplementation(async (projectDir: string) => {
      const { existsSync } = await import('node:fs')
      sprintContractExists = existsSync(join(projectDir, 'sprint-contract.json'))
      return { sessionId: 's', totalInputTokens: 0, totalOutputTokens: 0, peakContextTokens: 0, success: true, durationMs: 100 } as AgentResult
    })
    mockEval.mockImplementation(async (projectDir: string, featureId: string) => {
      const report: EvalReport = {
        featureId,
        verdict: 'pass',
        criteriaResults: [],
        notes: '',
        evaluatedAt: new Date().toISOString(),
        sessionId: 'eval-s',
      }
      await writeFile(join(projectDir, 'eval-report.json'), JSON.stringify(report))
      return { sessionId: 'eval-s', totalInputTokens: 0, totalOutputTokens: 0, peakContextTokens: 0, success: true, durationMs: 100 } as AgentResult
    })

    const orch = new Orchestrator({ projectDir: dir })
    await orch.implementFeature(testFeature)
    expect(sprintContractExists).toBe(true)
  })

  it('full run() loop processes all features', async () => {
    const features = [
      makeFeature({ id: 'feat-1', passes: false }),
      makeFeature({ id: 'feat-2', passes: false }),
    ]
    const multiDir = await makeTempProject(features)

    mockCoder.mockResolvedValue({
      sessionId: 'coder',
      totalInputTokens: 100,
      totalOutputTokens: 50,
      peakContextTokens: 500,
      success: true,
      durationMs: 200,
    } as AgentResult)

    mockEval.mockImplementation(async (projectDir: string, featureId: string) => {
      const report: EvalReport = {
        featureId,
        verdict: 'pass',
        criteriaResults: [{ criterion: 'A', result: 'pass', evidence: 'ok' }],
        notes: 'pass',
        evaluatedAt: new Date().toISOString(),
        sessionId: 'eval',
      }
      await writeFile(join(projectDir, 'eval-report.json'), JSON.stringify(report, null, 2))
      // Mark feature as passing in features.json so the run() loop can detect completion
      await markFeaturePassing(projectDir, featureId, 'eval-session')
      return {
        sessionId: 'eval',
        totalInputTokens: 50,
        totalOutputTokens: 20,
        peakContextTokens: 200,
        success: true,
        durationMs: 100,
      } as AgentResult
    })

    const orch = new Orchestrator({ projectDir: multiDir, maxConcurrency: 1 })
    await orch.run()

    expect(mockCoder).toHaveBeenCalledTimes(2)
    expect(mockEval).toHaveBeenCalledTimes(2)

    await cleanTempDir(multiDir)
  })

  it('evaluator failure causes retry and eventual fail', async () => {
    mockCoder.mockResolvedValue({
      sessionId: 'coder',
      totalInputTokens: 100,
      totalOutputTokens: 50,
      peakContextTokens: 500,
      success: true,
      durationMs: 200,
    } as AgentResult)

    // Always fail
    mockEval.mockImplementation(async (projectDir: string, featureId: string) => {
      const report: EvalReport = {
        featureId,
        verdict: 'fail',
        criteriaResults: [{ criterion: 'A', result: 'fail', evidence: 'not working' }],
        notes: 'fail',
        evaluatedAt: new Date().toISOString(),
        sessionId: 'eval',
      }
      await writeFile(join(projectDir, 'eval-report.json'), JSON.stringify(report, null, 2))
      return {
        sessionId: 'eval',
        totalInputTokens: 50,
        totalOutputTokens: 20,
        peakContextTokens: 200,
        success: true,
        durationMs: 100,
      } as AgentResult
    })

    const orch = new Orchestrator({ projectDir: dir, retryLimit: 1 })
    const { verdict } = await orch.implementFeature(testFeature)
    expect(verdict).toBe('fail')
    // Should have tried retryLimit + 1 = 2 times
    expect(mockCoder).toHaveBeenCalledTimes(2)
    expect(mockEval).toHaveBeenCalledTimes(2)
  })
})
