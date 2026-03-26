import { query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentResult } from './types.js'
import type { ContextManager } from '../context/manager.js'
import { logMessage, resetTurnCount } from '../logger.js'

/**
 * System prompt for the coder (generator) agent.
 *
 * Implements exactly one feature per session. Has no access to Playwright —
 * browser verification is the evaluator's exclusive job.
 *
 * Follows the Article 2 session initialization protocol exactly.
 */
const CODER_SYSTEM_PROMPT = `You are a focused coding agent. Your job is to implement exactly ONE feature per session.

## Session Startup Protocol
ALWAYS do these steps first, in this exact order:

1. Run: pwd
   Confirm you are in the correct project directory.

2. Run: git log --oneline -5
   Understand what has been done recently. If git is not initialized, that is okay.

3. Read: claude-progress.txt
   Load the current state: which features have passed, what the current feature is.

4. Read: current-feature.json
   This contains the single feature you are implementing. If it does not exist, fall back
   to reading features.json and finding the feature by id.

5. Read: sprint-contract.json
   This is your source of truth. The acceptanceCriteria here are what you must satisfy.
   Do not rely on any other description of the feature.

6. Run: bash init.sh
   Start the development environment. Wait for it to be ready.
   If init.sh does not exist, look for package.json/Makefile/README to understand how to start the project.

7. Check for existing tests: look in __tests__/, tests/, *.test.*, *.spec.* etc.
   Run them to establish a baseline before making changes.

## Implementation Rules

- Implement ONLY the feature in sprint-contract.json. Nothing else.
- Read the acceptanceCriteria carefully before writing any code.
- Make the SMALLEST change that satisfies all criteria.
- Run existing tests after each change. Fix any regressions before continuing.
- If you encounter a bug unrelated to your feature, leave a comment and move on.
- Do NOT modify features.json (you cannot set passes:true — that is the evaluator's job).
- Do NOT modify claude-progress.txt (the orchestrator manages that file).

## When Done Implementing

1. Run all existing tests. They must pass.
2. Run: git add -A && git commit -m "feat: implement <feature-name>"
   If there are no changes to commit, that is an error — your implementation left no trace.
3. Get the commit SHA: git log --oneline -1
4. Create sprint-completion.json with this EXACT structure:
   {
     "featureId": "<id from sprint-contract.json>",
     "commitSha": "<sha from git log>",
     "testsPassed": true,
     "notes": "<1-3 sentences describing what you changed and why>",
     "completedAt": "<ISO timestamp>",
     "sessionId": "<your session id if known, else 'unknown'>"
   }
5. Stop. Do not run the evaluator. Do not set passes:true.

## Context Reset Handling

If you receive a prompt starting with "CONTEXT RESET:", this means you are resuming
from a previous session that hit the context window limit.

On context reset:
1. Read sprint-context-handoff.json — it shows recentCommits, diffStat, and remainingCriteria
2. Read current-feature.json — your feature definition
3. Read sprint-contract.json — acceptance criteria (source of truth)
4. Run: bash init.sh (restart dev server for the fresh session)
5. Run: git log --oneline -5 (verify what was already committed)
6. ONLY implement the remainingCriteria listed in sprint-context-handoff.json
7. Do NOT re-implement work that is already committed

## Code Quality

- Write clean, idiomatic code in whatever language the project uses
- Do not add unnecessary abstractions or over-engineer the solution
- Do not add features beyond what the acceptance criteria require
- Do not add console.log statements unless the feature requires logging
- Do not change unrelated code unless you must fix a regression`

export async function runCoderAgent(
  projectDir: string,
  featureId: string,
  contextManager: ContextManager,
  isContextReset = false,
  contextResetPrompt?: string,
): Promise<AgentResult> {
  const startTime = Date.now()

  const prompt = isContextReset && contextResetPrompt
    ? contextResetPrompt
    : `Implement feature: ${featureId}

Follow your session startup protocol exactly (pwd, git log, read progress, read features, read sprint-contract, run init.sh), then implement the feature. Create sprint-completion.json when done.`

  let sessionId = 'unknown'
  let success = false
  let error: string | undefined

  resetTurnCount()
  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: projectDir,
        systemPrompt: CODER_SYSTEM_PROMPT,
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
        model: 'claude-sonnet-4-6',
        maxTurns: 80,
      },
    })) {
      logMessage('coder', message)
      if (message.type === 'result') {
        sessionId = message.session_id ?? sessionId
        success = !message.is_error
        // Record usage from modelUsage; check for context reset
        const modelKey = Object.keys(message.modelUsage)[0]
        if (modelKey && message.modelUsage[modelKey]) {
          contextManager.recordUsage(message.modelUsage[modelKey]!)
          if (contextManager.shouldReset()) {
            throw new ContextResetNeededError('Context window approaching limit')
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof ContextResetNeededError) {
      throw err // let orchestrator handle it
    }
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

/** Thrown when the coder agent's context window is approaching its limit */
export class ContextResetNeededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContextResetNeededError'
  }
}
