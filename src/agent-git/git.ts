/**
 * Low-level git operations wrapper.
 *
 * All functions operate on a specific working directory and return
 * structured results. Uses execFile (no shell) to prevent command injection.
 * Inputs are validated before use.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export class GitError extends Error {
  constructor(
    message: string,
    public readonly command: string,
    public readonly stderr: string,
  ) {
    super(message)
    this.name = 'GitError'
  }
}

// ── Input validation ─────────────────────────────────────────────────

function validateSha(sha: string): void {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) {
    throw new Error(`Invalid SHA: ${sha}`)
  }
}

function validateBranchName(name: string): void {
  if (!/^[a-zA-Z0-9._\/-]+$/.test(name) || name.includes('..')) {
    throw new Error(`Invalid branch name: ${name}`)
  }
}

function validateCount(count: number): void {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`Invalid count: ${count}`)
  }
}

// ── Core executor ────────────────────────────────────────────────────

async function run(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 })
    return stdout.trim()
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string }
    throw new GitError(
      `Git command failed: git ${args.join(' ')}`,
      `git ${args.join(' ')}`,
      error.stderr ?? error.message ?? 'unknown error',
    )
  }
}

// ── Public API ───────────────────────────────────────────────────────

/** Get the current HEAD commit SHA */
export async function getHead(cwd: string): Promise<string> {
  return run(['rev-parse', 'HEAD'], cwd)
}

/** Get the current branch name */
export async function getCurrentBranch(cwd: string): Promise<string> {
  return run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
}

/** Check if the working tree has uncommitted changes */
export async function hasChanges(cwd: string): Promise<boolean> {
  const status = await run(['status', '--porcelain'], cwd)
  return status.length > 0
}

/** Stage all changes and create a commit */
export async function commitAll(cwd: string, message: string): Promise<string> {
  await run(['add', '-A'], cwd)
  await run(['commit', '-m', message], cwd)
  return getHead(cwd)
}

/** Get the list of files modified since a given commit */
export async function getModifiedFiles(cwd: string, sinceSha: string): Promise<string[]> {
  validateSha(sinceSha)
  try {
    const output = await run(['diff', '--name-only', sinceSha, 'HEAD'], cwd)
    return output ? output.split('\n').filter(Boolean) : []
  } catch {
    return []
  }
}

/** Get diff stat between two commits */
export async function getDiffStat(cwd: string, fromSha: string, toSha: string): Promise<string> {
  validateSha(fromSha)
  validateSha(toSha)
  try {
    return await run(['diff', '--stat', fromSha, toSha], cwd)
  } catch {
    return ''
  }
}

/** Get categorized file changes between two commits */
export async function getDiffNameStatus(
  cwd: string,
  fromSha: string,
  toSha: string,
): Promise<{ added: string[]; modified: string[]; deleted: string[] }> {
  validateSha(fromSha)
  validateSha(toSha)
  try {
    const output = await run(['diff', '--name-status', fromSha, toSha], cwd)
    const added: string[] = []
    const modified: string[] = []
    const deleted: string[] = []

    for (const line of output.split('\n').filter(Boolean)) {
      const [status, file] = line.split('\t')
      if (!file) continue
      if (status === 'A') added.push(file)
      else if (status === 'D') deleted.push(file)
      else modified.push(file)
    }

    return { added, modified, deleted }
  } catch {
    return { added: [], modified: [], deleted: [] }
  }
}

/** Count commits between two SHAs */
export async function getCommitCount(cwd: string, fromSha: string, toSha: string): Promise<number> {
  validateSha(fromSha)
  validateSha(toSha)
  try {
    const output = await run(['rev-list', '--count', `${fromSha}..${toSha}`], cwd)
    return parseInt(output, 10) || 0
  } catch {
    return 0
  }
}

/** Get recent commit log */
export async function getLog(
  cwd: string,
  count = 10,
): Promise<Array<{ sha: string; message: string }>> {
  validateCount(count)
  try {
    const output = await run(['log', `--format=%H %s`, `-${count}`], cwd)
    return output
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const spaceIdx = line.indexOf(' ')
        return {
          sha: line.slice(0, spaceIdx),
          message: line.slice(spaceIdx + 1),
        }
      })
  } catch {
    return []
  }
}

/** Create a new branch from a specific commit */
export async function createBranch(cwd: string, branchName: string, fromSha: string): Promise<void> {
  validateBranchName(branchName)
  validateSha(fromSha)
  await run(['branch', branchName, fromSha], cwd)
}

/** Checkout a branch */
export async function checkoutBranch(cwd: string, branchName: string): Promise<void> {
  validateBranchName(branchName)
  await run(['checkout', branchName], cwd)
}

/** Create and checkout a new branch from a specific commit */
export async function checkoutNewBranch(cwd: string, branchName: string, fromSha: string): Promise<void> {
  validateBranchName(branchName)
  validateSha(fromSha)
  await run(['checkout', '-b', branchName, fromSha], cwd)
}

/** Hard reset to a specific commit */
export async function resetHard(cwd: string, toSha: string): Promise<void> {
  validateSha(toSha)
  await run(['reset', '--hard', toSha], cwd)
}

/** Stash current changes */
export async function stash(cwd: string, message?: string): Promise<string> {
  const args = message ? ['stash', 'push', '-m', message] : ['stash', 'push']
  return run(args, cwd)
}

/** Pop the most recent stash */
export async function stashPop(cwd: string): Promise<void> {
  await run(['stash', 'pop'], cwd)
}

/** Check if a commit SHA exists in the repo */
export async function commitExists(cwd: string, sha: string): Promise<boolean> {
  validateSha(sha)
  try {
    await run(['cat-file', '-t', sha], cwd)
    return true
  } catch {
    return false
  }
}

/** Check if a branch exists */
export async function branchExists(cwd: string, branchName: string): Promise<boolean> {
  validateBranchName(branchName)
  try {
    await run(['rev-parse', '--verify', `refs/heads/${branchName}`], cwd)
    return true
  } catch {
    return false
  }
}

/** Delete a branch (non-force) */
export async function deleteBranch(cwd: string, branchName: string): Promise<void> {
  validateBranchName(branchName)
  await run(['branch', '-d', branchName], cwd)
}

/** Cherry-pick a commit onto the current branch */
export async function cherryPick(cwd: string, sha: string): Promise<boolean> {
  validateSha(sha)
  try {
    await run(['cherry-pick', sha], cwd)
    return true
  } catch {
    try {
      await run(['cherry-pick', '--abort'], cwd)
    } catch {
      // ignore
    }
    return false
  }
}

/** Initialize a git repo if one doesn't exist */
export async function ensureRepo(cwd: string): Promise<boolean> {
  try {
    await run(['rev-parse', '--git-dir'], cwd)
    return false
  } catch {
    await run(['init'], cwd)
    return true
  }
}
