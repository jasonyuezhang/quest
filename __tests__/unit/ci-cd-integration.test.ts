/**
 * Tests for CI/CD integration feature (ci-cd-integration-23).
 *
 * Verifies:
 * - ciMode outputs JSON lines to stdout
 * - failFast stops on first failure
 * - QUEST_API_KEY / QUEST_MODEL env var handling is wired in cli
 * - GitHub Actions workflow template exists
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { makeTempDir, cleanTempDir, makeFeature, makeTempProject } from '../helpers/tempDir.js'
import type { AgentResult, EvalReport } from '../../src/agents/types.js'

// ── Mock agent modules ──────────────────────────────────────────────────────
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
  planNextBatch: vi.fn().mockReturnValue([]),
  getNewlyUnblocked: vi.fn().mockReturnValue([]),
  estimateTotalTime: vi.fn().mockReturnValue(0),
  formatDAGSummary: vi.fn().mockReturnValue(''),
}))

vi.mock('../../src/trace.js', () => ({
  Tracer: class MockTracer {
    startSession() { return { id: 'trace-session-id', recordMessage() {}, end() {} } }
    endSession() {}
  },
}))

vi.mock('../../src/agent-git/index.js', () => ({
  AgentGit: class MockAgentGit {
    async init() {}
    async createExternalSession() { return { id: 'ext-session-id' } }
    async startSession() { return { id: 'ag-session-id' } }
    async endSession() {}
    async checkpoint() { return { id: 'checkpoint-abc123def' } }
    async rollbackTo() { return { preservedBranch: null } }
  },
}))

import { Orchestrator } from '../../src/orchestrator.js'
import { runCoderAgent } from '../../src/agents/coder.js'
import { runEvaluatorAgent } from '../../src/agents/evaluator.js'

const mockCoderAgent = vi.mocked(runCoderAgent)
const mockEvalAgent = vi.mocked(runEvaluatorAgent)

function makeAgentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    sessionId: 'session-test',
    totalInputTokens: 100,
    totalOutputTokens: 50,
    peakContextTokens: 1000,
    success: true,
    durationMs: 500,
    ...overrides,
  }
}

async function writeEvalReport(dir: string, verdict: 'pass' | 'fail', featureId = 'test-feature') {
  const report: EvalReport = {
    featureId,
    verdict,
    criteriaResults: [{ criterion: 'A', result: verdict, evidence: 'mock evidence' }],
    notes: 'Mock eval',
    evaluatedAt: new Date().toISOString(),
    sessionId: 'eval-session',
  }
  await writeFile(join(dir, 'eval-report.json'), JSON.stringify(report, null, 2) + '\n')
}

describe('CI/CD Integration', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeTempProject([makeFeature({ id: 'test-feature', passes: false })])
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await cleanTempDir(dir)
  })

  describe('ciMode option', () => {
    it('accepts ciMode option without error', () => {
      const orch = new Orchestrator({ projectDir: dir, ciMode: true })
      expect(orch).toBeInstanceOf(Orchestrator)
    })

    it('outputs JSON to stdout in CI mode during feature run', async () => {
      const stdoutWrites: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        stdoutWrites.push(String(chunk))
        return true
      })

      mockCoderAgent.mockResolvedValue(makeAgentResult({ success: true }))
      mockEvalAgent.mockImplementation(async (projDir: string) => {
        await writeEvalReport(projDir, 'pass')
        return makeAgentResult({ sessionId: 'eval-session' })
      })

      const orch = new Orchestrator({ projectDir: dir, ciMode: true, maxConcurrency: 1, maxFeatures: 1 })
      await orch.run()

      vi.restoreAllMocks()

      // Should have written JSON lines to stdout
      const jsonLines = stdoutWrites.join('').split('\n').filter(l => l.trim())
      expect(jsonLines.length).toBeGreaterThan(0)

      // Each line should be valid JSON
      for (const line of jsonLines) {
        expect(() => JSON.parse(line)).not.toThrow()
      }

      // Should include feature_start and feature_done events
      const events = jsonLines.map(l => JSON.parse(l) as { event?: string })
      const eventTypes = events.map(e => e.event)
      expect(eventTypes).toContain('feature_start')
      expect(eventTypes).toContain('feature_done')
    })

    it('sends chalk output to stderr instead of stdout in CI mode', async () => {
      const stderrWrites: string[] = []
      const stdoutWrites: string[] = []

      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
        stderrWrites.push(String(chunk))
        return true
      })
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        stdoutWrites.push(String(chunk))
        return true
      })

      mockCoderAgent.mockResolvedValue(makeAgentResult({ success: true }))
      mockEvalAgent.mockImplementation(async (projDir: string) => {
        await writeEvalReport(projDir, 'pass')
        return makeAgentResult({ sessionId: 'eval-session' })
      })

      const orch = new Orchestrator({ projectDir: dir, ciMode: true, maxConcurrency: 1, maxFeatures: 1 })
      await orch.run()

      vi.restoreAllMocks()

      // stderr should have some human-readable output
      expect(stderrWrites.join('')).toBeTruthy()

      // stdout should only have JSON lines (no non-JSON content)
      const nonJsonStdout = stdoutWrites.join('').split('\n').filter(l => l.trim()).filter(l => {
        try { JSON.parse(l); return false } catch { return true }
      })
      expect(nonJsonStdout).toHaveLength(0)
    })
  })

  describe('failFast option', () => {
    it('accepts failFast option without error', () => {
      const orch = new Orchestrator({ projectDir: dir, failFast: true })
      expect(orch).toBeInstanceOf(Orchestrator)
    })

    it('stops after first failure when failFast is true', async () => {
      // Use maxFeatures: 3 — without failFast this would try the same feature 3 times
      // With failFast it should stop after the 1st failure
      mockCoderAgent.mockResolvedValue(makeAgentResult({ success: true }))
      mockEvalAgent.mockImplementation(async (projDir: string) => {
        await writeEvalReport(projDir, 'fail')
        return makeAgentResult({ sessionId: 'eval-session' })
      })

      const orch = new Orchestrator({
        projectDir: dir,
        failFast: true,
        retryLimit: 0,
        maxConcurrency: 1,
        maxFeatures: 3,
      })
      await orch.run()

      // With failFast, the loop breaks after 1 failure
      expect(mockEvalAgent).toHaveBeenCalledTimes(1)
    })

    it('continues past failure without failFast (processes maxFeatures)', async () => {
      // Without failFast, the loop runs up to maxFeatures times
      mockCoderAgent.mockResolvedValue(makeAgentResult({ success: true }))
      mockEvalAgent.mockImplementation(async (projDir: string) => {
        await writeEvalReport(projDir, 'fail')
        return makeAgentResult({ sessionId: 'eval-session' })
      })

      const orch = new Orchestrator({
        projectDir: dir,
        failFast: false,
        retryLimit: 0,
        maxConcurrency: 1,
        maxFeatures: 2,
      })
      await orch.run()

      // Without failFast, the loop runs until maxFeatures (2 iterations of the failing feature)
      expect(mockEvalAgent).toHaveBeenCalledTimes(2)
    })
  })

  describe('CI mode JSON output structure', () => {
    it('includes ts (timestamp) in each JSON event', async () => {
      const stdoutWrites: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        stdoutWrites.push(String(chunk))
        return true
      })

      mockCoderAgent.mockResolvedValue(makeAgentResult({ success: true }))
      mockEvalAgent.mockImplementation(async (projDir: string) => {
        await writeEvalReport(projDir, 'pass')
        return makeAgentResult({ sessionId: 'eval-session' })
      })

      const orch = new Orchestrator({ projectDir: dir, ciMode: true, maxConcurrency: 1, maxFeatures: 1 })
      await orch.run()

      vi.restoreAllMocks()

      const jsonLines = stdoutWrites.join('').split('\n').filter(l => l.trim())
      for (const line of jsonLines) {
        const event = JSON.parse(line) as { ts?: string }
        expect(event.ts).toBeTruthy()
        expect(typeof event.ts).toBe('string')
      }
    })

    it('includes feature_done with verdict in JSON output', async () => {
      const stdoutWrites: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        stdoutWrites.push(String(chunk))
        return true
      })

      mockCoderAgent.mockResolvedValue(makeAgentResult({ success: true }))
      mockEvalAgent.mockImplementation(async (projDir: string) => {
        await writeEvalReport(projDir, 'pass')
        return makeAgentResult({ sessionId: 'eval-session' })
      })

      const orch = new Orchestrator({ projectDir: dir, ciMode: true, maxConcurrency: 1, maxFeatures: 1 })
      await orch.run()

      vi.restoreAllMocks()

      const jsonLines = stdoutWrites.join('').split('\n').filter(l => l.trim())
      const events = jsonLines.map(l => JSON.parse(l) as Record<string, unknown>)
      const featureDone = events.find(e => e.event === 'feature_done')
      expect(featureDone).toBeTruthy()
      expect(featureDone?.verdict).toBe('pass')
    })
  })

  describe('GitHub Actions workflow template', () => {
    it('exists at .github/workflows/quest-run.yml', () => {
      const workflowPath = resolve(__dirname, '../../.github/workflows/quest-run.yml')
      expect(existsSync(workflowPath)).toBe(true)
    })

    it('contains QUEST_API_KEY environment variable reference', () => {
      const workflowPath = resolve(__dirname, '../../.github/workflows/quest-run.yml')
      const content = readFileSync(workflowPath, 'utf-8')
      expect(content).toContain('QUEST_API_KEY')
    })

    it('contains --ci flag usage', () => {
      const workflowPath = resolve(__dirname, '../../.github/workflows/quest-run.yml')
      const content = readFileSync(workflowPath, 'utf-8')
      expect(content).toContain('--ci')
    })

    it('contains --fail-fast flag', () => {
      const workflowPath = resolve(__dirname, '../../.github/workflows/quest-run.yml')
      const content = readFileSync(workflowPath, 'utf-8')
      expect(content).toContain('--fail-fast')
    })

    it('contains QUEST_MODEL environment variable reference', () => {
      const workflowPath = resolve(__dirname, '../../.github/workflows/quest-run.yml')
      const content = readFileSync(workflowPath, 'utf-8')
      expect(content).toContain('QUEST_MODEL')
    })
  })
})
