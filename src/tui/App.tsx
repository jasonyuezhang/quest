import React, { useState, useEffect, useCallback } from 'react'
import { Box, Text, useInput, useApp } from 'ink'
import { readEvents, readNewEvents } from '../events.js'
import { buildState, applyEvent, type MonitorState, type FeatureRun } from './state.js'
import type { QuestEvent } from '../events.js'

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

function Header({ state }: { state: MonitorState }) {
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
        <Text color="gray">  [q] quit  [↑↓] scroll  [enter] details  [esc] back</Text>
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

  return (
    <Box>
      <Text backgroundColor={selected ? 'gray' : undefined}>
        <Text color={iconColor}>{icon} </Text>
        <Text color={selected ? 'white' : 'gray'}>{feature.featureId.padEnd(32).slice(0, 32)} </Text>
        <Text color={priorityColor(feature.priority)}>[{feature.priority[0]}] </Text>
        {resetCount > 0 ? <Text color="yellow">↺{resetCount} </Text> : <Text>   </Text>}
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

function DetailPanel({ feature, onBack }: { feature: FeatureRun; onBack: () => void }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="white" paddingX={1} marginTop={1}>
      <Box justifyContent="space-between">
        <Text bold color="white">◆ {feature.featureId}</Text>
        <Text color="gray"> [{feature.priority}]  [esc] back</Text>
      </Box>

      {feature.coderSessions.map((s, i) => (
        <Box key={i} flexDirection="column" marginTop={1}>
          <Text color="cyan">
            CODER{s.isContextReset ? ` (reset #${i})` : ''}
            {'  '}
            <Text color="gray">
              {s.turns} turns  {fmtMs(s.durationMs)}  {fmtTokens(s.inputTokens)}↑ {fmtTokens(s.outputTokens)}↓ tokens
            </Text>
          </Text>
        </Box>
      ))}

      {feature.evalSession ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="magenta">
            EVALUATOR  {'  '}
            <Text color="gray">
              {feature.evalSession.turns} turns  {fmtMs(feature.evalSession.durationMs)}  {fmtTokens(feature.evalSession.inputTokens)}↑ {fmtTokens(feature.evalSession.outputTokens)}↓ tokens
            </Text>
          </Text>
          {feature.verdict ? (
            <Text color={feature.verdict === 'pass' ? 'green' : 'red'}>
              Verdict: {feature.verdict.toUpperCase()}
            </Text>
          ) : null}
        </Box>
      ) : null}

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

  const visibleFeatures = state.features

  useInput((input, key) => {
    if (input === 'q') { exit(); return }

    if (detailFeatureId) {
      if (key.escape || input === 'q') setDetailFeatureId(null)
      return
    }

    if (key.upArrow) setScrollIndex(i => Math.max(0, i - 1))
    if (key.downArrow) setScrollIndex(i => Math.min(visibleFeatures.length - 1, i + 1))
    if (key.return && visibleFeatures[scrollIndex]) {
      setDetailFeatureId(visibleFeatures[scrollIndex]!.featureId)
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
      <Header state={state} />
      <ActivePanel state={state} />

      {selectedFeature ? (
        <DetailPanel feature={selectedFeature} onBack={() => setDetailFeatureId(null)} />
      ) : (
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
          <Text color="gray">
            HISTORY  {visibleFeatures.length} features
            {visibleFeatures.length === 0 ? '  (waiting for quest run…)' : ''}
          </Text>
          {visibleSlice.map((f, i) => (
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
