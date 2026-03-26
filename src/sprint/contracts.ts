import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Feature, SprintContract, SprintCompletion, EvalReport, ContextHandoff } from '../agents/types.js'

const CONTRACT_FILE = 'sprint-contract.json'
const COMPLETION_FILE = 'sprint-completion.json'
const COMPLETION_PARTIAL_FILE = 'sprint-completion-partial.json'
const HANDOFF_FILE = 'sprint-context-handoff.json'
const EVAL_REPORT_FILE = 'eval-report.json'
/** Single-feature file so the coder doesn't have to scan all of features.json */
const CURRENT_FEATURE_FILE = 'current-feature.json'

/** Build a sprint contract from a feature's acceptance criteria */
export function buildSprintContract(feature: Feature): SprintContract {
  return {
    featureId: feature.id,
    featureName: feature.name,
    description: feature.description,
    acceptanceCriteria: feature.acceptanceCriteria,
    browserTestUrl: feature.browserTestUrl,
    startedAt: new Date().toISOString(),
  }
}

export async function writeSprintContract(dir: string, contract: SprintContract): Promise<void> {
  await writeFile(join(dir, CONTRACT_FILE), JSON.stringify(contract, null, 2) + '\n', 'utf-8')
}

export async function readSprintContract(dir: string): Promise<SprintContract> {
  const content = await readFile(join(dir, CONTRACT_FILE), 'utf-8')
  return JSON.parse(content) as SprintContract
}

export async function writeSprintCompletion(dir: string, completion: SprintCompletion): Promise<void> {
  const file = completion.isPartial ? COMPLETION_PARTIAL_FILE : COMPLETION_FILE
  await writeFile(join(dir, file), JSON.stringify(completion, null, 2) + '\n', 'utf-8')
}

export async function readSprintCompletion(dir: string): Promise<SprintCompletion | null> {
  try {
    const content = await readFile(join(dir, COMPLETION_FILE), 'utf-8')
    return JSON.parse(content) as SprintCompletion
  } catch {
    return null
  }
}

export async function writeContextHandoff(dir: string, handoff: ContextHandoff): Promise<void> {
  await writeFile(join(dir, HANDOFF_FILE), JSON.stringify(handoff, null, 2) + '\n', 'utf-8')
}

export async function readContextHandoff(dir: string): Promise<ContextHandoff | null> {
  try {
    const content = await readFile(join(dir, HANDOFF_FILE), 'utf-8')
    return JSON.parse(content) as ContextHandoff
  } catch {
    return null
  }
}

export async function writeEvalReport(dir: string, report: EvalReport): Promise<void> {
  await writeFile(join(dir, EVAL_REPORT_FILE), JSON.stringify(report, null, 2) + '\n', 'utf-8')
}

export async function readEvalReport(dir: string): Promise<EvalReport | null> {
  try {
    const content = await readFile(join(dir, EVAL_REPORT_FILE), 'utf-8')
    return JSON.parse(content) as EvalReport
  } catch {
    return null
  }
}

/**
 * Write the current feature to current-feature.json.
 * The coder reads this instead of scanning all 200+ entries in features.json,
 * saving startup tokens for actual coding work.
 */
export async function writeCurrentFeature(dir: string, feature: Feature): Promise<void> {
  await writeFile(join(dir, CURRENT_FEATURE_FILE), JSON.stringify(feature, null, 2) + '\n', 'utf-8')
}

/** Clean up sprint artifacts before starting a new feature */
export async function cleanSprintArtifacts(dir: string): Promise<void> {
  const { unlink } = await import('node:fs/promises')
  const files = [
    COMPLETION_FILE,
    COMPLETION_PARTIAL_FILE,
    HANDOFF_FILE,
    EVAL_REPORT_FILE,
    CURRENT_FEATURE_FILE,
  ]
  await Promise.all(
    files.map(f =>
      unlink(join(dir, f)).catch(() => {
        // ignore if file doesn't exist
      }),
    ),
  )
}
