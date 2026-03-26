/**
 * Automated Sprint Retrospective generator for Quest harness.
 *
 * Analyzes the latest run's events and uses Claude to generate an AI-powered
 * retrospective with insights about what went well, what failed, and
 * recommendations for improving the feature list and harness configuration.
 *
 * Output is written to .quest/retros/<timestamp>.md
 */

import Anthropic from '@anthropic-ai/sdk'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildReportData, type RunReportData } from './report.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetroResult {
  /** Path to the written retrospective file */
  retroPath: string
  /** The markdown content of the retrospective */
  content: string
}

// ---------------------------------------------------------------------------
// System prompt for Claude analysis
// ---------------------------------------------------------------------------

const RETRO_SYSTEM_PROMPT = `You are an experienced engineering lead analyzing a software delivery sprint run by an AI coding agent harness called Quest.

Quest runs a set of "features" — each feature has an ID, name, description, and acceptance criteria. An AI "coder" agent implements each feature, then an AI "evaluator" agent grades it. Features that fail can be retried.

You will receive a structured JSON summary of a run. Your job is to write a thoughtful, actionable sprint retrospective in Markdown.

Your retrospective MUST include these sections:

## What Went Well
- Highlight successful features, efficient patterns, and positive trends
- Note features that passed on first attempt, low-cost features, and clean runs

## What Struggled
- Analyze features with multiple retries, high cost, or failures
- Identify root causes (complexity, vague acceptance criteria, dependency issues, context exhaustion)
- Flag features that had context resets (the agent ran out of context window mid-implementation)

## Pattern Analysis
- Identify common failure categories across features
- Note if certain feature types or categories consistently struggle
- Analyze if complexity correlates with retries/cost

## Recommendations: Feature List
- Split: identify features that were too complex (many retries, high cost, vague criteria) — suggest how to break them up
- Merge: identify features that were trivially small (zero cost, instant pass) — suggest combining related ones
- Dependencies: suggest dependency ordering improvements if features had conflicts
- Rewrite: suggest features with unclear acceptance criteria that should be rewritten

## Recommendations: Harness Tuning
- Model selection: should certain types of features use a more capable (or cheaper) model?
- Concurrency: is the current concurrency setting appropriate given the run's behavior?
- Timeout/retry limits: were features exhausting their retry budgets? Should limits be adjusted?
- Context window: were there many context resets? Should features be split or context limits raised?
- Cost optimization: which features could use a cheaper model without sacrificing quality?

## Summary
A 2-3 sentence executive summary with the single most important action to take before the next run.

Be specific and reference actual feature IDs. Write as an engineering lead, not a cheerleader. If things went poorly, say so clearly. If context resets are frequent, that is a serious signal. Prioritize actionability over praise.`

// ---------------------------------------------------------------------------
// Build the analysis prompt from run data
// ---------------------------------------------------------------------------

function buildRetroPrompt(data: RunReportData): string {
  const summary = {
    projectName: data.projectName,
    runStartedAt: data.runStartedAt,
    durationMs: data.durationMs,
    passingCount: data.passingCount,
    totalCount: data.totalCount,
    passRate: `${Math.round(data.passRate * 100)}%`,
    totalCostUsd: data.totalCostUsd.toFixed(4),
    contextResetCount: data.contextResetCount,
  }

  const features = data.features.map(f => ({
    featureId: f.featureId,
    featureName: f.featureName,
    verdict: f.verdict,
    attempts: f.attempts,
    durationMs: f.durationMs,
    failureCategory: f.failureCategory ?? null,
    contextResets: f.contextResets,
    costUsd: parseFloat(f.costUsd.toFixed(4)),
  }))

  const mostRetriedFeatures = data.mostRetriedFeatures
  const mostExpensiveFeatures = data.mostExpensiveFeatures
  const commonFailurePatterns = data.commonFailurePatterns
  const costByAgent = data.costByAgent.map(a => ({
    agent: a.agent,
    estimatedUsd: parseFloat(a.estimatedUsd.toFixed(4)),
    inputTokens: a.inputTokens,
    outputTokens: a.outputTokens,
    cacheReadTokens: a.cacheReadTokens,
  }))

  const payload = {
    runSummary: summary,
    features,
    mostRetriedFeatures,
    mostExpensiveFeatures,
    commonFailurePatterns,
    costByAgent,
  }

  return `Here is the run data for the sprint retrospective:

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`

Please write a comprehensive sprint retrospective for this Quest run.`
}

// ---------------------------------------------------------------------------
// Format timestamp for filename
// ---------------------------------------------------------------------------

function formatTimestamp(date: Date): string {
  return date.toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19)
}

// ---------------------------------------------------------------------------
// Main retrospective generation function
// ---------------------------------------------------------------------------

/**
 * Generate an AI-powered sprint retrospective from the latest run's events.
 *
 * Reads quest-events.jsonl, builds a structured summary, sends it to Claude
 * for analysis, and writes the result to .quest/retros/<timestamp>.md.
 *
 * @param projectDir - Path to the project directory containing quest-events.jsonl
 * @returns RetroResult with the file path and content
 */
export async function generateRetro(projectDir: string): Promise<RetroResult> {
  // Build structured report data from events
  const data = buildReportData(projectDir)

  // Build the prompt
  const prompt = buildRetroPrompt(data)

  // Call Claude for AI-powered analysis
  const client = new Anthropic()
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    system: RETRO_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  })

  const analysis = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')

  // Build final markdown document
  const generatedAt = new Date()
  const header = [
    `# Sprint Retrospective — ${data.projectName}`,
    '',
    `**Generated:** ${generatedAt.toLocaleString()}`,
    `**Run Started:** ${new Date(data.runStartedAt).toLocaleString()}`,
    `**Pass Rate:** ${data.passingCount}/${data.totalCount} (${Math.round(data.passRate * 100)}%)`,
    `**Total Cost:** $${data.totalCostUsd.toFixed(4)} USD`,
    `**Context Resets:** ${data.contextResetCount}`,
    '',
    '---',
    '',
  ].join('\n')

  const content = header + analysis

  // Ensure retros directory exists
  const retrosDir = join(projectDir, '.quest', 'retros')
  if (!existsSync(retrosDir)) {
    mkdirSync(retrosDir, { recursive: true })
  }

  // Write to file
  const timestamp = formatTimestamp(generatedAt)
  const retroPath = join(retrosDir, `${timestamp}.md`)
  writeFileSync(retroPath, content, 'utf-8')

  return { retroPath, content }
}
