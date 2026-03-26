import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentResult, ReviewReport } from './types.js'
import type { ContextManager } from '../context/manager.js'
import { logMessage, resetTurnCount } from '../logger.js'

const REVIEW_REPORT_FILE = 'review-report.json'

/**
 * System prompt for the reviewer agent.
 *
 * Reads the git diff of the coder's changes and checks for code quality issues.
 * Runs between coder and evaluator when --review flag is set.
 */
const REVIEWER_SYSTEM_PROMPT = `You are a code review agent. Your job is to review the coder's changes for quality issues BEFORE functional testing.

## Startup Protocol

1. Run: pwd (confirm project directory)
2. Run: git log --oneline -5 (understand recent changes)
3. Run: git show HEAD --stat (see what files changed)
4. Run: git show HEAD (read the git diff of the coder's changes — NOT the full codebase)
   If the diff is very large, run: git diff HEAD~1 HEAD -- <specific files>
5. Read: sprint-contract.json (understand what was supposed to be implemented)
6. Read: sprint-completion.json (understand what the coder claims to have done)

## Review Protocol

Analyze the git diff for the following categories of issues:

### Security Vulnerabilities
- Hardcoded secrets, passwords, API keys, tokens
- SQL injection vulnerabilities (string concatenation in queries)
- XSS vulnerabilities (unescaped user input in HTML)
- Path traversal vulnerabilities
- Insecure use of eval() or similar
- Missing authentication/authorization checks

### Error Handling
- Missing try/catch blocks around I/O operations, network calls, JSON parsing
- Swallowed exceptions (catch blocks that do nothing)
- Missing null/undefined checks on potentially null values
- Unhandled promise rejections

### Code Duplication
- Identical or near-identical code blocks that should be extracted into functions
- Copy-paste of logic that already exists elsewhere in the diff

### Naming Quality
- Misleading variable/function names (name doesn't match behavior)
- Single-letter variable names outside of short loops/lambdas
- Abbreviations that reduce clarity (e.g., "mgr", "tmp", "dat" without context)

### Style Consistency
- Mixed indentation (tabs vs spaces)
- Inconsistent naming conventions (camelCase vs snake_case in same file)
- Inconsistent quote style in same file
- Trailing whitespace on many lines

## Output Format

Write review-report.json with this EXACT structure:
{
  "featureId": "<from sprint-contract.json>",
  "issues": [
    {
      "category": "security" | "error-handling" | "duplication" | "naming" | "style",
      "severity": "critical" | "high" | "medium" | "low",
      "description": "<specific description of the issue>",
      "location": "<file:line or file reference>",
      "suggestion": "<concrete fix suggestion>"
    }
  ],
  "summary": "<1-2 sentence overall assessment>",
  "hasCriticalIssues": true | false,
  "reviewedAt": "<ISO timestamp>"
}

## Severity Guidelines

- **critical**: Security vulnerabilities, data loss risks, crashes in production paths
- **high**: Missing error handling on critical paths, logic errors, significant naming confusion
- **medium**: Moderate duplication, minor naming issues, missing error handling on non-critical paths
- **low**: Style inconsistencies, minor naming preferences, trivial duplication

## Important Rules

- Only review the DIFF, not the entire codebase
- Be specific: include file names and approximate line numbers
- If there are no issues in a category, do not invent problems
- hasCriticalIssues must be true ONLY if there is at least one "critical" severity issue
- An empty issues array is valid — it means the code is clean
- Do NOT set passes:true in features.json (that is the evaluator's job)
- After writing review-report.json, stop. Do not attempt to fix the issues yourself.`

export async function runReviewerAgent(
  projectDir: string,
  featureId: string,
  contextManager: ContextManager,
): Promise<AgentResult> {
  const startTime = Date.now()

  const prompt = `Review the coder's changes for feature: ${featureId}

Follow your startup protocol (pwd, git log, git show HEAD, read sprint-contract, read sprint-completion), then perform the code review and write review-report.json.`

  let sessionId = 'unknown'
  let success = false
  let error: string | undefined

  resetTurnCount()
  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: projectDir,
        systemPrompt: REVIEWER_SYSTEM_PROMPT,
        allowedTools: ['Read', 'Write', 'Bash', 'Glob', 'Grep'],
        model: 'claude-sonnet-4-6',
        maxTurns: 30,
      },
    })) {
      logMessage('reviewer', message)
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

export async function readReviewReport(dir: string): Promise<ReviewReport | null> {
  try {
    const content = await readFile(join(dir, REVIEW_REPORT_FILE), 'utf-8')
    return JSON.parse(content) as ReviewReport
  } catch {
    return null
  }
}
