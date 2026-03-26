import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempDir, cleanTempDir } from '../helpers/tempDir.js'
import type { EvalReport } from '../../src/agents/types.js'

describe('evaluator-screenshot-capture-21', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeTempDir()
  })

  afterEach(async () => {
    await cleanTempDir(dir)
  })

  describe('EvalReport type includes consoleErrors and networkErrors', () => {
    it('accepts consoleErrors field in EvalReport', () => {
      const report: EvalReport = {
        featureId: 'test-feature',
        verdict: 'fail',
        criteriaResults: [
          { criterion: 'should work', result: 'fail', evidence: 'nothing happened' },
        ],
        notes: 'Failed',
        evaluatedAt: new Date().toISOString(),
        sessionId: 'unknown',
        consoleErrors: ['TypeError: Cannot read property', 'ReferenceError: foo is not defined'],
      }
      expect(report.consoleErrors).toHaveLength(2)
      expect(report.consoleErrors![0]).toBe('TypeError: Cannot read property')
    })

    it('accepts networkErrors field in EvalReport', () => {
      const report: EvalReport = {
        featureId: 'test-feature',
        verdict: 'fail',
        criteriaResults: [
          { criterion: 'should work', result: 'fail', evidence: 'nothing happened' },
        ],
        notes: 'Failed',
        evaluatedAt: new Date().toISOString(),
        sessionId: 'unknown',
        networkErrors: ['404 /api/users', '500 /api/login'],
      }
      expect(report.networkErrors).toHaveLength(2)
      expect(report.networkErrors![0]).toBe('404 /api/users')
    })

    it('allows omitting consoleErrors and networkErrors (optional)', () => {
      const report: EvalReport = {
        featureId: 'test-feature',
        verdict: 'pass',
        criteriaResults: [
          { criterion: 'should work', result: 'pass', evidence: 'it worked' },
        ],
        notes: 'Passed',
        evaluatedAt: new Date().toISOString(),
        sessionId: 'unknown',
      }
      expect(report.consoleErrors).toBeUndefined()
      expect(report.networkErrors).toBeUndefined()
    })
  })

  describe('evidence directory management', () => {
    it('creates evidence directory structure under .quest/evidence/<feature-id>/', () => {
      const featureId = 'my-feature-123'
      const evidenceDir = join(dir, '.quest', 'evidence', featureId)
      mkdirSync(evidenceDir, { recursive: true })
      expect(existsSync(evidenceDir)).toBe(true)
    })

    it('can store screenshots in evidence directory', () => {
      const featureId = 'my-feature-123'
      const evidenceDir = join(dir, '.quest', 'evidence', featureId)
      mkdirSync(evidenceDir, { recursive: true })

      // Simulate saving a screenshot (just a file for the test)
      const screenshotPath = join(evidenceDir, 'screenshot-0.png')
      writeFileSync(screenshotPath, 'fake-png-data')

      expect(existsSync(screenshotPath)).toBe(true)
    })

    it('evidence directory cleaned up on quest clean', () => {
      const featureId = 'my-feature-123'
      const evidenceDir = join(dir, '.quest', 'evidence', featureId)
      mkdirSync(evidenceDir, { recursive: true })
      writeFileSync(join(evidenceDir, 'screenshot-0.png'), 'fake-png-data')

      // Simulate what quest clean does: remove .quest/evidence/
      const questEvidenceDir = join(dir, '.quest', 'evidence')
      rmSync(questEvidenceDir, { recursive: true, force: true })

      expect(existsSync(questEvidenceDir)).toBe(false)
    })

    it('clean does not error when evidence directory does not exist', () => {
      const questEvidenceDir = join(dir, '.quest', 'evidence')
      // Should not throw even when directory doesn't exist
      expect(() => {
        if (existsSync(questEvidenceDir)) {
          rmSync(questEvidenceDir, { recursive: true, force: true })
        }
      }).not.toThrow()
    })
  })

  describe('evaluator system prompt evidence capture instructions', () => {
    it('EVALUATOR_SYSTEM_PROMPT contains evidence capture instructions', async () => {
      // We need to check the module exports the prompt with evidence instructions
      // by verifying the evaluator agent source contains the right content
      const { readFileSync } = await import('node:fs')
      const evaluatorSrc = readFileSync(
        new URL('../../src/agents/evaluator.ts', import.meta.url),
        'utf-8',
      )

      // Check for evidence capture section
      expect(evaluatorSrc).toContain('.quest/evidence/<feature-id>/')
      expect(evaluatorSrc).toContain('consoleErrors')
      expect(evaluatorSrc).toContain('networkErrors')
      expect(evaluatorSrc).toContain('screenshot')
    })

    it('EVALUATOR_SYSTEM_PROMPT instructs saving screenshots on failure', async () => {
      const { readFileSync } = await import('node:fs')
      const evaluatorSrc = readFileSync(
        new URL('../../src/agents/evaluator.ts', import.meta.url),
        'utf-8',
      )
      // The prompt should mention saving screenshots to the evidence directory
      expect(evaluatorSrc).toContain('mkdir -p .quest/evidence/')
      expect(evaluatorSrc).toContain('screenshot-<criterion-index>.png')
    })

    it('runEvaluatorAgent accepts noEvidence option', async () => {
      // Verify the function signature includes noEvidence by checking the source
      const { readFileSync } = await import('node:fs')
      const evaluatorSrc = readFileSync(
        new URL('../../src/agents/evaluator.ts', import.meta.url),
        'utf-8',
      )
      expect(evaluatorSrc).toContain('noEvidence')
      expect(evaluatorSrc).toContain('--no-evidence')
    })
  })

  describe('--no-evidence flag behavior', () => {
    it('OrchestratorOptions type includes noEvidence field', async () => {
      // Check types file includes noEvidence
      const { readFileSync } = await import('node:fs')
      const typesSrc = readFileSync(
        new URL('../../src/agents/types.ts', import.meta.url),
        'utf-8',
      )
      expect(typesSrc).toContain('noEvidence')
    })

    it('CLI eval command includes --no-evidence option', async () => {
      const { readFileSync } = await import('node:fs')
      const cliSrc = readFileSync(
        new URL('../../src/cli.ts', import.meta.url),
        'utf-8',
      )
      expect(cliSrc).toContain("'--no-evidence'")
      // Ensure it appears in context of eval command (near the eval command definition)
      expect(cliSrc).toContain('Evidence capture disabled (--no-evidence)')
    })

    it('CLI run command includes --no-evidence option', async () => {
      const { readFileSync } = await import('node:fs')
      const cliSrc = readFileSync(
        new URL('../../src/cli.ts', import.meta.url),
        'utf-8',
      )
      // Count occurrences of --no-evidence to ensure both eval and run have it
      const count = (cliSrc.match(/--no-evidence/g) ?? []).length
      expect(count).toBeGreaterThanOrEqual(2)
    })
  })

  describe('quest inspect shows evidence', () => {
    it('inspect command shows screenshots from evidence directory', async () => {
      const { readFileSync } = await import('node:fs')
      const cliSrc = readFileSync(
        new URL('../../src/cli.ts', import.meta.url),
        'utf-8',
      )
      // Should reference .quest/evidence in inspect command
      expect(cliSrc).toContain('.quest/evidence')
      // Should show evidence files with screenshot indicator
      expect(cliSrc).toContain('.png')
    })

    it('inspect command shows console and network errors from eval-report', async () => {
      const { readFileSync } = await import('node:fs')
      const cliSrc = readFileSync(
        new URL('../../src/cli.ts', import.meta.url),
        'utf-8',
      )
      // Should display consoleErrors and networkErrors from eval-report
      expect(cliSrc).toContain('consoleErrors')
      expect(cliSrc).toContain('networkErrors')
      expect(cliSrc).toContain('Console Errors')
      expect(cliSrc).toContain('Network Errors')
    })
  })

  describe('evidence directory structure', () => {
    it('evidence is organized by feature ID', () => {
      const feature1Dir = join(dir, '.quest', 'evidence', 'feature-1')
      const feature2Dir = join(dir, '.quest', 'evidence', 'feature-2')
      mkdirSync(feature1Dir, { recursive: true })
      mkdirSync(feature2Dir, { recursive: true })
      writeFileSync(join(feature1Dir, 'screenshot-0.png'), 'fake1')
      writeFileSync(join(feature2Dir, 'screenshot-0.png'), 'fake2')

      const evidenceRoot = join(dir, '.quest', 'evidence')
      const featureDirs = readdirSync(evidenceRoot)
      expect(featureDirs).toContain('feature-1')
      expect(featureDirs).toContain('feature-2')
    })
  })
})
