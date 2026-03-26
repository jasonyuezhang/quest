/**
 * Shared types for the Quest coding agent harness.
 *
 * All inter-agent communication goes through files on disk using these types.
 * Agents are stateless — they read state files at startup and write them on completion.
 */

/** A single feature from features.json */
export interface Feature {
  /** Unique kebab-case id, e.g. "user-auth-login" */
  id: string
  name: string
  description: string
  category: string
  priority: 'high' | 'medium' | 'low'
  /** Acceptance criteria that must ALL pass for the feature to be marked complete */
  acceptanceCriteria: string[]
  /** If set, evaluator uses Playwright to test this URL */
  browserTestUrl?: string
  /** Feature IDs that must pass before this feature can be implemented */
  dependsOn?: string[]
  /** ONLY the evaluator agent may set this to true */
  passes: boolean
  implementedAt?: string
  /** Session ID of the coder that implemented it */
  sessionId?: string
}

/** Top-level shape of features.json */
export interface FeaturesFile {
  version: string
  projectName: string
  generatedAt: string
  features: Feature[]
}

/**
 * Sprint contract: written by the orchestrator BEFORE the coder runs.
 * Both the coder and evaluator read the same file — criteria are locked before
 * implementation begins, preventing scope creep and self-evaluation bias.
 */
export interface SprintContract {
  featureId: string
  featureName: string
  description: string
  acceptanceCriteria: string[]
  browserTestUrl?: string
  startedAt: string
  /** IDs of features that previously passed — evaluator runs smoke checks on these */
  previouslyPassingFeatureIds?: string[]
  /** If true, skip regression checks for speed during development */
  skipRegression?: boolean
  /** If true, coder is operating in TDD mode (write tests first, then implement) */
  tddMode?: boolean
}

/**
 * Written by the coder agent when it finishes implementing a feature.
 * The evaluator reads this to know what was claimed — but verifies independently.
 */
export interface SprintCompletion {
  featureId: string
  commitSha: string
  testsPassed: boolean
  notes: string
  completedAt: string
  sessionId: string
  /** If true, coder hit context limit and wrote a partial completion */
  isPartial?: boolean
  /** Number of test files written during TDD mode (only present in TDD mode) */
  testsWritten?: number
}

/**
 * Written by the orchestrator when a context reset is needed.
 * The fresh coder session reads this to resume from where the previous session left off.
 */
export interface ContextHandoff {
  featureId: string
  featureName: string
  completedSteps: string[]
  /** Acceptance criteria that are already done — fresh session must verify these still pass */
  completedCriteria: string[]
  remainingCriteria: string[]
  modifiedFiles: string[]
  /** Last 5 git commits made during this feature's work (git log --oneline -5) */
  recentCommits: string
  /** Diff stat of changes since the feature started (git diff --name-only) */
  diffStat: string
  partialNotes: string
  handoffAt: string
  resetCount: number
}

/**
 * Per-criterion evaluation result written by the evaluator.
 */
export interface CriterionResult {
  criterion: string
  result: 'pass' | 'fail'
  /** Concrete evidence: what the agent actually saw */
  evidence: string
}

/**
 * A single issue found during code review.
 */
export interface ReviewIssue {
  category: 'security' | 'error-handling' | 'duplication' | 'naming' | 'style'
  severity: 'critical' | 'high' | 'medium' | 'low'
  description: string
  location: string
  suggestion: string
}

/**
 * Review report written by the reviewer agent.
 * Orchestrator reads this to decide whether to send the feature back to coder.
 */
export interface ReviewReport {
  featureId: string
  issues: ReviewIssue[]
  summary: string
  hasCriticalIssues: boolean
  reviewedAt: string
}

/**
 * A regression detected by the evaluator: a previously passing feature that now fails.
 */
export interface RegressionResult {
  /** ID of the previously passing feature that regressed */
  featureId: string
  /** Concrete evidence of the regression */
  evidence: string
}

/**
 * Evaluation report written by the evaluator agent.
 * Orchestrator reads this to determine whether to commit or retry.
 */
export interface EvalReport {
  featureId: string
  verdict: 'pass' | 'fail'
  criteriaResults: CriterionResult[]
  notes: string
  evaluatedAt: string
  sessionId: string
  /** Classification of the failure cause (only set when verdict is 'fail') */
  failureCategory?: string
  /** Regressions detected in previously passing features (blocks pass even if verdict is 'pass') */
  regressions?: RegressionResult[]
}

/** What an agent session produces (returned to orchestrator) */
export interface AgentResult {
  sessionId: string
  totalInputTokens: number
  totalOutputTokens: number
  peakContextTokens: number
  success: boolean
  error?: string
  durationMs: number
}

/**
 * Progress state written to claude-progress.txt.
 * All agents read this at session startup to understand current state.
 */
export interface ProgressState {
  projectName: string
  totalFeatures: number
  passedFeatures: number
  currentFeatureId: string | null
  lastCommitSha: string | null
  lastSessionId: string | null
  lastUpdated: string
  contextResets: number
}

/** Result from a parallel worker implementing a feature */
export interface WorkerResult {
  workerId: number
  feature: Feature
  verdict: 'pass' | 'fail'
  commitSha?: string
  durationMs: number
  error?: string
  failureCategory?: string
}

/** Supported models for agent selection */
export const SUPPORTED_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'] as const
export type SupportedModel = typeof SUPPORTED_MODELS[number]

/** Per-agent model configuration (stored in .quest/config.json) */
export interface ModelConfig {
  coder?: string
  evaluator?: string
  reviewer?: string
  planner?: string
}

/** Orchestrator configuration */
export interface OrchestratorOptions {
  projectDir: string
  /** Stop after N features (useful for testing) */
  maxFeatures?: number
  /** Max retries per failed feature (default: 2) */
  retryLimit?: number
  /** Max context resets per feature before giving up (default: 5) */
  maxContextResets?: number
  /** Print plan without running agents */
  dryRun?: boolean
  /** Override model for all agents */
  model?: string
  /** Override model specifically for the coder agent */
  coderModel?: string
  /** Override model specifically for the evaluator agent */
  evaluatorModel?: string
  /** Override model specifically for the reviewer agent */
  reviewerModel?: string
  /** Maximum parallel workers — scheduler auto-adjusts based on DAG width (default: 4) */
  maxConcurrency?: number
  /** Run a reviewer agent between coder and evaluator (default: false) */
  review?: boolean
  /** Maximum context window tokens for dynamic budgeting (default: 200000) */
  maxContextTokens?: number
  /** Skip running init.sh before dispatching agents (default: false) */
  skipInit?: boolean
  /** Timeout in seconds for health check polling after init.sh (default: 30) */
  healthTimeout?: number
  /** Disable session transcript capture to save disk space (default: false) */
  noTranscripts?: boolean
  /** Skip regression checks in evaluator for speed during development (default: false) */
  skipRegression?: boolean
  /** Enable TDD mode: coder writes failing tests first, then implements to make them pass (default: false) */
  tdd?: boolean
}
