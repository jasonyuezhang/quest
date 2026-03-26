import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Feature, FeaturesFile } from '../agents/types.js'

const FEATURES_FILE = 'features.json'

export async function readFeaturesFile(projectDir: string): Promise<FeaturesFile> {
  const path = join(projectDir, FEATURES_FILE)
  const content = await readFile(path, 'utf-8')
  return JSON.parse(content) as FeaturesFile
}

export async function writeFeaturesFile(projectDir: string, data: FeaturesFile): Promise<void> {
  const path = join(projectDir, FEATURES_FILE)
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

/** Get next feature to implement (highest priority, not yet passing) */
export function getNextFeature(features: Feature[]): Feature | null {
  const pending = features.filter(f => !f.passes)
  if (pending.length === 0) return null

  const byPriority = { high: 0, medium: 1, low: 2 }
  return pending.sort((a, b) => byPriority[a.priority] - byPriority[b.priority])[0]!
}

/** Mark a feature as passing (called by evaluator or orchestrator after eval report) */
export async function markFeaturePassing(
  projectDir: string,
  featureId: string,
  sessionId: string,
): Promise<void> {
  const data = await readFeaturesFile(projectDir)
  const feature = data.features.find(f => f.id === featureId)
  if (!feature) throw new Error(`Feature not found: ${featureId}`)

  feature.passes = true
  feature.implementedAt = new Date().toISOString()
  feature.sessionId = sessionId

  await writeFeaturesFile(projectDir, data)
}

export function countPassing(features: Feature[]): number {
  return features.filter(f => f.passes).length
}
