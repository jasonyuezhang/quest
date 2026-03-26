/**
 * Unit tests for agents/coder.ts
 * Tests ContextResetNeededError and the agent function with a mocked SDK.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeTempDir, cleanTempDir } from '../helpers/tempDir.js'
import { ContextManager } from '../../src/context/manager.js'

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
}))

import { runCoderAgent, ContextResetNeededError } from '../../src/agents/coder.js'
import { query } from '@anthropic-ai/claude-agent-sdk'

const mockQuery = vi.mocked(query)

describe('agents/coder.ts', () => {
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

  describe('ContextResetNeededError', () => {
    it('is an instance of Error', () => {
      const err = new ContextResetNeededError('test')
      expect(err).toBeInstanceOf(Error)
    })

    it('has correct name', () => {
      const err = new ContextResetNeededError('test')
      expect(err.name).toBe('ContextResetNeededError')
    })

    it('preserves the message', () => {
      const err = new ContextResetNeededError('context limit reached')
      expect(err.message).toBe('context limit reached')
    })

    it('can be caught as ContextResetNeededError', () => {
      const err = new ContextResetNeededError('test')
      expect(err instanceof ContextResetNeededError).toBe(true)
    })
  })

  describe('runCoderAgent', () => {
    it('returns an AgentResult on success', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'result',
          session_id: 'test-session-123',
          is_error: false,
          modelUsage: {},
        }
      })

      const result = await runCoderAgent(dir, 'test-feature', ctxMgr)
      expect(result.success).toBe(true)
      expect(result.sessionId).toBe('test-session-123')
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('returns success=false on error result', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'result',
          session_id: 'error-session',
          is_error: true,
          modelUsage: {},
        }
      })

      const result = await runCoderAgent(dir, 'test-feature', ctxMgr)
      expect(result.success).toBe(false)
    })

    it('returns success=false when query throws', async () => {
      mockQuery.mockImplementation(async function* () {
        throw new Error('Network error')
        yield // unreachable TypeScript generator stub
      })

      const result = await runCoderAgent(dir, 'test-feature', ctxMgr)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Network error')
    })

    it('uses contextResetPrompt when isContextReset=true', async () => {
      let capturedPrompt: string | undefined

      mockQuery.mockImplementation(async function* (params: any) {
        capturedPrompt = params.prompt
        yield {
          type: 'result',
          session_id: 'reset-session',
          is_error: false,
          modelUsage: {},
        }
      })

      await runCoderAgent(dir, 'my-feature', ctxMgr, true, 'CONTEXT RESET: resume from here')
      expect(capturedPrompt).toBe('CONTEXT RESET: resume from here')
    })

    it('uses default prompt when not a context reset', async () => {
      let capturedPrompt: string | undefined

      mockQuery.mockImplementation(async function* (params: any) {
        capturedPrompt = params.prompt
        yield {
          type: 'result',
          session_id: 'session',
          is_error: false,
          modelUsage: {},
        }
      })

      await runCoderAgent(dir, 'my-feature', ctxMgr)
      expect(capturedPrompt).toContain('my-feature')
    })

    it('throws ContextResetNeededError when context limit is reached', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'result',
          session_id: 'session',
          is_error: false,
          modelUsage: {
            'claude-sonnet': {
              inputTokens: 175_000,
              outputTokens: 5000,
              contextWindow: 175_000, // Exceeds 170k threshold (85% of 200k for simple features)
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          },
        }
      })

      await expect(runCoderAgent(dir, 'test-feature', ctxMgr)).rejects.toThrow(
        ContextResetNeededError,
      )
    })

    it('returns token stats in result', async () => {
      mockQuery.mockImplementation(async function* () {
        yield {
          type: 'result',
          session_id: 'session',
          is_error: false,
          modelUsage: {
            claude: {
              inputTokens: 1000,
              outputTokens: 200,
              contextWindow: 5000,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          },
        }
      })

      const result = await runCoderAgent(dir, 'test-feature', ctxMgr)
      expect(result.totalInputTokens).toBe(1000)
      expect(result.totalOutputTokens).toBe(200)
      expect(result.peakContextTokens).toBe(5000)
    })
  })
})
