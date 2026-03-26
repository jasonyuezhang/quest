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
}

/**
 * Written by the orchestrator when a context reset is needed.
 * The fresh coder session reads this to resume from where the previous session left off.
 */
export interface ContextHandoff {
  featureId: string
  featureName: string
  completedSteps: string[]
  remainingCriteria: string[]
  modifiedFiles: string[]
  /** Recent git commits made during this feature's work (git log output) */
  recentCommits: string
  /** Diff stat of changes since the feature started (git diff --stat) */
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
}
