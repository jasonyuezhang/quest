import { query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentResult } from './types.js'
import type { ContextManager } from '../context/manager.js'
import { logMessage, resetTurnCount } from '../logger.js'
import type { TraceSQLSession } from '../trace-db.js'

/**
 * System prompt for the initializer agent.
 *
 * Runs exactly once when the project has no init.sh.
 * Creates all scaffold files required by subsequent coder and evaluator sessions.
 */
const INITIALIZER_SYSTEM_PROMPT = `You are a project initialization agent for the Quest coding harness. Your job runs exactly once.

## Your Responsibilities

When invoked with a project directory and project description, you must create all scaffold files that subsequent coding sessions will depend on. Do this work carefully — if any file is missing or malformed, the entire harness will fail.

## Required Files to Create

### 1. init.sh
A shell script that sets up and starts the development environment.
- Must be executable: chmod +x init.sh
- Should install dependencies if needed (e.g., npm install)
- Should start the dev server in the background on a known port
- Must include a comment at the top explaining what it does
- Example for a Node.js project:
  #!/bin/bash
  npm install 2>&1
  npm run dev &
  echo "Dev server started on port 3000"

### 2. claude-progress.txt
Valid JSON (pretty-printed) with this exact structure:
{
  "projectName": "<name from prompt>",
  "totalFeatures": <N>,
  "passedFeatures": 0,
  "currentFeatureId": null,
  "lastCommitSha": null,
  "lastSessionId": null,
  "lastUpdated": "<ISO timestamp>",
  "contextResets": 0
}

### 3. features.json
Valid JSON with 200+ features. Structure:
{
  "version": "1.0",
  "projectName": "<name>",
  "generatedAt": "<ISO timestamp>",
  "features": [
    {
      "id": "unique-kebab-case-id",
      "name": "Human readable name",
      "description": "What this feature does",
      "category": "auth|ui|api|data|performance|security|ux",
      "priority": "high|medium|low",
      "acceptanceCriteria": [
        "Criterion 1: specific, testable, observable",
        "Criterion 2: ...",
        "Criterion 3: ..."
      ],
      "browserTestUrl": "/path/to/test" (optional — only for UI features),
      "passes": false
    }
  ]
}

CRITICAL RULES for features.json:
- NEVER set passes:true on any feature
- Each id must be unique across all features
- acceptanceCriteria must be specific and testable (not vague like "should work")
- Generate features across all categories: auth, UI components, API endpoints, data handling, error states, edge cases, performance, accessibility, security
- High priority = core functionality; Medium = important but not blocking; Low = nice to have
- Total: aim for 200-250 features depending on project scope

## Steps to Follow

1. Run: pwd (confirm you are in the project directory)
2. Run: git log --oneline -5 (understand current state; initialize git if needed)
3. Analyze the project description to understand what features are needed
4. Create init.sh with the correct commands for this project type
5. Create features.json with 200+ well-organized features
6. Create claude-progress.txt with initial state
7. If git repo exists, stage and commit everything: git add -A && git commit -m "chore: initialize quest harness"
8. If no git repo, initialize one first: git init && git add -A && git commit -m "chore: initialize quest harness"
9. Print a summary: how many features generated, categories covered, initial commit SHA

## Constraints

- NEVER implement any features
- NEVER set passes:true
- NEVER skip creating any of the three required files
- If you are unsure about the tech stack, ask the user or make reasonable assumptions based on existing files`

export async function runInitializerAgent(
  projectDir: string,
  projectDescription: string,
  projectName: string,
  contextManager: ContextManager,
  traceSession?: TraceSQLSession | null,
): Promise<AgentResult> {
  const startTime = Date.now()

  const prompt = `Initialize the Quest coding harness for this project.

Project directory: ${projectDir}
Project name: ${projectName}
Project description: ${projectDescription}

Create init.sh, features.json, and claude-progress.txt as described in your instructions. Then make an initial git commit.`

  let sessionId = 'unknown'
  let success = false
  let error: string | undefined

  resetTurnCount()
  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: projectDir,
        systemPrompt: INITIALIZER_SYSTEM_PROMPT,
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
        model: 'claude-sonnet-4-6',
        maxTurns: 50,
      },
    })) {
      logMessage('init', message)
      traceSession?.recordSDKMessage(message as Parameters<TraceSQLSession['recordSDKMessage']>[0])
      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = (message as unknown as { session_id: string }).session_id ?? 'unknown'
      }

      if (message.type === 'result') {
        // Usage and session ID are on the result message
        sessionId = message.session_id ?? sessionId
        success = !message.is_error
        // Record usage from modelUsage record (keyed by model name)
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
