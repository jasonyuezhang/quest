/**
 * Feature refinement for the Quest harness.
 *
 * Provides three operations on the feature list:
 *  - split: break a large feature into smaller sub-features (parent ID as prefix)
 *  - merge: combine small features into one (union of acceptance criteria)
 *  - reorder: adjust priorities based on failure patterns
 *
 * Refinement NEVER modifies features that have passes:true.
 *
 * The `runRefinementSession` function uses Claude to analyse the current
 * features.json and failure patterns, then applies the suggested changes.
 */

import Anthropic from '@anthropic-ai/sdk'
import chalk from 'chalk'
import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import type { Feature, FeaturesFile } from './agents/types.js'
import { readFeaturesFile, writeFeaturesFile } from './state/features.js'
import { readEvents } from './events.js'

// ---------------------------------------------------------------------------
// Core refinement operations
// ---------------------------------------------------------------------------

export interface SplitSubFeature {
  /** Appended to parent ID with a hyphen: parentId-idSuffix */
  idSuffix: string
  name: string
  description: string
  acceptanceCriteria: string[]
  priority: 'high' | 'medium' | 'low'
  category?: string
}

/**
 * Replace a feature with a set of smaller sub-features.
 *
 * The new feature IDs follow the pattern `<parentId>-<idSuffix>`.
 * The parent feature must not be passing.
 */
export function splitFeature(
  features: Feature[],
  parentId: string,
  subFeatures: SplitSubFeature[],
): Feature[] {
  const parent = features.find(f => f.id === parentId)
  if (!parent) throw new Error(`Feature not found: ${parentId}`)
  if (parent.passes) throw new Error(`Cannot split a passing feature: ${parentId}`)
  if (subFeatures.length < 2) throw new Error(`Split requires at least 2 sub-features`)

  const created: Feature[] = subFeatures.map(sf => ({
    id: `${parentId}-${sf.idSuffix}`,
    name: sf.name,
    description: sf.description,
    category: sf.category ?? parent.category,
    priority: sf.priority,
    acceptanceCriteria: sf.acceptanceCriteria,
    passes: false,
    refinedFrom: parentId,
    refinedAction: 'split' as const,
  }))

  return features.flatMap(f => (f.id === parentId ? created : [f]))
}

export interface MergeResultSpec {
  id: string
  name: string
  description: string
  priority: 'high' | 'medium' | 'low'
  category?: string
}

/**
 * Combine multiple features into one.
 *
 * The merged feature's acceptance criteria are the union (deduplicated) of
 * all source features' criteria.  Any feature that is already passing cannot
 * be merged — the call will throw.
 */
export function mergeFeatures(
  features: Feature[],
  featureIds: string[],
  result: MergeResultSpec,
): Feature[] {
  if (featureIds.length < 2) throw new Error(`Merge requires at least 2 features`)

  const toMerge = featureIds.map(id => {
    const f = features.find(f => f.id === id)
    if (!f) throw new Error(`Feature not found: ${id}`)
    if (f.passes) throw new Error(`Cannot merge a passing feature: ${id}`)
    return f
  })

  const allCriteria = [...new Set(toMerge.flatMap(f => f.acceptanceCriteria))]
  const firstCategory = toMerge[0]?.category ?? 'api'

  const merged: Feature = {
    id: result.id,
    name: result.name,
    description: result.description,
    category: result.category ?? firstCategory,
    priority: result.priority,
    acceptanceCriteria: allCriteria,
    passes: false,
    refinedFrom: featureIds.join(','),
    refinedAction: 'merge',
  }

  const mergeSet = new Set(featureIds)
  let inserted = false
  const out: Feature[] = []
  for (const f of features) {
    if (mergeSet.has(f.id)) {
      if (!inserted) {
        out.push(merged)
        inserted = true
      }
    } else {
      out.push(f)
    }
  }
  return out
}

export interface ReorderSpec {
  featureId: string
  newPriority: 'high' | 'medium' | 'low'
}

/**
 * Adjust feature priorities based on failure patterns.
 *
 * Passing features are never modified.
 */
export function reorderFeaturePriorities(
  features: Feature[],
  reorders: ReorderSpec[],
): Feature[] {
  return features.map(f => {
    if (f.passes) return f
    const spec = reorders.find(r => r.featureId === f.id)
    if (!spec) return f
    return {
      ...f,
      priority: spec.newPriority,
      refinedFrom: f.refinedFrom ?? f.id,
      refinedAction: 'reorder' as const,
    }
  })
}

// ---------------------------------------------------------------------------
// Failure-pattern analysis helpers
// ---------------------------------------------------------------------------

/**
 * Build a map of featureId → failure count from the event log.
 */
export function buildFailureMap(projectDir: string): Map<string, number> {
  const events = readEvents(projectDir)
  const counts = new Map<string, number>()
  for (const ev of events) {
    if (ev.type === 'feature_done' && ev.verdict === 'fail') {
      counts.set(ev.featureId, (counts.get(ev.featureId) ?? 0) + 1)
    }
  }
  return counts
}

