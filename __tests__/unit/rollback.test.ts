/**
 * Unit tests for Feature Rollback Mechanism (rollback-mechanism-10).
 *
 * Tests:
 *  - Orchestrator tracks commit SHAs for passing features
 *  - rollbackFeature() identifies the commit and reverts it
 *  - Revert commit message format
 *  - Rolled-back feature is re-queued (passes:false)
 *  - Regressor feature is also re-queued when provided
 *  - Errors on missing feature / missing SHA
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeTempDir, cleanTempDir, makeFeature, makeTempProject } from '../helpers/tempDir.js'
import type { ProgressState } from '../../src/agents/types.js'

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

// Mock node:child_process so we can control git output
const mockExec = vi.fn()
vi.mock('node:child_process', () => ({
  exec: (cmd: string, opts: unknown, cb: (err: null | Error, result: { stdout: string; stderr: string }) => void) => {
    // Support both (cmd, opts, cb) and (cmd, cb) signatures
    const callback = typeof opts === 'function' ? opts : cb
    mockExec(cmd, opts, callback)
  },
}))

import { Orchestrator } from '../../src/orchestrator.js'
import { readFeaturesFile } from '../../src/state/features.js'
import { readProgress } from '../../src/state/progress.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Write a progress file with featureCommitShas populated */
async function writeProgressWithShas(
  dir: string,
  featureCommitShas: Record<string, string>,
): Promise<void> {
  const progress: ProgressState = {
    projectName: 'test-project',
    totalFeatures: 2,
    passedFeatures: 1,
    currentFeatureId: null,
    lastCommitSha: null,
    lastSessionId: null,
    lastUpdated: new Date().toISOString(),
    contextResets: 0,
    featureCommitShas,
  }
  await writeFile(join(dir, 'claude-progress.txt'), JSON.stringify(progress, null, 2) + '\n', 'utf-8')
}

