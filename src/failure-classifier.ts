/**
 * Failure classification for the Quest harness.
 *
 * Classifies agent errors into categories that the orchestrator can use
 * to decide retry strategy.
 */

export type FailureCategory =
  | 'timeout'
  | 'tool_error'
  | 'logic_bug'
  | 'external_dep'
  | 'context_exhaustion'
  | 'unknown'

/**
 * Classify an error into a FailureCategory.
 *
 * @param error - The error to classify (string, Error, or unknown)
 * @param context - Optional context: turns used and maxTurns limit
 * @returns The classified failure category
 */
export function classifyFailure(
  error: string | Error | unknown,
  context?: { turns?: number; maxTurns?: number },
): FailureCategory {
  // Check context exhaustion by turn count first
  if (
    context?.turns !== undefined &&
    context?.maxTurns !== undefined &&
    context.turns >= context.maxTurns
  ) {
    return 'context_exhaustion'
  }

  const message = errorToString(error).toLowerCase()

  // context_exhaustion: context window or token limit hit
  if (
    (message.includes('context') &&
      (message.includes('limit') ||
        message.includes('exhausted') ||
        message.includes('exceeded'))) ||
    message.includes('context window') ||
    message.includes('max tokens')
  ) {
    return 'context_exhaustion'
  }

  // timeout: network or execution timeouts
  if (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('etimedout') ||
    message.includes('deadline')
  ) {
    return 'timeout'
  }

  // tool_error: agent tool failures
  if (
    message.includes('tool') ||
    message.includes('toolusblock') ||
    message.includes('tool_use') ||
    message.includes('bash error') ||
    message.includes('command failed')
  ) {
    return 'tool_error'
  }

  // external_dep: network/dependency failures
  if (
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('network') ||
    message.includes('fetch failed') ||
    message.includes('connection refused') ||
    message.includes('external')
  ) {
    return 'external_dep'
  }

  // logic_bug: programming errors
  if (
    message.includes('assertion') ||
    message.includes('typeerror') ||
    message.includes('referenceerror') ||
    message.includes('undefined is not') ||
    message.includes('cannot read') ||
    message.includes('logic')
  ) {
    return 'logic_bug'
  }

  return 'unknown'
}

function errorToString(error: string | Error | unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return String(error)
}
