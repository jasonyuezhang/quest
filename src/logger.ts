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

// ---------------------------------------------------------------------------
// Log verbosity
// ---------------------------------------------------------------------------

export type LogVerbosity = 'quiet' | 'normal' | 'verbose'

let verbosity: LogVerbosity = 'normal'

export function setLogVerbosity(level: LogVerbosity): void {
  verbosity = level
}

export function getLogVerbosity(): LogVerbosity {
  return verbosity
}

// ---------------------------------------------------------------------------
// Per-worker state
// ---------------------------------------------------------------------------

interface WorkerLogState {
  turnCount: number
  agentLabel: AgentLabel | undefined
  startTime: number
  /** Last high-level action logged (for dedup in quiet mode) */
  lastAction: string
}

/** Per-worker log state. Worker 0 is the default (sequential mode). */
const workerStates = new Map<number, WorkerLogState>()

function getWorkerState(workerId: number): WorkerLogState {
  let state = workerStates.get(workerId)
  if (!state) {
    state = { turnCount: 0, agentLabel: undefined, startTime: Date.now(), lastAction: '' }
    workerStates.set(workerId, state)
  }
  return state
}

/** Currently active model (set before running each agent) */
let currentModel: string = 'claude-sonnet-4-6'

/** Set the current model so agent_start/agent_done events include it */
export function setCurrentModel(model: string): void {
  currentModel = model
}

/** Get the current model */
export function getCurrentModel(): string {
  return currentModel
}

/** Reset turn counter at the start of each agent session */
export function resetTurnCount(workerId = 0) {
  const state = getWorkerState(workerId)
  state.turnCount = 0
  state.startTime = Date.now()
  state.lastAction = ''
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

// ---------------------------------------------------------------------------
// Quiet-mode intent classification
// ---------------------------------------------------------------------------

/**
 * Classify a tool call into a human-readable intent.
 * Returns null if the action shouldn't be logged in quiet mode.
 */
function classifyIntent(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const inp = input as Record<string, unknown>

  if (toolName === 'Write') {
    const path = String(inp['file_path'] ?? '')
    const filename = path.split('/').pop() ?? path
    if (filename === 'sprint-completion.json') return 'Writing sprint completion'
    if (filename.endsWith('.test.ts') || filename.endsWith('.spec.ts')) return `Writing tests: ${filename}`
    if (filename.endsWith('.ts') || filename.endsWith('.tsx')) return `Creating ${filename}`
    if (filename.endsWith('.json')) return `Writing ${filename}`
    return `Creating ${filename}`
  }

  if (toolName === 'Edit') {
    const path = String(inp['file_path'] ?? '')
    const filename = path.split('/').pop() ?? path
    return `Editing ${filename}`
  }

  if (toolName === 'Bash') {
    const cmd = String(inp['command'] ?? '')
    if (cmd.startsWith('git add') || cmd.startsWith('git commit')) return 'Committing changes'
    if (cmd.startsWith('git log')) return null // noise
    if (cmd.startsWith('git show')) return null
    if (cmd.startsWith('git status')) return null
    if (cmd.startsWith('git diff')) return null
    if (cmd.startsWith('npm test') || cmd.startsWith('npx vitest') || cmd.startsWith('npx jest')) return 'Running tests'
    if (cmd.startsWith('npm install') || cmd.startsWith('npm run build')) return 'Building project'
    if (cmd.startsWith('npx tsc')) return 'Type checking'
    if (cmd.startsWith('bash init.sh')) return 'Starting dev server'
    if (cmd.startsWith('pwd') || cmd.startsWith('ls') || cmd.startsWith('cat') || cmd.startsWith('head') || cmd.startsWith('tail')) return null
    if (cmd.startsWith('grep') || cmd.startsWith('find') || cmd.startsWith('sed')) return null
    if (cmd.startsWith('curl')) return 'Testing endpoint'
    if (cmd.startsWith('mkdir')) return null
    return null // most bash commands are noise in quiet mode
  }

  // Read, Glob, Grep are always noise in quiet mode
  return null
}

// ---------------------------------------------------------------------------
// Main log function
// ---------------------------------------------------------------------------

/**
 * Log progress from an SDK message.
 * Also emits structured events to the event log for the monitor TUI.
 *
 * In quiet mode: only logs high-level intents (file creates, edits, test runs, commits).
 * In normal mode: logs every tool call with summaries (current behavior).
 * In verbose mode: same as normal (trace files have full detail).
 */
export function logMessage(agent: AgentLabel, message: SDKMessage, workerId = 0): void {
  const state = getWorkerState(workerId)
  const workerTag = workerId > 0 ? chalk.yellow(`[W${workerId}]`) : ''
  const prefix = `${workerTag}${AGENT_LABEL[agent]} `

  if (message.type === 'assistant') {
    state.turnCount++
    for (const block of message.message.content) {
      if (block.type === 'tool_use') {
        const summary = summarizeInput(block.name, block.input)

        // Always emit structured events (for monitor TUI and traces)
        emit({ type: 'tool_use', agent, tool: block.name, summary, turn: state.turnCount, workerId })

        // Console output depends on verbosity
        if (verbosity === 'quiet') {
          const intent = classifyIntent(block.name, block.input)
          if (intent && intent !== state.lastAction) {
            state.lastAction = intent
            process.stdout.write(`${prefix}${chalk.white(intent)}\n`)
          }
        } else {
          const { icon, color } = toolDisplay(block.name)
          const toolStr = color(`${block.name}`)
          const summaryStr = summary ? chalk.gray(` ${summary}`) : ''
          const turnStr = chalk.gray(` t${state.turnCount}`)
          process.stdout.write(`${prefix}${icon} ${toolStr}${summaryStr}${turnStr}\n`)
        }
      }
    }
  }

  if (message.type === 'tool_progress') {
    // Always emit event
    emit({ type: 'tool_progress', agent, tool: message.tool_name, elapsedSeconds: message.elapsed_time_seconds, workerId })

    // Only show in normal/verbose mode
    if (verbosity !== 'quiet') {
      const elapsed = message.elapsed_time_seconds.toFixed(1)
      const { icon, color } = toolDisplay(message.tool_name)
      process.stdout.write(
        `${prefix}${icon} ${color(message.tool_name)} ${chalk.gray(`${elapsed}s…`)}\n`
      )
    }
  }

  if (message.type === 'result') {
    const modelKey = Object.keys(message.modelUsage)[0]
    const usage = modelKey ? message.modelUsage[modelKey] : undefined

    const tokens = usage
      ? chalk.gray(` (${usage.inputTokens}↑ ${usage.outputTokens}↓ tokens)`)
      : ''

    // Always show result (even in quiet mode — it's high-level)
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
      model: currentModel,
    })
  }

  if (message.type === 'system' && message.subtype === 'init') {
    state.turnCount = 0

    // Only show in normal/verbose mode
    if (verbosity !== 'quiet') {
      process.stdout.write(`${prefix}${chalk.gray('session started')}\n`)
    }

    emit({ type: 'agent_start', agent, workerId, model: currentModel })
  }
}
