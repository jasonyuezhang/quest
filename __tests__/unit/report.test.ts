/**
 * Unit tests for report.ts — run summary report generation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildReportData, renderMarkdown, renderHtml, generateReport, type RunReportData } from '../../src/report.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeProjectDir(): string {
  const dir = join(tmpdir(), `quest-report-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeEvents(dir: string, lines: object[]): void {
  const content = lines.map(l => JSON.stringify(l)).join('\n') + '\n'
  writeFileSync(join(dir, 'quest-events.jsonl'), content, 'utf-8')
}

const NOW = '2026-01-01T12:00:00.000Z'
const END = '2026-01-01T14:30:00.000Z'

const SAMPLE_EVENTS = [
  { ts: NOW, type: 'run_start', projectName: 'TestProject', total: 3, concurrency: 2 },
  { ts: NOW, type: 'feature_start', featureId: 'feat-1', featureName: 'Feature One', priority: 'high', index: 1, total: 3 },
  { ts: NOW, type: 'agent_done', agent: 'coder', featureId: 'feat-1', turns: 5, durationMs: 10000, success: true, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, model: 'claude-sonnet-4-6' },
  { ts: NOW, type: 'feature_done', featureId: 'feat-1', verdict: 'pass', attempt: 1, durationMs: 12000 },
  { ts: NOW, type: 'feature_start', featureId: 'feat-2', featureName: 'Feature Two', priority: 'medium', index: 2, total: 3 },
  { ts: NOW, type: 'agent_done', agent: 'coder', featureId: 'feat-2', turns: 8, durationMs: 20000, success: false, inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 0, model: 'claude-sonnet-4-6' },
  { ts: NOW, type: 'feature_done', featureId: 'feat-2', verdict: 'fail', attempt: 1, durationMs: 22000, failureCategory: 'logic_bug' },
  { ts: NOW, type: 'agent_done', agent: 'coder', featureId: 'feat-2', turns: 10, durationMs: 25000, success: false, inputTokens: 2500, outputTokens: 1200, cacheReadTokens: 100, model: 'claude-sonnet-4-6' },
  { ts: NOW, type: 'feature_done', featureId: 'feat-2', verdict: 'fail', attempt: 2, durationMs: 27000, failureCategory: 'logic_bug' },
  { ts: NOW, type: 'context_reset', featureId: 'feat-2', resetCount: 1, completedCount: 2, remainingCount: 1 },
  { ts: NOW, type: 'feature_start', featureId: 'feat-3', featureName: 'Feature Three', priority: 'low', index: 3, total: 3 },
  { ts: NOW, type: 'agent_done', agent: 'eval', featureId: 'feat-3', turns: 3, durationMs: 5000, success: true, inputTokens: 500, outputTokens: 200, cacheReadTokens: 50, model: 'claude-haiku-4-5' },
  { ts: NOW, type: 'feature_done', featureId: 'feat-3', verdict: 'pass', attempt: 1, durationMs: 6000 },
  { ts: END, type: 'run_complete', passing: 2, total: 3, durationMs: 9000000 },
]

// ---------------------------------------------------------------------------
// buildReportData tests
// ---------------------------------------------------------------------------

describe('buildReportData', () => {
  let dir: string

  beforeEach(() => {
    dir = makeProjectDir()
    writeEvents(dir, SAMPLE_EVENTS)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('extracts project name from run_start event', () => {
    const data = buildReportData(dir)
    expect(data.projectName).toBe('TestProject')
  })

  it('extracts duration from run_complete event', () => {
    const data = buildReportData(dir)
    expect(data.durationMs).toBe(9000000)
  })

  it('uses fallback project name when no run_start event', () => {
    writeEvents(dir, [{ ts: NOW, type: 'feature_done', featureId: 'f-1', verdict: 'pass', attempt: 1, durationMs: 1000 }])
    const data = buildReportData(dir)
    expect(data.projectName).toBe('Unknown Project')
  })

  it('counts passing and total features from run_complete', () => {
    const data = buildReportData(dir)
    expect(data.passingCount).toBe(2)
    expect(data.totalCount).toBe(3)
    expect(data.passRate).toBeCloseTo(2 / 3)
  })

  it('computes pass rate from features when no run_complete', () => {
    writeEvents(dir, [
      { ts: NOW, type: 'run_start', projectName: 'P', total: 2 },
      { ts: NOW, type: 'feature_start', featureId: 'f1', featureName: 'F1', priority: 'high', index: 1, total: 2 },
      { ts: NOW, type: 'feature_done', featureId: 'f1', verdict: 'pass', attempt: 1, durationMs: 1000 },
      { ts: NOW, type: 'feature_start', featureId: 'f2', featureName: 'F2', priority: 'low', index: 2, total: 2 },
      { ts: NOW, type: 'feature_done', featureId: 'f2', verdict: 'fail', attempt: 1, durationMs: 2000, failureCategory: 'timeout' },
    ])
    const data = buildReportData(dir)
    expect(data.passingCount).toBe(1)
    expect(data.totalCount).toBe(2)
    expect(data.passRate).toBe(0.5)
  })

  it('includes all features in the feature list', () => {
    const data = buildReportData(dir)
    expect(data.features).toHaveLength(3)
    const ids = data.features.map(f => f.featureId)
    expect(ids).toContain('feat-1')
    expect(ids).toContain('feat-2')
    expect(ids).toContain('feat-3')
  })

  it('records correct verdict per feature', () => {
    const data = buildReportData(dir)
    const f1 = data.features.find(f => f.featureId === 'feat-1')!
    const f2 = data.features.find(f => f.featureId === 'feat-2')!
    expect(f1.verdict).toBe('pass')
    expect(f2.verdict).toBe('fail')
  })

  it('records max attempts for retried features', () => {
    const data = buildReportData(dir)
    const f2 = data.features.find(f => f.featureId === 'feat-2')!
    expect(f2.attempts).toBe(2)
  })

  it('records failure category', () => {
    const data = buildReportData(dir)
    const f2 = data.features.find(f => f.featureId === 'feat-2')!
    expect(f2.failureCategory).toBe('logic_bug')
  })

  it('counts context resets per feature', () => {
    const data = buildReportData(dir)
    const f2 = data.features.find(f => f.featureId === 'feat-2')!
    expect(f2.contextResets).toBe(1)
    expect(data.contextResetCount).toBe(1)
  })

  it('computes cost per feature from agent_done events', () => {
    const data = buildReportData(dir)
    const f1 = data.features.find(f => f.featureId === 'feat-1')!
    expect(f1.costUsd).toBeGreaterThan(0)
  })

  it('includes lessons learned sections', () => {
    const data = buildReportData(dir)
    // feat-2 has 2 attempts → should appear in mostRetried
    expect(data.mostRetriedFeatures.some(f => f.featureId === 'feat-2')).toBe(true)
    // common failure patterns should include logic_bug
    expect(data.commonFailurePatterns.some(p => p.category === 'logic_bug')).toBe(true)
  })

  it('handles empty events file gracefully', () => {
    writeEvents(dir, [])
    const data = buildReportData(dir)
    expect(data.projectName).toBe('Unknown Project')
    expect(data.features).toHaveLength(0)
    expect(data.passingCount).toBe(0)
    expect(data.totalCount).toBe(0)
    expect(data.passRate).toBe(0)
  })

  it('handles missing quest-events.jsonl gracefully', () => {
    const emptyDir = makeProjectDir()
    const data = buildReportData(emptyDir)
    expect(data.features).toHaveLength(0)
    rmSync(emptyDir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// renderMarkdown tests
// ---------------------------------------------------------------------------

describe('renderMarkdown', () => {
  const sampleData: RunReportData = {
    projectName: 'MyProject',
    generatedAt: '2026-01-01T12:00:00.000Z',
    runStartedAt: '2026-01-01T10:00:00.000Z',
    runEndedAt: '2026-01-01T12:00:00.000Z',
    durationMs: 7200000,
    passingCount: 1,
    totalCount: 2,
    passRate: 0.5,
    totalCostUsd: 0.1234,
    costByAgent: [{ agent: 'coder', estimatedUsd: 0.1234, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 }],
    features: [
      { featureId: 'f-1', featureName: 'Feature 1', verdict: 'pass', attempts: 1, durationMs: 3000, contextResets: 0, costUsd: 0.05 },
      { featureId: 'f-2', featureName: 'Feature 2', verdict: 'fail', attempts: 2, durationMs: 5000, failureCategory: 'timeout', contextResets: 1, costUsd: 0.07 },
    ],
    contextResetCount: 1,
    mostRetriedFeatures: [{ featureId: 'f-2', attempts: 2 }],
    mostExpensiveFeatures: [{ featureId: 'f-2', costUsd: 0.07 }],
    commonFailurePatterns: [{ category: 'timeout', count: 1, features: ['f-2'] }],
  }

  it('includes project name in heading', () => {
    const md = renderMarkdown(sampleData)
    expect(md).toContain('# Quest Run Report — MyProject')
  })

  it('includes run summary table', () => {
    const md = renderMarkdown(sampleData)
    expect(md).toContain('## Run Summary')
    expect(md).toContain('Pass Rate')
    expect(md).toContain('1/2 (50%)')
    expect(md).toContain('Context Resets')
  })

  it('includes per-feature results table', () => {
    const md = renderMarkdown(sampleData)
    expect(md).toContain('## Per-Feature Results')
    expect(md).toContain('f-1')
    expect(md).toContain('✅ pass')
    expect(md).toContain('f-2')
    expect(md).toContain('❌ fail')
  })

  it('includes failure analysis section when failures exist', () => {
    const md = renderMarkdown(sampleData)
    expect(md).toContain('## Failure Analysis')
    expect(md).toContain('timeout')
  })

  it('includes lessons learned section', () => {
    const md = renderMarkdown(sampleData)
    expect(md).toContain('## Lessons Learned')
    expect(md).toContain('Most Retried Features')
    expect(md).toContain('Most Expensive Features')
    expect(md).toContain('Common Failure Patterns')
  })

  it('omits failure analysis when no failures', () => {
    const noFail = { ...sampleData, features: [{ ...sampleData.features[0] }] }
    const md = renderMarkdown(noFail)
    expect(md).not.toContain('## Failure Analysis')
  })

  it('includes cost breakdown by agent', () => {
    const md = renderMarkdown(sampleData)
    expect(md).toContain('Cost Breakdown by Agent')
    expect(md).toContain('coder')
  })
})

// ---------------------------------------------------------------------------
// renderHtml tests
// ---------------------------------------------------------------------------

describe('renderHtml', () => {
  const sampleData: RunReportData = {
    projectName: 'HtmlProject',
    generatedAt: '2026-01-01T12:00:00.000Z',
    runStartedAt: '2026-01-01T10:00:00.000Z',
    runEndedAt: '2026-01-01T12:00:00.000Z',
    durationMs: 7200000,
    passingCount: 2,
    totalCount: 2,
    passRate: 1.0,
    totalCostUsd: 0.05,
    costByAgent: [{ agent: 'coder', estimatedUsd: 0.05, inputTokens: 500, outputTokens: 200, cacheReadTokens: 0 }],
    features: [
      { featureId: 'f-1', featureName: 'Feature 1', verdict: 'pass', attempts: 1, durationMs: 3000, contextResets: 0, costUsd: 0.025 },
      { featureId: 'f-2', featureName: 'Feature 2', verdict: 'pass', attempts: 1, durationMs: 2000, contextResets: 0, costUsd: 0.025 },
    ],
    contextResetCount: 0,
    mostRetriedFeatures: [],
    mostExpensiveFeatures: [{ featureId: 'f-1', costUsd: 0.025 }],
    commonFailurePatterns: [],
  }

  it('produces valid HTML with DOCTYPE', () => {
    const html = renderHtml(sampleData)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<html')
    expect(html).toContain('</html>')
  })

  it('includes project name in title and heading', () => {
    const html = renderHtml(sampleData)
    expect(html).toContain('HtmlProject')
  })

  it('includes Chart.js script tag', () => {
    const html = renderHtml(sampleData)
    expect(html).toContain('chart.js')
  })

  it('includes pass rate chart canvas', () => {
    const html = renderHtml(sampleData)
    expect(html).toContain('passRateChart')
  })

  it('includes cost breakdown chart canvas', () => {
    const html = renderHtml(sampleData)
    expect(html).toContain('costChart')
  })

  it('includes run summary cards', () => {
    const html = renderHtml(sampleData)
    expect(html).toContain('Pass Rate')
    expect(html).toContain('100%')
    expect(html).toContain('Duration')
  })

  it('includes lessons learned section', () => {
    const html = renderHtml(sampleData)
    expect(html).toContain('Lessons Learned')
  })

  it('escapes HTML in project name to prevent XSS', () => {
    const xssData = { ...sampleData, projectName: '<script>alert("xss")</script>' }
    const html = renderHtml(xssData)
    expect(html).not.toContain('<script>alert("xss")</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

// ---------------------------------------------------------------------------
// generateReport tests
// ---------------------------------------------------------------------------

describe('generateReport', () => {
  let dir: string

  beforeEach(() => {
    dir = makeProjectDir()
    writeEvents(dir, SAMPLE_EVENTS)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes markdown report to .quest/reports/<timestamp>.md', () => {
    const reportPath = generateReport(dir, 'markdown')
    expect(reportPath).toMatch(/\.quest[/\\]reports[/\\].*\.md$/)
    expect(existsSync(reportPath)).toBe(true)
  })

  it('writes JSON report to .quest/reports/<timestamp>.json', () => {
    const reportPath = generateReport(dir, 'json')
    expect(reportPath).toMatch(/\.quest[/\\]reports[/\\].*\.json$/)
    expect(existsSync(reportPath)).toBe(true)
  })

  it('writes HTML report to .quest/reports/<timestamp>.html', () => {
    const reportPath = generateReport(dir, 'html')
    expect(reportPath).toMatch(/\.quest[/\\]reports[/\\].*\.html$/)
    expect(existsSync(reportPath)).toBe(true)
  })

  it('JSON report contains valid parseable JSON with expected keys', () => {

    const reportPath = generateReport(dir, 'json')
    const content = readFileSync(reportPath, 'utf-8')
    const data = JSON.parse(content) as Record<string, unknown>
    expect(data).toHaveProperty('projectName')
    expect(data).toHaveProperty('features')
    expect(data).toHaveProperty('passRate')
    expect(data).toHaveProperty('mostRetriedFeatures')
    expect(data).toHaveProperty('commonFailurePatterns')
    expect(data).toHaveProperty('contextResetCount')
  })

  it('markdown report contains all required sections', () => {

    const reportPath = generateReport(dir, 'markdown')
    const content = readFileSync(reportPath, 'utf-8')
    expect(content).toContain('## Run Summary')
    expect(content).toContain('## Per-Feature Results')
    expect(content).toContain('## Lessons Learned')
    expect(content).toContain('Context Resets')
  })

  it('creates .quest/reports/ directory if it does not exist', () => {
    const reportsDir = join(dir, '.quest', 'reports')
    expect(existsSync(reportsDir)).toBe(false)
    generateReport(dir)
    expect(existsSync(reportsDir)).toBe(true)
  })

  it('defaults to markdown format', () => {
    const reportPath = generateReport(dir)
    expect(reportPath).toMatch(/\.md$/)
  })
})
