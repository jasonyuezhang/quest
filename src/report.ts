/**
 * Run Summary Report Generator for Quest harness.
 *
 * Parses quest-events.jsonl and generates human-readable reports
 * in Markdown, JSON, or HTML format for sharing, archiving, and retrospectives.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readEvents, type QuestEvent } from './events.js'
import { computeRunCost, calculateCost } from './cost.js'

export type ReportFormat = 'markdown' | 'json' | 'html'

export interface FeatureReportRow {
  featureId: string
  featureName: string
  verdict: 'pass' | 'fail' | 'unknown'
  attempts: number
  durationMs: number
  failureCategory?: string
  contextResets: number
  costUsd: number
}

export interface RunReportData {
  projectName: string
  generatedAt: string
  /** ISO timestamp of run start */
  runStartedAt: string
  /** ISO timestamp of run end */
  runEndedAt: string
  durationMs: number
  passingCount: number
  totalCount: number
  passRate: number
  totalCostUsd: number
  costByAgent: Array<{ agent: string; estimatedUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }>
  features: FeatureReportRow[]
  contextResetCount: number
  /** Lessons learned */
  mostRetriedFeatures: Array<{ featureId: string; attempts: number }>
  mostExpensiveFeatures: Array<{ featureId: string; costUsd: number }>
  commonFailurePatterns: Array<{ category: string; count: number; features: string[] }>
}

/**
 * Parse quest-events.jsonl and produce a structured RunReportData.
 */
export function buildReportData(projectDir: string): RunReportData {
  const events = readEvents(projectDir)

  // Extract run-level metadata
  const runStart = events.find((e): e is Extract<QuestEvent, { type: 'run_start' }> => e.type === 'run_start')
  const runComplete = events.find((e): e is Extract<QuestEvent, { type: 'run_complete' }> => e.type === 'run_complete')

  const projectName = runStart?.projectName ?? 'Unknown Project'
  const runStartedAt = runStart?.ts ?? events[0]?.ts ?? new Date().toISOString()
  const runEndedAt = runComplete?.ts ?? (events.length > 0 ? events[events.length - 1].ts : new Date().toISOString())
  const durationMs = runComplete?.durationMs ??
    (new Date(runEndedAt).getTime() - new Date(runStartedAt).getTime())

  // Compute overall cost
  const costSummary = computeRunCost(events)

  // Collect feature_start events for names
  const featureNames = new Map<string, string>()
  for (const e of events) {
    if (e.type === 'feature_start') {
      featureNames.set(e.featureId, e.featureName)
    }
  }

  // Collect feature_done events (last attempt per feature) and max attempt per feature
  const featureDoneMap = new Map<string, Extract<QuestEvent, { type: 'feature_done' }>>()
  const featureAttempts = new Map<string, number>()

  for (const e of events) {
    if (e.type === 'feature_done') {
      featureDoneMap.set(e.featureId, e)
      featureAttempts.set(e.featureId, Math.max(featureAttempts.get(e.featureId) ?? 0, e.attempt))
    }
  }

  // Count context resets per feature and total
  const contextResetsPerFeature = new Map<string, number>()
  let totalContextResets = 0
  for (const e of events) {
    if (e.type === 'context_reset') {
      contextResetsPerFeature.set(e.featureId, e.resetCount)
      totalContextResets++
    }
  }

  // Compute cost per feature by summing agent_done events with matching featureId
  const featureCostMap = new Map<string, number>()
  for (const e of events) {
    if (e.type === 'agent_done' && e.featureId) {
      const tokens = {
        inputTokens: e.inputTokens ?? 0,
        outputTokens: e.outputTokens ?? 0,
        cacheReadTokens: e.cacheReadTokens ?? 0,
      }
      const model = (e as { model?: string }).model ?? 'claude-sonnet-4-6'
      const cost = calculateCost(tokens, model)
      featureCostMap.set(e.featureId, (featureCostMap.get(e.featureId) ?? 0) + cost)
    }
  }

  // Build feature rows from all known feature IDs
  const allFeatureIds = new Set([...featureNames.keys(), ...featureDoneMap.keys()])
  const features: FeatureReportRow[] = []

  for (const featureId of allFeatureIds) {
    const done = featureDoneMap.get(featureId)
    features.push({
      featureId,
      featureName: featureNames.get(featureId) ?? featureId,
      verdict: done?.verdict ?? 'unknown',
      attempts: featureAttempts.get(featureId) ?? 1,
      durationMs: done?.durationMs ?? 0,
      failureCategory: done?.failureCategory,
      contextResets: contextResetsPerFeature.get(featureId) ?? 0,
      costUsd: featureCostMap.get(featureId) ?? 0,
    })
  }

  // Sort by featureId
  features.sort((a, b) => a.featureId.localeCompare(b.featureId))

  const passingCount = runComplete?.passing ?? features.filter(f => f.verdict === 'pass').length
  const totalCount = runComplete?.total ?? features.length

  // Lessons learned: most retried features (attempts > 1)
  const mostRetriedFeatures = [...features]
    .filter(f => f.attempts > 1)
    .sort((a, b) => b.attempts - a.attempts)
    .slice(0, 5)
    .map(f => ({ featureId: f.featureId, attempts: f.attempts }))

  // Most expensive features
  const mostExpensiveFeatures = [...features]
    .filter(f => f.costUsd > 0)
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 5)
    .map(f => ({ featureId: f.featureId, costUsd: f.costUsd }))

  // Common failure patterns (group by failureCategory)
  const failurePatternMap = new Map<string, string[]>()
  for (const f of features) {
    if (f.verdict === 'fail' && f.failureCategory) {
      const cat = f.failureCategory
      if (!failurePatternMap.has(cat)) failurePatternMap.set(cat, [])
      failurePatternMap.get(cat)!.push(f.featureId)
    }
  }
  const commonFailurePatterns = [...failurePatternMap.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([category, featureIds]) => ({ category, count: featureIds.length, features: featureIds }))

  return {
    projectName,
    generatedAt: new Date().toISOString(),
    runStartedAt,
    runEndedAt,
    durationMs,
    passingCount,
    totalCount,
    passRate: totalCount > 0 ? passingCount / totalCount : 0,
    totalCostUsd: costSummary.totalCostUsd,
    costByAgent: costSummary.byAgent,
    features,
    contextResetCount: totalContextResets,
    mostRetriedFeatures,
    mostExpensiveFeatures,
    commonFailurePatterns,
  }
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1000)
  return `${mins}m ${secs}s`
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

