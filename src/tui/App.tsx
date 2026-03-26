import React, { useState, useEffect } from 'react'
import { Box, Text, useInput, useApp } from 'ink'
import { readEvents, readNewEvents } from '../events.js'
import { buildState, applyEvent, type MonitorState, type FeatureRun } from './state.js'
import { computeRunCost } from '../cost.js'

const POLL_MS = 500

// ─── small helpers ──────────────────────────────────────────────────────────

function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return '?'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`
}

function fmtTokens(n: number | undefined): string {
  if (n === undefined) return '?'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`
}

function elapsed(from: string): string {
  return fmtMs(Date.now() - new Date(from).getTime())
}

function priorityColor(p: string) {
  if (p === 'high') return 'red'
  if (p === 'medium') return 'yellow'
  return 'gray'
}

// ─── sub-components ─────────────────────────────────────────────────────────

function ProgressBar({ value, total, width = 30 }: { value: number; total: number; width?: number }) {
  const pct = total > 0 ? value / total : 0
  const filled = Math.round(pct * width)
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
  return (
    <Box>
      <Text color="green">{bar.slice(0, filled)}</Text>
      <Text color="gray">{bar.slice(filled)}</Text>
    </Box>
  )
}

function Header({ state, filterFailing, sortByPriority }: { state: MonitorState; filterFailing: boolean; sortByPriority: boolean }) {
  const pct = state.totalFeatures > 0
    ? Math.round((state.passingFeatures / state.totalFeatures) * 100)
    : 0
  const runtime = state.runStartedAt ? elapsed(state.runStartedAt) : ''

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="white">quest monitor  </Text>
        <Text color="cyan">{state.projectName}</Text>
        <Text color="gray">  {state.passingFeatures}/{state.totalFeatures} ({pct}%)</Text>
        {runtime ? <Text color="gray">  {runtime}</Text> : null}
        {filterFailing ? <Text color="red">  [FAIL]</Text> : null}
        {sortByPriority ? <Text color="yellow">  [PRI]</Text> : null}
        <Text color="gray">  [q]quit [↑↓]nav [enter]detail [c]cost [f]fail [r]sort</Text>
      </Box>
      <Box marginTop={0}>
        <ProgressBar value={state.passingFeatures} total={state.totalFeatures} width={40} />
      </Box>
    </Box>
  )
}

function ActivePanel({ state }: { state: MonitorState }) {
  const featureId = state.activeFeatureId
  if (!featureId) return null

  const feature = state.features.find(f => f.featureId === featureId)
  if (!feature) return null

  const isCoderActive = state.activeAgent === 'coder'
  const isEvalActive = state.activeAgent === 'eval'

  const coderSession = isCoderActive
    ? feature.coderSessions[feature.coderSessions.length - 1]
    : undefined
  const evalSession = isEvalActive ? feature.evalSession : undefined
  const activeSession = coderSession ?? evalSession

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
      <Box>
        <Text bold color="cyan">ACTIVE  </Text>
        <Text color="white">{featureId}</Text>
        <Text color={priorityColor(feature.priority)}> [{feature.priority}]</Text>
        {activeSession ? (
          <>
            <Text color="gray">  t:{activeSession.turns}</Text>
            <Text color="gray">  {elapsed(activeSession.startedAt)}</Text>
          </>
        ) : null}
      </Box>
      {activeSession?.lastTool ? (
        <Box>
          <Text color="gray">  last: </Text>
          <Text color="yellow">{activeSession.lastTool}</Text>
          {activeSession.lastToolSummary ? (
            <Text color="gray">  {activeSession.lastToolSummary.slice(0, 60)}</Text>
          ) : null}
        </Box>
      ) : null}
      <Box>
        <Text color="gray">  agents: </Text>
        <Text color={isCoderActive ? 'cyan' : 'gray'}>
          {isCoderActive ? '● coder' : '○ coder'}
        </Text>
        <Text color="gray">  →  </Text>
        <Text color={isEvalActive ? 'magenta' : 'gray'}>
          {isEvalActive ? '● eval' : '○ eval'}
        </Text>
        {feature.coderSessions.length > 1 ? (
          <Text color="yellow">  ↺ {feature.coderSessions.length - 1} reset(s)</Text>
        ) : null}
      </Box>
    </Box>
  )
}

