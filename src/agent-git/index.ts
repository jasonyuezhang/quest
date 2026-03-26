/**
 * Agent-Git: Git-like version control for AI coding agents.
 *
 * Standalone TypeScript implementation inspired by github.com/MAS-Infra-Layer/Agent-Git.
 * Provides checkpoint-and-rollback workflows for agent state management,
 * non-destructive branching for parallel exploration, and session tracking
 * for multi-attempt feature implementation.
 *
 * @example
 *   import { AgentGit } from './agent-git/index.js'
 *
 *   const ag = new AgentGit('/path/to/project')
 *   await ag.init()
 *
 *   const ext = await ag.createExternalSession('implement-user-auth')
 *   const session = await ag.startSession(ext.id, { featureId: 'user-auth' })
 *
 *   await ag.checkpoint({ description: 'Added login component' })
 *   // ... if evaluation fails ...
 *   await ag.rollbackTo(checkpoint.id)
 */

export { AgentGit } from './agent-git.js'

export type {
  Checkpoint,
  CheckpointOptions,
  CheckpointDiff,
  Session,
  ExternalSession,
  Branch,
  BranchOptions,
  RollbackOptions,
  ToolRecord,
  AgentGitState,
} from './types.js'

export { type RollbackResult } from './rollback.js'

export { GitError } from './git.js'
