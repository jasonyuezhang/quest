import { describe, it, expect } from 'vitest'
import {
  calculateCost,
  computeRunCost,
  DEFAULT_MODEL_PRICING,
  type ModelPricing,
  type TokenCounts,
} from '../../src/cost.js'
import type { QuestEvent } from '../../src/events.js'

describe('cost.ts', () => {
  describe('calculateCost', () => {
    it('calculates zero cost for zero tokens', () => {
      const tokens: TokenCounts = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
      expect(calculateCost(tokens, 'claude-sonnet-4-6')).toBe(0)
    })

    it('calculates input token cost correctly for claude-sonnet-4-6', () => {
      // $3.00 per 1M input tokens → 1M tokens = $3.00
      const tokens: TokenCounts = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }
      expect(calculateCost(tokens, 'claude-sonnet-4-6')).toBeCloseTo(3.0)
    })

    it('calculates output token cost correctly for claude-sonnet-4-6', () => {
      // $15.00 per 1M output tokens → 500K tokens = $7.50
      const tokens: TokenCounts = { inputTokens: 0, outputTokens: 500_000, cacheReadTokens: 0 }
      expect(calculateCost(tokens, 'claude-sonnet-4-6')).toBeCloseTo(7.5)
    })

    it('calculates cache read token cost correctly for claude-sonnet-4-6', () => {
      // $0.30 per 1M cache read tokens → 2M tokens = $0.60
      const tokens: TokenCounts = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 2_000_000 }
      expect(calculateCost(tokens, 'claude-sonnet-4-6')).toBeCloseTo(0.6)
    })

    it('sums all token costs correctly', () => {
      // Input: 1M * $3.00/1M = $3.00
      // Output: 100K * $15.00/1M = $1.50
      // Cache: 500K * $0.30/1M = $0.15
      // Total: $4.65
      const tokens: TokenCounts = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000 }
      expect(calculateCost(tokens, 'claude-sonnet-4-6')).toBeCloseTo(4.65)
    })

    it('uses claude-opus-4-5 pricing correctly', () => {
      // $15.00 per 1M input tokens → 1M tokens = $15.00
      const tokens: TokenCounts = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }
      expect(calculateCost(tokens, 'claude-opus-4-5')).toBeCloseTo(15.0)
    })

    it('uses claude-haiku-4-5 pricing correctly', () => {
      // $0.80 per 1M input tokens → 1M tokens = $0.80
      const tokens: TokenCounts = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }
      expect(calculateCost(tokens, 'claude-haiku-4-5')).toBeCloseTo(0.8)
    })

    it('falls back to default pricing for unknown models', () => {
      const tokens: TokenCounts = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }
      // Default uses Sonnet pricing: $3.00/1M
      const defaultCost = calculateCost(tokens, 'unknown-model-xyz')
      expect(defaultCost).toBeCloseTo(3.0)
    })

    it('accepts a custom pricing table', () => {
      const customPricing: Record<string, ModelPricing> = {
        'my-model': { inputPer1M: 10.0, outputPer1M: 20.0, cacheReadPer1M: 1.0 },
        'default': { inputPer1M: 1.0, outputPer1M: 2.0, cacheReadPer1M: 0.1 },
      }
      const tokens: TokenCounts = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }
      expect(calculateCost(tokens, 'my-model', customPricing)).toBeCloseTo(10.0)
    })

    it('calculates fractional token costs accurately', () => {
      // 10,000 input tokens at $3.00/1M = $0.03
      const tokens: TokenCounts = { inputTokens: 10_000, outputTokens: 0, cacheReadTokens: 0 }
      expect(calculateCost(tokens, 'claude-sonnet-4-6')).toBeCloseTo(0.03)
    })
  })

  describe('DEFAULT_MODEL_PRICING', () => {
    it('has pricing for claude-sonnet-4-6', () => {
      expect(DEFAULT_MODEL_PRICING['claude-sonnet-4-6']).toBeDefined()
      expect(DEFAULT_MODEL_PRICING['claude-sonnet-4-6']!.inputPer1M).toBeGreaterThan(0)
    })

    it('has pricing for claude-opus-4-5', () => {
      expect(DEFAULT_MODEL_PRICING['claude-opus-4-5']).toBeDefined()
    })

    it('has pricing for claude-haiku-4-5', () => {
      expect(DEFAULT_MODEL_PRICING['claude-haiku-4-5']).toBeDefined()
    })

    it('has a default fallback entry', () => {
      expect(DEFAULT_MODEL_PRICING['default']).toBeDefined()
    })

    it('opus is more expensive than sonnet per input token', () => {
      expect(DEFAULT_MODEL_PRICING['claude-opus-4-5']!.inputPer1M).toBeGreaterThan(
        DEFAULT_MODEL_PRICING['claude-sonnet-4-6']!.inputPer1M
      )
    })
  })

  describe('computeRunCost', () => {
    it('returns zero cost for empty events', () => {
      const summary = computeRunCost([])
      expect(summary.totalCostUsd).toBe(0)
      expect(summary.byAgent).toHaveLength(0)
    })

    it('returns zero cost when no agent_done events are present', () => {
      const events: QuestEvent[] = [
        { ts: '2024-01-01T00:00:00Z', type: 'run_start', projectName: 'test', total: 1 },
        { ts: '2024-01-01T00:01:00Z', type: 'run_complete', passing: 1, total: 1, durationMs: 60000 },
      ]
      const summary = computeRunCost(events)
      expect(summary.totalCostUsd).toBe(0)
      expect(summary.byAgent).toHaveLength(0)
    })

    it('computes cost for a single agent_done event', () => {
      const events: QuestEvent[] = [
        {
          ts: '2024-01-01T00:00:00Z',
          type: 'agent_done',
          agent: 'coder',
          turns: 10,
          durationMs: 30000,
          success: true,
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadTokens: 0,
        },
      ]
      const summary = computeRunCost(events, 'claude-sonnet-4-6')
      // $3.00 per 1M input tokens
      expect(summary.totalCostUsd).toBeCloseTo(3.0)
      expect(summary.byAgent).toHaveLength(1)
      expect(summary.byAgent[0]!.agent).toBe('coder')
      expect(summary.byAgent[0]!.estimatedUsd).toBeCloseTo(3.0)
    })

    it('aggregates multiple agent_done events for the same agent', () => {
      const events: QuestEvent[] = [
        {
          ts: '2024-01-01T00:00:00Z',
          type: 'agent_done',
          agent: 'coder',
          turns: 5,
          durationMs: 15000,
          success: true,
          inputTokens: 500_000,
          outputTokens: 0,
          cacheReadTokens: 0,
        },
        {
          ts: '2024-01-01T00:01:00Z',
          type: 'agent_done',
          agent: 'coder',
          turns: 5,
          durationMs: 15000,
          success: true,
          inputTokens: 500_000,
          outputTokens: 0,
          cacheReadTokens: 0,
        },
      ]
      const summary = computeRunCost(events, 'claude-sonnet-4-6')
      // 1M total input tokens at $3.00/1M = $3.00
      expect(summary.totalCostUsd).toBeCloseTo(3.0)
      expect(summary.byAgent).toHaveLength(1)
      expect(summary.byAgent[0]!.inputTokens).toBe(1_000_000)
    })

    it('separates cost by agent type', () => {
      const events: QuestEvent[] = [
        {
          ts: '2024-01-01T00:00:00Z',
          type: 'agent_done',
          agent: 'coder',
          turns: 10,
          durationMs: 30000,
          success: true,
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadTokens: 0,
        },
        {
          ts: '2024-01-01T00:01:00Z',
          type: 'agent_done',
          agent: 'eval',
          turns: 5,
          durationMs: 15000,
          success: true,
          inputTokens: 0,
          outputTokens: 1_000_000,
          cacheReadTokens: 0,
        },
      ]
      const summary = computeRunCost(events, 'claude-sonnet-4-6')
      // coder: $3.00 (1M input), eval: $15.00 (1M output)
      expect(summary.totalCostUsd).toBeCloseTo(18.0)
      expect(summary.byAgent).toHaveLength(2)

      const coder = summary.byAgent.find(b => b.agent === 'coder')
      const evalAgent = summary.byAgent.find(b => b.agent === 'eval')
      expect(coder?.estimatedUsd).toBeCloseTo(3.0)
      expect(evalAgent?.estimatedUsd).toBeCloseTo(15.0)
    })

    it('handles missing token fields in agent_done events', () => {
      const events: QuestEvent[] = [
        {
          ts: '2024-01-01T00:00:00Z',
          type: 'agent_done',
          agent: 'coder',
          turns: 5,
          durationMs: 10000,
          success: true,
          // No token fields
        },
      ]
      const summary = computeRunCost(events)
      expect(summary.totalCostUsd).toBe(0)
      expect(summary.byAgent[0]!.inputTokens).toBe(0)
      expect(summary.byAgent[0]!.outputTokens).toBe(0)
      expect(summary.byAgent[0]!.cacheReadTokens).toBe(0)
    })

    it('sorts breakdown by cost descending', () => {
      const events: QuestEvent[] = [
        {
          ts: '2024-01-01T00:00:00Z',
          type: 'agent_done',
          agent: 'init',
          turns: 3,
          durationMs: 5000,
          success: true,
          inputTokens: 100_000,
          outputTokens: 0,
          cacheReadTokens: 0,
        },
        {
          ts: '2024-01-01T00:01:00Z',
          type: 'agent_done',
          agent: 'coder',
          turns: 10,
          durationMs: 30000,
          success: true,
          inputTokens: 10_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 0,
        },
        {
          ts: '2024-01-01T00:02:00Z',
          type: 'agent_done',
          agent: 'eval',
          turns: 5,
          durationMs: 15000,
          success: true,
          inputTokens: 500_000,
          outputTokens: 0,
          cacheReadTokens: 0,
        },
      ]
      const summary = computeRunCost(events, 'claude-sonnet-4-6')
      // Verify sorted descending
      for (let i = 1; i < summary.byAgent.length; i++) {
        expect(summary.byAgent[i - 1]!.estimatedUsd).toBeGreaterThanOrEqual(
          summary.byAgent[i]!.estimatedUsd
        )
      }
    })

    it('includes all three token types in breakdown', () => {
      const events: QuestEvent[] = [
        {
          ts: '2024-01-01T00:00:00Z',
          type: 'agent_done',
          agent: 'coder',
          turns: 10,
          durationMs: 30000,
          success: true,
          inputTokens: 100_000,
          outputTokens: 50_000,
          cacheReadTokens: 200_000,
        },
      ]
      const summary = computeRunCost(events)
      expect(summary.byAgent[0]!.inputTokens).toBe(100_000)
      expect(summary.byAgent[0]!.outputTokens).toBe(50_000)
      expect(summary.byAgent[0]!.cacheReadTokens).toBe(200_000)
    })
  })
})
