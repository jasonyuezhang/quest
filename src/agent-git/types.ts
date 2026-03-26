/**
 * Agent-Git: Git-like version control for AI coding agents.
 *
 * Provides checkpoint-and-rollback workflows so agents can save state,
 * explore alternatives via branches, and revert when an approach fails.
 *
 * All inter-agent state is persisted to `.agent-git/` as JSON files,
 * consistent with Quest's file-based communication philosophy.
 */

/** A saved snapshot of agent state at a specific git commit */
export interface Checkpoint {
  /** Unique checkpoint ID (monotonic within a session) */
  id: string
  /** The git commit SHA this checkpoint references */
  commitSha: string
  /** Human-readable description of what was accomplished */
  description: string
  /** Session this checkpoint belongs to */
  sessionId: string
  /** Branch name this checkpoint lives on */
  branch: string
  /** Parent checkpoint ID (null for the first checkpoint in a session) */
  parentId: string | null
  /** Files modified since the previous checkpoint */
  modifiedFiles: string[]
  /** Tool calls made since the previous checkpoint */
  toolHistory: ToolRecord[]
  /** ISO timestamp */
  createdAt: string
  /** Arbitrary metadata (feature ID, acceptance criteria status, etc.) */
  metadata: Record<string, unknown>
}

/** A record of a tool invocation that can potentially be reversed */
export interface ToolRecord {
  /** Tool name (e.g. 'Write', 'Edit', 'Bash') */
  tool: string
  /** What the tool did */
  description: string
  /** Whether this tool call has side effects that need reversal */
  hasSideEffects: boolean
  /** ISO timestamp */
  calledAt: string
}

/**
 * A session represents a single agent execution timeline.
 * Multiple sessions can exist within an external session (project).
 */
export interface Session {
  /** Unique session ID */
  id: string
  /** The external session (project) this belongs to */
  externalSessionId: string
  /** The git branch this session operates on */
  branch: string
  /** Checkpoint IDs in chronological order */
  checkpointIds: string[]
  /** The feature being implemented (if applicable) */
  featureId?: string
  /** Whether this session is still active */
  active: boolean
  /** ISO timestamp of creation */
  createdAt: string
  /** ISO timestamp of last activity */
  updatedAt: string
}

/**
 * An external session groups related internal sessions.
 * Maps to a Quest "feature implementation" lifecycle.
 */
export interface ExternalSession {
  /** Unique external session ID */
  id: string
  /** Human-readable name */
  name: string
  /** Internal session IDs */
  sessionIds: string[]
  /** The main branch this external session targets */
  baseBranch: string
  /** ISO timestamp */
  createdAt: string
}

/** A named branch point from a checkpoint */
export interface Branch {
  /** Branch name */
  name: string
  /** The checkpoint this branch was created from */
  fromCheckpointId: string
  /** The session operating on this branch */
  sessionId: string
  /** ISO timestamp */
  createdAt: string
}

/** Options for creating a checkpoint */
export interface CheckpointOptions {
  /** Description of what was accomplished */
  description: string
  /** Tool records since last checkpoint */
  toolHistory?: ToolRecord[]
  /** Additional metadata */
  metadata?: Record<string, unknown>
  /** If true, stage and commit all changes before checkpointing (default: true) */
  autoCommit?: boolean
  /** Custom commit message (default: derived from description) */
  commitMessage?: string
}

/** Options for rolling back to a checkpoint */
export interface RollbackOptions {
  /** If true, create a new branch preserving the current timeline (default: true) */
  preserveTimeline?: boolean
  /** Name for the preservation branch (auto-generated if omitted) */
  preserveBranchName?: string
  /** If true, reverse tool side effects recorded since the target checkpoint */
  reverseTools?: boolean
}

/** Options for creating a branch from a checkpoint */
export interface BranchOptions {
  /** Name for the new branch */
  branchName: string
  /** Start a new session on the branch (default: true) */
  startSession?: boolean
}

/** The full persisted state of agent-git */
export interface AgentGitState {
  /** All external sessions */
  externalSessions: ExternalSession[]
  /** All internal sessions */
  sessions: Session[]
  /** All checkpoints */
  checkpoints: Checkpoint[]
  /** All branches */
  branches: Branch[]
  /** Currently active session ID */
  activeSessionId: string | null
  /** Schema version for future migrations */
  version: number
}

/** Result of a diff between two checkpoints */
export interface CheckpointDiff {
  fromCheckpointId: string
  toCheckpointId: string
  /** Files added */
  added: string[]
  /** Files modified */
  modified: string[]
  /** Files deleted */
  deleted: string[]
  /** Git diff stat summary */
  diffStat: string
  /** Number of commits between checkpoints */
  commitCount: number
}
