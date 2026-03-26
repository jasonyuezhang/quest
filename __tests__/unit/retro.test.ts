/**
 * Unit tests for retro.ts — AI-powered sprint retrospective generator.
 *
 * Tests cover:
 *  - generateRetro correctly writes .quest/retros/<timestamp>.md
 *  - The output file contains the required sections
 *  - Claude is called with relevant run data
 *  - Error cases (missing events file, empty data)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProjectDir(): string {
  const dir = join(tmpdir(), `quest-retro-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeEvents(dir: string, lines: object[]): void {
  const content = lines.map(l => JSON.stringify(l)).join('\n') + '\n'
  writeFileSync(join(dir, 'quest-events.jsonl'), content, 'utf-8')
}

const NOW = '2026-01-01T12:00:00.000Z'
const END = '2026-01-01T14:00:00.000Z'

const SAMPLE_EVENTS = [
  { ts: NOW, type: 'run_start', projectName: 'TestProject', total: 4, concurrency: 2 },
  // feat-1: passes on first attempt, low cost
  { ts: NOW, type: 'feature_start', featureId: 'feat-1', featureName: 'Feature One', priority: 'high', index: 1, total: 4 },
  { ts: NOW, type: 'agent_done', agent: 'coder', featureId: 'feat-1', turns: 3, durationMs: 5000, success: true, inputTokens: 500, outputTokens: 200, cacheReadTokens: 0, model: 'claude-sonnet-4-6' },
  { ts: NOW, type: 'feature_done', featureId: 'feat-1', verdict: 'pass', attempt: 1, durationMs: 6000 },
  // feat-2: fails multiple times, high cost, context reset
  { ts: NOW, type: 'feature_start', featureId: 'feat-2', featureName: 'Feature Two', priority: 'high', index: 2, total: 4 },
  { ts: NOW, type: 'agent_done', agent: 'coder', featureId: 'feat-2', turns: 10, durationMs: 30000, success: false, inputTokens: 5000, outputTokens: 3000, cacheReadTokens: 0, model: 'claude-sonnet-4-6' },
  { ts: NOW, type: 'feature_done', featureId: 'feat-2', verdict: 'fail', attempt: 1, durationMs: 32000, failureCategory: 'logic_bug' },
  { ts: NOW, type: 'context_reset', featureId: 'feat-2', resetCount: 1, completedCount: 2, remainingCount: 1 },
  { ts: NOW, type: 'agent_done', agent: 'coder', featureId: 'feat-2', turns: 12, durationMs: 40000, success: false, inputTokens: 6000, outputTokens: 4000, cacheReadTokens: 0, model: 'claude-sonnet-4-6' },
  { ts: NOW, type: 'feature_done', featureId: 'feat-2', verdict: 'fail', attempt: 2, durationMs: 42000, failureCategory: 'logic_bug' },
  // feat-3: passes on second attempt
  { ts: NOW, type: 'feature_start', featureId: 'feat-3', featureName: 'Feature Three', priority: 'medium', index: 3, total: 4 },
  { ts: NOW, type: 'agent_done', agent: 'coder', featureId: 'feat-3', turns: 5, durationMs: 15000, success: false, inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 0, model: 'claude-sonnet-4-6' },
  { ts: NOW, type: 'feature_done', featureId: 'feat-3', verdict: 'fail', attempt: 1, durationMs: 17000, failureCategory: 'timeout' },
  { ts: NOW, type: 'agent_done', agent: 'coder', featureId: 'feat-3', turns: 4, durationMs: 12000, success: true, inputTokens: 1500, outputTokens: 800, cacheReadTokens: 0, model: 'claude-sonnet-4-6' },
  { ts: NOW, type: 'feature_done', featureId: 'feat-3', verdict: 'pass', attempt: 2, durationMs: 14000 },
  // feat-4: passes instantly
  { ts: NOW, type: 'feature_start', featureId: 'feat-4', featureName: 'Feature Four', priority: 'low', index: 4, total: 4 },
  { ts: NOW, type: 'agent_done', agent: 'coder', featureId: 'feat-4', turns: 2, durationMs: 2000, success: true, inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, model: 'claude-haiku-4-5' },
  { ts: NOW, type: 'feature_done', featureId: 'feat-4', verdict: 'pass', attempt: 1, durationMs: 3000 },
  { ts: END, type: 'run_complete', passing: 3, total: 4, durationMs: 7200000 },
]

// ---------------------------------------------------------------------------
// Mock Anthropic
// ---------------------------------------------------------------------------

const mockRetroContent = `## What Went Well
- feat-1 and feat-4 passed on first attempt
- Low cost features show good efficiency

## What Struggled
- feat-2 had context resets and multiple failures
- logic_bug failures indicate unclear acceptance criteria

## Pattern Analysis
- logic_bug is the most common failure category

## Recommendations: Feature List
- Split feat-2 — too complex, caused context resets
- Merge feat-4 with similar small features

## Recommendations: Harness Tuning
- Increase context window for complex features
- Use haiku model for simple features like feat-4

## Summary
The run shows 75% pass rate with one problematic feature. Split feat-2 before next run.`

const mockCreate = vi.fn().mockResolvedValue({
  content: [{ type: 'text', text: mockRetroContent }],
})

vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = function (this: unknown) {
    (this as { messages: { create: typeof mockCreate } }).messages = { create: mockCreate }
  }
  return { default: MockAnthropic }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateRetro', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = makeProjectDir()
    writeEvents(projectDir, SAMPLE_EVENTS)
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('writes a retrospective file to .quest/retros/<timestamp>.md', async () => {
    const { generateRetro } = await import('../../src/retro.js')
    const result = await generateRetro(projectDir)

    expect(result.retroPath).toMatch(/\.quest[/\\]retros[/\\]\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.md$/)
    expect(existsSync(result.retroPath)).toBe(true)
  })

  it('creates the .quest/retros/ directory if it does not exist', async () => {
    const retrosDir = join(projectDir, '.quest', 'retros')
    expect(existsSync(retrosDir)).toBe(false)

    const { generateRetro } = await import('../../src/retro.js')
    await generateRetro(projectDir)

    expect(existsSync(retrosDir)).toBe(true)
  })

  it('returns the content of the retrospective', async () => {
    const { generateRetro } = await import('../../src/retro.js')
    const result = await generateRetro(projectDir)

    expect(result.content).toContain('Sprint Retrospective')
    expect(result.content).toContain('TestProject')
  })

  it('includes the run summary header in the output', async () => {
    const { generateRetro } = await import('../../src/retro.js')
    const result = await generateRetro(projectDir)

    // Header should include project name and key metrics
    expect(result.content).toContain('TestProject')
    expect(result.content).toContain('Pass Rate')
    expect(result.content).toContain('Context Resets')
    expect(result.content).toContain('Total Cost')
  })

  it('appends the Claude analysis to the header', async () => {
    const { generateRetro } = await import('../../src/retro.js')
    const result = await generateRetro(projectDir)

    // The mock content should be in the output
    expect(result.content).toContain('What Went Well')
    expect(result.content).toContain('What Struggled')
    expect(result.content).toContain('Recommendations: Feature List')
    expect(result.content).toContain('Recommendations: Harness Tuning')
  })

  it('writes the same content to file as returned in result', async () => {
    const { generateRetro } = await import('../../src/retro.js')
    const result = await generateRetro(projectDir)

    const fileContent = readFileSync(result.retroPath, 'utf-8')
    expect(fileContent).toBe(result.content)
  })

  it('calls Claude with run data containing feature metrics', async () => {
    mockCreate.mockClear()

    const { generateRetro } = await import('../../src/retro.js')
    await generateRetro(projectDir)

    expect(mockCreate).toHaveBeenCalledOnce()

    const callArgs = mockCreate.mock.calls[0][0]
    // Should use a capable model for analysis
    expect(callArgs.model).toBeTruthy()
    // Should have system prompt and user message
    expect(callArgs.system).toContain('retrospective')
    expect(callArgs.messages).toHaveLength(1)
    expect(callArgs.messages[0].role).toBe('user')
    // User message should contain run data
    expect(callArgs.messages[0].content).toContain('TestProject')
    expect(callArgs.messages[0].content).toContain('feat-2')
  })

  it('includes context reset count in call to Claude', async () => {
    mockCreate.mockClear()

    const { generateRetro } = await import('../../src/retro.js')
    await generateRetro(projectDir)

    const callArgs = mockCreate.mock.calls[0][0]

    // The prompt should include context reset info (feat-2 had 1 reset)
    const userContent = callArgs.messages[0].content
    expect(userContent).toContain('contextResets')
  })

  it('includes failure patterns in call to Claude', async () => {
    mockCreate.mockClear()

    const { generateRetro } = await import('../../src/retro.js')
    await generateRetro(projectDir)

    const callArgs = mockCreate.mock.calls[0][0]

    // The prompt should include failure pattern data
    const userContent = callArgs.messages[0].content
    expect(userContent).toContain('logic_bug')
    expect(userContent).toContain('commonFailurePatterns')
  })
})