// ---------------------------------------------------------------------------
// Claude-based refinement session
// ---------------------------------------------------------------------------

const REFINEMENT_SYSTEM_PROMPT = `You are a software project manager reviewing a feature list for an AI coding agent harness called Quest.

Your task is to analyse the features and suggest refinements:
1. SPLIT large features with many acceptance criteria (>4) into focused sub-features
2. MERGE small related features that logically belong together
3. REORDER feature priorities based on failure patterns (frequently failing features should be deprioritised)

Rules:
- NEVER modify or remove features that have passes:true
- Sub-feature IDs must use the parent ID as a prefix: <parentId>-<suffix>
- Merged feature IDs should be concise and descriptive
- Only suggest changes that genuinely improve the feature list
- If the list already looks good, return empty arrays

When you have finished your analysis, output EXACTLY this JSON block (no other text):

\`\`\`refinement
{
  "splits": [
    {
      "parentId": "feature-id-to-split",
      "subFeatures": [
        {
          "idSuffix": "part-one",
          "name": "Sub-feature name",
          "description": "What this sub-feature covers",
          "acceptanceCriteria": ["criterion 1", "criterion 2"],
          "priority": "high"
        }
      ]
    }
  ],
  "merges": [
    {
      "featureIds": ["feature-a", "feature-b"],
      "result": {
        "id": "merged-feature-id",
        "name": "Merged feature name",
        "description": "Combined description",
        "priority": "medium"
      }
    }
  ],
  "reorders": [
    {
      "featureId": "feature-id",
      "newPriority": "low",
      "reason": "Fails frequently due to external dependencies"
    }
  ]
}
\`\`\``

interface RefinementPlan {
  splits: Array<{
    parentId: string
    subFeatures: SplitSubFeature[]
  }>
  merges: Array<{
    featureIds: string[]
    result: MergeResultSpec
  }>
  reorders: Array<ReorderSpec & { reason?: string }>
}

function extractRefinementPlan(text: string): RefinementPlan | null {
  const match = text.match(/```refinement\s*([\s\S]*?)```/)
  if (!match) return null
  try {
    return JSON.parse(match[1]!) as RefinementPlan
  } catch {
    return null
  }
}

function printRefinementPlan(plan: RefinementPlan, features: Feature[]): void {
  const hasSplits = plan.splits.length > 0
  const hasMerges = plan.merges.length > 0
  const hasReorders = plan.reorders.length > 0

  if (!hasSplits && !hasMerges && !hasReorders) {
    console.log(chalk.green('\n  ✓ No refinements suggested — feature list looks good.\n'))
    return
  }

  console.log()
  console.log(chalk.bold.white('═'.repeat(60)))
  console.log(chalk.bold.white('  PROPOSED REFINEMENTS'))
  console.log(chalk.bold.white('═'.repeat(60)))

  if (hasSplits) {
    console.log()
    console.log(chalk.bold('  Splits'))
    for (const split of plan.splits) {
      const parent = features.find(f => f.id === split.parentId)
      console.log(`    ${chalk.yellow('÷')} ${split.parentId} ${chalk.gray(`(${parent?.name ?? 'unknown'})`)}`)
      for (const sf of split.subFeatures) {
        console.log(`      → ${split.parentId}-${sf.idSuffix}: ${sf.name}`)
        console.log(chalk.gray(`        ${sf.acceptanceCriteria.length} criteria, ${sf.priority} priority`))
      }
    }
  }

  if (hasMerges) {
    console.log()
    console.log(chalk.bold('  Merges'))
    for (const merge of plan.merges) {
      console.log(`    ${chalk.cyan('⊕')} ${merge.featureIds.join(' + ')} → ${merge.result.id}`)
      console.log(`      ${merge.result.name}`)
    }
  }

  if (hasReorders) {
    console.log()
    console.log(chalk.bold('  Priority Reorders'))
    for (const reorder of plan.reorders) {
      const feature = features.find(f => f.id === reorder.featureId)
      const oldPri = feature?.priority ?? '?'
      const priColor =
        reorder.newPriority === 'high' ? chalk.red :
        reorder.newPriority === 'medium' ? chalk.yellow :
        chalk.gray
      console.log(`    ${chalk.magenta('↕')} ${reorder.featureId}: ${oldPri} → ${priColor(reorder.newPriority)}`)
      if (reorder.reason) console.log(chalk.gray(`      ${reorder.reason}`))
    }
  }

  console.log()
  console.log(chalk.bold.white('═'.repeat(60)))
  console.log()
}

/**
 * Apply a refinement plan to a features list.
 *
 * Operations are applied in order: splits first, then merges, then reorders.
 * Any operation that would affect a passing feature is silently skipped.
 */
