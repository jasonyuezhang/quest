/**
 * Git worktree manager for parallel feature implementation.
 *
 * Each parallel worker gets its own worktree (a lightweight checkout sharing
 * the same .git object store). This gives filesystem isolation without
 * cloning the entire repo.
 */

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { existsSync, cpSync, mkdirSync } from 'node:fs'
import { attemptMergeTreeResolution, trackConflict } from './conflict-resolution.js'
import { emit } from './events.js'

const execAsync = promisify(exec)

export interface WorktreeInfo {
  dir: string
  branch: string
  workerId: number
}

const WORKERS_DIR = '.quest-workers'

function workerDir(mainDir: string, workerId: number): string {
  return join(mainDir, WORKERS_DIR, `worker-${workerId}`)
}

/**
 * Create a git worktree for a parallel worker.
 * Checks out a new branch from HEAD so the worker can commit independently.
 */
export async function createWorktree(mainDir: string, workerId: number): Promise<WorktreeInfo> {
  const dir = workerDir(mainDir, workerId)
  const branch = `quest-worker-${workerId}-${Date.now()}`

  // Ensure parent directory exists
  mkdirSync(join(mainDir, WORKERS_DIR), { recursive: true })

  // Remove stale worktree at this path if it exists
  if (existsSync(dir)) {
    try {
      await execAsync(`git worktree remove "${dir}" --force`, { cwd: mainDir })
    } catch {
      // May fail if already removed — that's fine
    }
  }

  await execAsync(`git worktree add "${dir}" -b "${branch}" HEAD`, { cwd: mainDir })

  return { dir, branch, workerId }
}

/**
 * Remove a worktree and delete its branch.
 */
export async function removeWorktree(mainDir: string, info: WorktreeInfo): Promise<void> {
  try {
    await execAsync(`git worktree remove "${info.dir}" --force`, { cwd: mainDir })
  } catch {
    // Already removed
  }
  try {
    await execAsync(`git branch -D "${info.branch}"`, { cwd: mainDir })
  } catch {
    // Branch may already be gone
  }
}

/**
 * Cherry-pick a commit from a worker branch onto the current branch in mainDir.
 * Returns true on success, false on conflict.
 */
export async function cherryPickToMain(mainDir: string, commitSha: string): Promise<boolean> {
  try {
    await execAsync(`git cherry-pick ${commitSha}`, { cwd: mainDir })
    return true
  } catch {
    // Abort the failed cherry-pick to leave mainDir clean
    try {
      await execAsync('git cherry-pick --abort', { cwd: mainDir })
    } catch {
      // May fail if nothing to abort
    }
    return false
  }
}

/**
 * Cherry-pick a commit onto the current branch, with automatic 3-way merge fallback.
 *
 * If the plain cherry-pick fails, this attempts a 3-way merge using `git merge-tree`.
 * If the merge is clean it is applied directly (avoids expensive sequential re-run).
 * Otherwise a `conflict_detected` event is emitted and the caller should retry
 * the feature sequentially.
 *
 * Returns true if the commit was successfully applied (either via cherry-pick or
 * 3-way merge), false if it needs to be retried sequentially.
 */
export async function cherryPickToMainWithResolution(
  mainDir: string,
  commitSha: string,
  sourceFeatureId: string,
  targetFeatureId: string,
): Promise<boolean> {
  // First try a plain cherry-pick
  try {
    await execAsync(`git cherry-pick ${commitSha}`, { cwd: mainDir })
    return true
  } catch {
    // Abort the failed cherry-pick before trying merge-tree
    try {
      await execAsync('git cherry-pick --abort', { cwd: mainDir })
    } catch {
      // May fail if nothing to abort
    }
  }

  // Plain cherry-pick failed — try 3-way merge via merge-tree
  const resolution = await attemptMergeTreeResolution(mainDir, commitSha)

  // Track conflict frequency (also logs a warning after 2+ consecutive conflicts)
  trackConflict(sourceFeatureId, targetFeatureId)

  emit({
    type: 'conflict_detected',
    sourceFeatureId,
    targetFeatureId,
    conflictingFiles: resolution.conflictingFiles,
  })

  if (resolution.success) {
    // 3-way merge applied cleanly — no sequential retry needed
    return true
  }

  // Still conflicted — caller must queue for sequential retry
  return false
}

/**
 * Get the latest commit SHA from a worktree.
 */
export async function getWorktreeSha(worktreeDir: string): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync('git log --format=%H -1', { cwd: worktreeDir })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * Copy files needed by agents from the main worktree into a worker worktree.
 * Sprint artifacts are written fresh per-feature, but these files are needed at startup.
 */
export async function syncFilesToWorktree(mainDir: string, worktreeDir: string): Promise<void> {
  const filesToSync = [
    'features.json',
    'claude-progress.txt',
    'init.sh',
  ]

  for (const file of filesToSync) {
    const src = join(mainDir, file)
    const dst = join(worktreeDir, file)
    if (existsSync(src)) {
      cpSync(src, dst, { force: true })
    }
  }
}

/**
 * Remove all quest worker worktrees and prune stale entries.
 * Safe to call at startup to clean up after crashes.
 */
export async function cleanupAllWorktrees(mainDir: string): Promise<void> {
  // Prune stale worktree references
  try {
    await execAsync('git worktree prune', { cwd: mainDir })
  } catch {
    // Non-fatal
  }

  // List remaining worktrees and remove quest-worker ones
  try {
    const { stdout } = await execAsync('git worktree list --porcelain', { cwd: mainDir })
    const worktreePaths = stdout
      .split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => line.replace('worktree ', ''))
      .filter(path => path.includes(WORKERS_DIR))

    for (const path of worktreePaths) {
      try {
        await execAsync(`git worktree remove "${path}" --force`, { cwd: mainDir })
      } catch {
        // Continue cleanup
      }
    }
  } catch {
    // Non-fatal
  }

  // Delete quest-worker-* branches
  try {
    const { stdout } = await execAsync('git branch --list "quest-worker-*"', { cwd: mainDir })
    const branches = stdout.split('\n').map(b => b.trim()).filter(Boolean)
    for (const branch of branches) {
      try {
        await execAsync(`git branch -D "${branch}"`, { cwd: mainDir })
      } catch {
        // Continue cleanup
      }
    }
  } catch {
    // Non-fatal
  }
}
