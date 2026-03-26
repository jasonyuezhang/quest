/**
 * Unit tests for src/webhook.ts
 *
 * Verifies payload format, Slack message format, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  sendWebhook,
  sendSlackNotification,
  buildSlackFeatureDoneMessage,
  buildSlackRunCompleteMessage,
  notifyFeatureDone,
  notifyRunComplete,
  type FeatureDonePayload,
  type RunCompletePayload,
} from '../../src/webhook.js'

// We mock global fetch to intercept HTTP calls
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function makeOkResponse(): Response {
  return { ok: true, status: 200 } as Response
}

function makeErrorResponse(status: number): Response {
  return { ok: false, status } as Response
}

describe('webhook.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    delete process.env.QUEST_SLACK_WEBHOOK
  })

  // ── sendWebhook ──────────────────────────────────────────────────────────────

  describe('sendWebhook()', () => {
    it('sends a POST request with JSON body', async () => {
      mockFetch.mockResolvedValue(makeOkResponse())

      const payload: FeatureDonePayload = {
        event: 'feature_done',
        featureId: 'my-feature-1',
        verdict: 'pass',
        durationMs: 5000,
        costEstimateUsd: 0.0042,
      }

      await sendWebhook('https://example.com/hook', payload)

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://example.com/hook')
      expect(init.method).toBe('POST')
      expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
      const body = JSON.parse(init.body as string) as FeatureDonePayload
      expect(body.event).toBe('feature_done')
      expect(body.featureId).toBe('my-feature-1')
      expect(body.verdict).toBe('pass')
      expect(body.durationMs).toBe(5000)
      expect(body.costEstimateUsd).toBe(0.0042)
    })

    it('includes errorSummary in payload when provided', async () => {
      mockFetch.mockResolvedValue(makeOkResponse())

      const payload: FeatureDonePayload = {
        event: 'feature_done',
        featureId: 'feat-2',
        verdict: 'fail',
        durationMs: 3000,
        errorSummary: 'Tests failed: 3 assertions',
      }

      await sendWebhook('https://example.com/hook', payload)

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as FeatureDonePayload
      expect(body.errorSummary).toBe('Tests failed: 3 assertions')
    })

    it('sends run_complete payload with summary fields', async () => {
      mockFetch.mockResolvedValue(makeOkResponse())

      const payload: RunCompletePayload = {
        event: 'run_complete',
        passing: 7,
        total: 10,
        durationMs: 120_000,
        totalCostUsd: 1.2345,
        summary: '7/10 features passing',
      }

      await sendWebhook('https://example.com/hook', payload)

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as RunCompletePayload
      expect(body.event).toBe('run_complete')
      expect(body.passing).toBe(7)
      expect(body.total).toBe(10)
      expect(body.durationMs).toBe(120_000)
      expect(body.totalCostUsd).toBe(1.2345)
      expect(body.summary).toBe('7/10 features passing')
    })

    it('logs error and does not throw when fetch throws', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'))
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const payload: FeatureDonePayload = {
        event: 'feature_done',
        featureId: 'feat-3',
        verdict: 'pass',
        durationMs: 1000,
      }

      // Should not throw
      await expect(sendWebhook('https://bad-url.example', payload)).resolves.toBeUndefined()
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Network error'))
      consoleSpy.mockRestore()
    })

    it('logs error and does not throw when response is not ok', async () => {
      mockFetch.mockResolvedValue(makeErrorResponse(500))
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const payload: FeatureDonePayload = {
        event: 'feature_done',
        featureId: 'feat-4',
        verdict: 'fail',
        durationMs: 500,
      }

      await expect(sendWebhook('https://example.com/hook', payload)).resolves.toBeUndefined()
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('500'))
      consoleSpy.mockRestore()
    })
  })

  // ── sendSlackNotification ────────────────────────────────────────────────────

  describe('sendSlackNotification()', () => {
    it('sends Slack payload with text field', async () => {
      mockFetch.mockResolvedValue(makeOkResponse())

      await sendSlackNotification('Hello from Quest!', 'https://hooks.slack.com/test')

      expect(mockFetch).toHaveBeenCalledOnce()
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://hooks.slack.com/test')
      const body = JSON.parse(init.body as string) as { text: string }
      expect(body.text).toBe('Hello from Quest!')
    })

    it('reads webhook URL from QUEST_SLACK_WEBHOOK env var', async () => {
      process.env.QUEST_SLACK_WEBHOOK = 'https://hooks.slack.com/env-url'
      mockFetch.mockResolvedValue(makeOkResponse())

      await sendSlackNotification('Test message')

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://hooks.slack.com/env-url')
    })

    it('logs a warning and does not throw when no URL is configured', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      await expect(sendSlackNotification('Test')).resolves.toBeUndefined()
      expect(mockFetch).not.toHaveBeenCalled()
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('QUEST_SLACK_WEBHOOK'))
      consoleSpy.mockRestore()
    })

    it('logs error and does not throw when fetch throws', async () => {
      mockFetch.mockRejectedValue(new Error('Slack unreachable'))
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      await expect(
        sendSlackNotification('msg', 'https://hooks.slack.com/test')
      ).resolves.toBeUndefined()
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[notify/slack]'), expect.stringContaining('Slack unreachable'))
      consoleSpy.mockRestore()
    })
  })

  // ── buildSlackFeatureDoneMessage ─────────────────────────────────────────────

  describe('buildSlackFeatureDoneMessage()', () => {
    it('formats a passing feature with checkmark', () => {
      const payload: FeatureDonePayload = {
        event: 'feature_done',
        featureId: 'auth-login-1',
        verdict: 'pass',
        durationMs: 45_000,
        costEstimateUsd: 0.0123,
      }
      const msg = buildSlackFeatureDoneMessage(payload)
      expect(msg).toContain('✅')
      expect(msg).toContain('auth-login-1')
      expect(msg).toContain('PASS')
      expect(msg).toContain('45.0s')
      expect(msg).toContain('$0.0123')
    })

    it('formats a failing feature with X and error summary', () => {
      const payload: FeatureDonePayload = {
        event: 'feature_done',
        featureId: 'failing-feature-2',
        verdict: 'fail',
        durationMs: 30_000,
        errorSummary: 'Coder timed out',
      }
      const msg = buildSlackFeatureDoneMessage(payload)
      expect(msg).toContain('❌')
      expect(msg).toContain('failing-feature-2')
      expect(msg).toContain('FAIL')
      expect(msg).toContain('Coder timed out')
    })

    it('omits cost line when costEstimateUsd is not provided', () => {
      const payload: FeatureDonePayload = {
        event: 'feature_done',
        featureId: 'feat-no-cost',
        verdict: 'pass',
        durationMs: 5_000,
      }
      const msg = buildSlackFeatureDoneMessage(payload)
      expect(msg).not.toContain('$')
    })
  })

  // ── buildSlackRunCompleteMessage ─────────────────────────────────────────────

  describe('buildSlackRunCompleteMessage()', () => {
    it('formats run_complete message with X/Y and cost', () => {
      const payload: RunCompletePayload = {
        event: 'run_complete',
        passing: 8,
        total: 10,
        durationMs: 180_000,
        totalCostUsd: 2.5,
        summary: '8/10 features passing',
      }
      const msg = buildSlackRunCompleteMessage(payload)
      expect(msg).toContain('8/10')
      expect(msg).toContain('3.0min')
      expect(msg).toContain('$2.5000')
    })

    it('omits cost line when totalCostUsd is not provided', () => {
      const payload: RunCompletePayload = {
        event: 'run_complete',
        passing: 5,
        total: 5,
        durationMs: 60_000,
        summary: '5/5 features passing',
      }
      const msg = buildSlackRunCompleteMessage(payload)
      expect(msg).not.toContain('cost')
    })
  })

  // ── notifyFeatureDone ────────────────────────────────────────────────────────

  describe('notifyFeatureDone()', () => {
    it('sends webhook POST when webhookUrl is provided', async () => {
      mockFetch.mockResolvedValue(makeOkResponse())

      const payload: FeatureDonePayload = {
        event: 'feature_done',
        featureId: 'my-feat',
        verdict: 'pass',
        durationMs: 1000,
      }

      await notifyFeatureDone(payload, 'https://example.com/hook')

      expect(mockFetch).toHaveBeenCalledOnce()
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as FeatureDonePayload
      expect(body.event).toBe('feature_done')
      expect(body.featureId).toBe('my-feat')
    })

    it('sends Slack notification when notify is "slack"', async () => {
      process.env.QUEST_SLACK_WEBHOOK = 'https://hooks.slack.com/test'
      mockFetch.mockResolvedValue(makeOkResponse())

      const payload: FeatureDonePayload = {
        event: 'feature_done',
        featureId: 'slack-feat',
        verdict: 'fail',
        durationMs: 2000,
      }

      await notifyFeatureDone(payload, undefined, 'slack')

      expect(mockFetch).toHaveBeenCalledOnce()
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as { text: string }
      expect(body.text).toContain('slack-feat')
    })

    it('sends both webhook and Slack when both are configured', async () => {
      process.env.QUEST_SLACK_WEBHOOK = 'https://hooks.slack.com/test'
      mockFetch.mockResolvedValue(makeOkResponse())

      const payload: FeatureDonePayload = {
        event: 'feature_done',
        featureId: 'both-feat',
        verdict: 'pass',
        durationMs: 3000,
      }

      await notifyFeatureDone(payload, 'https://example.com/hook', 'slack')

      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('does not send anything when neither webhookUrl nor notify is provided', async () => {
      const payload: FeatureDonePayload = {
        event: 'feature_done',
        featureId: 'no-notify',
        verdict: 'pass',
        durationMs: 1000,
      }

      await notifyFeatureDone(payload)

      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  // ── notifyRunComplete ────────────────────────────────────────────────────────

  describe('notifyRunComplete()', () => {
    it('sends run_complete payload to webhook', async () => {
      mockFetch.mockResolvedValue(makeOkResponse())

      const payload: RunCompletePayload = {
        event: 'run_complete',
        passing: 3,
        total: 5,
        durationMs: 60_000,
        totalCostUsd: 0.5,
        summary: '3/5 features passing',
      }

      await notifyRunComplete(payload, 'https://example.com/hook')

      expect(mockFetch).toHaveBeenCalledOnce()
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as RunCompletePayload
      expect(body.event).toBe('run_complete')
      expect(body.passing).toBe(3)
      expect(body.total).toBe(5)
      expect(body.totalCostUsd).toBe(0.5)
      expect(body.summary).toBe('3/5 features passing')
    })

    it('sends Slack message with summary info when notify is "slack"', async () => {
      process.env.QUEST_SLACK_WEBHOOK = 'https://hooks.slack.com/test'
      mockFetch.mockResolvedValue(makeOkResponse())

      const payload: RunCompletePayload = {
        event: 'run_complete',
        passing: 10,
        total: 10,
        durationMs: 300_000,
        totalCostUsd: 4.2,
        summary: '10/10 features passing',
      }

      await notifyRunComplete(payload, undefined, 'slack')

      expect(mockFetch).toHaveBeenCalledOnce()
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as { text: string }
      expect(body.text).toContain('10/10')
      expect(body.text).toContain('5.0min')
    })

    it('does not block when delivery fails', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'))
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const payload: RunCompletePayload = {
        event: 'run_complete',
        passing: 1,
        total: 1,
        durationMs: 1000,
        summary: '1/1 features passing',
      }

      // Must not throw
      await expect(notifyRunComplete(payload, 'https://bad.example')).resolves.toBeUndefined()
      consoleSpy.mockRestore()
    })
  })
})
