import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { makeTempDir, cleanTempDir, makeFeature, makeTempProject } from '../helpers/tempDir.js'
import type { AgentResult, EvalReport } from '../../src/agents/types.js'
import { readEvents, initEventLog } from '../../src/events.js'

// ── Mock all agent modules ──────────────────────────────────────────────────
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

// ── Mock infrastructure modules ─────────────────────────────────────────────
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
    startSession() {
      return { id: 'trace-session-id', recordMessage() {}, end() {} }
    }
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

// ── Import after mocks are set up ────────────────────────────────────────────
import { Orchestrator } from '../../src/orchestrator.js'
import { runCoderAgent, ContextResetNeededError } from '../../src/agents/coder.js'
import { runEvaluatorAgent } from '../../src/agents/evaluator.js'
import { runInitializerAgent } from '../../src/agents/initializer.js'

const mockCoderAgent = vi.mocked(runCoderAgent)
const mockEvalAgent = vi.mocked(runEvaluatorAgent)
const mockInitAgent = vi.mocked(runInitializerAgent)

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

describe('orchestrator.ts', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeTempProject([makeFeature({ id: 'test-feature', passes: false })])
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await cleanTempDir(dir)
  })

  describe('constructor and defaults', () => {
    it('creates an orchestrator with given projectDir', () => {
      const orch = new Orchestrator({ projectDir: dir })
      expect(orch).toBeInstanceOf(Orchestrator)
    })
  })

  describe('getStatus()', () => {
    it('returns correct passing count and total', async () => {
      const orch = new Orchestrator({ projectDir: dir })
      const status = await orch.getStatus()
      expect(status.passing).toBe(0)
      expect(status.total).toBe(1)
    })

    it('returns currentFeature from progress', async () => {
      const orch = new Orchestrator({ projectDir: dir })
      const status = await orch.getStatus()
      expect(status.currentFeature).toBeNull()
    })

    it('reflects passing features correctly', async () => {
      const dir2 = await makeTempProject([
        makeFeature({ id: 'a', passes: true }),
        makeFeature({ id: 'b', passes: false }),
      ])
      const orch = new Orchestrator({ projectDir: dir2 })
      const status = await orch.getStatus()
      expect(status.passing).toBe(1)
      expect(status.total).toBe(2)
      await cleanTempDir(dir2)
    })
  })

  describe('implementFeature()', () => {
    it('returns "pass" when coder and evaluator succeed', async () => {
      mockCoderAgent.mockResolvedValue(makeAgentResult({ success: true }))
      mockEvalAgent.mockImplementation(async (projDir: string) => {
        await writeEvalReport(projDir, 'pass')
        return makeAgentResult({ sessionId: 'eval-session' })
      })

      const orch = new Orchestrator({ projectDir: dir })
      const verdict = await orch.implementFeature(makeFeature({ id: 'test-feature' }))
      expect(verdict).toBe('pass')
    })

    it('returns "fail" when evaluator returns fail verdict after all retries', async () => {
      mockCoderAgent.mockResolvedValue(makeAgentResult({ success: true }))
      mockEvalAgent.mockImplementation(async (projDir: string) => {
        await writeEvalReport(projDir, 'fail')
        return makeAgentResult({ sessionId: 'eval-session' })
      })

      const orch = new Orchestrator({ projectDir: dir, retryLimit: 0 })
      const verdict = await orch.implementFeature(makeFeature({ id: 'test-feature' }))
      expect(verdict).toBe('fail')
    })

    it('retries when evaluator fails initially then passes', async () => {
      mockCoderAgent.mockResolvedValue(makeAgentResult({ success: true }))

      let callCount = 0
      mockEvalAgent.mockImplementation(async (projDir: string) => {
        callCount++
        const verdict = callCount < 2 ? 'fail' : 'pass'
        await writeEvalReport(projDir, verdict)
        return makeAgentResult({ sessionId: 'eval-session' })
      })

      const orch = new Orchestrator({ projectDir: dir, retryLimit: 2 })
      const verdict = await orch.implementFeature(makeFeature({ id: 'test-feature' }))
      expect(verdict).toBe('pass')
      expect(callCount).toBe(2)
    })

    it('calls runCoderAgent at least once', async () => {
      mockCoderAgent.mockResolvedValue(makeAgentResult({ success: true }))
      mockEvalAgent.mockImplementation(async (projDir: string) => {
        await writeEvalReport(projDir, 'pass')
        return makeAgentResult()
      })

      const orch = new Orchestrator({ projectDir: dir })
      await orch.implementFeature(makeFeature({ id: 'test-feature' }))
      expect(mockCoderAgent).toHaveBeenCalledTimes(1)
    })

    it('calls runEvaluatorAgent after coder succeeds', async () => {
      mockCoderAgent.mockResolvedValue(makeAgentResult({ success: true }))
      mockEvalAgent.mockImplementation(async (projDir: string) => {
        await writeEvalReport(projDir, 'pass')
        return makeAgentResult()
      })

      const orch = new Orchestrator({ projectDir: dir })
      await orch.implementFeature(makeFeature({ id: 'test-feature' }))
      expect(mockEvalAgent).toHaveBeenCalledTimes(1)
    })

    it('returns "fail" when coder fails', async () => {
      mockCoderAgent.mockResolvedValue(makeAgentResult({ success: false, error: 'coder crashed' }))

      const orch = new Orchestrator({ projectDir: dir, retryLimit: 0 })
      const verdict = await orch.implementFeature(makeFeature({ id: 'test-feature' }))
      expect(verdict).toBe('fail')
      expect(mockEvalAgent).not.toHaveBeenCalled()
    })

    it('returns "fail" when eval report is missing', async () => {
      mockCoderAgent.mockResolvedValue(makeAgentResult({ success: true }))
      mockEvalAgent.mockResolvedValue(makeAgentResult({ success: true }))
      // Don't write eval-report.json

      const orch = new Orchestrator({ projectDir: dir, retryLimit: 0 })
      const verdict = await orch.implementFeature(makeFeature({ id: 'test-feature' }))
      expect(verdict).toBe('fail')
    })

    it('writes sprint-contract.json before calling coder', async () => {
      let contractExists = false
      mockCoderAgent.mockImplementation(async (projDir: string) => {
        const { existsSync } = await import('node:fs')
        contractExists = existsSync(join(projDir, 'sprint-contract.json'))
        return makeAgentResult({ success: true })
      })
      mockEvalAgent.mockImplementation(async (projDir: string) => {
        await writeEvalReport(projDir, 'pass')
        return makeAgentResult()
      })

      const orch = new Orchestrator({ projectDir: dir })
      await orch.implementFeature(makeFeature({ id: 'test-feature' }))
      expect(contractExists).toBe(true)
    })
  })

  describe('run() with dryRun=true', () => {
    it('does not call any agents in dry-run mode', async () => {
      const orch = new Orchestrator({ projectDir: dir, dryRun: true })
      await orch.run()
      expect(mockCoderAgent).not.toHaveBeenCalled()
      expect(mockEvalAgent).not.toHaveBeenCalled()
    })

    it('completes without error in dry-run mode', async () => {
      const orch = new Orchestrator({ projectDir: dir, dryRun: true })
      await expect(orch.run()).resolves.not.toThrow()
    })

    it('handles all-features-passing case in dry-run', async () => {
      const dir2 = await makeTempProject([
        makeFeature({ id: 'a', passes: true }),
      ])
      const orch = new Orchestrator({ projectDir: dir2, dryRun: true })
      await expect(orch.run()).resolves.not.toThrow()
      await cleanTempDir(dir2)
    })
  })

  describe('run() sequential mode', () => {
    it('calls implementFeature for a pending feature', async () => {
      mockCoderAgent.mockResolvedValue(makeAgentResult({ success: true }))
      mockEvalAgent.mockImplementation(async (projDir: string) => {
        await writeEvalReport(projDir, 'pass')
        return makeAgentResult()
      })

      const orch = new Orchestrator({ projectDir: dir, maxFeatures: 1 })
      await orch.run()
      expect(mockCoderAgent).toHaveBeenCalledTimes(1)
    })

    it('stops when maxFeatures is reached', async () => {
      const dir2 = await makeTempProject([
        makeFeature({ id: 'a' }),
        makeFeature({ id: 'b' }),
      ])

      mockCoderAgent.mockResolvedValue(makeAgentResult({ success: true }))
      mockEvalAgent.mockImplementation(async (projDir: string, featureId: string) => {
        await writeEvalReport(projDir, 'pass', featureId)
        return makeAgentResult()
      })

      const orch = new Orchestrator({ projectDir: dir2, maxFeatures: 1 })
      await orch.run()
      expect(mockCoderAgent).toHaveBeenCalledTimes(1)
      await cleanTempDir(dir2)
    })
  })

  describe('initialize()', () => {
    it('skips if init.sh already exists', async () => {
      await writeFile(join(dir, 'init.sh'), '#!/bin/bash\n')
      const orch = new Orchestrator({ projectDir: dir })
      await orch.initialize('desc', 'project')
      expect(mockInitAgent).not.toHaveBeenCalled()
    })

    it('skips if dryRun=true', async () => {
      const orch = new Orchestrator({ projectDir: dir, dryRun: true })
      await orch.initialize('desc', 'project')
      expect(mockInitAgent).not.toHaveBeenCalled()
    })
  })

  describe('resume()', () => {
    it('calls run() after reading progress', async () => {
      mockCoderAgent.mockResolvedValue(makeAgentResult({ success: true }))
      mockEvalAgent.mockImplementation(async (projDir: string) => {
        await writeEvalReport(projDir, 'pass')
        return makeAgentResult()
      })

      const orch = new Orchestrator({ projectDir: dir, maxFeatures: 1 })
      await expect(orch.resume()).resolves.not.toThrow()
    })

    it('throws when claude-progress.txt does not exist', async () => {
      const emptyDir = await makeTempDir()
      const orch = new Orchestrator({ projectDir: emptyDir })
      await expect(orch.resume()).rejects.toThrow()
      await cleanTempDir(emptyDir)
    })
  })

  describe('context reset handling in runCoderWithResets', () => {
    it('retries on ContextResetNeededError', async () => {
      let coderCallCount = 0
      mockCoderAgent.mockImplementation(async () => {
        coderCallCount++
        if (coderCallCount === 1) {
          throw new ContextResetNeededError('context limit reached')
        }
        return makeAgentResult({ success: true })
      })
      mockEvalAgent.mockImplementation(async (projDir: string) => {
        await writeEvalReport(projDir, 'pass')
        return makeAgentResult()
      })

      const orch = new Orchestrator({ projectDir: dir, maxContextResets: 2 })
      const verdict = await orch.implementFeature(makeFeature({ id: 'test-feature' }))
      expect(coderCallCount).toBeGreaterThan(1)
      expect(verdict).toBe('pass')
    })

    it('returns fail when maxContextResets is exceeded', async () => {
      mockCoderAgent.mockRejectedValue(new ContextResetNeededError('always reset'))

      const orch = new Orchestrator({ projectDir: dir, maxContextResets: 1, retryLimit: 0 })
      const verdict = await orch.implementFeature(makeFeature({ id: 'test-feature' }))
      expect(verdict).toBe('fail')
    })
  })

  describe('runInitSh()', () => {
    it('succeeds silently when no init.sh exists', async () => {
      const orch = new Orchestrator({ projectDir: dir })
      await expect(orch.runInitSh()).resolves.toBeUndefined()
    })

    it('skips init.sh when skipInit is true', async () => {
      // Create a failing init.sh to verify it's not run
      const initSh = join(dir, 'init.sh')
      await writeFile(initSh, '#!/bin/bash\nexit 1\n', 'utf-8')
      await chmod(initSh, 0o755)

      const orch = new Orchestrator({ projectDir: dir, skipInit: true })
      await expect(orch.runInitSh()).resolves.toBeUndefined()
    })

    it('succeeds when init.sh exits 0', async () => {
      const initSh = join(dir, 'init.sh')
      await writeFile(initSh, '#!/bin/bash\nexit 0\n', 'utf-8')
      await chmod(initSh, 0o755)

      const orch = new Orchestrator({ projectDir: dir })
      await expect(orch.runInitSh()).resolves.toBeUndefined()
    })

    it('emits init_failed events and throws after 3 failures', async () => {
      const initSh = join(dir, 'init.sh')
      await writeFile(initSh, '#!/bin/bash\necho "error output" >&2\nexit 1\n', 'utf-8')
      await chmod(initSh, 0o755)

      initEventLog(dir)
      const orch = new Orchestrator({ projectDir: dir })
      await expect(orch.runInitSh()).rejects.toThrow('init.sh failed after 3 attempts')

      const events = readEvents(dir)
      const failEvents = events.filter(e => e.type === 'init_failed')
      expect(failEvents).toHaveLength(3)
    })

    it('emits init_failed with captured stderr', async () => {
      const initSh = join(dir, 'init.sh')
      await writeFile(initSh, '#!/bin/bash\necho "something went wrong" >&2\nexit 2\n', 'utf-8')
      await chmod(initSh, 0o755)

      initEventLog(dir)
      const orch = new Orchestrator({ projectDir: dir })
      await expect(orch.runInitSh()).rejects.toThrow()

      const events = readEvents(dir)
      const failEvents = events.filter(e => e.type === 'init_failed')
      expect(failEvents.length).toBeGreaterThan(0)
      const firstFail = failEvents[0] as { type: 'init_failed'; attempt: number; exitCode: number | null; stderr: string }
      expect(firstFail.stderr).toContain('something went wrong')
      expect(firstFail.attempt).toBe(1)
    })

    it('succeeds on second attempt (retry logic)', async () => {
      const initSh = join(dir, 'init.sh')
      const attemptFile = join(dir, '.attempt')
      // First attempt fails, second succeeds
      await writeFile(initSh, `#!/bin/bash\nif [ ! -f "${attemptFile}" ]; then\n  touch "${attemptFile}"\n  exit 1\nfi\nexit 0\n`, 'utf-8')
      await chmod(initSh, 0o755)

      initEventLog(dir)
      const orch = new Orchestrator({ projectDir: dir })
      await expect(orch.runInitSh()).resolves.toBeUndefined()

      const events = readEvents(dir)
      const failEvents = events.filter(e => e.type === 'init_failed')
      expect(failEvents).toHaveLength(1)
    })
  })
})