function FeatureRow({
  feature,
  selected,
}: {
  feature: FeatureRun
  selected: boolean
}) {
  const verdict = feature.verdict
  const icon = verdict === 'pass' ? '✓' : verdict === 'fail' ? '✗' : '○'
  const iconColor = verdict === 'pass' ? 'green' : verdict === 'fail' ? 'red' : 'yellow'

  const coderMs = feature.coderSessions.reduce((sum, s) => sum + (s.durationMs ?? 0), 0)
  const evalMs = feature.evalSession?.durationMs

  const resetCount = feature.coderSessions.filter(s => s.isContextReset).length
  const retryCount = feature.retryHistory.length

  return (
    <Box>
      <Text backgroundColor={selected ? 'gray' : undefined}>
        <Text color={iconColor}>{icon} </Text>
        <Text color={selected ? 'white' : 'gray'}>{feature.featureId.padEnd(32).slice(0, 32)} </Text>
        <Text color={priorityColor(feature.priority)}>[{feature.priority[0]}] </Text>
        {resetCount > 0 ? <Text color="yellow">↺{resetCount} </Text> : <Text>   </Text>}
        {retryCount > 0 ? <Text color="red">R{retryCount} </Text> : <Text>   </Text>}
        <Text color="gray">code:{fmtMs(coderMs || undefined)}  </Text>
        <Text color="gray">eval:{evalMs ? fmtMs(evalMs) : '─'}</Text>
        {verdict ? (
          <Text color={verdict === 'pass' ? 'green' : 'red'}>{verdict === 'pass' ? '  PASS' : '  FAIL'}</Text>
        ) : (
          <Text color="yellow">  …</Text>
        )}
      </Text>
    </Box>
  )
}

