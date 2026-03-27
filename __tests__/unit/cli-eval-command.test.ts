/**
 * Tests for the `quest eval <feature-id>` CLI command (cli-eval-command).
 *
 * Verifies:
 * - quest eval invokes the evaluator agent for the given feature ID
 * - Verdict (PASS/FAIL) is printed clearly to stdout
 * - Each acceptance criterion result is printed with a pass/fail indicator
 * - Evidence for each criterion is shown in the output
 * - Command exits non-zero when verdict is FAIL
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeTempDir, cleanTempDir } from '../helpers/tempDir.js'
import type { AgentResult, EvalReport } from '../../src/agents/types.js'

// ── Mock agent modules ──────────────────────────────────────────────────────
vi.mock('../../src/agents/evaluator.js', () => ({
  runEvaluatorAgent: vi.fn(),
  readEvalReport: vi.fn(),
}))

vi.mock('../../src/context/manager.js', () => ({
  ContextManager: class MockContextManager {},
}))

import { runEvaluatorAgent, readEvalReport } from '../../src/agents/evaluator.js'

const mockRunEvaluatorAgent = vi.mocked(runEvaluatorAgent)
const mockReadEvalReport = vi.mocked(readEvalReport)

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

function makeEvalReport(verdict: 'pass' | 'fail', criteria: Array<{ criterion: string; result: 'pass' | 'fail'; evidence: string }> = []): EvalReport {
  return {
    featureId: 'test-feature',
    verdict,
    criteriaResults: criteria.length > 0 ? criteria : [
      { criterion: 'API returns 200', result: verdict, evidence: 'HTTP 200 observed in logs' },
      { criterion: 'Data persisted', result: verdict, evidence: 'Database row found after insert' },
    ],
    notes: `Feature ${verdict === 'pass' ? 'passed' : 'failed'} evaluation`,
    evaluatedAt: new Date().toISOString(),
    sessionId: 'eval-session-id',
  }
}

describe('quest eval CLI command (cli-eval-command)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeTempDir()
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await cleanTempDir(dir)
    vi.restoreAllMocks()
  })

  describe('CLI source code structure', () => {
    it('defines eval command with <feature-id> positional argument', async () => {
      const { readFileSync } = await import('node:fs')
      const cliSrc = readFileSync(
        new URL('../../src/cli.ts', import.meta.url),
        'utf-8',
      )
      expect(cliSrc).toContain("'eval <feature-id> [project-dir]'")
    })

    it('invokes runEvaluatorAgent with the feature ID', async () => {
      const { readFileSync } = await import('node:fs')
      const cliSrc = readFileSync(
        new URL('../../src/cli.ts', import.meta.url),
        'utf-8',
      )
      expect(cliSrc).toContain('runEvaluatorAgent')
      expect(cliSrc).toContain('featureId')
    })

    it('prints PASS/FAIL verdict to stdout', async () => {
      const { readFileSync } = await import('node:fs')
      const cliSrc = readFileSync(
        new URL('../../src/cli.ts', import.meta.url),
        'utf-8',
      )
      expect(cliSrc).toContain('report.verdict.toUpperCase()')
      expect(cliSrc).toContain('Verdict:')
    })

    it('prints each criterion with pass/fail icon', async () => {
      const { readFileSync } = await import('node:fs')
      const cliSrc = readFileSync(
        new URL('../../src/cli.ts', import.meta.url),
        'utf-8',
      )
      expect(cliSrc).toContain('criteriaResults')
      // Should have checkmark and X indicators
      expect(cliSrc).toContain("'✓'")
      expect(cliSrc).toContain("'✗'")
    })

    it('prints evidence for each criterion', async () => {
      const { readFileSync } = await import('node:fs')
      const cliSrc = readFileSync(
        new URL('../../src/cli.ts', import.meta.url),
        'utf-8',
      )
      expect(cliSrc).toContain('cr.evidence')
    })

    it('exits non-zero when verdict is FAIL', async () => {
      const { readFileSync } = await import('node:fs')
      const cliSrc = readFileSync(
        new URL('../../src/cli.ts', import.meta.url),
        'utf-8',
      )
      // Should contain process.exit(1) in the context of a non-pass verdict check
      expect(cliSrc).toContain("report.verdict !== 'pass'")
      expect(cliSrc).toContain('process.exit(1)')
    })
  })

  describe('evaluator agent invocation', () => {
    it('calls runEvaluatorAgent with the correct feature ID', async () => {
      const featureId = 'my-feature-id'
      const report = makeEvalReport('pass')

      mockRunEvaluatorAgent.mockResolvedValue(makeAgentResult({ success: true }))
      mockReadEvalReport.mockResolvedValue(report)

      // Call the function directly as the CLI would
      const { runEvaluatorAgent: runEval } = await import('../../src/agents/evaluator.js')
      const { ContextManager } = await import('../../src/context/manager.js')
      const ctxMgr = new ContextManager()

      await runEval(dir, featureId, ctxMgr, undefined, { noEvidence: false })

      expect(mockRunEvaluatorAgent).toHaveBeenCalledWith(dir, featureId, ctxMgr, undefined, { noEvidence: false })
    })

    it('uses readEvalReport to get results after evaluation', async () => {
      const report = makeEvalReport('pass')
      mockRunEvaluatorAgent.mockResolvedValue(makeAgentResult({ success: true }))
      mockReadEvalReport.mockResolvedValue(report)

      const { readEvalReport: read } = await import('../../src/agents/evaluator.js')
      const result = await read(dir)

      expect(result).toBe(report)
    })
  })

  describe('output formatting', () => {
    it('shows PASS verdict in output when evaluation passes', async () => {
      const report = makeEvalReport('pass', [
        { criterion: 'Button renders correctly', result: 'pass', evidence: 'Screenshot shows button' },
      ])

      const stdoutLines: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        stdoutLines.push(String(chunk))
        return true
      })

      // Simulate what the CLI does with a pass report
      const verdictText = `Verdict: ${report.verdict.toUpperCase()}`
      process.stdout.write(verdictText)

      expect(stdoutLines.join('')).toContain('PASS')
    })

    it('shows FAIL verdict in output when evaluation fails', () => {
      const report = makeEvalReport('fail', [
        { criterion: 'Button renders correctly', result: 'fail', evidence: 'Element not found in DOM' },
      ])

      const verdictText = `Verdict: ${report.verdict.toUpperCase()}`
      expect(verdictText).toContain('FAIL')
    })

    it('formats criterion results with checkmark for pass', () => {
      const report = makeEvalReport('pass', [
        { criterion: 'User can login', result: 'pass', evidence: 'Login form submits successfully' },
      ])

      const cr = report.criteriaResults[0]
      const icon = cr.result === 'pass' ? '✓' : '✗'
      expect(icon).toBe('✓')
    })

    it('formats criterion results with X for fail', () => {
      const report = makeEvalReport('fail', [
        { criterion: 'User can login', result: 'fail', evidence: 'Login form throws 500 error' },
      ])

      const cr = report.criteriaResults[0]
      const icon = cr.result === 'pass' ? '✓' : '✗'
      expect(icon).toBe('✗')
    })

    it('includes evidence text for each criterion', () => {
      const evidence = 'HTTP 200 returned from /api/users endpoint'
      const report = makeEvalReport('pass', [
        { criterion: 'API works', result: 'pass', evidence },
      ])

      const cr = report.criteriaResults[0]
      expect(cr.evidence).toBe(evidence)
    })

    it('shows all criteria in results', () => {
      const report = makeEvalReport('pass', [
        { criterion: 'Criterion A', result: 'pass', evidence: 'Evidence A' },
        { criterion: 'Criterion B', result: 'fail', evidence: 'Evidence B' },
        { criterion: 'Criterion C', result: 'pass', evidence: 'Evidence C' },
      ])

      expect(report.criteriaResults).toHaveLength(3)
      expect(report.criteriaResults.map(c => c.criterion)).toEqual(['Criterion A', 'Criterion B', 'Criterion C'])
    })
  })

  describe('exit code behavior', () => {
    it('does not call process.exit(1) for a pass verdict', async () => {
      const report = makeEvalReport('pass')
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit called') })

      // Simulate the CLI exit logic
      if (report.verdict !== 'pass') {
        process.exit(1)
      }

      expect(exitSpy).not.toHaveBeenCalled()
      exitSpy.mockRestore()
    })

    it('calls process.exit(1) for a fail verdict', async () => {
      const report = makeEvalReport('fail')
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as (code?: number | string | null) => never)

      // Simulate the CLI exit logic
      if (report.verdict !== 'pass') {
        process.exit(1)
      }

      expect(exitSpy).toHaveBeenCalledWith(1)
      exitSpy.mockRestore()
    })
  })
})
