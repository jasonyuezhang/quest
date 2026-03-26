/**
 * Webhook & Notification integration for Quest harness.
 *
 * Sends POST requests to external systems on feature_done and run_complete events.
 * Also supports Slack formatted notifications via QUEST_SLACK_WEBHOOK env var.
 *
 * All delivery failures are logged but never block the orchestrator.
 */

/** Payload sent on feature_done events */
export interface FeatureDonePayload {
  event: 'feature_done'
  featureId: string
  verdict: 'pass' | 'fail'
  durationMs: number
  costEstimateUsd?: number
  errorSummary?: string
}

/** Payload sent on run_complete events */
export interface RunCompletePayload {
  event: 'run_complete'
  passing: number
  total: number
  durationMs: number
  totalCostUsd?: number
  summary: string
}

export type WebhookPayload = FeatureDonePayload | RunCompletePayload

/**
 * Send a POST request with a JSON payload to a webhook URL.
 * Failures are logged but never thrown — they must not block the orchestrator.
 */
export async function sendWebhook(url: string, payload: WebhookPayload): Promise<void> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      console.error(`[webhook] Delivery failed (HTTP ${response.status}): ${url}`)
    }
  } catch (err) {
    console.error(`[webhook] Delivery error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Send a Slack-formatted notification to the QUEST_SLACK_WEBHOOK URL.
 * If QUEST_SLACK_WEBHOOK is not set, logs a warning and returns.
 * Failures are logged but never thrown.
 */
export async function sendSlackNotification(message: string, webhookUrl?: string): Promise<void> {
  const url = webhookUrl ?? process.env.QUEST_SLACK_WEBHOOK
  if (!url) {
    console.error('[notify/slack] QUEST_SLACK_WEBHOOK environment variable is not set')
    return
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    })
    if (!response.ok) {
      console.error(`[notify/slack] Delivery failed (HTTP ${response.status}): ${url}`)
    }
  } catch (err) {
    console.error('[notify/slack]', `Delivery error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Build a Slack message for a feature_done event.
 */
export function buildSlackFeatureDoneMessage(payload: FeatureDonePayload): string {
  const icon = payload.verdict === 'pass' ? '✅' : '❌'
  const durationSec = (payload.durationMs / 1000).toFixed(1)
  let msg = `${icon} *${payload.featureId}* — ${payload.verdict.toUpperCase()} (${durationSec}s)`
  if (payload.costEstimateUsd !== undefined) {
    msg += ` | ~$${payload.costEstimateUsd.toFixed(4)}`
  }
  if (payload.verdict === 'fail' && payload.errorSummary) {
    msg += `\n> ${payload.errorSummary}`
  }
  return msg
}

/**
 * Build a Slack message for a run_complete event.
 */
export function buildSlackRunCompleteMessage(payload: RunCompletePayload): string {
  const durationMin = (payload.durationMs / 60_000).toFixed(1)
  const costStr = payload.totalCostUsd !== undefined
    ? ` | Total cost: ~$${payload.totalCostUsd.toFixed(4)}`
    : ''
  return (
    `🏁 *Quest run complete* — ${payload.passing}/${payload.total} features passing\n` +
    `> Duration: ${durationMin}min${costStr}`
  )
}

/**
 * Dispatch webhook and/or Slack notifications for a feature_done event.
 * Never throws — all failures are logged.
 */
export async function notifyFeatureDone(
  payload: FeatureDonePayload,
  webhookUrl?: string,
  notifyChannel?: string,
): Promise<void> {
  const promises: Promise<void>[] = []

  if (webhookUrl) {
    promises.push(sendWebhook(webhookUrl, payload))
  }

  if (notifyChannel === 'slack') {
    const msg = buildSlackFeatureDoneMessage(payload)
    promises.push(sendSlackNotification(msg))
  }

  await Promise.allSettled(promises)
}

/**
 * Dispatch webhook and/or Slack notifications for a run_complete event.
 * Never throws — all failures are logged.
 */
export async function notifyRunComplete(
  payload: RunCompletePayload,
  webhookUrl?: string,
  notifyChannel?: string,
): Promise<void> {
  const promises: Promise<void>[] = []

  if (webhookUrl) {
    promises.push(sendWebhook(webhookUrl, payload))
  }

  if (notifyChannel === 'slack') {
    const msg = buildSlackRunCompleteMessage(payload)
    promises.push(sendSlackNotification(msg))
  }

  await Promise.allSettled(promises)
}