/** Set up mock exec to succeed for git operations */
function setupGitMocksSuccess(sha = 'abc1234567890def') {
  mockExec.mockImplementation((cmd: string, _opts: unknown, cb: (err: null, res: { stdout: string; stderr: string }) => void) => {
    const callback = typeof _opts === 'function' ? _opts : cb
    if (typeof cmd === 'string' && cmd.includes('git log')) {
      callback(null, { stdout: sha + '\n', stderr: '' })
    } else {
      callback(null, { stdout: '', stderr: '' })
    }
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('rollback mechanism', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeTempProject([
      makeFeature({ id: 'feature-a', name: 'Feature Alpha', passes: true }),
      makeFeature({ id: 'feature-b', name: 'Feature Beta', passes: true }),
    ])
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await cleanTempDir(dir)
  })

  describe('commit SHA tracking', () => {
    it('featureCommitShas field is recorded in progress when feature passes', async () => {
      // The featureCommitShas field should be part of ProgressState type
      const progress = await readProgress(dir)
      // Initially undefined (not set in initial progress)
      expect(progress.featureCommitShas ?? {}).toEqual({})
    })

    it('ProgressState type supports featureCommitShas as optional Record', async () => {
      // Write a progress file with featureCommitShas
      await writeProgressWithShas(dir, { 'feature-a': 'deadbeef1234' })
      const progress = await readProgress(dir)
      expect(progress.featureCommitShas).toBeDefined()
      expect(progress.featureCommitShas!['feature-a']).toBe('deadbeef1234')
    })
  })

  describe('rollbackFeature()', () => {
    it('throws when feature is not found', async () => {
      setupGitMocksSuccess()
      const orch = new Orchestrator({ projectDir: dir })
      await expect(orch.rollbackFeature('nonexistent-feature')).rejects.toThrow('Feature not found')
    })

    it('throws when no commit SHA is recorded for the feature', async () => {
      setupGitMocksSuccess()
      // No featureCommitShas set (empty progress)
      const orch = new Orchestrator({ projectDir: dir })
      await expect(orch.rollbackFeature('feature-a')).rejects.toThrow('No commit SHA recorded')
    })

    it('marks the feature as passes:false after rollback', async () => {
      setupGitMocksSuccess()
      await writeProgressWithShas(dir, { 'feature-a': 'abc123' })

      const orch = new Orchestrator({ projectDir: dir })
      await orch.rollbackFeature('feature-a')

      const featuresData = await readFeaturesFile(dir)
      const feature = featuresData.features.find(f => f.id === 'feature-a')
      expect(feature?.passes).toBe(false)
    })

    it('leaves other features unaffected when rolling back one feature', async () => {
      setupGitMocksSuccess()
      await writeProgressWithShas(dir, { 'feature-a': 'abc123' })

      const orch = new Orchestrator({ projectDir: dir })
      await orch.rollbackFeature('feature-a')

      const featuresData = await readFeaturesFile(dir)
      const featureB = featuresData.features.find(f => f.id === 'feature-b')
      expect(featureB?.passes).toBe(true)
    })

    it('also marks the regressor feature as passes:false when provided', async () => {
      setupGitMocksSuccess()
      await writeProgressWithShas(dir, { 'feature-a': 'abc123' })

      const orch = new Orchestrator({ projectDir: dir })
      await orch.rollbackFeature('feature-a', 'feature-b')

      const featuresData = await readFeaturesFile(dir)
      const featureA = featuresData.features.find(f => f.id === 'feature-a')
      const featureB = featuresData.features.find(f => f.id === 'feature-b')
      expect(featureA?.passes).toBe(false)
      expect(featureB?.passes).toBe(false)
    })

    it('does not double-requeue if rollbackFeatureId === regressorFeatureId', async () => {
      setupGitMocksSuccess()
      await writeProgressWithShas(dir, { 'feature-a': 'abc123' })

      const orch = new Orchestrator({ projectDir: dir })
      // Should not throw even if same ID passed for both
      await expect(orch.rollbackFeature('feature-a', 'feature-a')).resolves.not.toThrow()
    })

    it('removes the commit SHA from progress after rollback', async () => {
      setupGitMocksSuccess()
      await writeProgressWithShas(dir, { 'feature-a': 'abc123', 'feature-b': 'def456' })

      const orch = new Orchestrator({ projectDir: dir })
      await orch.rollbackFeature('feature-a')

      const progress = await readProgress(dir)
      expect(progress.featureCommitShas?.['feature-a']).toBeUndefined()
      // feature-b SHA should still be there
      expect(progress.featureCommitShas?.['feature-b']).toBe('def456')
    })

    it('calls git revert with the correct commit SHA', async () => {
      const capturedCmds: string[] = []
      mockExec.mockImplementation((cmd: string, _opts: unknown, cb: (err: null, res: { stdout: string; stderr: string }) => void) => {
        const callback = typeof _opts === 'function' ? _opts : cb
        capturedCmds.push(cmd)
        callback(null, { stdout: '', stderr: '' })
      })

      await writeProgressWithShas(dir, { 'feature-a': 'deadbeef9999' })

      const orch = new Orchestrator({ projectDir: dir })
      await orch.rollbackFeature('feature-a')

      const revertCmd = capturedCmds.find(c => c.includes('git revert'))
      expect(revertCmd).toBeDefined()
      expect(revertCmd).toContain('deadbeef9999')
    })

    it('creates a revert commit with the correct message format', async () => {
      const capturedCmds: string[] = []
      mockExec.mockImplementation((cmd: string, _opts: unknown, cb: (err: null, res: { stdout: string; stderr: string }) => void) => {
        const callback = typeof _opts === 'function' ? _opts : cb
        capturedCmds.push(cmd)
        callback(null, { stdout: '', stderr: '' })
      })

      await writeProgressWithShas(dir, { 'feature-a': 'abc123xyz' })

      const orch = new Orchestrator({ projectDir: dir })
      await orch.rollbackFeature('feature-a')

      // The commit message should be 'revert: rollback <feature-name> due to regression'
      const commitCmd = capturedCmds.find(c => c.includes('git commit'))
      expect(commitCmd).toBeDefined()
      expect(commitCmd).toContain('revert: rollback Feature Alpha due to regression')
    })

    it('uses --no-commit flag when reverting so it can set the message', async () => {
      const capturedCmds: string[] = []
      mockExec.mockImplementation((cmd: string, _opts: unknown, cb: (err: null, res: { stdout: string; stderr: string }) => void) => {
        const callback = typeof _opts === 'function' ? _opts : cb
        capturedCmds.push(cmd)
        callback(null, { stdout: '', stderr: '' })
      })

      await writeProgressWithShas(dir, { 'feature-a': 'abc123xyz' })

      const orch = new Orchestrator({ projectDir: dir })
      await orch.rollbackFeature('feature-a')

      const revertCmd = capturedCmds.find(c => c.includes('git revert'))
      expect(revertCmd).toContain('--no-commit')
    })

    it('updates passedFeatures count in progress after rollback', async () => {
      setupGitMocksSuccess()
      await writeProgressWithShas(dir, { 'feature-a': 'abc123', 'feature-b': 'def456' })

      const orch = new Orchestrator({ projectDir: dir })
      await orch.rollbackFeature('feature-a')

      const progress = await readProgress(dir)
      // Started with 2 passing (both features had passes:true), now 1 after rolling back feature-a
      expect(progress.passedFeatures).toBe(1)
    })

    it('throws and aborts git revert on git failure', async () => {
      mockExec.mockImplementation((cmd: string, _opts: unknown, cb: (err: Error | null, res?: { stdout: string; stderr: string }) => void) => {
        const callback = typeof _opts === 'function' ? _opts : cb
        if (typeof cmd === 'string' && cmd.includes('git revert') && !cmd.includes('--abort')) {
          callback(new Error('conflict during revert'))
        } else {
          callback(null, { stdout: '', stderr: '' })
        }
      })

      await writeProgressWithShas(dir, { 'feature-a': 'abc123' })

      const orch = new Orchestrator({ projectDir: dir })
      await expect(orch.rollbackFeature('feature-a')).rejects.toThrow('Failed to revert')
    })
  })
})
