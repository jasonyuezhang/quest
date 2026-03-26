/**
 * Example Quest Plugin: Slack Notifications
 *
 * Sends a Slack notification when a feature passes evaluation.
 *
 * Installation:
 *   1. Copy this file to .quest/plugins/slack-notifications.js in your project
 *   2. Set the SLACK_WEBHOOK_URL environment variable to your Slack incoming webhook URL
 *   3. Run `quest plugin list` to confirm it loaded
 *
 * The plugin will post a message like:
 *   ✅ Feature user-auth-login passed! (12.3s)
 *
 * Plugin interface docs: src/plugins.ts
 */

/** @type {import('../src/plugins.js').QuestPlugin} */
const plugin = {
  name: 'slack-notifications',
  description: 'Send Slack notifications when features pass or the run completes',
  hooks: ['onFeatureDone', 'onRunComplete'],

  /**
   * Called when a feature finishes (pass or fail after all retries).
   * Sends a Slack message only on pass.
   *
   * @param {import('../src/plugins.js').FeatureDoneContext} ctx
   */
  async onFeatureDone(ctx) {
    if (ctx.verdict !== 'pass') return

    const webhookUrl = process.env.SLACK_WEBHOOK_URL
    if (!webhookUrl) return

    const durationSec = (ctx.durationMs / 1000).toFixed(1)
    const message = `✅ *${ctx.featureName}* (\`${ctx.featureId}\`) passed! (${durationSec}s)`

    await sendSlackMessage(webhookUrl, message)
  },

  /**
   * Called when the entire orchestration run completes.
   * Sends a summary message with pass/total counts.
   *
   * @param {import('../src/plugins.js').RunCompleteContext} ctx
   */
  async onRunComplete(ctx) {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL
    if (!webhookUrl) return

    const durationMin = (ctx.durationMs / 60_000).toFixed(1)
    const costStr = ctx.totalCostUsd != null ? ` | ~$${ctx.totalCostUsd.toFixed(2)}` : ''
    const emoji = ctx.passing === ctx.total ? '🎉' : '⚠️'
    const message = `${emoji} Quest run complete: *${ctx.passing}/${ctx.total}* features passing (${durationMin}min${costStr})`

    await sendSlackMessage(webhookUrl, message)
  },
}

/**
 * Post a message to a Slack incoming webhook URL.
 *
 * @param {string} webhookUrl
 * @param {string} text
 */
async function sendSlackMessage(webhookUrl, text) {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!response.ok) {
      console.warn(`[slack-notifications] Webhook returned ${response.status}`)
    }
  } catch (err) {
    // Errors are caught by the plugin manager, but we can also log here for clarity
    console.warn(`[slack-notifications] Failed to send message: ${err.message}`)
  }
}

export default plugin