function DetailPanel({ feature }: { feature: FeatureRun }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="white" paddingX={1} marginTop={1}>
      <Box justifyContent="space-between">
        <Text bold color="white">◆ {feature.featureId}</Text>
        <Text color="gray"> [{feature.priority}]  [esc] back</Text>
      </Box>

      {/* Agent timeline: coder sessions with tool call history */}
      {feature.coderSessions.map((s, i) => (
        <Box key={i} flexDirection="column" marginTop={1}>
          <Text color="cyan">
            {s.isContextReset ? `CODER (context reset #${i})` : `CODER session ${i + 1}`}
            {'  '}
            <Text color="gray">
              {s.turns} turns  {fmtMs(s.durationMs)}  {fmtTokens(s.inputTokens)}↑ {fmtTokens(s.outputTokens)}↓ tokens
            </Text>
          </Text>
          {s.toolCalls.length > 0 ? (
            <Box flexDirection="column" paddingLeft={2}>
              {s.toolCalls.slice(-5).map((tc, j) => (
                <Box key={j}>
                  <Text color="gray">t{tc.turn} </Text>
                  <Text color="yellow">{tc.tool}</Text>
                  {tc.summary ? <Text color="gray">  {tc.summary.slice(0, 50)}</Text> : null}
                </Box>
              ))}
              {s.toolCalls.length > 5 ? (
                <Text color="gray">  … +{s.toolCalls.length - 5} more tool calls</Text>
              ) : null}
            </Box>
          ) : null}
        </Box>
      ))}

      {/* Evaluator session with token counts and eval verdict */}
      {feature.evalSession ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="magenta">
            EVALUATOR  {'  '}
            <Text color="gray">
              {feature.evalSession.turns} turns  {fmtMs(feature.evalSession.durationMs)}  {fmtTokens(feature.evalSession.inputTokens)}↑ {fmtTokens(feature.evalSession.outputTokens)}↓ tokens
            </Text>
          </Text>
          {feature.evalSession.toolCalls.length > 0 ? (
            <Box flexDirection="column" paddingLeft={2}>
              {feature.evalSession.toolCalls.slice(-3).map((tc, j) => (
                <Box key={j}>
                  <Text color="gray">t{tc.turn} </Text>
                  <Text color="yellow">{tc.tool}</Text>
                  {tc.summary ? <Text color="gray">  {tc.summary.slice(0, 50)}</Text> : null}
                </Box>
              ))}
            </Box>
          ) : null}
          {feature.verdict ? (
            <Text color={feature.verdict === 'pass' ? 'green' : 'red'}>
              Verdict: {feature.verdict.toUpperCase()}
            </Text>
          ) : null}
        </Box>
      ) : null}

      {/* Eval criteria results */}
      {feature.criteriaResults ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Criteria:</Text>
          {feature.criteriaResults.map((cr, i) => (
            <Box key={i}>
              <Text color={cr.result === 'pass' ? 'green' : 'red'}>
                {cr.result === 'pass' ? '  ✓ ' : '  ✗ '}
              </Text>
              <Text color="gray">{cr.criterion.slice(0, 70)}</Text>
            </Box>
          ))}
        </Box>
      ) : null}

      {/* Context reset history */}
      {feature.coderSessions.filter(s => s.isContextReset).length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">
            Context reset history ({feature.coderSessions.filter(s => s.isContextReset).length} reset{feature.coderSessions.filter(s => s.isContextReset).length > 1 ? 's' : ''}):
          </Text>
          {feature.coderSessions
            .filter(s => s.isContextReset)
            .map((s, i) => (
              <Box key={i} paddingLeft={2}>
                <Text color="gray">reset {i + 1}: {s.startedAt}  {fmtMs(s.durationMs)}</Text>
              </Box>
            ))}
        </Box>
      ) : null}

      {/* Retry history */}
      {feature.retryHistory.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red">
            Retry history ({feature.retryHistory.length} previous attempt{feature.retryHistory.length > 1 ? 's' : ''}):
          </Text>
          {feature.retryHistory.map((prev, i) => {
            const prevCoderMs = prev.coderSessions.reduce((sum, s) => sum + (s.durationMs ?? 0), 0)
            return (
              <Box key={i} paddingLeft={2}>
                <Text color="gray">
                  attempt {i + 1}: {prev.verdict ?? 'in-progress'}  coder:{fmtMs(prevCoderMs || undefined)}
                  {prev.evalSession ? `  eval:${fmtMs(prev.evalSession.durationMs)}` : ''}
                </Text>
              </Box>
            )
          })}
        </Box>
      ) : null}
    </Box>
  )
}

function CostPanel({ state }: { state: MonitorState }) {
  const costSummary = computeRunCost(state.allEvents)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
      <Box justifyContent="space-between">
        <Text bold color="yellow">Cumulative Cost Breakdown</Text>
        <Text color="gray">  [esc] or [c] close</Text>
      </Box>
      <Box marginTop={1}>
        <Text bold color="white">Total: </Text>
        <Text color="yellow">{fmtUsd(costSummary.totalCostUsd)}</Text>
      </Box>
      {costSummary.byAgent.map((a, i) => (
        <Box key={i} paddingLeft={2}>
          <Text color="cyan">{a.agent.padEnd(10)}</Text>
          <Text color="gray">
            {fmtUsd(a.estimatedUsd)}  in:{fmtTokens(a.inputTokens)}  out:{fmtTokens(a.outputTokens)}  cache:{fmtTokens(a.cacheReadTokens)}
          </Text>
        </Box>
      ))}
      {costSummary.byAgent.length === 0 ? (
        <Text color="gray">  No agent runs recorded yet.</Text>
      ) : null}
    </Box>
  )
}

