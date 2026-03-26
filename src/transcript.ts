/**
 * Session Transcript Capture
 *
 * Captures full agent session transcripts (tool calls, responses, reasoning)
 * for debugging and evaluator calibration.
 *
 * Transcripts are written to:
 *   .quest/transcripts/<feature-id>-<agent>-<timestamp>.jsonl
 *
 * Each line is a JSON object representing one turn with:
 *   - role: 'assistant' | 'tool_result' | 'session_start' | 'session_end'
 *   - content: summarized text content (truncated to 500 chars)
 *   - toolCalls: array of { name, input (truncated to 500 chars) }
 *   - toolResults: array of { name, output (truncated to 500 chars) }
 *   - ts: ISO timestamp
 *
 * Usage:
 *   const capture = new TranscriptCapture(projectDir, featureId, 'coder')
 *   capture.recordSDKMessage(sdkMessage)
 *   capture.end()
 */

import {
  mkdirSync,
  appendFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
  statSync,
  readFileSync,
} from 'node:fs'
import { join } from 'node:path'
import chalk from 'chalk'
import type { AgentLabel } from './logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscriptTurn {
  ts: string
  role: 'assistant' | 'tool_result' | 'session_start' | 'session_end' | 'result'
  /** Summarized text content (truncated to 500 chars) */
  content?: string
  /** Tool calls made in this turn */
  toolCalls?: Array<{ name: string; input: string }>
  /** Tool results received in this turn */
  toolResults?: Array<{ name: string; output: string }>
  /** Token usage (for result turns) */
  usage?: { inputTokens: number; outputTokens: number }
  /** Whether the session errored (for result turns) */
  isError?: boolean
}

// ---------------------------------------------------------------------------
// TranscriptCapture
// ---------------------------------------------------------------------------

export class TranscriptCapture {
  private filePath: string
  private ended = false

  constructor(
    private projectDir: string,
    private featureId: string,
    private agent: AgentLabel | 'planner' | 'init',
  ) {
    const transcriptsDir = join(projectDir, '.quest', 'transcripts')
    mkdirSync(transcriptsDir, { recursive: true })

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const filename = `${featureId}-${agent}-${timestamp}.jsonl`
    this.filePath = join(transcriptsDir, filename)

    this.appendTurn({ ts: new Date().toISOString(), role: 'session_start' })
  }

  /**
   * Record an SDK message from the query() async generator.
   */
  recordSDKMessage(message: {
    type: string
    subtype?: string
    message?: {
      content: Array<{
        type: string
        name?: string
        input?: unknown
        text?: string
        id?: string
        tool_use_id?: string
        content?: unknown
      }>
    }
    tool_name?: string
    is_error?: boolean
    modelUsage?: Record<string, { inputTokens: number; outputTokens: number }>
  }): void {
    if (this.ended) return

    if (message.type === 'assistant' && message.message) {
      const toolCalls: Array<{ name: string; input: string }> = []
      let textContent = ''

      for (const block of message.message.content) {
        if (block.type === 'text' && block.text) {
          textContent += block.text
        }
        if (block.type === 'tool_use') {
          toolCalls.push({
            name: block.name ?? 'unknown',
            input: truncate(
              typeof block.input === 'string'
                ? block.input
                : JSON.stringify(block.input),
              500,
            ),
          })
        }
      }

      const turn: TranscriptTurn = {
        ts: new Date().toISOString(),
        role: 'assistant',
      }
      if (textContent) turn.content = truncate(textContent, 500)
      if (toolCalls.length > 0) turn.toolCalls = toolCalls

      this.appendTurn(turn)
      return
    }

    if (message.type === 'tool_result' && message.message) {
      const toolResults: Array<{ name: string; output: string }> = []

      for (const block of message.message.content) {
        if (block.type === 'tool_result') {
          toolResults.push({
            name: block.name ?? block.tool_use_id ?? 'unknown',
            output: truncate(
              typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content),
              500,
            ),
          })
        }
      }

      if (toolResults.length > 0) {
        this.appendTurn({
          ts: new Date().toISOString(),
          role: 'tool_result',
          toolResults,
        })
      }
      return
    }

