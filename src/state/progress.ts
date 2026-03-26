import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProgressState } from '../agents/types.js'

const PROGRESS_FILE = 'claude-progress.txt'

export async function readProgress(projectDir: string): Promise<ProgressState> {
  const path = join(projectDir, PROGRESS_FILE)
  const content = await readFile(path, 'utf-8')
  return JSON.parse(content) as ProgressState
}

export async function writeProgress(projectDir: string, state: ProgressState): Promise<void> {
  const path = join(projectDir, PROGRESS_FILE)
  const updated: ProgressState = { ...state, lastUpdated: new Date().toISOString() }
  await writeFile(path, JSON.stringify(updated, null, 2) + '\n', 'utf-8')
}

export function createInitialProgress(projectName: string, totalFeatures: number): ProgressState {
  return {
    projectName,
    totalFeatures,
    passedFeatures: 0,
    currentFeatureId: null,
    lastCommitSha: null,
    lastSessionId: null,
    lastUpdated: new Date().toISOString(),
    contextResets: 0,
  }
}
