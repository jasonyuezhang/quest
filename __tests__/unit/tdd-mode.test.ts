/**
 * Unit tests for TDD mode (coder-tdd-mode-11).
 *
 * Covers:
 * - --tdd CLI flag enables TDD mode (tested via orchestrator options)
 * - Coder system prompt includes TDD instructions when tdd=true
 * - sprint-completion.json testsWritten count and testsPassed boolean
 * - Non-TDD mode preserves default behavior
 * - Sprint contract sets tddMode flag correctly
 * - Evaluator system prompt includes TDD verification section
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeTempDir, cleanTempDir, makeFeature } from '../helpers/tempDir.js'
import { ContextManager } from '../../src/context/manager.js'
import { buildSprintContract } from '../../src/sprint/contracts.js'
import { writeSprintCompletion, readSprintCompletion } from '../../src/sprint/contracts.js'
import type { SprintCompletion } from '../../src/agents/types.js'

// Mock the SDK query function
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: vi.fn(),
  }
})

// Mock the logger
vi.mock('../../src/logger.js', () => ({
  printAgentBanner: vi.fn(),
  logMessage: vi.fn(),
  resetTurnCount: vi.fn(),
  setCurrentModel: vi.fn(),
}))

import { runCoderAgent } from '../../src/agents/coder.js'
import { query } from '@anthropic-ai/claude-agent-sdk'

const mockQuery = vi.mocked(query)

describe('TDD Mode — coder-tdd-mode-11', () => {
  let dir: string
  let ctxMgr: ContextManager

  beforeEach(async () => {
    dir = await makeTempDir()
    ctxMgr = new ContextManager()
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await cleanTempDir(dir)
  })

  // --------------------------------------------------------------------------
  // 1. quest run --tdd enables TDD mode for coder sessions
  // --------------------------------------------------------------------------
  describe('--tdd flag enables TDD mode', () => {
    it('runCoderAgent accepts tdd option', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'result',
          session_id: 'tdd-session',
          is_error: false,
          modelUsage: {},
        }
      })

      // Should not throw — TDD mode is accepted as an option
      const result = await runCoderAgent(dir, 'test-feature', ctxMgr, false, undefined, { tdd: true })
      expect(result.success).toBe(true)
    })

    it('TDD mode is disabled by default (tdd=false)', async () => {
      let capturedSystemPrompt: string | undefined

      mockQuery.mockImplementation(async function* (params: any) {
        capturedSystemPrompt = params.options?.systemPrompt
        yield {
          type: 'result',
          session_id: 'default-session',
          is_error: false,
          modelUsage: {},
        }
      })

      await runCoderAgent(dir, 'test-feature', ctxMgr)
      // Default (non-TDD) system prompt should NOT contain TDD-specific content
      expect(capturedSystemPrompt).not.toContain('TDD Mode')
      expect(capturedSystemPrompt).not.toContain('Red-Green-Refactor')
    })
  })

  // --------------------------------------------------------------------------
  // 2. In TDD mode, coder system prompt instructs: write a test first
  // --------------------------------------------------------------------------
  describe('TDD system prompt instructions', () => {
    it('includes TDD mode heading in system prompt when tdd=true', async () => {
      let capturedSystemPrompt: string | undefined

      mockQuery.mockImplementation(async function* (params: any) {
        capturedSystemPrompt = params.options?.systemPrompt
        yield {
          type: 'result',
          session_id: 'tdd-prompt-session',
          is_error: false,
          modelUsage: {},
        }
      })

      await runCoderAgent(dir, 'my-feature', ctxMgr, false, undefined, { tdd: true })
      expect(capturedSystemPrompt).toContain('TDD Mode')
    })

    it('instructs coder to write failing tests first in TDD mode', async () => {
      let capturedSystemPrompt: string | undefined

      mockQuery.mockImplementation(async function* (params: any) {
        capturedSystemPrompt = params.options?.systemPrompt
        yield {
          type: 'result',
          session_id: 'tdd-instructions-session',
          is_error: false,
          modelUsage: {},
        }
      })

      await runCoderAgent(dir, 'my-feature', ctxMgr, false, undefined, { tdd: true })
      // Must instruct to write failing tests first (case-insensitive)
      expect(capturedSystemPrompt).toMatch(/[Ff]ailing [Tt]ests|write.*tests.*first|tests.*fail/si)
    })

    it('instructs coder to verify tests FAIL before implementing', async () => {
      let capturedSystemPrompt: string | undefined

      mockQuery.mockImplementation(async function* (params: any) {
        capturedSystemPrompt = params.options?.systemPrompt
        yield {
          type: 'result',
          session_id: 'tdd-red-session',
          is_error: false,
          modelUsage: {},
        }
      })

      await runCoderAgent(dir, 'my-feature', ctxMgr, false, undefined, { tdd: true })
      // Must mention RED phase — verifying tests fail before implementation
      expect(capturedSystemPrompt).toMatch(/RED|red|fail/i)
    })

    it('instructs coder to implement code to make tests pass (GREEN)', async () => {
      let capturedSystemPrompt: string | undefined

      mockQuery.mockImplementation(async function* (params: any) {
        capturedSystemPrompt = params.options?.systemPrompt
        yield {
          type: 'result',
          session_id: 'tdd-green-session',
          is_error: false,
          modelUsage: {},
        }
      })

      await runCoderAgent(dir, 'my-feature', ctxMgr, false, undefined, { tdd: true })
      // Must mention GREEN phase — implementing to make tests pass
      expect(capturedSystemPrompt).toMatch(/GREEN|green|pass/i)
    })

    it('mentions red-green-refactor workflow', async () => {
      let capturedSystemPrompt: string | undefined

      mockQuery.mockImplementation(async function* (params: any) {
        capturedSystemPrompt = params.options?.systemPrompt
        yield {
          type: 'result',
          session_id: 'tdd-rgr-session',
          is_error: false,
          modelUsage: {},
        }
      })

      await runCoderAgent(dir, 'my-feature', ctxMgr, false, undefined, { tdd: true })
      // Red-green-refactor is the core TDD cycle
      expect(capturedSystemPrompt).toMatch(/[Rr]ed.{0,5}[Gg]reen.{0,5}[Rr]efactor/i)
    })

    it('includes testsWritten field in sprint-completion.json instructions for TDD mode', async () => {
      let capturedSystemPrompt: string | undefined

      mockQuery.mockImplementation(async function* (params: any) {
        capturedSystemPrompt = params.options?.systemPrompt
        yield {
          type: 'result',
          session_id: 'tdd-completion-session',
          is_error: false,
          modelUsage: {},
        }
      })

      await runCoderAgent(dir, 'my-feature', ctxMgr, false, undefined, { tdd: true })
      // Must instruct coder to include testsWritten in sprint-completion.json
      expect(capturedSystemPrompt).toContain('testsWritten')
    })
  })

  // --------------------------------------------------------------------------
  // 3. sprint-completion.json includes testsWritten count and testsPassed boolean
  // --------------------------------------------------------------------------
  describe('sprint-completion.json structure with TDD fields', () => {
    it('SprintCompletion type accepts testsWritten field', async () => {
      const completion: SprintCompletion = {
        featureId: 'tdd-feature',
        commitSha: 'abc123',
        testsPassed: true,
        testsWritten: 5,
        notes: 'Wrote 5 tests, verified red->green',
        completedAt: new Date().toISOString(),
        sessionId: 'test-session',
      }
      // Write and read back to verify round-trip
      await writeSprintCompletion(dir, completion)
      const read = await readSprintCompletion(dir)
      expect(read).not.toBeNull()
      expect(read!.testsWritten).toBe(5)
      expect(read!.testsPassed).toBe(true)
    })

    it('testsWritten persists as a number in sprint-completion.json', async () => {
      const completion: SprintCompletion = {
        featureId: 'tdd-feature-2',
        commitSha: 'def456',
        testsPassed: true,
        testsWritten: 3,
        notes: 'Three tests written',
        completedAt: new Date().toISOString(),
        sessionId: 'tdd-session-2',
      }
      await writeSprintCompletion(dir, completion)
      const read = await readSprintCompletion(dir)
      expect(typeof read!.testsWritten).toBe('number')
      expect(read!.testsWritten).toBe(3)
    })

    it('testsPassed is a boolean in sprint-completion.json', async () => {
      const completion: SprintCompletion = {
        featureId: 'tdd-feature-3',
        commitSha: 'ghi789',
        testsPassed: false,
        testsWritten: 2,
        notes: 'Tests did not pass',
        completedAt: new Date().toISOString(),
        sessionId: 'tdd-session-3',
      }
      await writeSprintCompletion(dir, completion)
      const read = await readSprintCompletion(dir)
      expect(typeof read!.testsPassed).toBe('boolean')
      expect(read!.testsPassed).toBe(false)
    })

    it('testsWritten is optional (non-TDD mode does not require it)', async () => {
      const completion: SprintCompletion = {
        featureId: 'non-tdd-feature',
        commitSha: 'xyz000',
        testsPassed: true,
        notes: 'Regular implementation, no TDD',
        completedAt: new Date().toISOString(),
        sessionId: 'non-tdd-session',
      }
      await writeSprintCompletion(dir, completion)
      const read = await readSprintCompletion(dir)
      expect(read).not.toBeNull()
      expect(read!.testsWritten).toBeUndefined()
      expect(read!.testsPassed).toBe(true)
    })
  })

  // --------------------------------------------------------------------------
  // 4. Sprint contract sets tddMode flag correctly
  // --------------------------------------------------------------------------
  describe('sprint contract tddMode flag', () => {
    it('sets tddMode=true in contract when tdd=true', () => {
      const feature = makeFeature({ id: 'tdd-test', acceptanceCriteria: ['Test A'] })
      const contract = buildSprintContract(feature, undefined, undefined, true)
      expect(contract.tddMode).toBe(true)
    })

    it('does not set tddMode when tdd=false', () => {
      const feature = makeFeature({ id: 'non-tdd-test', acceptanceCriteria: ['Test A'] })
      const contract = buildSprintContract(feature, undefined, undefined, false)
      expect(contract.tddMode).toBeUndefined()
    })

    it('does not set tddMode by default', () => {
      const feature = makeFeature({ id: 'default-test', acceptanceCriteria: ['Test A'] })
      const contract = buildSprintContract(feature)
      expect(contract.tddMode).toBeUndefined()
    })

    it('preserves other contract fields when tddMode is set', () => {
      const feature = makeFeature({
        id: 'tdd-full',
        name: 'TDD Full Feature',
        description: 'A TDD feature',
        acceptanceCriteria: ['Crit 1', 'Crit 2'],
      })
      const contract = buildSprintContract(feature, ['prev-1'], false, true)
      expect(contract.featureId).toBe('tdd-full')
      expect(contract.featureName).toBe('TDD Full Feature')
      expect(contract.acceptanceCriteria).toEqual(['Crit 1', 'Crit 2'])
      expect(contract.previouslyPassingFeatureIds).toEqual(['prev-1'])
      expect(contract.tddMode).toBe(true)
    })
  })

  // --------------------------------------------------------------------------
  // 5. Non-TDD mode preserves current behavior for backward compatibility
  // --------------------------------------------------------------------------
  describe('non-TDD mode backward compatibility', () => {
    it('uses base CODER_SYSTEM_PROMPT without TDD extension by default', async () => {
      let capturedSystemPrompt: string | undefined

      mockQuery.mockImplementation(async function* (params: any) {
        capturedSystemPrompt = params.options?.systemPrompt
        yield {
          type: 'result',
          session_id: 'compat-session',
          is_error: false,
          modelUsage: {},
        }
      })

      await runCoderAgent(dir, 'compat-feature', ctxMgr)
      // Default prompt should contain Session Startup Protocol
      expect(capturedSystemPrompt).toContain('Session Startup Protocol')
      // Should NOT contain TDD-specific extensions
      expect(capturedSystemPrompt).not.toContain('TDD Mode')
      expect(capturedSystemPrompt).not.toContain('Red-Green-Refactor')
      expect(capturedSystemPrompt).not.toContain('testsWritten')
    })

    it('uses base CODER_SYSTEM_PROMPT when tdd=false explicitly', async () => {
      let capturedSystemPrompt: string | undefined

      mockQuery.mockImplementation(async function* (params: any) {
        capturedSystemPrompt = params.options?.systemPrompt
        yield {
          type: 'result',
          session_id: 'compat-false-session',
          is_error: false,
          modelUsage: {},
        }
      })

      await runCoderAgent(dir, 'compat-feature', ctxMgr, false, undefined, { tdd: false })
      expect(capturedSystemPrompt).not.toContain('TDD Mode')
    })

    it('returns same AgentResult structure in non-TDD mode', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'result',
          session_id: 'compat-result-session',
          is_error: false,
          modelUsage: {},
        }
      })

      const result = await runCoderAgent(dir, 'compat-feature', ctxMgr)
      // Core AgentResult fields must exist
      expect(result).toHaveProperty('sessionId')
      expect(result).toHaveProperty('success')
      expect(result).toHaveProperty('durationMs')
      expect(result).toHaveProperty('totalInputTokens')
      expect(result).toHaveProperty('totalOutputTokens')
    })
  })

  // --------------------------------------------------------------------------
  // 6. Coder in TDD mode runs tests before and after implementation
  // --------------------------------------------------------------------------
  describe('TDD red->green transition guidance', () => {
    it('instructs to run tests BEFORE implementation to verify they fail', async () => {
      let capturedSystemPrompt: string | undefined

      mockQuery.mockImplementation(async function* (params: any) {
        capturedSystemPrompt = params.options?.systemPrompt
        yield {
          type: 'result',
          session_id: 'tdd-before-session',
          is_error: false,
          modelUsage: {},
        }
      })

      await runCoderAgent(dir, 'my-feature', ctxMgr, false, undefined, { tdd: true })
      // Must mention running tests before implementation
      expect(capturedSystemPrompt).toMatch(/[Rr]un the tests.*[Ff]ail|[Vv]erify.*[Ff]ail|[Ff]ail.*before/s)
    })

    it('instructs to run tests AFTER implementation to verify they pass', async () => {
      let capturedSystemPrompt: string | undefined

      mockQuery.mockImplementation(async function* (params: any) {
        capturedSystemPrompt = params.options?.systemPrompt
        yield {
          type: 'result',
          session_id: 'tdd-after-session',
          is_error: false,
          modelUsage: {},
        }
      })

      await runCoderAgent(dir, 'my-feature', ctxMgr, false, undefined, { tdd: true })
      // Must mention running tests after implementation to verify they pass
      expect(capturedSystemPrompt).toMatch(/[Rr]un the tests.*[Pp]ass|[Vv]erify.*[Pp]ass|[Pp]ass.*after/s)
    })

    it('TDD system prompt is an extension of the base coder prompt', async () => {
      let tddPrompt: string | undefined
      let basePrompt: string | undefined

      mockQuery.mockImplementation(async function* (params: any) {
        const prompt = params.options?.systemPrompt
        if (tddPrompt === undefined) {
          tddPrompt = prompt
        } else {
          basePrompt = prompt
        }
        yield {
          type: 'result',
          session_id: 'compare-session',
          is_error: false,
          modelUsage: {},
        }
      })

      // Call TDD first, then base
      await runCoderAgent(dir, 'feature-a', ctxMgr, false, undefined, { tdd: true })
      await runCoderAgent(dir, 'feature-b', ctxMgr, false, undefined, { tdd: false })

      // TDD prompt should be longer (it's base + extension)
      expect(tddPrompt!.length).toBeGreaterThan(basePrompt!.length)
      // TDD prompt should contain all base prompt content
      expect(tddPrompt).toContain('Session Startup Protocol')
    })
  })
})
