import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  buildSprintContract,
  writeSprintContract,
  readSprintContract,
  writeSprintCompletion,
  readSprintCompletion,
  writeContextHandoff,
  readContextHandoff,
  writeEvalReport,
  readEvalReport,
  writeCurrentFeature,
  cleanSprintArtifacts,
} from '../../src/sprint/contracts.js'
import type {
  Feature,
  SprintCompletion,
  ContextHandoff,
  EvalReport,
} from '../../src/agents/types.js'
import { makeTempDir, cleanTempDir, makeFeature } from '../helpers/tempDir.js'

describe('sprint/contracts.ts', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeTempDir()
  })

  afterEach(async () => {
    await cleanTempDir(dir)
  })

  describe('buildSprintContract', () => {
    it('creates a contract from a feature', () => {
      const feature = makeFeature({
        id: 'test-feature',
        name: 'Test Feature',
        description: 'A test feature',
        acceptanceCriteria: ['Criterion A', 'Criterion B'],
        browserTestUrl: 'http://localhost:3000',
      })
      const contract = buildSprintContract(feature)
      expect(contract.featureId).toBe('test-feature')
      expect(contract.featureName).toBe('Test Feature')
      expect(contract.description).toBe('A test feature')
      expect(contract.acceptanceCriteria).toEqual(['Criterion A', 'Criterion B'])
      expect(contract.browserTestUrl).toBe('http://localhost:3000')
      expect(contract.startedAt).toBeDefined()
    })

    it('sets startedAt to a valid ISO timestamp', () => {
      const before = new Date()
      const contract = buildSprintContract(makeFeature())
      const after = new Date()
      const ts = new Date(contract.startedAt)
      expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(ts.getTime()).toBeLessThanOrEqual(after.getTime())
    })

    it('handles missing browserTestUrl', () => {
      const feature = makeFeature()
      delete (feature as any).browserTestUrl
      const contract = buildSprintContract(feature)
      expect(contract.browserTestUrl).toBeUndefined()
    })
  })

  describe('writeSprintContract / readSprintContract', () => {
    it('round-trips contract to sprint-contract.json', async () => {
      const contract = buildSprintContract(makeFeature({ id: 'my-feat' }))
      await writeSprintContract(dir, contract)
      const result = await readSprintContract(dir)
      expect(result.featureId).toBe('my-feat')
      expect(result.acceptanceCriteria).toEqual(contract.acceptanceCriteria)
    })

    it('writes a file called sprint-contract.json', async () => {
      await writeSprintContract(dir, buildSprintContract(makeFeature()))
      expect(existsSync(join(dir, 'sprint-contract.json'))).toBe(true)
    })
  })

  describe('writeSprintCompletion / readSprintCompletion', () => {
    const makeCompletion = (overrides = {}): SprintCompletion => ({
      featureId: 'feat-1',
      commitSha: 'abc123',
      testsPassed: true,
      notes: 'Done',
      completedAt: new Date().toISOString(),
      sessionId: 'session-1',
      ...overrides,
    })

    it('round-trips completion to sprint-completion.json', async () => {
      const completion = makeCompletion()
      await writeSprintCompletion(dir, completion)
      const result = await readSprintCompletion(dir)
      expect(result).not.toBeNull()
      expect(result?.featureId).toBe('feat-1')
      expect(result?.commitSha).toBe('abc123')
    })

    it('writes partial completion to sprint-completion-partial.json', async () => {
      const partial = makeCompletion({ isPartial: true })
      await writeSprintCompletion(dir, partial)
      expect(existsSync(join(dir, 'sprint-completion-partial.json'))).toBe(true)
      expect(existsSync(join(dir, 'sprint-completion.json'))).toBe(false)
    })

    it('writes non-partial to sprint-completion.json', async () => {
      await writeSprintCompletion(dir, makeCompletion({ isPartial: false }))
      expect(existsSync(join(dir, 'sprint-completion.json'))).toBe(true)
    })

    it('returns null when sprint-completion.json does not exist', async () => {
      const result = await readSprintCompletion(dir)
      expect(result).toBeNull()
    })
  })

  describe('writeContextHandoff / readContextHandoff', () => {
    const makeHandoff = (): ContextHandoff => ({
      featureId: 'feat-x',
      featureName: 'Feature X',
      completedSteps: ['step 1', 'step 2'],
      remainingCriteria: ['Criterion B'],
      modifiedFiles: ['src/foo.ts'],
      recentCommits: 'abc123 initial\ndef456 wip',
      diffStat: '1 file changed',
      partialNotes: 'Some notes',
      handoffAt: new Date().toISOString(),
      resetCount: 1,
    })

    it('round-trips handoff to sprint-context-handoff.json', async () => {
      const handoff = makeHandoff()
      await writeContextHandoff(dir, handoff)
      const result = await readContextHandoff(dir)
      expect(result).not.toBeNull()
      expect(result?.featureId).toBe('feat-x')
      expect(result?.remainingCriteria).toEqual(['Criterion B'])
      expect(result?.resetCount).toBe(1)
    })

    it('writes a file called sprint-context-handoff.json', async () => {
      await writeContextHandoff(dir, makeHandoff())
      expect(existsSync(join(dir, 'sprint-context-handoff.json'))).toBe(true)
    })

    it('returns null when file does not exist', async () => {
      const result = await readContextHandoff(dir)
      expect(result).toBeNull()
    })
  })

  describe('writeEvalReport / readEvalReport', () => {
    const makeReport = (verdict: 'pass' | 'fail' = 'pass'): EvalReport => ({
      featureId: 'feat-1',
      verdict,
      criteriaResults: [
        { criterion: 'Criterion A', result: 'pass', evidence: 'Saw it working' },
      ],
      notes: 'All good',
      evaluatedAt: new Date().toISOString(),
      sessionId: 'eval-session-1',
    })

    it('round-trips eval report to eval-report.json', async () => {
      const report = makeReport('pass')
      await writeEvalReport(dir, report)
      const result = await readEvalReport(dir)
      expect(result).not.toBeNull()
      expect(result?.verdict).toBe('pass')
      expect(result?.criteriaResults).toHaveLength(1)
    })

    it('writes a file called eval-report.json', async () => {
      await writeEvalReport(dir, makeReport())
      expect(existsSync(join(dir, 'eval-report.json'))).toBe(true)
    })

    it('returns null when eval-report.json does not exist', async () => {
      const result = await readEvalReport(dir)
      expect(result).toBeNull()
    })

    it('round-trips a failing report', async () => {
      const report = makeReport('fail')
      await writeEvalReport(dir, report)
      const result = await readEvalReport(dir)
      expect(result?.verdict).toBe('fail')
    })
  })

  describe('writeCurrentFeature', () => {
    it('writes feature to current-feature.json', async () => {
      const feature = makeFeature({ id: 'current' })
      await writeCurrentFeature(dir, feature)
      expect(existsSync(join(dir, 'current-feature.json'))).toBe(true)

      const { readFile } = await import('node:fs/promises')
      const raw = await readFile(join(dir, 'current-feature.json'), 'utf-8')
      const parsed = JSON.parse(raw) as Feature
      expect(parsed.id).toBe('current')
    })
  })

  describe('cleanSprintArtifacts', () => {
    it('deletes sprint-completion.json', async () => {
      await writeFile(join(dir, 'sprint-completion.json'), '{}')
      await cleanSprintArtifacts(dir)
      expect(existsSync(join(dir, 'sprint-completion.json'))).toBe(false)
    })

    it('deletes sprint-completion-partial.json', async () => {
      await writeFile(join(dir, 'sprint-completion-partial.json'), '{}')
      await cleanSprintArtifacts(dir)
      expect(existsSync(join(dir, 'sprint-completion-partial.json'))).toBe(false)
    })

    it('deletes sprint-context-handoff.json', async () => {
      await writeFile(join(dir, 'sprint-context-handoff.json'), '{}')
      await cleanSprintArtifacts(dir)
      expect(existsSync(join(dir, 'sprint-context-handoff.json'))).toBe(false)
    })

    it('deletes eval-report.json', async () => {
      await writeFile(join(dir, 'eval-report.json'), '{}')
      await cleanSprintArtifacts(dir)
      expect(existsSync(join(dir, 'eval-report.json'))).toBe(false)
    })

    it('deletes current-feature.json', async () => {
      await writeFile(join(dir, 'current-feature.json'), '{}')
      await cleanSprintArtifacts(dir)
      expect(existsSync(join(dir, 'current-feature.json'))).toBe(false)
    })

    it('does not throw when files do not exist', async () => {
      await expect(cleanSprintArtifacts(dir)).resolves.not.toThrow()
    })

    it('deletes all sprint files at once', async () => {
      const files = [
        'sprint-completion.json',
        'sprint-completion-partial.json',
        'sprint-context-handoff.json',
        'eval-report.json',
        'current-feature.json',
      ]
      await Promise.all(files.map(f => writeFile(join(dir, f), '{}')))
      await cleanSprintArtifacts(dir)
      for (const f of files) {
        expect(existsSync(join(dir, f))).toBe(false)
      }
    })
  })
})
