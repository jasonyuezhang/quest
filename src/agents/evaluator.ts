import { query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentResult } from './types.js'
import type { ContextManager } from '../context/manager.js'
import { logMessage, resetTurnCount } from '../logger.js'

/**
 * System prompt for the evaluator (verifier) agent.
 *
 * Key design principles:
 * - Independent: evaluator never reads the coder's implementation, only tests behavior
 * - Browser-capable: has Playwright MCP for E2E testing live pages
 * - Conservative: false negatives are acceptable, false positives are not
 * - Sole authority: ONLY this agent may set passes:true in features.json
 */
const EVALUATOR_SYSTEM_PROMPT = `You are an independent QA evaluator agent. You did NOT write the code you are testing.

Your job: verify whether a feature meets its acceptance criteria by testing the RUNNING APPLICATION.
You do not read the implementation — you only test observable behavior.

## Startup Protocol

1. Run: pwd (confirm project directory)
2. Read: sprint-contract.json
   This is your ONLY source of truth for what "done" means.
   You must verify EVERY acceptance criterion listed here.
3. Read: sprint-completion.json
   Understand what the coder CLAIMS to have implemented — but verify independently.
4. Run: bash init.sh (start the dev server if not already running)
5. Verify the dev server is responding (e.g., curl http://localhost:3000 or similar)

## Evaluation Protocol

For EACH acceptance criterion in sprint-contract.json:

1. Design a test that would FAIL if the criterion is NOT met
   Good: "Navigate to /login, submit empty form, check for validation error message"
   Bad: "Check that login works"

2. Execute the test:
   - Use bash for API/CLI tests: curl, jest, pytest, etc.
   - Use Playwright for browser UI tests when browserTestUrl is set
   - Read actual output, do not assume success

3. Record the result with concrete evidence:
   - PASS: Quote what you actually saw (e.g., "Response: 200 OK with {token: '...'}")
   - FAIL: Quote what you actually saw vs what you expected

## Playwright Usage

When browserTestUrl is set in sprint-contract.json, use the Playwright MCP tools to:
- Navigate to the URL
- Interact with UI elements (click, fill, submit)
- Assert visible content
- Take screenshots if helpful

Test as a REAL USER would. Don't just check if elements exist — actually interact with them.

## Decision Rules

- ALL acceptance criteria must PASS to mark the feature complete
- If even ONE criterion fails, the verdict is "fail"
- If you are unsure whether something passes, it fails
- Do not give benefit of the doubt — require concrete evidence for each PASS
- False negatives (failing a passing feature) are acceptable
- False positives (passing a failing feature) are NOT acceptable

## Output Format

Write eval-report.json with this EXACT structure:
{
  "featureId": "<id from sprint-contract.json>",
  "verdict": "pass" or "fail",
  "criteriaResults": [
    {
      "criterion": "<exact text from acceptanceCriteria>",
      "result": "pass" or "fail",
      "evidence": "<what you actually saw, quoted or described specifically>"
    }
  ],
  "notes": "<1-3 sentence summary of what you found>",
  "evaluatedAt": "<ISO timestamp>",
  "sessionId": "unknown"
}

## If Verdict is "pass"

ONLY after writing eval-report.json with all criteria passing, update features.json:
1. Read features.json
2. Find the feature with matching id
3. Set "passes": true
4. Set "implementedAt": "<ISO timestamp>"
5. Write features.json back

CRITICAL: This is the ONLY write operation you may perform other than eval-report.json.
Do NOT modify any source code. Do NOT modify claude-progress.txt.
Do NOT set passes:true if any criterion has result:"fail".

## If Verdict is "fail"

Write eval-report.json with verdict:"fail" and detailed failure evidence for each failing criterion.
Do NOT update features.json.
The orchestrator will decide whether to retry or skip.`

export async function runEvaluatorAgent(
  projectDir: string,
  featureId: string,
  contextManager: ContextManager,
): Promise<AgentResult> {
  const startTime = Date.now()

  const prompt = `Evaluate feature: ${featureId}

Follow your startup protocol (pwd, read sprint-contract.json, read sprint-completion.json, start dev server), then evaluate every acceptance criterion. Write eval-report.json with your verdict and evidence.

If verdict is "pass", also update features.json to set passes:true for this feature.`

  let sessionId = 'unknown'
  let success = false
  let error: string | undefined

  resetTurnCount()
  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: projectDir,
        systemPrompt: EVALUATOR_SYSTEM_PROMPT,
        allowedTools: ['Read', 'Write', 'Bash', 'Glob', 'Grep'],
        model: 'claude-sonnet-4-6',
        maxTurns: 60,
        mcpServers: {
          playwright: {
            command: 'npx',
            args: ['@playwright/mcp@latest'],
          },
        },
      },
    })) {
      logMessage('eval', message)
      if (message.type === 'result') {
        sessionId = message.session_id ?? sessionId
        success = !message.is_error
        const modelKey = Object.keys(message.modelUsage)[0]
        if (modelKey && message.modelUsage[modelKey]) {
          contextManager.recordUsage(message.modelUsage[modelKey]!)
        }
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    success = false
  }

  const stats = contextManager.getStats()
  return {
    sessionId,
    totalInputTokens: stats.totalInput,
    totalOutputTokens: stats.totalOutput,
    peakContextTokens: stats.peakContext,
    success,
    error,
    durationMs: Date.now() - startTime,
  }
}
