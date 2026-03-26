/**
 * Cost calculator for Quest harness.
 *
 * Converts token counts to estimated USD based on model pricing.
 * Pricing is configurable per model via ModelPricing entries.
 */

import type { AgentLabel } from './logger.js'
import type { QuestEvent } from './events.js'

/** Per-token pricing in USD (per 1M tokens) */
export interface ModelPricing {
  /** Input tokens price per 1M tokens in USD */
  inputPer1M: number
  /** Output tokens price per 1M tokens in USD */
  outputPer1M: number
  /** Cache read tokens price per 1M tokens in USD */
  cacheReadPer1M: number
}

/** Default model pricing table — can be overridden */
export const DEFAULT_MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-5': {
    inputPer1M: 15.0,
    outputPer1M: 75.0,
    cacheReadPer1M: 1.5,
  },
  'claude-opus-4-6': {
    inputPer1M: 15.0,
    outputPer1M: 75.0,
    cacheReadPer1M: 1.5,
  },
  'claude-sonnet-4-6': {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheReadPer1M: 0.3,
  },
  'claude-haiku-4-5': {
    inputPer1M: 0.8,
    outputPer1M: 4.0,
    cacheReadPer1M: 0.08,
  },
  'claude-haiku-4-6': {
    inputPer1M: 0.8,
    outputPer1M: 4.0,
    cacheReadPer1M: 0.08,
  },
  // Fallback for unknown models — use Sonnet pricing
  'default': {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheReadPer1M: 0.3,
  },
}

/** Token counts for a single agent invocation */
export interface TokenCounts {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

/** Calculate estimated USD cost for a set of token counts */
export function calculateCost(
  tokens: TokenCounts,
  model: string,
  pricingTable: Record<string, ModelPricing> = DEFAULT_MODEL_PRICING,
): number {
  const pricing = pricingTable[model] ?? pricingTable['default'] ?? DEFAULT_MODEL_PRICING['default']!
  const inputCost = (tokens.inputTokens / 1_000_000) * pricing.inputPer1M
  const outputCost = (tokens.outputTokens / 1_000_000) * pricing.outputPer1M
  const cacheReadCost = (tokens.cacheReadTokens / 1_000_000) * pricing.cacheReadPer1M
  return inputCost + outputCost + cacheReadCost
}

/** Cost breakdown by agent type */
export interface AgentCostBreakdown {
  agent: AgentLabel
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  estimatedUsd: number
}

/** Full cost summary for a run */
export interface RunCostSummary {
  totalCostUsd: number
  byAgent: AgentCostBreakdown[]
}

/**
 * Compute cost summary from a list of quest events.
 * Uses agent_done events to aggregate token counts per agent type.
 * If agent_done events include a `model` field, that model's pricing is used.
 * Otherwise falls back to the provided default model.
 */
export function computeRunCost(
  events: QuestEvent[],
  model = 'claude-sonnet-4-6',
  pricingTable: Record<string, ModelPricing> = DEFAULT_MODEL_PRICING,
): RunCostSummary {
  // Accumulate cost per agent using per-event model pricing
  const byAgent = new Map<AgentLabel, { inputTokens: number; outputTokens: number; cacheReadTokens: number; estimatedUsd: number }>()

  for (const event of events) {
    if (event.type !== 'agent_done') continue
    const { agent, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0 } = event
    // Use per-event model if available, otherwise fall back to provided default
    const eventModel = (event as { model?: string }).model ?? model
    const tokens: TokenCounts = { inputTokens, outputTokens, cacheReadTokens }
    const eventCost = calculateCost(tokens, eventModel, pricingTable)

    const existing = byAgent.get(agent) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, estimatedUsd: 0 }
    byAgent.set(agent, {
      inputTokens: existing.inputTokens + inputTokens,
      outputTokens: existing.outputTokens + outputTokens,
      cacheReadTokens: existing.cacheReadTokens + cacheReadTokens,
      estimatedUsd: existing.estimatedUsd + eventCost,
    })
  }

  const breakdowns: AgentCostBreakdown[] = []
  let totalCostUsd = 0

  for (const [agent, data] of byAgent.entries()) {
    totalCostUsd += data.estimatedUsd
    breakdowns.push({
      agent,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
      cacheReadTokens: data.cacheReadTokens,
      estimatedUsd: data.estimatedUsd,
    })
  }

  // Sort by cost descending for display
  breakdowns.sort((a, b) => b.estimatedUsd - a.estimatedUsd)

  return { totalCostUsd, byAgent: breakdowns }
}
