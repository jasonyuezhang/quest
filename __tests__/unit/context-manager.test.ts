import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ContextManager } from '../../src/context/manager.js'
import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk'
import { makeTempDir, cleanTempDir, makeFeature } from '../helpers/tempDir.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Default ContextManager has 0 criteria (simple feature) → 85% threshold
const RESET_THRESHOLD = Math.floor(200_000 * 0.85) // 170,000
const CONTEXT_WINDOW = 200_000

function makeUsage(overrides: Partial<ModelUsage> = {}): ModelUsage {
  return {
    inputTokens: 1000,
    outputTokens: 500,
    contextWindow: 5000,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    ...overrides,
  }
}

describe('context/manager.ts', () => {
  let manager: ContextManager

  beforeEach(() => {
    manager = new ContextManager()
  })

  describe('recordUsage', () => {
    it('accumulates input tokens', () => {
      manager.recordUsage(makeUsage({ inputTokens: 1000, contextWindow: 1000 }))
      manager.recordUsage(makeUsage({ inputTokens: 2000, contextWindow: 2000 }))
      const stats = manager.getStats()
      expect(stats.totalInput).toBe(3000)
    })

    it('accumulates output tokens', () => {
      manager.recordUsage(makeUsage({ outputTokens: 500, contextWindow: 1000 }))
      manager.recordUsage(makeUsage({ outputTokens: 300, contextWindow: 1000 }))
      const stats = manager.getStats()
      expect(stats.totalOutput).toBe(800)
    })

    it('tracks peak context window (uses max, not sum)', () => {
      manager.recordUsage(makeUsage({ contextWindow: 50_000 }))
      manager.recordUsage(makeUsage({ contextWindow: 120_000 }))
      manager.recordUsage(makeUsage({ contextWindow: 80_000 }))
      const stats = manager.getStats()
      expect(stats.peakContext).toBe(120_000)
    })

    it('starts with zero counts', () => {
      const stats = manager.getStats()
      expect(stats.totalInput).toBe(0)
      expect(stats.totalOutput).toBe(0)
      expect(stats.peakContext).toBe(0)
    })
  })

  describe('shouldReset', () => {
    it('returns false when peak context is below threshold', () => {
      manager.recordUsage(makeUsage({ contextWindow: RESET_THRESHOLD - 1 }))
      expect(manager.shouldReset()).toBe(false)
    })

    it('returns true when peak context equals threshold', () => {
      manager.recordUsage(makeUsage({ contextWindow: RESET_THRESHOLD }))
      expect(manager.shouldReset()).toBe(true)
    })

    it('returns true when peak context exceeds threshold', () => {
      manager.recordUsage(makeUsage({ contextWindow: RESET_THRESHOLD + 10_000 }))
      expect(manager.shouldReset()).toBe(true)
    })

    it('returns false with no usage recorded', () => {
      expect(manager.shouldReset()).toBe(false)
    })

    it('threshold is 85% of 200k context window for simple features (default)', () => {
      const stats = manager.getStats()
      expect(stats.resetThreshold).toBe(RESET_THRESHOLD)
      expect(stats.resetThreshold).toBe(Math.floor(CONTEXT_WINDOW * 0.85))
    })
  })

  describe('resetForNewSession', () => {
    it('resets token counts to zero', () => {
      manager.recordUsage(makeUsage({ inputTokens: 5000, outputTokens: 2000, contextWindow: 10_000 }))
      manager.resetForNewSession()
      const stats = manager.getStats()
      expect(stats.totalInput).toBe(0)
      expect(stats.totalOutput).toBe(0)
      expect(stats.peakContext).toBe(0)
    })

    it('increments resetCount', () => {
      expect(manager.getStats().resetCount).toBe(0)
      manager.resetForNewSession()
      expect(manager.getStats().resetCount).toBe(1)
      manager.resetForNewSession()
      expect(manager.getStats().resetCount).toBe(2)
    })

    it('allows shouldReset to return false after reset', () => {
      manager.recordUsage(makeUsage({ contextWindow: RESET_THRESHOLD + 1000 }))
      expect(manager.shouldReset()).toBe(true)
      manager.resetForNewSession()
      expect(manager.shouldReset()).toBe(false)
    })
  })

  describe('getStats', () => {
    it('returns correct resetThreshold value', () => {
      const stats = manager.getStats()
      // 85% of 200000 = 170000 (simple feature, 0 criteria)
      expect(stats.resetThreshold).toBe(RESET_THRESHOLD)
    })

    it('returns correct initial state', () => {
      const stats = manager.getStats()
      expect(stats.totalInput).toBe(0)
      expect(stats.totalOutput).toBe(0)
      expect(stats.peakContext).toBe(0)
      expect(stats.resetCount).toBe(0)
    })

    it('reflects recorded usage', () => {
      manager.recordUsage(makeUsage({ inputTokens: 10_000, outputTokens: 3_000, contextWindow: 80_000 }))
      const stats = manager.getStats()
      expect(stats.totalInput).toBe(10_000)
      expect(stats.totalOutput).toBe(3_000)
      expect(stats.peakContext).toBe(80_000)
    })
  })

  describe('buildHandoffPrompt', () => {
    let dir: string

    beforeEach(async () => {
      dir = await makeTempDir()
    })

    afterEach(async () => {
      await cleanTempDir(dir)
    })

    it('returns a string containing feature info', async () => {
      const feature = makeFeature({
        id: 'test-feature',
        name: 'Test Feature',
        acceptanceCriteria: ['Criterion A', 'Criterion B'],
      })
      manager.resetForNewSession() // sets resetCount to 1
      const prompt = await manager.buildHandoffPrompt(dir, feature, [], 'partial notes')
      expect(typeof prompt).toBe('string')
      expect(prompt).toContain('test-feature')
      expect(prompt).toContain('CONTEXT RESET')
    })

    it('includes remaining criteria in the prompt', async () => {
      const feature = makeFeature({
        acceptanceCriteria: ['Criterion A long text here', 'Criterion B another long text'],
      })
      const prompt = await manager.buildHandoffPrompt(dir, feature, [], '')
      expect(prompt).toContain('Criterion A')
      expect(prompt).toContain('Criterion B')
    })

    it('filters out completed steps from remaining criteria', async () => {
      const feature = makeFeature({
        acceptanceCriteria: ['Add user login endpoint', 'Add user logout endpoint'],
      })
      const completedSteps = ['Add user login']
      const prompt = await manager.buildHandoffPrompt(dir, feature, completedSteps, '')
      expect(prompt).toContain('Add user logout endpoint')
      expect(prompt).not.toContain('Add user login endpoint')
    })

    it('writes sprint-context-handoff.json', async () => {
      const feature = makeFeature()
      await manager.buildHandoffPrompt(dir, feature, [], '')
      expect(existsSync(join(dir, 'sprint-context-handoff.json'))).toBe(true)
    })

    it('includes reset count in the prompt', async () => {
      manager.resetForNewSession() // resetCount = 1
      const feature = makeFeature()
      const prompt = await manager.buildHandoffPrompt(dir, feature, [], '')
      expect(prompt).toContain('#1')
    })

    it('includes completed steps in the prompt when provided', async () => {
      const feature = makeFeature({ acceptanceCriteria: ['Do X', 'Do Y'] })
      const prompt = await manager.buildHandoffPrompt(dir, feature, ['Do X completed'], 'some notes')
      expect(prompt).toContain('Do X completed')
    })
  })
})
