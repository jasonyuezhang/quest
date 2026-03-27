/**
 * Project state detection for automatic command dispatch.
 *
 * Inspects SQLite databases and filesystem artifacts to determine whether to init, resume, or run.
 * Used by the default `quest` command and by `quest run` to auto-init.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProgressState, FeaturesFile } from './agents/types.js'
import { FeatureDB } from './feature-db.js'
import { EventDB } from './event-db.js'

export type ProjectState =
  | { status: 'uninitialized' }
  | { status: 'interrupted'; featureId: string; hasHandoff: boolean; resetCount: number }
  | { status: 'pending'; passing: number; total: number }
  | { status: 'complete'; passing: number; total: number }

/**
 * Detect the current project state by inspecting databases and filesystem artifacts.
 *
 * Priority order:
 *   1. No features DB or features.json → uninitialized (needs init)
 *   2. Has currentFeatureId in progress → interrupted (needs resume)
 *   3. Has sprint-context-handoff.json → interrupted mid-reset (needs resume)
 *   4. Has pending features → pending (needs run)
 *   5. All features pass → complete (nothing to do)
 */
export async function detectProjectState(projectDir: string): Promise<ProjectState> {
  const questDbPath = join(projectDir, '.quest', 'store', 'quest.db')
  const legacyFeaturesDbPath = join(projectDir, '.quest', 'store', 'features.db')
  const storeFeaturesPath = join(projectDir, '.quest', 'store', 'features.json')
  const featuresPath = join(projectDir, 'features.json')
  const handoffPath = join(projectDir, 'sprint-context-handoff.json')

  // Signal 1: Check if features exist (DB or JSON)
  const hasDb = existsSync(questDbPath) || existsSync(legacyFeaturesDbPath)
  const hasJson = existsSync(storeFeaturesPath) || existsSync(featuresPath)

  if (!hasDb && !hasJson) {
    return { status: 'uninitialized' }
  }

  // Read features from SQLite if available, else fall back to JSON
  let total: number
  let passing: number

  if (hasDb) {
    try {
      const db = new FeatureDB(projectDir)
      const stats = db.stats()
      total = stats.total
      passing = stats.passing
      db.close()
    } catch {
      return { status: 'uninitialized' }
    }
  } else {
    const jsonPath = existsSync(storeFeaturesPath) ? storeFeaturesPath : featuresPath
    try {
      const raw = await readFile(jsonPath, 'utf-8')
      const data = JSON.parse(raw) as FeaturesFile
      total = data.features.length
      passing = data.features.filter(f => f.passes).length
    } catch {
      return { status: 'uninitialized' }
    }
  }

  if (total === 0) {
    return { status: 'uninitialized' }
  }

  // Signal 2: Check progress in SQLite (EventDB), fall back to JSON file
  const legacyEventsDbPath = join(projectDir, '.quest', 'store', 'events.db')
  if (existsSync(questDbPath) || existsSync(legacyEventsDbPath)) {
    try {
      const evtDb = new EventDB(projectDir)
      const progress = evtDb.readProgress() as ProgressState | null
      evtDb.close()
      if (progress?.currentFeatureId) {
        const hasHandoff = existsSync(handoffPath)
        return {
          status: 'interrupted',
          featureId: progress.currentFeatureId,
          hasHandoff,
          resetCount: progress.contextResets ?? 0,
        }
      }
    } catch {
      // Fall through to JSON check
    }
  }

  // Fall back to claude-progress.txt
  const storeProgressPath = join(projectDir, '.quest', 'store', 'claude-progress.txt')
  const progressPath = existsSync(storeProgressPath) ? storeProgressPath : join(projectDir, 'claude-progress.txt')
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
      // Corrupt progress — fall through
    }
  }

  // Signal 3: Handoff file exists without progress tracking it
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
