/**
 * Unit tests for conflict-resolution.ts
 *
 * Tests cover:
 * - 3-way merge attempt using git merge-tree
 * - Fallback to sequential retry when merge-tree reports conflicts
 * - Conflict tracking and consecutive-conflict warnings
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { resetConflictCounts, trackConflict, getConflictCount, extractConflictingFiles } from '../../src/conflict-resolution.js'

// ── Mock child_process.exec ────────────────────────────────────────────────
vi.mock('node:child_process', () => ({
  exec: vi.fn(),
}))

import { exec } from 'node:child_process'

// Promisified exec mock: we need to intercept the promisified version.
// Since conflict-resolution.ts uses `promisify(exec)` at module load time,
// we must mock the module-level exec before the module initialises.
// We use vi.mock with a factory that lets us control exec per-test.

// Re-import with fresh module state
const mockExec = vi.mocked(exec)

// Helper: make exec resolve with stdout
function execResolves(stdout: string, stderr = ''): void {
  mockExec.mockImplementation((_cmd: any, _opts: any, callback: any) => {
    if (typeof _opts === 'function') {
      _opts(null, stdout, stderr)
    } else {
      callback(null, stdout, stderr)
    }
    return {} as any
  })
}

// Helper: make exec reject with an error that has stdout/stderr
function execRejectsWithOutput(stdout: string, stderr = ''): void {
  mockExec.mockImplementation((_cmd: any, _opts: any, callback: any) => {
    const err = Object.assign(new Error('Command failed'), { stdout, stderr })
    if (typeof _opts === 'function') {
      _opts(err, stdout, stderr)
    } else {
      callback(err, stdout, stderr)
    }
    return {} as any
  })
}

// ---------------------------------------------------------------------------
// Tests for conflict tracking
// ---------------------------------------------------------------------------

describe('conflict tracking', () => {
  beforeEach(() => {
    resetConflictCounts()
  })

  it('starts with zero conflicts for any pair', () => {
    expect(getConflictCount('feat-a', 'feat-b')).toBe(0)
  })

  it('increments conflict count on each call', () => {
    const count1 = trackConflict('feat-a', 'feat-b')
    expect(count1).toBe(1)
    expect(getConflictCount('feat-a', 'feat-b')).toBe(1)

    const count2 = trackConflict('feat-a', 'feat-b')
    expect(count2).toBe(2)
    expect(getConflictCount('feat-a', 'feat-b')).toBe(2)
  })

  it('tracks feature pairs independently', () => {
    trackConflict('feat-a', 'feat-b')
    trackConflict('feat-a', 'feat-b')
    trackConflict('feat-x', 'feat-y')

    expect(getConflictCount('feat-a', 'feat-b')).toBe(2)
    expect(getConflictCount('feat-x', 'feat-y')).toBe(1)
    expect(getConflictCount('feat-b', 'feat-a')).toBe(0) // different direction
  })

  it('logs a warning after 2 consecutive conflicts', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    trackConflict('feat-a', 'feat-b') // count = 1, no warning
    expect(warnSpy).not.toHaveBeenCalled()

    trackConflict('feat-a', 'feat-b') // count = 2, warning
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0][0]).toContain('feat-a')
    expect(warnSpy.mock.calls[0][0]).toContain('feat-b')
    expect(warnSpy.mock.calls[0][0]).toContain('dependency')

    warnSpy.mockRestore()
  })

  it('continues warning for count > 2', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    trackConflict('feat-a', 'feat-b')
    trackConflict('feat-a', 'feat-b')
    trackConflict('feat-a', 'feat-b') // count = 3

    expect(warnSpy).toHaveBeenCalledTimes(2)
    warnSpy.mockRestore()
  })

  it('resetConflictCounts clears all tracking data', () => {
    trackConflict('feat-a', 'feat-b')
    trackConflict('feat-a', 'feat-b')
    resetConflictCounts()

    expect(getConflictCount('feat-a', 'feat-b')).toBe(0)
    const count = trackConflict('feat-a', 'feat-b')
    expect(count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Tests for extractConflictingFiles
// ---------------------------------------------------------------------------

describe('extractConflictingFiles', () => {
  it('returns empty array for clean merge output', () => {
    const output = 'diff --git a/foo.ts b/foo.ts\n+added line\n'
    expect(extractConflictingFiles(output)).toEqual([])
  })

  it('detects files when conflict markers are present after file entry lines', () => {
    const output = [
      'changed in both',
      '  base   100644 abc1234 src/foo.ts',
      '  our    100644 def5678 src/foo.ts',
      '  their  100644 789abcd src/foo.ts',
      '@@ -1,3 +1,3 @@',
      ' context',
      '<<<<<<< HEAD',
      '-our line',
      '=======',
      '+their line',
      '>>>>>>> commit',
    ].join('\n')

    const files = extractConflictingFiles(output)
    expect(files).toContain('src/foo.ts')
  })

  it('detects files from CONFLICT lines (new git format)', () => {
    const output = [
      'CONFLICT (content): Merge conflict in src/bar.ts',
      'CONFLICT (modify/delete): src/baz.ts deleted in HEAD',
    ].join('\n')

    const files = extractConflictingFiles(output)
    expect(files).toContain('src/bar.ts')
    // baz.ts is mentioned but in a slightly different format
  })

  it('deduplicates files appearing multiple times', () => {
    const output = [
      '  base   100644 abc1234 src/foo.ts',
      '<<<<<<< HEAD',
      '  base   100644 abc1234 src/foo.ts',
      '<<<<<<< HEAD',
    ].join('\n')

    const files = extractConflictingFiles(output)
    const fooCount = files.filter(f => f === 'src/foo.ts').length
    expect(fooCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Tests for attemptMergeTreeResolution (integration-style with mocked exec)
// ---------------------------------------------------------------------------

describe('attemptMergeTreeResolution', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    resetConflictCounts()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns success=false and empty conflictingFiles when exec throws without commit parent', async () => {
    // Mock exec to fail on rev-parse (e.g. initial commit, no parent)
    mockExec.mockImplementation((_cmd: any, _opts: any, callback: any) => {
      const err = new Error('unknown revision')
      if (typeof _opts === 'function') {
        _opts(err, '', '')
      } else {
        callback(err, '', '')
      }
      return {} as any
    })

    const { attemptMergeTreeResolution } = await import('../../src/conflict-resolution.js')
    const result = await attemptMergeTreeResolution('/repo', 'deadbeef')

    expect(result.success).toBe(false)
    expect(result.resolvedViaMergeTree).toBe(false)
  })

  it('returns success=false when merge-tree output contains conflict markers', async () => {
    let callCount = 0
    mockExec.mockImplementation((_cmd: any, _opts: any, callback: any) => {
      callCount++
      const cb = typeof _opts === 'function' ? _opts : callback
      if (callCount === 1) {
        // git rev-parse <sha>^
        cb(null, 'parent-sha\n', '')
      } else if (callCount === 2) {
        // git rev-parse HEAD
        cb(null, 'head-sha\n', '')
      } else if (callCount === 3) {
        // git merge-tree — has conflicts
        cb(null, '<<<<<<< HEAD\nour code\n=======\ntheir code\n>>>>>>> commit\n', '')
      } else {
        // git diff --name-only calls
        cb(null, 'src/file.ts\n', '')
      }
      return {} as any
    })

    const { attemptMergeTreeResolution } = await import('../../src/conflict-resolution.js')
    const result = await attemptMergeTreeResolution('/repo', 'deadbeef')

    expect(result.success).toBe(false)
    expect(result.resolvedViaMergeTree).toBe(false)
  })

  it('returns success=true when merge-tree is clean and cherry-pick -3 succeeds', async () => {
    let callCount = 0
    mockExec.mockImplementation((_cmd: any, _opts: any, callback: any) => {
      callCount++
      const cb = typeof _opts === 'function' ? _opts : callback
      if (callCount === 1) {
        // git rev-parse <sha>^
        cb(null, 'parent-sha\n', '')
      } else if (callCount === 2) {
        // git rev-parse HEAD
        cb(null, 'head-sha\n', '')
      } else if (callCount === 3) {
        // git merge-tree — clean output (no conflict markers)
        cb(null, 'diff --git a/foo.ts b/foo.ts\n+added\n', '')
      } else if (callCount === 4) {
        // git cherry-pick -3
        cb(null, '', '')
      }
      return {} as any
    })

    const { attemptMergeTreeResolution } = await import('../../src/conflict-resolution.js')
    const result = await attemptMergeTreeResolution('/repo', 'deadbeef')

    expect(result.success).toBe(true)
    expect(result.resolvedViaMergeTree).toBe(true)
    expect(result.conflictingFiles).toEqual([])
  })

  it('returns success=false when cherry-pick -3 fails despite clean merge-tree', async () => {
    let callCount = 0
    mockExec.mockImplementation((_cmd: any, _opts: any, callback: any) => {
      callCount++
      const cb = typeof _opts === 'function' ? _opts : callback
      if (callCount === 1) {
        // git rev-parse <sha>^
        cb(null, 'parent-sha\n', '')
      } else if (callCount === 2) {
        // git rev-parse HEAD
        cb(null, 'head-sha\n', '')
      } else if (callCount === 3) {
        // git merge-tree — clean
        cb(null, 'diff --git a/foo.ts b/foo.ts\n+added\n', '')
      } else if (callCount === 4) {
        // git cherry-pick -3 fails
        cb(new Error('conflict'), '', '')
      } else if (callCount === 5) {
        // git cherry-pick --abort
        cb(null, '', '')
      } else {
        // git diff --name-only fallback
        cb(null, '', '')
      }
      return {} as any
    })

    const { attemptMergeTreeResolution } = await import('../../src/conflict-resolution.js')
    const result = await attemptMergeTreeResolution('/repo', 'deadbeef')

    expect(result.success).toBe(false)
    expect(result.resolvedViaMergeTree).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests for cherryPickToMainWithResolution (in worktree.ts)
// ---------------------------------------------------------------------------

describe('cherryPickToMainWithResolution', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    resetConflictCounts()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns true immediately on successful plain cherry-pick', async () => {
    // Plain cherry-pick succeeds on first try
    mockExec.mockImplementation((_cmd: any, _opts: any, callback: any) => {
      const cb = typeof _opts === 'function' ? _opts : callback
      cb(null, '', '')
      return {} as any
    })

    const { cherryPickToMainWithResolution } = await import('../../src/worktree.js')
    const result = await cherryPickToMainWithResolution('/repo', 'abc123', 'feat-a', 'main')

    expect(result).toBe(true)
  })

  it('emits conflict_detected event when cherry-pick fails', async () => {
    const { initEventLog, readEvents } = await import('../../src/events.js')
    const { mkdtempSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')

    const dir = mkdtempSync(join(tmpdir(), 'quest-test-'))
    initEventLog(dir)

    let callCount = 0
    mockExec.mockImplementation((_cmd: any, _opts: any, callback: any) => {
      callCount++
      const cb = typeof _opts === 'function' ? _opts : callback
      // First call: cherry-pick fails
      if (callCount === 1) {
        cb(new Error('cherry-pick conflict'), '', '')
      } else {
        // All subsequent calls (abort, rev-parse, merge-tree, diff, etc.) succeed
        cb(null, 'some-sha\n', '')
      }
      return {} as any
    })

    const { cherryPickToMainWithResolution } = await import('../../src/worktree.js')
    await cherryPickToMainWithResolution('/repo', 'deadbeef', 'feat-source', 'feat-target')

    const events = readEvents(dir)
    const conflictEvent = events.find(e => e.type === 'conflict_detected')
    expect(conflictEvent).toBeDefined()
    expect(conflictEvent!.type).toBe('conflict_detected')
    // @ts-expect-error narrowing
    expect(conflictEvent!.sourceFeatureId).toBe('feat-source')
    // @ts-expect-error narrowing
    expect(conflictEvent!.targetFeatureId).toBe('feat-target')

    // cleanup
    const { rmSync } = await import('node:fs')
    rmSync(dir, { recursive: true, force: true })
  })

  it('tracks conflict count and falls back to sequential when merge also fails', async () => {
    let callCount = 0
    mockExec.mockImplementation((_cmd: any, _opts: any, callback: any) => {
      callCount++
      const cb = typeof _opts === 'function' ? _opts : callback
      // First call: cherry-pick fails
      if (callCount === 1) {
        cb(new Error('cherry-pick conflict'), '', '')
      } else if (callCount === 2) {
        // cherry-pick --abort
        cb(null, '', '')
      } else {
        // All subsequent: rev-parse, merge-tree with conflicts, etc.
        // Make merge-tree show conflicts so resolution fails
        const cmd = _cmd as string
        if (cmd.includes('rev-parse') && cmd.includes('^')) {
          cb(null, 'parent-sha\n', '')
        } else if (cmd.includes('rev-parse')) {
          cb(null, 'head-sha\n', '')
        } else if (cmd.includes('merge-tree')) {
          cb(null, '<<<<<<< HEAD\nconflict\n=======\n>>>>>>> commit\n', '')
        } else {
          cb(null, 'src/conflicted.ts\n', '')
        }
      }
      return {} as any
    })

    const { cherryPickToMainWithResolution } = await import('../../src/worktree.js')
    const result = await cherryPickToMainWithResolution('/repo', 'deadbeef', 'feat-a', 'main')

    expect(result).toBe(false)
    expect(getConflictCount('feat-a', 'main')).toBe(1)
  })
})