    if (message.type === 'result') {
      const modelKey = message.modelUsage ? Object.keys(message.modelUsage)[0] : undefined
      const usage = modelKey ? message.modelUsage![modelKey] : undefined

      this.appendTurn({
        ts: new Date().toISOString(),
        role: 'result',
        isError: message.is_error,
        usage: usage
          ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
          : undefined,
      })
      return
    }
  }

  /** Mark session as complete. */
  end(): void {
    if (this.ended) return
    this.ended = true
    this.appendTurn({ ts: new Date().toISOString(), role: 'session_end' })
  }

  /** Return the path to the transcript file. */
  getFilePath(): string {
    return this.filePath
  }

  private appendTurn(turn: TranscriptTurn): void {
    try {
      appendFileSync(this.filePath, JSON.stringify(turn) + '\n', 'utf-8')
    } catch {
      // Non-fatal — transcript capture should never break the harness
    }
  }

  // ---------------------------------------------------------------------------
  // Static helpers
  // ---------------------------------------------------------------------------

  /** Find the most recent transcript file for a given feature-id. */
  static findLatest(projectDir: string, featureId: string): string | null {
    const transcriptsDir = join(projectDir, '.quest', 'transcripts')
    if (!existsSync(transcriptsDir)) return null

    const files = readdirSync(transcriptsDir)
      .filter(f => f.startsWith(`${featureId}-`) && f.endsWith('.jsonl'))
      .map(f => ({
        name: f,
        path: join(transcriptsDir, f),
        mtime: statSync(join(transcriptsDir, f)).mtime,
      }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

    return files.length > 0 ? files[0].path : null
  }

  /** List all transcripts for a given feature-id, sorted newest first. */
  static listForFeature(projectDir: string, featureId: string): string[] {
    const transcriptsDir = join(projectDir, '.quest', 'transcripts')
    if (!existsSync(transcriptsDir)) return []

    return readdirSync(transcriptsDir)
      .filter(f => f.startsWith(`${featureId}-`) && f.endsWith('.jsonl'))
      .map(f => join(transcriptsDir, f))
      .sort((a, b) => statSync(b).mtime.getTime() - statSync(a).mtime.getTime())
  }

  /**
   * Clean up old transcripts.
   * Removes all transcripts older than maxAgeDays (default: 7).
   * Returns the number of files deleted.
   */
  static cleanup(projectDir: string, maxAgeDays = 7): number {
    const transcriptsDir = join(projectDir, '.quest', 'transcripts')
    if (!existsSync(transcriptsDir)) return 0

    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    let count = 0

    for (const file of readdirSync(transcriptsDir)) {
      if (!file.endsWith('.jsonl')) continue
      const filePath = join(transcriptsDir, file)
      try {
        const { mtime } = statSync(filePath)
        if (mtime.getTime() < cutoff) {
          unlinkSync(filePath)
          count++
        }
      } catch {
        // Skip files we can't access
      }
    }

    return count
  }

  /** Remove ALL transcripts (used by quest clean). */
  static cleanAll(projectDir: string): number {
    const transcriptsDir = join(projectDir, '.quest', 'transcripts')
    if (!existsSync(transcriptsDir)) return 0

    let count = 0
    for (const file of readdirSync(transcriptsDir)) {
      if (!file.endsWith('.jsonl')) continue
      try {
        unlinkSync(join(transcriptsDir, file))
        count++
      } catch {
        // Skip
      }
    }

    return count
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, maxLen: number): string {
  if (!s) return s
  if (s.length <= maxLen) return s
  return s.slice(0, maxLen) + `… [${s.length} chars]`
}

// ---------------------------------------------------------------------------
// Formatting (for quest inspect)
// ---------------------------------------------------------------------------

/**
 * Read and format a transcript file for display.
 * Returns a human-readable string with optional syntax highlighting markers.
 */
export function formatTranscript(filePath: string, featureId: string, agent: string): string {
  if (!existsSync(filePath)) return `No transcript found at: ${filePath}`

  const lines: string[] = []
  let turns: TranscriptTurn[] = []

  try {
    turns = readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as TranscriptTurn)
  } catch {
    return `Error reading transcript: ${filePath}`
  }

  lines.push(chalk.bold(`Feature: ${featureId}`))
  lines.push(chalk.bold(`Agent:   ${agent}`))
  lines.push(chalk.gray(`File:    ${filePath}`))
  lines.push(chalk.gray('─'.repeat(60)))

  for (const turn of turns) {
    if (turn.role === 'session_start') {
      lines.push(chalk.green(`[${formatTs(turn.ts)}] ▶ SESSION START`))
      continue
    }

    if (turn.role === 'session_end') {
      lines.push(chalk.green(`[${formatTs(turn.ts)}] ■ SESSION END`))
      continue
    }

    if (turn.role === 'result') {
      const status = turn.isError ? chalk.red('ERROR') : chalk.green('OK')
      const tokens = turn.usage
        ? chalk.gray(` | ${turn.usage.inputTokens}↑ ${turn.usage.outputTokens}↓`)
        : ''
      lines.push(`${chalk.gray(`[${formatTs(turn.ts)}]`)} ${chalk.yellow('RESULT')}: ${status}${tokens}`)
      continue
    }

    if (turn.role === 'assistant') {
      const ts = chalk.gray(`[${formatTs(turn.ts)}]`)
      if (turn.content) {
        lines.push(`${ts} ${chalk.cyan('ASSISTANT')}: ${turn.content}`)
      }
      if (turn.toolCalls) {
        for (const tc of turn.toolCalls) {
          lines.push(`${ts} ${chalk.magenta('TOOL_CALL')}: ${chalk.bold(tc.name)}(${chalk.gray(tc.input)})`)
        }
      }
      continue
    }

    if (turn.role === 'tool_result') {
      if (turn.toolResults) {
        const ts = chalk.gray(`[${formatTs(turn.ts)}]`)
        for (const tr of turn.toolResults) {
          lines.push(`${ts} ${chalk.blue('TOOL_RESULT')}: ${chalk.bold(tr.name)} → ${tr.output}`)
        }
      }
      continue
    }
  }

  return lines.join('\n')
}

function formatTs(ts: string): string {
  return ts.split('T')[1]?.split('.')[0] ?? ts
}
