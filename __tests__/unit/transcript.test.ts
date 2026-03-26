import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { TranscriptCapture, formatTranscript, type TranscriptTurn } from '../../src/transcript.js'
import { makeTempDir, cleanTempDir } from '../helpers/tempDir.js'

describe('transcript.ts', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeTempDir()
  })

  afterEach(async () => {
    await cleanTempDir(dir)
  })

  // ---------------------------------------------------------------------------
  // TranscriptCapture — file creation
  // ---------------------------------------------------------------------------

  describe('TranscriptCapture constructor', () => {
    it('creates .quest/transcripts directory', () => {
      new TranscriptCapture(dir, 'feat-1', 'coder')
      expect(existsSync(join(dir, '.quest', 'transcripts'))).toBe(true)
    })

    it('creates a .jsonl file with the correct naming pattern', () => {
      const capture = new TranscriptCapture(dir, 'my-feature', 'coder')
      const filePath = capture.getFilePath()
      expect(filePath).toMatch(/my-feature-coder-.+\.jsonl$/)
      expect(existsSync(filePath)).toBe(true)
    })

    it('writes a session_start turn on creation', () => {
      const capture = new TranscriptCapture(dir, 'feat-1', 'eval')
      const content = readFileSync(capture.getFilePath(), 'utf-8')
      const firstLine = JSON.parse(content.split('\n').filter(Boolean)[0]) as TranscriptTurn
      expect(firstLine.role).toBe('session_start')
      expect(firstLine.ts).toBeDefined()
    })
  })

  // ---------------------------------------------------------------------------
  // TranscriptCapture — recording turns
  // ---------------------------------------------------------------------------

  describe('recordSDKMessage', () => {
    it('records assistant text content', () => {
      const capture = new TranscriptCapture(dir, 'feat-1', 'coder')
      capture.recordSDKMessage({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello, world!' }],
        },
      })
      const turns = readTurns(capture.getFilePath())
      const assistantTurn = turns.find(t => t.role === 'assistant')
      expect(assistantTurn).toBeDefined()
      expect(assistantTurn?.content).toBe('Hello, world!')
    })

    it('records tool calls', () => {
      const capture = new TranscriptCapture(dir, 'feat-1', 'coder')
      capture.recordSDKMessage({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'ls -la' },
            },
          ],
        },
      })
      const turns = readTurns(capture.getFilePath())
      const assistantTurn = turns.find(t => t.role === 'assistant')
      expect(assistantTurn?.toolCalls).toHaveLength(1)
      expect(assistantTurn?.toolCalls?.[0].name).toBe('Bash')
      expect(assistantTurn?.toolCalls?.[0].input).toContain('ls -la')
    })

    it('records tool results', () => {
      const capture = new TranscriptCapture(dir, 'feat-1', 'coder')
      capture.recordSDKMessage({
        type: 'tool_result',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_123',
              content: 'file1.ts\nfile2.ts',
            },
          ],
        },
      })
      const turns = readTurns(capture.getFilePath())
      const toolResultTurn = turns.find(t => t.role === 'tool_result')
      expect(toolResultTurn).toBeDefined()
      expect(toolResultTurn?.toolResults?.[0].output).toContain('file1.ts')
    })

    it('truncates tool call input to 500 chars', () => {
      const longInput = 'x'.repeat(600)
      const capture = new TranscriptCapture(dir, 'feat-1', 'coder')
      capture.recordSDKMessage({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Write', input: longInput }],
        },
      })
      const turns = readTurns(capture.getFilePath())
      const assistantTurn = turns.find(t => t.role === 'assistant')
      const toolInput = assistantTurn?.toolCalls?.[0].input ?? ''
      expect(toolInput.length).toBeLessThanOrEqual(520) // 500 + truncation suffix
      expect(toolInput).toContain('… [600 chars]')
    })

    it('truncates content to 500 chars', () => {
      const longText = 'a'.repeat(600)
      const capture = new TranscriptCapture(dir, 'feat-1', 'coder')
      capture.recordSDKMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: longText }] },
      })
      const turns = readTurns(capture.getFilePath())
      const assistantTurn = turns.find(t => t.role === 'assistant')
      expect(assistantTurn?.content?.length).toBeLessThanOrEqual(520)
      expect(assistantTurn?.content).toContain('… [600 chars]')
    })

    it('records result turn with usage', () => {
      const capture = new TranscriptCapture(dir, 'feat-1', 'coder')
      capture.recordSDKMessage({
        type: 'result',
        is_error: false,
        modelUsage: {
          'claude-3-5-sonnet': { inputTokens: 1000, outputTokens: 200 },
        },
      })
      const turns = readTurns(capture.getFilePath())
      const resultTurn = turns.find(t => t.role === 'result')
      expect(resultTurn).toBeDefined()
      expect(resultTurn?.isError).toBe(false)
      expect(resultTurn?.usage?.inputTokens).toBe(1000)
      expect(resultTurn?.usage?.outputTokens).toBe(200)
    })

    it('ignores messages after end() is called', () => {
      const capture = new TranscriptCapture(dir, 'feat-1', 'coder')
      capture.end()
      const turnsBefore = readTurns(capture.getFilePath()).length
      capture.recordSDKMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'after end' }] },
      })
      const turnsAfter = readTurns(capture.getFilePath()).length
      expect(turnsAfter).toBe(turnsBefore)
    })
  })

  // ---------------------------------------------------------------------------
  // TranscriptCapture — end()
  // ---------------------------------------------------------------------------

  describe('end()', () => {
    it('writes session_end turn', () => {
      const capture = new TranscriptCapture(dir, 'feat-1', 'coder')
      capture.end()
      const turns = readTurns(capture.getFilePath())
      const endTurn = turns.find(t => t.role === 'session_end')
      expect(endTurn).toBeDefined()
    })

    it('is idempotent — only one session_end written', () => {
      const capture = new TranscriptCapture(dir, 'feat-1', 'coder')
      capture.end()
      capture.end()
      const turns = readTurns(capture.getFilePath())
      const endTurns = turns.filter(t => t.role === 'session_end')
      expect(endTurns).toHaveLength(1)
    })
  })

  // ---------------------------------------------------------------------------
  // TranscriptCapture.findLatest
  // ---------------------------------------------------------------------------

  describe('findLatest()', () => {
    it('returns null when no transcripts exist', () => {
      const result = TranscriptCapture.findLatest(dir, 'my-feature')
      expect(result).toBeNull()
    })

    it('returns the most recent transcript for a feature', async () => {
      const transcriptsDir = join(dir, '.quest', 'transcripts')
      mkdirSync(transcriptsDir, { recursive: true })

      // Write two files with different timestamps
      const old = join(transcriptsDir, 'my-feature-coder-2024-01-01T00-00-00.jsonl')
      const newer = join(transcriptsDir, 'my-feature-coder-2024-06-01T00-00-00.jsonl')
      writeFileSync(old, '')
      writeFileSync(newer, '')

      // Set modification times so "newer" is actually newer
      const oldTime = new Date('2024-01-01')
      const newTime = new Date('2024-06-01')
      utimesSync(old, oldTime, oldTime)
      utimesSync(newer, newTime, newTime)

      const result = TranscriptCapture.findLatest(dir, 'my-feature')
      expect(result).toBe(newer)
    })

    it('ignores transcripts for other features', () => {
      const transcriptsDir = join(dir, '.quest', 'transcripts')
      mkdirSync(transcriptsDir, { recursive: true })
      writeFileSync(join(transcriptsDir, 'other-feature-coder-2024-01-01T00-00-00.jsonl'), '')

      const result = TranscriptCapture.findLatest(dir, 'my-feature')
      expect(result).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // TranscriptCapture.cleanup
  // ---------------------------------------------------------------------------

  describe('cleanup()', () => {
    it('returns 0 when no transcripts directory exists', () => {
      const count = TranscriptCapture.cleanup(dir, 7)
      expect(count).toBe(0)
    })

    it('removes files older than maxAgeDays', () => {
      const transcriptsDir = join(dir, '.quest', 'transcripts')
      mkdirSync(transcriptsDir, { recursive: true })

      const oldFile = join(transcriptsDir, 'feat-coder-old.jsonl')
      writeFileSync(oldFile, '')
      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) // 10 days ago
      utimesSync(oldFile, oldDate, oldDate)

      const count = TranscriptCapture.cleanup(dir, 7)
      expect(count).toBe(1)
      expect(existsSync(oldFile)).toBe(false)
    })

    it('keeps files newer than maxAgeDays', () => {
      const transcriptsDir = join(dir, '.quest', 'transcripts')
      mkdirSync(transcriptsDir, { recursive: true })

      const recentFile = join(transcriptsDir, 'feat-coder-recent.jsonl')
      writeFileSync(recentFile, '')
      // mtime defaults to now — no need to change it

      const count = TranscriptCapture.cleanup(dir, 7)
      expect(count).toBe(0)
      expect(existsSync(recentFile)).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // TranscriptCapture.cleanAll
  // ---------------------------------------------------------------------------

  describe('cleanAll()', () => {
    it('returns 0 when no transcripts directory exists', () => {
      expect(TranscriptCapture.cleanAll(dir)).toBe(0)
    })

    it('removes all .jsonl files', () => {
      const transcriptsDir = join(dir, '.quest', 'transcripts')
      mkdirSync(transcriptsDir, { recursive: true })
      writeFileSync(join(transcriptsDir, 'a-coder-1.jsonl'), '')
      writeFileSync(join(transcriptsDir, 'b-eval-2.jsonl'), '')
      writeFileSync(join(transcriptsDir, 'c-coder-3.jsonl'), '')

      const count = TranscriptCapture.cleanAll(dir)
      expect(count).toBe(3)
    })

    it('does not remove non-.jsonl files', () => {
      const transcriptsDir = join(dir, '.quest', 'transcripts')
      mkdirSync(transcriptsDir, { recursive: true })
      writeFileSync(join(transcriptsDir, 'readme.txt'), '')

      const count = TranscriptCapture.cleanAll(dir)
      expect(count).toBe(0)
      expect(existsSync(join(transcriptsDir, 'readme.txt'))).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // formatTranscript
  // ---------------------------------------------------------------------------

  describe('formatTranscript()', () => {
    it('returns error message for missing file', () => {
      const result = formatTranscript('/nonexistent/path.jsonl', 'feat', 'coder')
      expect(result).toContain('No transcript found at')
    })

    it('includes feature id and agent in header', () => {
      const capture = new TranscriptCapture(dir, 'my-feat', 'coder')
      capture.end()
      const output = formatTranscript(capture.getFilePath(), 'my-feat', 'coder')
      expect(output).toContain('my-feat')
      expect(output).toContain('coder')
    })

    it('shows SESSION START and SESSION END', () => {
      const capture = new TranscriptCapture(dir, 'feat', 'coder')
      capture.end()
      const output = formatTranscript(capture.getFilePath(), 'feat', 'coder')
      expect(output).toContain('SESSION START')
      expect(output).toContain('SESSION END')
    })

    it('shows ASSISTANT content', () => {
      const capture = new TranscriptCapture(dir, 'feat', 'coder')
      capture.recordSDKMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'I will implement this.' }] },
      })
      capture.end()
      const output = formatTranscript(capture.getFilePath(), 'feat', 'coder')
      expect(output).toContain('ASSISTANT')
      expect(output).toContain('I will implement this.')
    })

    it('shows TOOL_CALL with name and input', () => {
      const capture = new TranscriptCapture(dir, 'feat', 'coder')
      capture.recordSDKMessage({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/file.ts' } }],
        },
      })
      capture.end()
      const output = formatTranscript(capture.getFilePath(), 'feat', 'coder')
      expect(output).toContain('TOOL_CALL')
      expect(output).toContain('Read')
    })

    it('shows TOOL_RESULT', () => {
      const capture = new TranscriptCapture(dir, 'feat', 'coder')
      capture.recordSDKMessage({
        type: 'tool_result',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents here' }],
        },
      })
      capture.end()
      const output = formatTranscript(capture.getFilePath(), 'feat', 'coder')
      expect(output).toContain('TOOL_RESULT')
      expect(output).toContain('file contents here')
    })
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readTurns(filePath: string): TranscriptTurn[] {
  return readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as TranscriptTurn)
}
