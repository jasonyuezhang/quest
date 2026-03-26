/**
 * Project state detection for automatic command dispatch.
 *
 * Inspects filesystem artifacts to determine whether to init, resume, or run.
 * Used by the default `quest` command and by `quest run` to auto-init.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProgressState, FeaturesFile } from './agents/types.js'

export type ProjectState =
  | { status: 'uninitialized' }
  | { status: 'interrupted'; featureId: string; hasHandoff: boolean; resetCount: number }
  | { status: 'pending'; passing: number; total: number }
  | { status: 'complete'; passing: number; total: number }

/**
 * Detect the current project state by inspecting filesystem artifacts.
 *
 * Priority order:
 *   1. No features.json → uninitialized (needs init)
 *   2. Has currentFeatureId in progress → interrupted (needs resume)
 *   3. Has sprint-context-handoff.json → interrupted mid-reset (needs resume)
 *   4. Has pending features → pending (needs run)
 *   5. All features pass → complete (nothing to do)
 */
export async function detectProjectState(projectDir: string): Promise<ProjectState> {
  const featuresPath = join(projectDir, 'features.json')
  const progressPath = join(projectDir, 'claude-progress.txt')
  const handoffPath = join(projectDir, 'sprint-context-handoff.json')

  // Signal 1: No features.json means the project has never been initialized
  if (!existsSync(featuresPath)) {
    return { status: 'uninitialized' }
  }

  // Parse features to count passing/pending
  let featuresData: FeaturesFile
  try {
    const raw = await readFile(featuresPath, 'utf-8')
    featuresData = JSON.parse(raw) as FeaturesFile
  } catch {
    // Corrupt features.json — treat as uninitialized
    return { status: 'uninitialized' }
  }

  const total = featuresData.features.length
  const passing = featuresData.features.filter(f => f.passes).length

  if (total === 0) {
    return { status: 'uninitialized' }
  }

  // Signal 2: Progress file says a feature was in-progress when we stopped
  if (existsSync(progressPath)) {
    try {
      const raw = await readFile(progressPath, 'utf-8')
      const progress = JSON.parse(raw) as ProgressState
      if (progress.currentFeatureId) {
        const hasHandoff = existsSync(handoffPath)
        return {
          status: 'interrupted',
          featureId: progress.currentFeatureId,
          hasHandoff,
          resetCount: progress.contextResets,
        }
      }
    } catch {
      // Corrupt progress — fall through to pending/complete check
    }
  }

  // Signal 3: Handoff file exists without progress tracking it (edge case: crash between writes)
  if (existsSync(handoffPath)) {
    try {
      const raw = await readFile(handoffPath, 'utf-8')
      const handoff = JSON.parse(raw) as { featureId: string; resetCount: number }
      return {
        status: 'interrupted',
        featureId: handoff.featureId,
        hasHandoff: true,
        resetCount: handoff.resetCount,
      }
    } catch {
      // Corrupt handoff — fall through
    }
  }

  // Signal 4/5: Check if there are pending features
  if (passing < total) {
    return { status: 'pending', passing, total }
  }

  return { status: 'complete', passing, total }
}
