import { describe, it, expect } from 'vitest'
import { classifyFailure } from '../../src/failure-classifier.js'
import type { FailureCategory } from '../../src/failure-classifier.js'

describe('classifyFailure', () => {
  describe('context_exhaustion', () => {
    it('classifies by turn count >= maxTurns', () => {
      expect(classifyFailure('some error', { turns: 60, maxTurns: 60 })).toBe<FailureCategory>('context_exhaustion')
    })

    it('classifies when turns exceed maxTurns', () => {
      expect(classifyFailure('some error', { turns: 65, maxTurns: 60 })).toBe<FailureCategory>('context_exhaustion')
    })

    it('does not classify when turns < maxTurns', () => {
      expect(classifyFailure('some error', { turns: 59, maxTurns: 60 })).not.toBe<FailureCategory>('context_exhaustion')
    })

    it('classifies "context limit" messages', () => {
      expect(classifyFailure('hit context limit')).toBe<FailureCategory>('context_exhaustion')
    })

    it('classifies "context exhausted" messages', () => {
      expect(classifyFailure('context exhausted after 200k tokens')).toBe<FailureCategory>('context_exhaustion')
    })

    it('classifies "context exceeded" messages', () => {
      expect(classifyFailure('context exceeded maximum size')).toBe<FailureCategory>('context_exhaustion')
    })

    it('classifies "max tokens" messages', () => {
      expect(classifyFailure('max tokens reached')).toBe<FailureCategory>('context_exhaustion')
    })
  })

  describe('timeout', () => {
    it('classifies "timeout" messages', () => {
      expect(classifyFailure('operation timeout')).toBe<FailureCategory>('timeout')
    })

    it('classifies "timed out" messages', () => {
      expect(classifyFailure('request timed out after 30s')).toBe<FailureCategory>('timeout')
    })

    it('classifies "ETIMEDOUT" messages', () => {
      expect(classifyFailure('ETIMEDOUT connect error')).toBe<FailureCategory>('timeout')
    })

    it('classifies "deadline" messages', () => {
      expect(classifyFailure('deadline exceeded')).toBe<FailureCategory>('timeout')
    })

    it('classifies Error objects with timeout messages', () => {
      expect(classifyFailure(new Error('request timeout'))).toBe<FailureCategory>('timeout')
    })
  })

  describe('tool_error', () => {
    it('classifies "tool" messages', () => {
      expect(classifyFailure('tool execution failed')).toBe<FailureCategory>('tool_error')
    })

    it('classifies "ToolUseBlock" messages', () => {
      expect(classifyFailure('ToolUseBlock returned error')).toBe<FailureCategory>('tool_error')
    })

    it('classifies "tool_use" messages', () => {
      expect(classifyFailure('tool_use result was invalid')).toBe<FailureCategory>('tool_error')
    })

    it('classifies "bash error" messages', () => {
      expect(classifyFailure('bash error: exit code 1')).toBe<FailureCategory>('tool_error')
    })

    it('classifies "command failed" messages', () => {
      expect(classifyFailure('command failed with exit 127')).toBe<FailureCategory>('tool_error')
    })
  })

  describe('external_dep', () => {
    it('classifies "ECONNREFUSED" messages', () => {
      expect(classifyFailure('ECONNREFUSED 127.0.0.1:3000')).toBe<FailureCategory>('external_dep')
    })

    it('classifies "ENOTFOUND" messages', () => {
      expect(classifyFailure('ENOTFOUND api.example.com')).toBe<FailureCategory>('external_dep')
    })

    it('classifies "network" messages', () => {
      expect(classifyFailure('network error connecting to service')).toBe<FailureCategory>('external_dep')
    })

    it('classifies "fetch failed" messages', () => {
      expect(classifyFailure('fetch failed: could not connect')).toBe<FailureCategory>('external_dep')
    })

    it('classifies "connection refused" messages', () => {
      expect(classifyFailure('connection refused on port 5432')).toBe<FailureCategory>('external_dep')
    })

    it('classifies "external" messages', () => {
      expect(classifyFailure('external service unavailable')).toBe<FailureCategory>('external_dep')
    })
  })

  describe('logic_bug', () => {
    it('classifies "assertion" messages', () => {
      expect(classifyFailure('assertion failed: expected true got false')).toBe<FailureCategory>('logic_bug')
    })

    it('classifies "TypeError" messages', () => {
      expect(classifyFailure('TypeError: Cannot read properties of undefined')).toBe<FailureCategory>('logic_bug')
    })

    it('classifies "ReferenceError" messages', () => {
      expect(classifyFailure('ReferenceError: myVar is not defined')).toBe<FailureCategory>('logic_bug')
    })

    it('classifies "undefined is not" messages', () => {
      expect(classifyFailure('undefined is not a function')).toBe<FailureCategory>('logic_bug')
    })

    it('classifies "cannot read" messages', () => {
      expect(classifyFailure('cannot read property of null')).toBe<FailureCategory>('logic_bug')
    })

    it('classifies "logic" messages', () => {
      expect(classifyFailure('logic error in calculation')).toBe<FailureCategory>('logic_bug')
    })
  })

  describe('unknown', () => {
    it('returns unknown for unrecognized error messages', () => {
      expect(classifyFailure('something went wrong')).toBe<FailureCategory>('unknown')
    })

    it('returns unknown for empty string', () => {
      expect(classifyFailure('')).toBe<FailureCategory>('unknown')
    })

    it('handles null-ish unknown input', () => {
      expect(classifyFailure(null)).toBe<FailureCategory>('unknown')
    })

    it('handles numeric unknown input', () => {
      expect(classifyFailure(42)).toBe<FailureCategory>('unknown')
    })
  })

  describe('priority ordering', () => {
    it('prefers context_exhaustion over timeout when turns >= maxTurns', () => {
      expect(classifyFailure('timeout', { turns: 60, maxTurns: 60 })).toBe<FailureCategory>('context_exhaustion')
    })

    it('classifies context_exhaustion before tool_error', () => {
      expect(classifyFailure('context limit tool error', { turns: 60, maxTurns: 60 })).toBe<FailureCategory>('context_exhaustion')
    })
  })
})
