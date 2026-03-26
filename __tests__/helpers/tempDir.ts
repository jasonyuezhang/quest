import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Feature, FeaturesFile } from '../../src/agents/types.js'
import { createInitialProgress } from '../../src/state/progress.js'

export async function makeTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'quest-test-'))
}

export async function cleanTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

export function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 'test-feature',
    name: 'Test Feature',
    description: 'A test feature',
    category: 'api',
    priority: 'high',
    acceptanceCriteria: ['Criterion A', 'Criterion B'],
    passes: false,
    ...overrides,
  }
}

export async function makeTempProject(features: Feature[]): Promise<string> {
  const dir = await makeTempDir()

  const featuresData: FeaturesFile = {
    version: '1.0',
    projectName: 'test-project',
    generatedAt: new Date().toISOString(),
    features,
  }

  await writeFile(join(dir, 'features.json'), JSON.stringify(featuresData, null, 2) + '\n', 'utf-8')

  const progress = createInitialProgress('test-project', features.length)
  await writeFile(join(dir, 'claude-progress.txt'), JSON.stringify(progress, null, 2) + '\n', 'utf-8')

  return dir
}
