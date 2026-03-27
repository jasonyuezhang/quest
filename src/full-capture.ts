/**
 * Full-capture mode — writes complete, untruncated LLM prompts and outputs
 * to per-session JSONL files for debugging and analysis.
 *
 * Files are stored at `.quest/full-capture/<session-id>.jsonl`.
 * Each line is a JSON object with the raw SDK message content.
 *
 * Toggle via: dashboard toggle, `quest config set fullCapture true`, or --full-capture CLI flag.
 */

import {
  mkdirSync,
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'

export interface FullCaptureEntry {
  ts: number
  type: string
  /** Raw content — no truncation */
  content: unknown
}

export class FullCapture {
  private filePath: string
  private ended = false

  constructor(projectDir: string, sessionId: string) {
    const dir = join(projectDir, '.quest', 'full-capture')
    mkdirSync(dir, { recursive: true })
    this.filePath = join(dir, `${sessionId}.jsonl`)
  }

  /** Record a raw SDK message without any truncation. */
  recordSDKMessage(message: unknown): void {
    if (this.ended) return
    this.append({ ts: Date.now(), type: 'sdk_message', content: message })
  }

  /** Record a raw API call (for planner which uses @anthropic-ai/sdk directly). */
  recordAPICall(role: string, content: string, usage?: { inputTokens: number; outputTokens: number }): void {
    if (this.ended) return
    this.append({ ts: Date.now(), type: 'api_call', content: { role, content, usage } })
  }

  /** Mark the session as ended. */
  end(): void {
    if (this.ended) return
    this.ended = true
    this.append({ ts: Date.now(), type: 'session_end', content: null })
  }

  getFilePath(): string {
    return this.filePath
  }

  private append(entry: FullCaptureEntry): void {
    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8')
    } catch {
      // Non-fatal — full capture should never crash the harness
    }
  }

  // ---------------------------------------------------------------------------
  // Static helpers
  // ---------------------------------------------------------------------------

  /** Check if a full-capture file exists for a session. */
  static exists(projectDir: string, sessionId: string): boolean {
    return existsSync(join(projectDir, '.quest', 'full-capture', `${sessionId}.jsonl`))
  }

  /** Read and parse a full-capture JSONL file. Returns entries array. */
  static read(projectDir: string, sessionId: string): FullCaptureEntry[] {
    const filePath = join(projectDir, '.quest', 'full-capture', `${sessionId}.jsonl`)
    if (!existsSync(filePath)) return []
    try {
      return readFileSync(filePath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as FullCaptureEntry)
    } catch {
      return []
    }
  }

  /** Remove all full-capture files. Returns count deleted. */
  static cleanAll(projectDir: string): number {
    const dir = join(projectDir, '.quest', 'full-capture')
    if (!existsSync(dir)) return 0
    let count = 0
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue
      try {
        unlinkSync(join(dir, file))
        count++
      } catch { /* skip */ }
    }
    return count
  }
}