// ─── main App ────────────────────────────────────────────────────────────────

export function App({ projectDir }: { projectDir: string }) {
  const { exit } = useApp()

  const [state, setState] = useState<MonitorState>(() =>
    buildState(readEvents(projectDir))
  )
  const [offset, setOffset] = useState(0)
  const [scrollIndex, setScrollIndex] = useState(0)
  const [detailFeatureId, setDetailFeatureId] = useState<string | null>(null)
  const [showCost, setShowCost] = useState(false)
  const [filterFailing, setFilterFailing] = useState(false)
  const [sortByPriority, setSortByPriority] = useState(false)

  // Poll for new events
  useEffect(() => {
    // Initialize offset from current file size
    const initial = readNewEvents(projectDir, 0)
    setOffset(initial.newOffset)

    const timer = setInterval(() => {
      setOffset(prev => {
        const { events, newOffset } = readNewEvents(projectDir, prev)
        if (events.length > 0) {
          setState(s => events.reduce(applyEvent, s))
        }
        return newOffset
      })
    }, POLL_MS)

    return () => clearInterval(timer)
  }, [projectDir])

  // Build the visible feature list with optional filter and sort
  const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 }
  let visibleFeatures = filterFailing
    ? state.features.filter(f => f.verdict === 'fail' || (f.verdict === undefined && f.coderSessions.length > 0))
    : state.features

  if (sortByPriority) {
    visibleFeatures = [...visibleFeatures].sort(
      (a, b) => (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1)
    )
  }

  useInput((input, key) => {
    if (input === 'q') { exit(); return }

    // In detail panel: esc closes it
    if (detailFeatureId) {
      if (key.escape) { setDetailFeatureId(null); return }
      return
    }

    // In cost panel: esc or c closes it
    if (showCost) {
      if (key.escape || input === 'c') { setShowCost(false); return }
      return
    }

    if (key.upArrow) { setScrollIndex(i => Math.max(0, i - 1)); return }
    if (key.downArrow) { setScrollIndex(i => Math.min(visibleFeatures.length - 1, i + 1)); return }
    if (key.return && visibleFeatures[scrollIndex]) {
      setDetailFeatureId(visibleFeatures[scrollIndex]!.featureId)
      return
    }
    // 'c' opens cost breakdown
    if (input === 'c') { setShowCost(true); return }
    // 'f' toggles failing filter
    if (input === 'f') {
      setFilterFailing(v => !v)
      setScrollIndex(0)
      return
    }
    // 'r' toggles priority sort
    if (input === 'r') {
      setSortByPriority(v => !v)
      setScrollIndex(0)
      return
    }
  })

  const selectedFeature = detailFeatureId
    ? state.features.find(f => f.featureId === detailFeatureId) ?? null
    : null

  // Show up to 15 features in the history list
  const listStart = Math.max(0, scrollIndex - 7)
  const visibleSlice = visibleFeatures.slice(listStart, listStart + 15)

  return (
    <Box flexDirection="column">
      <Header state={state} filterFailing={filterFailing} sortByPriority={sortByPriority} />
      <ActivePanel state={state} />

      {selectedFeature ? (
        <DetailPanel feature={selectedFeature} />
      ) : showCost ? (
        <CostPanel state={state} />
      ) : (
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
          <Text color="gray">
            HISTORY  {visibleFeatures.length} feature{visibleFeatures.length !== 1 ? 's' : ''}
            {filterFailing ? ' (failing only)' : ''}
            {sortByPriority ? ' [priority order]' : ''}
            {visibleFeatures.length === 0 ? '  (waiting for quest run…)' : ''}
          </Text>
          {visibleSlice.map((f) => (
            <FeatureRow
              key={f.featureId}
              feature={f}
              selected={visibleFeatures.indexOf(f) === scrollIndex}
            />
          ))}
        </Box>
      )}
    </Box>
  )
}