export function applyRefinementPlan(features: Feature[], plan: RefinementPlan): Feature[] {
  let result = [...features]

  for (const split of plan.splits) {
    try {
      result = splitFeature(result, split.parentId, split.subFeatures)
    } catch (err) {
      // Log but don't abort — skip this split
      console.warn(chalk.yellow(`  ⚠ Skipping split of ${split.parentId}: ${err instanceof Error ? err.message : err}`))
    }
  }

  for (const merge of plan.merges) {
    try {
      result = mergeFeatures(result, merge.featureIds, merge.result)
    } catch (err) {
      console.warn(chalk.yellow(`  ⚠ Skipping merge: ${err instanceof Error ? err.message : err}`))
    }
  }

  const reorderSpecs: ReorderSpec[] = plan.reorders.map(r => ({
    featureId: r.featureId,
    newPriority: r.newPriority,
  }))
  result = reorderFeaturePriorities(result, reorderSpecs)

  return result
}

export interface RefinementSessionOptions {
  /** If true, don't ask for confirmation — apply changes automatically */
  nonInteractive?: boolean
  /** Provide failure counts from outside (tests / CI) */
  failureCounts?: Map<string, number>
}

/**
 * Run an interactive (or non-interactive) refinement session using Claude.
 *
 * Reads the current features.json, analyses failure patterns, asks Claude for
 * a refinement plan, shows the plan to the user, and (optionally) applies it.
 */
export async function runRefinementSession(
  projectDir: string,
  opts: RefinementSessionOptions = {},
): Promise<void> {
  const featuresData = await readFeaturesFile(projectDir)
  const failureCounts = opts.failureCounts ?? buildFailureMap(projectDir)

  const passingFeatures = featuresData.features.filter(f => f.passes)
  const pendingFeatures = featuresData.features.filter(f => !f.passes)

  console.log(chalk.bold.cyan('\n  Quest Feature Refinement'))
  console.log(chalk.gray(`  ${passingFeatures.length} passing, ${pendingFeatures.length} pending features`))
  if (failureCounts.size > 0) {
    console.log(chalk.gray(`  ${failureCounts.size} features with failure history`))
  }
  console.log()

  // Build context for Claude
  const featureSummary = featuresData.features.map(f => ({
    id: f.id,
    name: f.name,
    description: f.description,
    priority: f.priority,
    passes: f.passes,
    criteriaCount: f.acceptanceCriteria.length,
    acceptanceCriteria: f.acceptanceCriteria,
    failureCount: failureCounts.get(f.id) ?? 0,
  }))

  const prompt = `Please analyse these features for the project "${featuresData.projectName}" and suggest refinements.

Features (${featuresData.features.length} total, ${passingFeatures.length} passing):
${JSON.stringify(featureSummary, null, 2)}

Failure counts by feature (from recent runs):
${failureCounts.size > 0
  ? [...failureCounts.entries()].map(([id, n]) => `  ${id}: ${n} failure(s)`).join('\n')
  : '  (no failure history available)'}

Remember: never modify features where passes:true.`

  console.log(chalk.blue('  Analysing features with Claude...'))

  const client = new Anthropic()
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    system: REFINEMENT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  })

  const responseText = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')

  const plan = extractRefinementPlan(responseText)
  if (!plan) {
    // Claude didn't produce a structured plan — show raw response
    console.log(chalk.yellow('\n  Claude did not produce a structured refinement plan.'))
    console.log(chalk.gray('  Response:'))
    console.log(chalk.gray('  ' + responseText.split('\n').join('\n  ')))
    return
  }

  printRefinementPlan(plan, featuresData.features)

  const hasSplits = plan.splits.length > 0
  const hasMerges = plan.merges.length > 0
  const hasReorders = plan.reorders.length > 0

  if (!hasSplits && !hasMerges && !hasReorders) {
    return
  }

  // Ask for confirmation unless running non-interactively
  if (!opts.nonInteractive) {
    const rl = readline.createInterface({ input, output, terminal: true })
    try {
      const answer = await rl.question(
        chalk.yellow('  Apply these refinements? ') +
        chalk.gray('[yes / no]: ')
      )
      rl.close()
      if (!['yes', 'y', 'ok', 'apply', 'yep'].includes(answer.trim().toLowerCase())) {
        console.log(chalk.gray('\n  Refinements cancelled.\n'))
        return
      }
    } catch {
      rl.close()
      return
    }
  }

  // Apply the refinement plan
  const refinedFeatures = applyRefinementPlan(featuresData.features, plan)
  const updatedData: FeaturesFile = {
    ...featuresData,
    features: refinedFeatures,
    generatedAt: new Date().toISOString(),
  }
  await writeFeaturesFile(projectDir, updatedData)

  const added = refinedFeatures.length - featuresData.features.length
  const addedStr = added > 0 ? `+${added}` : String(added)
  console.log(chalk.green(`  ✓ Refinements applied — features: ${featuresData.features.length} → ${refinedFeatures.length} (${addedStr})\n`))
}