/**
 * Render report data as a Markdown string.
 */
export function renderMarkdown(data: RunReportData): string {
  const lines: string[] = []

  lines.push(`# Quest Run Report — ${data.projectName}`)
  lines.push('')
  lines.push(`Generated: ${fmtDate(data.generatedAt)}`)
  lines.push('')

  // Run Summary
  lines.push('## Run Summary')
  lines.push('')
  lines.push('| Field | Value |')
  lines.push('|-------|-------|')
  lines.push(`| Started | ${fmtDate(data.runStartedAt)} |`)
  lines.push(`| Duration | ${fmtDuration(data.durationMs)} |`)
  lines.push(`| Pass Rate | ${data.passingCount}/${data.totalCount} (${Math.round(data.passRate * 100)}%) |`)
  lines.push(`| Total Cost | $${data.totalCostUsd.toFixed(4)} USD |`)
  lines.push(`| Context Resets | ${data.contextResetCount} |`)
  lines.push('')

  // Cost by Agent
  if (data.costByAgent.length > 0) {
    lines.push('### Cost Breakdown by Agent')
    lines.push('')
    lines.push('| Agent | Input Tokens | Output Tokens | Cache Reads | Cost (USD) |')
    lines.push('|-------|-------------|--------------|------------|-----------|')
    for (const a of data.costByAgent) {
      lines.push(`| ${a.agent} | ${a.inputTokens.toLocaleString()} | ${a.outputTokens.toLocaleString()} | ${a.cacheReadTokens.toLocaleString()} | $${a.estimatedUsd.toFixed(4)} |`)
    }
    lines.push('')
  }

  // Per-Feature Results Table
  lines.push('## Per-Feature Results')
  lines.push('')
  lines.push('| Feature ID | Name | Verdict | Attempts | Duration | Resets | Cost |')
  lines.push('|-----------|------|---------|---------|---------|-------|------|')
  for (const f of data.features) {
    const verdict = f.verdict === 'pass' ? '✅ pass' : f.verdict === 'fail' ? '❌ fail' : '❓ unknown'
    lines.push(`| \`${f.featureId}\` | ${f.featureName} | ${verdict} | ${f.attempts} | ${fmtDuration(f.durationMs)} | ${f.contextResets} | $${f.costUsd.toFixed(4)} |`)
  }
  lines.push('')

  // Failure Analysis
  const failures = data.features.filter(f => f.verdict === 'fail')
  if (failures.length > 0) {
    lines.push('## Failure Analysis')
    lines.push('')
    lines.push(`${failures.length} feature(s) failed:`)
    lines.push('')
    lines.push('| Feature ID | Category | Attempts |')
    lines.push('|-----------|---------|---------|')
    for (const f of failures) {
      lines.push(`| \`${f.featureId}\` | ${f.failureCategory ?? 'unknown'} | ${f.attempts} |`)
    }
    lines.push('')
  }

  // Lessons Learned
  lines.push('## Lessons Learned')
  lines.push('')

  if (data.mostRetriedFeatures.length > 0) {
    lines.push('### Most Retried Features')
    lines.push('')
    for (const f of data.mostRetriedFeatures) {
      lines.push(`- \`${f.featureId}\` — ${f.attempts} attempt(s)`)
    }
    lines.push('')
  }

  if (data.mostExpensiveFeatures.length > 0) {
    lines.push('### Most Expensive Features')
    lines.push('')
    for (const f of data.mostExpensiveFeatures) {
      lines.push(`- \`${f.featureId}\` — $${f.costUsd.toFixed(4)}`)
    }
    lines.push('')
  }

  if (data.commonFailurePatterns.length > 0) {
    lines.push('### Common Failure Patterns')
    lines.push('')
    for (const p of data.commonFailurePatterns) {
      const extra = p.features.length > 3 ? ` +${p.features.length - 3} more` : ''
      lines.push(`- **${p.category}**: ${p.count} feature(s) — ${p.features.slice(0, 3).join(', ')}${extra}`)
    }
    lines.push('')
  }

  if (data.mostRetriedFeatures.length === 0 && data.mostExpensiveFeatures.length === 0 && data.commonFailurePatterns.length === 0) {
    lines.push('_No significant patterns detected._')
    lines.push('')
  }

  return lines.join('\n')
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Render report data as a self-contained HTML file with inline charts.
 */
export function renderHtml(data: RunReportData): string {
  const passRate = Math.round(data.passRate * 100)
  const failRate = 100 - passRate

  const costData = data.costByAgent.map(a => ({
    label: a.agent,
    value: parseFloat(a.estimatedUsd.toFixed(4)),
  }))

  const featureRows = data.features.map(f => {
    const verdict =
      f.verdict === 'pass' ? '<span class="pass">✅ pass</span>' :
      f.verdict === 'fail' ? '<span class="fail">❌ fail</span>' :
      '<span class="unknown">❓ unknown</span>'
    return `<tr>
      <td><code>${escapeHtml(f.featureId)}</code></td>
      <td>${escapeHtml(f.featureName)}</td>
      <td>${verdict}</td>
      <td>${f.attempts}</td>
      <td>${fmtDuration(f.durationMs)}</td>
      <td>${f.contextResets}</td>
      <td>$${f.costUsd.toFixed(4)}</td>
    </tr>`
  }).join('\n')

  const failureRows = data.features
    .filter(f => f.verdict === 'fail')
    .map(f =>
      `<tr><td><code>${escapeHtml(f.featureId)}</code></td><td>${escapeHtml(f.failureCategory ?? 'unknown')}</td><td>${f.attempts}</td></tr>`,
    ).join('\n')

  const lessonsHtml = [
    data.mostRetriedFeatures.length > 0 ? `
      <h3>Most Retried Features</h3>
      <ul>${data.mostRetriedFeatures.map(f => `<li><code>${escapeHtml(f.featureId)}</code> — ${f.attempts} attempt(s)</li>`).join('')}</ul>
    ` : '',
    data.mostExpensiveFeatures.length > 0 ? `
      <h3>Most Expensive Features</h3>
      <ul>${data.mostExpensiveFeatures.map(f => `<li><code>${escapeHtml(f.featureId)}</code> — $${f.costUsd.toFixed(4)}</li>`).join('')}</ul>
    ` : '',
    data.commonFailurePatterns.length > 0 ? `
      <h3>Common Failure Patterns</h3>
      <ul>${data.commonFailurePatterns.map(p => {
        const extra = p.features.length > 3 ? ` +${p.features.length - 3} more` : ''
        return `<li><strong>${escapeHtml(p.category)}</strong>: ${p.count} feature(s) — ${p.features.slice(0, 3).map(escapeHtml).join(', ')}${extra}</li>`
      }).join('')}</ul>
    ` : '',
  ].filter(Boolean).join('') || '<p><em>No significant patterns detected.</em></p>'

  const chartLabels = JSON.stringify(costData.map(d => d.label))
  const chartValues = JSON.stringify(costData.map(d => d.value))
  const passRateLabels = JSON.stringify(['Passing', 'Failing'])
  const passRateValues = JSON.stringify([passRate, failRate])

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Quest Report — ${escapeHtml(data.projectName)}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 1100px; margin: 0 auto; padding: 2rem; color: #1a1a1a; background: #f9fafb; }
    h1 { color: #0f172a; border-bottom: 2px solid #e2e8f0; padding-bottom: 0.5rem; }
    h2 { color: #1e293b; margin-top: 2rem; }
    h3 { color: #334155; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1rem; margin: 1.5rem 0; }
    .card { background: white; border-radius: 8px; padding: 1rem 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .card .label { font-size: 0.75rem; text-transform: uppercase; color: #64748b; letter-spacing: 0.05em; }
    .card .value { font-size: 1.5rem; font-weight: 700; color: #0f172a; margin-top: 0.25rem; }
    .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; margin: 1.5rem 0; }
    .chart-box { background: white; border-radius: 8px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    canvas { max-height: 250px; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin: 1rem 0; font-size: 0.9rem; }
    th { background: #f1f5f9; text-align: left; padding: 0.75rem 1rem; font-size: 0.75rem; text-transform: uppercase; color: #64748b; }
    td { padding: 0.65rem 1rem; border-top: 1px solid #e2e8f0; }
    tr:hover td { background: #f8fafc; }
    code { background: #f1f5f9; padding: 0.1em 0.4em; border-radius: 3px; font-size: 0.85em; }
    .pass { color: #16a34a; font-weight: 600; }
    .fail { color: #dc2626; font-weight: 600; }
    .unknown { color: #9ca3af; }
    .lessons { background: white; border-radius: 8px; padding: 1.25rem 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    footer { text-align: center; color: #94a3b8; font-size: 0.8rem; margin-top: 3rem; }
  </style>
</head>
<body>
  <h1>Quest Report — ${escapeHtml(data.projectName)}</h1>
  <p style="color:#64748b">Generated: ${fmtDate(data.generatedAt)}</p>

  <h2>Run Summary</h2>
  <div class="summary-grid">
    <div class="card"><div class="label">Duration</div><div class="value">${fmtDuration(data.durationMs)}</div></div>
    <div class="card"><div class="label">Pass Rate</div><div class="value">${passRate}%</div></div>
    <div class="card"><div class="label">Features</div><div class="value">${data.passingCount}/${data.totalCount}</div></div>
    <div class="card"><div class="label">Total Cost</div><div class="value">$${data.totalCostUsd.toFixed(4)}</div></div>
    <div class="card"><div class="label">Context Resets</div><div class="value">${data.contextResetCount}</div></div>
  </div>

  <div class="charts">
    <div class="chart-box">
      <h3 style="margin:0 0 1rem">Pass Rate</h3>
      <canvas id="passRateChart"></canvas>
    </div>
    <div class="chart-box">
      <h3 style="margin:0 0 1rem">Cost by Agent</h3>
      <canvas id="costChart"></canvas>
    </div>
  </div>

  <h2>Per-Feature Results</h2>
  <table>
    <thead><tr><th>Feature ID</th><th>Name</th><th>Verdict</th><th>Attempts</th><th>Duration</th><th>Resets</th><th>Cost</th></tr></thead>
    <tbody>${featureRows}</tbody>
  </table>

  ${data.features.some(f => f.verdict === 'fail') ? `
  <h2>Failure Analysis</h2>
  <table>
    <thead><tr><th>Feature ID</th><th>Category</th><th>Attempts</th></tr></thead>
    <tbody>${failureRows}</tbody>
  </table>
  ` : ''}

  <h2>Lessons Learned</h2>
  <div class="lessons">${lessonsHtml}</div>

  <footer>Generated by Quest Harness</footer>

  <script>
    const passCtx = document.getElementById('passRateChart').getContext('2d');
    new Chart(passCtx, {
      type: 'doughnut',
      data: {
        labels: ${passRateLabels},
        datasets: [{ data: ${passRateValues}, backgroundColor: ['#16a34a', '#dc2626'], borderWidth: 0 }]
      },
      options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
    });

    const costCtx = document.getElementById('costChart').getContext('2d');
    new Chart(costCtx, {
      type: 'bar',
      data: {
        labels: ${chartLabels},
        datasets: [{ label: 'Cost (USD)', data: ${chartValues}, backgroundColor: ['#3b82f6', '#8b5cf6', '#f59e0b', '#10b981'] }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, title: { display: true, text: 'USD' } } }
      }
    });
  </script>
</body>
</html>`
}

/**
 * Generate a report and write it to .quest/reports/<timestamp>.<ext>.
 * Returns the path to the written report file.
 */
export function generateReport(projectDir: string, format: ReportFormat = 'markdown'): string {
  const data = buildReportData(projectDir)

  const reportsDir = join(projectDir, '.quest', 'reports')
  if (!existsSync(reportsDir)) {
    mkdirSync(reportsDir, { recursive: true })
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const ext = format === 'json' ? 'json' : format === 'html' ? 'html' : 'md'
  const reportPath = join(reportsDir, `${timestamp}.${ext}`)

  let content: string
  if (format === 'json') {
    content = JSON.stringify(data, null, 2)
  } else if (format === 'html') {
    content = renderHtml(data)
  } else {
    content = renderMarkdown(data)
  }

  writeFileSync(reportPath, content, 'utf-8')
  return reportPath
}
