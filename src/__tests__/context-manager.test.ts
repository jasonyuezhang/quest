/**
 * Unit tests for ContextManager dynamic threshold calculation.
 * Run with: npm test
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { calculateResetThresholdPct, ContextManager } from '../context/manager.js'

// ---------------------------------------------------------------------------
// calculateResetThresholdPct — pure function tests
// ---------------------------------------------------------------------------

describe('calculateResetThresholdPct', () => {
  it('simple features (0 criteria) use 85% threshold', () => {
    expect(calculateResetThresholdPct(0)).toBe(0.85)
  })

  it('simple features (1 criterion) use 85% threshold', () => {
    expect(calculateResetThresholdPct(1)).toBe(0.85)
  })

  it('simple features (3 criteria) use 85% threshold', () => {
    expect(calculateResetThresholdPct(3)).toBe(0.85)
  })

  it('medium features (4 criteria) use 75% threshold', () => {
    expect(calculateResetThresholdPct(4)).toBe(0.75)
  })

  it('medium features (5 criteria) use 75% threshold', () => {
    expect(calculateResetThresholdPct(5)).toBe(0.75)
  })

  it('complex features (6 criteria) use 65% threshold', () => {
    expect(calculateResetThresholdPct(6)).toBe(0.65)
  })

  it('complex features (10 criteria) use 65% threshold', () => {
    expect(calculateResetThresholdPct(10)).toBe(0.65)
  })
})

// ---------------------------------------------------------------------------
// ContextManager — constructor and defaults
// ---------------------------------------------------------------------------

describe('ContextManager constructor', () => {
  it('defaults to 200000 max context tokens (simple feature → 85% threshold)', () => {
    const mgr = new ContextManager()
    // Default complexity is 0 (simple) → 85% threshold
    expect(mgr.getResetThreshold()).toBe(Math.floor(200_000 * 0.85))
  })

  it('accepts configurable maxContextTokens', () => {
    const mgr = new ContextManager({ maxContextTokens: 100_000 })
    // Default complexity (0 criteria) → 85% of 100000
    expect(mgr.getResetThreshold()).toBe(Math.floor(100_000 * 0.85))
  })
})

// ---------------------------------------------------------------------------
// ContextManager — setFeatureComplexity + getResetThreshold
// ---------------------------------------------------------------------------

describe('ContextManager.setFeatureComplexity', () => {
  it('3 criteria → simple → 85% of 200000', () => {
    const mgr = new ContextManager()
    mgr.setFeatureComplexity(3)
    expect(mgr.getResetThreshold()).toBe(Math.floor(200_000 * 0.85))
  })

  it('4 criteria → medium → 75% of 200000', () => {
    const mgr = new ContextManager()
    mgr.setFeatureComplexity(4)
    expect(mgr.getResetThreshold()).toBe(Math.floor(200_000 * 0.75))
  })

  it('5 criteria → medium → 75% of 200000', () => {
    const mgr = new ContextManager()
    mgr.setFeatureComplexity(5)
    expect(mgr.getResetThreshold()).toBe(Math.floor(200_000 * 0.75))
  })

  it('6 criteria → complex → 65% of 200000', () => {
    const mgr = new ContextManager()
    mgr.setFeatureComplexity(6)
    expect(mgr.getResetThreshold()).toBe(Math.floor(200_000 * 0.65))
  })

  it('6 criteria with custom maxContextTokens(100000) → 65% of 100000', () => {
    const mgr = new ContextManager({ maxContextTokens: 100_000 })
    mgr.setFeatureComplexity(6)
    expect(mgr.getResetThreshold()).toBe(Math.floor(100_000 * 0.65))
  })

  it('complex feature has lower reset threshold than simple feature', () => {
    const simple = new ContextManager({ maxContextTokens: 200_000 })
    simple.setFeatureComplexity(2)
    const complex = new ContextManager({ maxContextTokens: 200_000 })
    complex.setFeatureComplexity(7)
    expect(complex.getResetThreshold()).toBeLessThan(simple.getResetThreshold())
  })
})

// ---------------------------------------------------------------------------
// ContextManager — shouldReset with dynamic threshold
// ---------------------------------------------------------------------------

const makeUsage = (contextWindow: number) => ({
  inputTokens: contextWindow,
  outputTokens: 100,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUSD: 0,
  contextWindow,
  maxOutputTokens: 8096,
})

describe('ContextManager.shouldReset', () => {
  it('returns false when below threshold', () => {
    const mgr = new ContextManager({ maxContextTokens: 100_000 })
    mgr.setFeatureComplexity(3) // 85% → 85000
    mgr.recordUsage(makeUsage(50_000)) // 50% < 85%
    expect(mgr.shouldReset()).toBe(false)
  })

  it('returns true when above threshold', () => {
    const mgr = new ContextManager({ maxContextTokens: 100_000 })
    mgr.setFeatureComplexity(3) // 85% → 85000
    mgr.recordUsage(makeUsage(86_000)) // 86% > 85%
    expect(mgr.shouldReset()).toBe(true)
  })

  it('simple feature resets later than complex feature at same usage', () => {
    const simple = new ContextManager({ maxContextTokens: 200_000 })
    simple.setFeatureComplexity(2) // 85% → 170000
    simple.recordUsage(makeUsage(140_000)) // 70% < 85% → no reset

    const complex = new ContextManager({ maxContextTokens: 200_000 })
    complex.setFeatureComplexity(7) // 65% → 130000
    complex.recordUsage(makeUsage(140_000)) // 70% > 65% → reset

    expect(simple.shouldReset()).toBe(false)
    expect(complex.shouldReset()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ContextManager — cacheReadTokens tracking
// ---------------------------------------------------------------------------

describe('ContextManager token tracking', () => {
  it('getStats includes cacheReadTokens', () => {
    const mgr = new ContextManager()
    mgr.recordUsage({
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 250,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
      contextWindow: 1500,
      maxOutputTokens: 8096,
    })
    const stats = mgr.getStats()
    expect(stats.cacheReadTokens).toBe(250)
    expect(stats.totalInput).toBe(1000)
    expect(stats.totalOutput).toBe(500)
  })

  it('accumulates cacheReadTokens across multiple recordUsage calls', () => {
    const mgr = new ContextManager()
    mgr.recordUsage({ inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 50, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: 110, maxOutputTokens: 8096 })
    mgr.recordUsage({ inputTokens: 200, outputTokens: 20, cacheReadInputTokens: 75, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: 220, maxOutputTokens: 8096 })
    const stats = mgr.getStats()
    expect(stats.cacheReadTokens).toBe(125)
    expect(stats.totalInput).toBe(300)
  })
})

// ---------------------------------------------------------------------------
// ContextManager — resetForNewSession
// ---------------------------------------------------------------------------

describe('ContextManager.resetForNewSession', () => {
  it('resets all token counters', () => {
    const mgr = new ContextManager()
    mgr.recordUsage({
      inputTokens: 5000,
      outputTokens: 1000,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
      contextWindow: 6000,
      maxOutputTokens: 8096,
    })
    mgr.resetForNewSession()
    const stats = mgr.getStats()
    expect(stats.totalInput).toBe(0)
    expect(stats.totalOutput).toBe(0)
    expect(stats.cacheReadTokens).toBe(0)
    expect(stats.peakContext).toBe(0)
    expect(stats.resetCount).toBe(1)
  })

  it('increments resetCount on each call', () => {
    const mgr = new ContextManager()
    mgr.resetForNewSession()
    mgr.resetForNewSession()
    mgr.resetForNewSession()
    expect(mgr.getStats().resetCount).toBe(3)
  })
})
