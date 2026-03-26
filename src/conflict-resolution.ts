/**
 * Intelligent parallel conflict resolution.
 *
 * When cherry-pick fails due to conflicts, this module attempts a 3-way merge
 * using `git merge-tree` before falling back to the expensive sequential retry path.
 * It also tracks conflict frequency between feature pairs to inform future batch
 * composition.
 */

import { exec } from 'node:child_process'

/**
 * Custom promisification of exec that always resolves to { stdout, stderr }.
 * Using this instead of util.promisify(exec) ensures the result shape is
 * consistent regardless of whether exec has its Node-built-in custom symbol
 * (which is absent when exec is mocked in tests).
 */
function execAsync(cmd: string, opts: { cwd: string }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(cmd, opts, (err, stdout, stderr) => {
      if (err) {
        ;(err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }).stdout = stdout
        ;(err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }).stderr = stderr
        reject(err)
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Conflict tracking
// ---------------------------------------------------------------------------

/** Tracks consecutive conflict counts between feature pairs. */
const conflictCounts = new Map<string, number>()

function pairKey(sourceFeatureId: string, targetFeatureId: string): string {
  return `${sourceFeatureId}::${targetFeatureId}`
}

/**
 * Record a conflict between two features and return the new consecutive count.
 * Emits a warning when the same pair conflicts 2+ times.
 */
export function trackConflict(
  sourceFeatureId: string,
  targetFeatureId: string,
): number {
  const key = pairKey(sourceFeatureId, targetFeatureId)
  const count = (conflictCounts.get(key) ?? 0) + 1
  conflictCounts.set(key, count)

  if (count >= 2) {
    console.warn(
      `⚠ Conflict warning: features "${sourceFeatureId}" and "${targetFeatureId}" have conflicted ` +
        `${count} consecutive time(s). Consider adding a dependency relationship between them.`,
    )
  }

  return count
}

/** Return the current conflict count for a feature pair. */
export function getConflictCount(
  sourceFeatureId: string,
  targetFeatureId: string,
): number {
  return conflictCounts.get(pairKey(sourceFeatureId, targetFeatureId)) ?? 0
}

/** Clear all conflict counts. Useful between runs or in tests. */
export function resetConflictCounts(): void {
  conflictCounts.clear()
}

// ---------------------------------------------------------------------------
// 3-way merge attempt
// ---------------------------------------------------------------------------

export interface MergeResolutionResult {
  /** Whether the merge succeeded with no conflicts. */
  success: boolean
  /** True if the commit was applied via merge-tree rather than plain cherry-pick. */
  resolvedViaMergeTree: boolean
  /** Files that had conflicts (only populated when success === false). */
  conflictingFiles: string[]
}

/**
 * Extract the list of files that have conflicts from `git merge-tree` output.
 *
 * Old-style `git merge-tree <base> <ours> <theirs>` outputs a diff-like format
 * where conflict markers (`<<<<<<<`) appear within changed sections. We identify
 * conflicting files by looking for section-change lines that precede conflict
 * markers.
 */
export function extractConflictingFiles(mergeTreeOutput: string): string[] {
  const conflicting = new Set<string>()
  const lines = mergeTreeOutput.split('\n')

  let currentFile: string | undefined
  for (const line of lines) {
    // Old merge-tree prints changed file paths in lines like:
    //   "changed in both"
    //   "  base   100644 <sha> path/to/file"
    // We pick up filenames from the indented entry lines that follow section headers
    const fileEntryMatch = line.match(/^\s+\S+\s+\d+\s+[0-9a-f]+\s+(.+)$/)
    if (fileEntryMatch) {
      currentFile = fileEntryMatch[1].trim()
    }

    // New-style merge-tree (git >= 2.38) may also emit:
    //   "CONFLICT (content): Merge conflict in path/to/file"
    const conflictLineMatch = line.match(/^CONFLICT.*:\s+.*\bin\s+(.+)$/)
    if (conflictLineMatch) {
      conflicting.add(conflictLineMatch[1].trim())
    }

    if ((line.startsWith('<<<<<<<') || line.startsWith('<<<<<<< ')) && currentFile) {
      conflicting.add(currentFile)
    }
  }

  return [...conflicting]
}

/**
 * Identify files modified by both the cherry-pick commit and by HEAD since the
 * commit's parent. These are the candidates for conflicts.
 */
async function getOverlappingFiles(
  mainDir: string,
  parentSha: string,
  commitSha: string,
): Promise<string[]> {
  try {
    const [commitFilesResult, mainFilesResult] = await Promise.all([
      execAsync(`git diff --name-only ${parentSha} ${commitSha}`, { cwd: mainDir }),
      execAsync(`git diff --name-only ${parentSha} HEAD`, { cwd: mainDir }),
    ])

    const commitFiles = new Set(commitFilesResult.stdout.split('\n').filter(Boolean))
    const mainFiles = new Set(mainFilesResult.stdout.split('\n').filter(Boolean))

    return [...commitFiles].filter(f => mainFiles.has(f))
  } catch {
    return []
  }
}

/**
 * Attempt to apply `commitSha` onto the current HEAD of `mainDir` using a
 * 3-way merge (`git merge-tree`) instead of a plain cherry-pick.
 *
 * Returns a MergeResolutionResult indicating whether the merge was clean and
 * was applied, or whether it still has conflicts (in which case the caller
 * should fall back to the sequential retry path).
 */
export async function attemptMergeTreeResolution(
  mainDir: string,
  commitSha: string,
): Promise<MergeResolutionResult> {
  try {
    // Get the parent commit (base for 3-way merge)
    const { stdout: parentOut } = await execAsync(
      `git rev-parse ${commitSha}^`,
      { cwd: mainDir },
    )
    const parentSha = parentOut.trim()

    const { stdout: headOut } = await execAsync('git rev-parse HEAD', { cwd: mainDir })
    const headSha = headOut.trim()

    // Perform the 3-way merge check
    let mergeTreeOutput = ''
    let mergeTreeExitCode = 0
    try {
      const result = await execAsync(
        `git merge-tree ${parentSha} ${headSha} ${commitSha}`,
        { cwd: mainDir },
      )
      mergeTreeOutput = result.stdout
    } catch (err: unknown) {
      // git merge-tree exits non-zero when there are conflicts (new git) or on error
      const execErr = err as { stdout?: string; stderr?: string }
      mergeTreeOutput = execErr.stdout ?? ''
      mergeTreeExitCode = 1
    }

    const hasConflicts =
      mergeTreeExitCode !== 0 ||
      mergeTreeOutput.includes('<<<<<<<') ||
      mergeTreeOutput.includes('CONFLICT')

    if (hasConflicts) {
      // Extract which files conflicted for event reporting
      let conflictingFiles = extractConflictingFiles(mergeTreeOutput)

      // Fall back to overlap detection if merge-tree output didn't name files
      if (conflictingFiles.length === 0) {
        conflictingFiles = await getOverlappingFiles(mainDir, parentSha, commitSha)
      }

      return { success: false, resolvedViaMergeTree: false, conflictingFiles }
    }

    // The 3-way merge is clean — apply using cherry-pick -3 (forces 3-way merge)
    try {
      await execAsync(`git cherry-pick -3 ${commitSha}`, { cwd: mainDir })
      return { success: true, resolvedViaMergeTree: true, conflictingFiles: [] }
    } catch {
      // cherry-pick -3 still failed; abort and report as conflict
      try {
        await execAsync('git cherry-pick --abort', { cwd: mainDir })
      } catch {
        // ignore
      }

      const conflictingFiles = await getOverlappingFiles(mainDir, parentSha, commitSha)
      return { success: false, resolvedViaMergeTree: false, conflictingFiles }
    }
  } catch {
    // Could not run merge-tree (e.g. initial commit, no parent) — treat as conflict
    return { success: false, resolvedViaMergeTree: false, conflictingFiles: [] }
  }
}
