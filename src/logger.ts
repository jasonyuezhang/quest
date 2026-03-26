import chalk from 'chalk'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { emit, setCurrentAgent } from './events.js'

/** Emoji + color for each tool name */
const TOOL_DISPLAY: Record<string, { icon: string; color: (s: string) => string }> = {
  Bash:      { icon: '⬡', color: chalk.yellow },
  Read:      { icon: '○', color: chalk.blue },
  Write:     { icon: '●', color: chalk.green },
  Edit:      { icon: '◎', color: chalk.cyan },
  Glob:      { icon: '◇', color: chalk.blue },
  Grep:      { icon: '◈', color: chalk.blue },
  WebSearch: { icon: '◉', color: chalk.magenta },
  WebFetch:  { icon: '◉', color: chalk.magenta },
  Agent:     { icon: '◆', color: chalk.magenta },
  // Playwright MCP tools
  mcp:       { icon: '◐', color: chalk.magenta },
}

function toolDisplay(name: string) {
  const key = Object.keys(TOOL_DISPLAY).find(k => name.startsWith(k)) ?? 'mcp'
  return TOOL_DISPLAY[key] ?? TOOL_DISPLAY['mcp']!
}

/** Summarize tool input into a short string */
function summarizeInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const inp = input as Record<string, unknown>

  if (toolName === 'Bash') {
    const cmd = String(inp['command'] ?? inp['cmd'] ?? '').replace(/\n/g, ' ')
    return cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd
  }

  const path = inp['file_path'] ?? inp['path'] ?? inp['pattern'] ?? inp['query'] ?? inp['url']
  if (path) {
    const s = String(path)
    return s.length > 60 ? '…' + s.slice(-60) : s
  }

  const firstStr = Object.values(inp).find(v => typeof v === 'string')
  if (firstStr) {
    const s = String(firstStr)
    return s.length > 60 ? s.slice(0, 60) + '…' : s
  }

  return ''
}

export type AgentLabel = 'init' | 'coder' | 'eval' | 'reviewer'

const AGENT_LABEL: Record<AgentLabel, string> = {
  init:     chalk.blue('[init]'),
  coder:    chalk.cyan('[code]'),
  eval:     chalk.magenta('[eval]'),
  reviewer: chalk.yellow('[review]'),
}

interface WorkerLogState {
  turnCount: number
  agentLabel: AgentLabel | undefined
  startTime: number
}

/** Per-worker log state. Worker 0 is the default (sequential mode). */
const workerStates = new Map<number, WorkerLogState>()

function getWorkerState(workerId: number): WorkerLogState {
  let state = workerStates.get(workerId)
  if (!state) {
    state = { turnCount: 0, agentLabel: undefined, startTime: Date.now() }
    workerStates.set(workerId, state)
  }
  return state
}

/** Reset turn counter at the start of each agent session */
export function resetTurnCount(workerId = 0) {
  const state = getWorkerState(workerId)
  state.turnCount = 0
  state.startTime = Date.now()
}

/** Print a section header banner when an agent phase begins */
export function printAgentBanner(
  agent: AgentLabel,
  step: number,
  totalSteps: number,
  detail?: string,
  workerId = 0,
): void {
  const labels: Record<AgentLabel, string> = {
    init:     'Initializer',
    coder:    'Coder',
    eval:     'Evaluator',
    reviewer: 'Reviewer',
  }
  const colors: Record<AgentLabel, (s: string) => string> = {
    init:     chalk.blue,
    coder:    chalk.cyan,
    eval:     chalk.magenta,
    reviewer: chalk.yellow,
  }
  const color = colors[agent]
  const name = labels[agent]
  const stepStr = chalk.gray(`[${step}/${totalSteps}]`)
  const detailStr = detail ? chalk.gray(` — ${detail}`) : ''
  const workerTag = workerId > 0 ? chalk.yellow(`[W${workerId}] `) : ''
  const line = '─'.repeat(50)
  process.stdout.write(`\n${chalk.gray(line)}\n`)
  process.stdout.write(`${workerTag}${stepStr} ${color(name)}${detailStr}\n`)
  process.stdout.write(`${chalk.gray(line)}\n`)

  setCurrentAgent(agent)
  const state = getWorkerState(workerId)
  state.agentLabel = agent
}

/**
 * Log progress from an SDK message.
 * Also emits structured events to the event log for the monitor TUI.
 */
export function logMessage(agent: AgentLabel, message: SDKMessage, workerId = 0): void {
  const state = getWorkerState(workerId)
  const workerTag = workerId > 0 ? chalk.yellow(`[W${workerId}]`) : ''
  const prefix = `${workerTag}${AGENT_LABEL[agent]} `

  if (message.type === 'assistant') {
    state.turnCount++
    for (const block of message.message.content) {
      if (block.type === 'tool_use') {
        const { icon, color } = toolDisplay(block.name)
        const summary = summarizeInput(block.name, block.input)
        const toolStr = color(`${block.name}`)
        const summaryStr = summary ? chalk.gray(` ${summary}`) : ''
        const turnStr = chalk.gray(` t${state.turnCount}`)
        process.stdout.write(`${prefix}${icon} ${toolStr}${summaryStr}${turnStr}\n`)

        emit({ type: 'tool_use', agent, tool: block.name, summary, turn: state.turnCount, workerId })
      }
    }
  }

  if (message.type === 'tool_progress') {
    const elapsed = message.elapsed_time_seconds.toFixed(1)
    const { icon, color } = toolDisplay(message.tool_name)
    process.stdout.write(
      `${prefix}${icon} ${color(message.tool_name)} ${chalk.gray(`${elapsed}s…`)}\n`
    )
    emit({ type: 'tool_progress', agent, tool: message.tool_name, elapsedSeconds: message.elapsed_time_seconds, workerId })
  }

  if (message.type === 'result') {
    const modelKey = Object.keys(message.modelUsage)[0]
    const usage = modelKey ? message.modelUsage[modelKey] : undefined

    const tokens = usage
      ? chalk.gray(` (${usage.inputTokens}↑ ${usage.outputTokens}↓ tokens)`)
      : ''

    if (message.is_error) {
      process.stdout.write(`${prefix}${chalk.red('✗ error')}${tokens}\n`)
    } else {
      process.stdout.write(`${prefix}${chalk.green('✓ done')} — ${state.turnCount} turns${tokens}\n`)
    }

    emit({
      type: 'agent_done',
      agent,
      turns: state.turnCount,
      durationMs: Date.now() - state.startTime,
      success: !message.is_error,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      cacheReadTokens: usage?.cacheReadInputTokens,
      workerId,
    })
  }

  if (message.type === 'system' && message.subtype === 'init') {
    state.turnCount = 0
    process.stdout.write(`${prefix}${chalk.gray('session started')}\n`)
    emit({ type: 'agent_start', agent, workerId })
  }
}
