/**
 * DAG-based adaptive scheduler for the Quest harness.
 *
 * Builds a dependency graph from features, computes topological levels and
 * critical path, then plans batches that maximize parallelism while respecting
 * dependency constraints.
 *
 * All functions are pure (no side effects) and O(V+E) where V = features,
 * E = dependency edges.
 */

import type { Feature } from './agents/types.js'

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

export interface DAGNode {
  feature: Feature
  /** Topological level (0 = no dependencies) */
  level: number
  /** Feature IDs this depends on */
  dependsOn: Set<string>
  /** Feature IDs that depend on this */
  dependents: Set<string>
  /** Estimated wall-clock time in ms (from history or heuristic) */
  estimatedDurationMs: number
  /** Own duration + max downstream weight (for critical path) */
  criticalPathWeight: number
  /** Whether this node is on the critical path */
  onCriticalPath: boolean
}

export interface DAG {
  nodes: Map<string, DAGNode>
  /** Level number → feature IDs at that level */
  levels: Map<number, string[]>
  /** Ordered feature IDs on the longest (critical) path */
  criticalPath: string[]
  maxLevel: number
  /** Width of the widest level — max useful parallelism */
  maxParallelism: number
}

export interface BatchPlan {
  features: Feature[]
  workerCount: number
  /** Human-readable explanation for logging */
  reason: string
}

export interface TimeEstimate {
  estimatedMs: number
  criticalPathMs: number
  /** Ratio of critical path time to estimated time (1.0 = fully serial) */
  parallelEfficiency: number
}

/** Historical duration data from previous runs */
export interface FeatureHistory {
  featureId: string
  durationMs: number
}

// ---------------------------------------------------------------------------
// DAG construction
// ---------------------------------------------------------------------------

const DURATION_PER_CRITERION_MS = 90_000 // 90s baseline per acceptance criterion

/**
 * Build a dependency DAG from a feature list.
 *
 * Uses Kahn's algorithm for topological sort + cycle detection.
 * Assigns levels during the sort, then computes critical path weights
 * via reverse-topological pass.
 *
 * @throws Error if the dependency graph contains a cycle
 * @throws Error if a dependsOn references a non-existent feature ID
 */
export function buildDAG(features: Feature[], history?: FeatureHistory[]): DAG {
  const historyMap = new Map<string, number>()
  if (history) {
    for (const h of history) {
      historyMap.set(h.featureId, h.durationMs)
    }
  }

  // Build adjacency lists
  const nodes = new Map<string, DAGNode>()
  const featureIds = new Set(features.map(f => f.id))

  for (const feature of features) {
    nodes.set(feature.id, {
      feature,
      level: 0,
      dependsOn: new Set<string>(),
      dependents: new Set<string>(),
      estimatedDurationMs:
        historyMap.get(feature.id) ??
        feature.acceptanceCriteria.length * DURATION_PER_CRITERION_MS,
      criticalPathWeight: 0,
      onCriticalPath: false,
    })
  }

  // Wire up edges
  for (const feature of features) {
    if (!feature.dependsOn?.length) continue
    const node = nodes.get(feature.id)!

    for (const depId of feature.dependsOn) {
      if (!featureIds.has(depId)) {
        throw new Error(
          `Feature "${feature.id}" depends on "${depId}" which does not exist in features.json`,
        )
      }
      node.dependsOn.add(depId)
      nodes.get(depId)!.dependents.add(feature.id)
    }
  }

  // Kahn's algorithm: topological sort + level assignment
  const inDegree = new Map<string, number>()
  for (const [id, node] of nodes) {
    inDegree.set(id, node.dependsOn.size)
  }

  // Seed queue with nodes that have no dependencies
  const queue: string[] = []
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id)
  }

  const sorted: string[] = []
  const levels = new Map<number, string[]>()

  while (queue.length > 0) {
    const id = queue.shift()!
    sorted.push(id)

    const node = nodes.get(id)!

    // Assign level: max(dependency levels) + 1, or 0 if no deps
    if (node.dependsOn.size === 0) {
      node.level = 0
    } else {
      let maxDepLevel = 0
      for (const depId of node.dependsOn) {
        maxDepLevel = Math.max(maxDepLevel, nodes.get(depId)!.level)
      }
      node.level = maxDepLevel + 1
    }

    // Track levels
    const levelFeatures = levels.get(node.level) ?? []
    levelFeatures.push(id)
    levels.set(node.level, levelFeatures)

    // Reduce in-degree for dependents
    for (const depId of node.dependents) {
      const newDeg = inDegree.get(depId)! - 1
      inDegree.set(depId, newDeg)
      if (newDeg === 0) queue.push(depId)
    }
  }

  // Cycle detection: if we didn't visit all nodes, there's a cycle
  if (sorted.length !== features.length) {
    const unvisited = features
      .filter(f => !sorted.includes(f.id))
      .map(f => f.id)
    throw new Error(
      `Dependency cycle detected involving features: ${unvisited.join(', ')}. ` +
        'Remove circular dependsOn references to proceed.',
    )
  }

  // Compute critical path weights (reverse topological order)
  for (let i = sorted.length - 1; i >= 0; i--) {
    const node = nodes.get(sorted[i])!
    let maxChildWeight = 0

    for (const depId of node.dependents) {
      const child = nodes.get(depId)!
      maxChildWeight = Math.max(maxChildWeight, child.criticalPathWeight)
    }

    node.criticalPathWeight = node.estimatedDurationMs + maxChildWeight
  }

  // Trace critical path: start from the node with highest weight, follow heaviest child
  const criticalPath = traceCriticalPath(nodes, sorted)

  // Mark critical path nodes
  const criticalSet = new Set(criticalPath)
  for (const id of criticalPath) {
    nodes.get(id)!.onCriticalPath = true
  }

  const maxLevel = Math.max(...Array.from(levels.keys()), 0)
  const maxParallelism = Math.max(
    ...Array.from(levels.values()).map(ids => ids.length),
    1,
  )

  return { nodes, levels, criticalPath, maxLevel, maxParallelism }
}

/**
 * Trace the critical path by starting from the root with highest weight
 * and following the heaviest dependent at each step.
 */
function traceCriticalPath(nodes: Map<string, DAGNode>, sorted: string[]): string[] {
  if (sorted.length === 0) return []

  // Find the root (level 0) with highest critical path weight
  let startId = sorted[0]
  let maxWeight = 0

  for (const [id, node] of nodes) {
    if (node.dependsOn.size === 0 && node.criticalPathWeight > maxWeight) {
      maxWeight = node.criticalPathWeight
      startId = id
    }
  }

  const path: string[] = [startId]
  let current = nodes.get(startId)!

  while (current.dependents.size > 0) {
    let heaviestId = ''
    let heaviestWeight = -1

    for (const depId of current.dependents) {
      const child = nodes.get(depId)!
      if (child.criticalPathWeight > heaviestWeight) {
        heaviestWeight = child.criticalPathWeight
        heaviestId = depId
      }
    }

    if (!heaviestId) break
    path.push(heaviestId)
    current = nodes.get(heaviestId)!
  }

  return path
}

// ---------------------------------------------------------------------------
// Batch planning
// ---------------------------------------------------------------------------

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 }

/**
 * Get features that are ready to execute: dependencies met, not in-flight,
 * not completed. Sorted by critical path membership, then weight, then priority.
 */
export function getReadyFeatures(
  dag: DAG,
  completed: ReadonlySet<string>,
  inFlight: ReadonlySet<string>,
): Feature[] {
  const ready: DAGNode[] = []

  for (const [id, node] of dag.nodes) {
    if (node.feature.passes) continue
    if (completed.has(id)) continue
    if (inFlight.has(id)) continue

    // All dependencies must be completed
    let allDepsMet = true
    for (const depId of node.dependsOn) {
      if (!completed.has(depId) && !dag.nodes.get(depId)!.feature.passes) {
        allDepsMet = false
        break
      }
    }

    if (allDepsMet) ready.push(node)
  }

  // Sort: critical path first, then by weight descending, then by priority
  ready.sort((a, b) => {
    // Critical path nodes first
    if (a.onCriticalPath !== b.onCriticalPath) {
      return a.onCriticalPath ? -1 : 1
    }
    // Higher critical path weight first (more downstream work depends on this)
    if (a.criticalPathWeight !== b.criticalPathWeight) {
      return b.criticalPathWeight - a.criticalPathWeight
    }
    // Higher priority first
    return (PRIORITY_ORDER[a.feature.priority] ?? 2) - (PRIORITY_ORDER[b.feature.priority] ?? 2)
  })

  return ready.map(n => n.feature)
}

/**
 * Plan the next batch of features to dispatch.
 *
 * Returns up to `maxConcurrency - inFlight.size` features from the ready set.
 * The scheduler self-limits: if only 2 features are ready, only 2 workers run
 * even if maxConcurrency is 8.
 */
export function planNextBatch(
  dag: DAG,
  completed: ReadonlySet<string>,
  inFlight: ReadonlySet<string>,
  maxConcurrency: number,
): BatchPlan {
  const ready = getReadyFeatures(dag, completed, inFlight)
  const availableSlots = maxConcurrency - inFlight.size
  const workerCount = Math.min(ready.length, Math.max(availableSlots, 0))
  const features = ready.slice(0, workerCount)

  const criticalInBatch = features.filter(f => dag.nodes.get(f.id)!.onCriticalPath)
  const criticalNote = criticalInBatch.length > 0
    ? `, critical path: ${criticalInBatch.map(f => f.id).join(', ')}`
    : ''

  const reason = workerCount === 0
    ? `0 features ready (${inFlight.size} in-flight, waiting for dependencies)`
    : `${ready.length} ready, dispatching ${workerCount} (${inFlight.size} in-flight${criticalNote})`

  return { features, workerCount, reason }
}

/**
 * Find features that become unblocked when a given feature completes.
 */
export function getNewlyUnblocked(
  dag: DAG,
  completedFeatureId: string,
  completed: ReadonlySet<string>,
  inFlight: ReadonlySet<string>,
): string[] {
  const node = dag.nodes.get(completedFeatureId)
  if (!node) return []

  const unblocked: string[] = []

  for (const depId of node.dependents) {
    const dependent = dag.nodes.get(depId)!
    if (dependent.feature.passes || completed.has(depId) || inFlight.has(depId)) continue

    // Check if ALL dependencies of this dependent are now met
    let allMet = true
    for (const d of dependent.dependsOn) {
      if (!completed.has(d) && !dag.nodes.get(d)!.feature.passes) {
        allMet = false
        break
      }
    }

    if (allMet) unblocked.push(depId)
  }

  return unblocked
}

// ---------------------------------------------------------------------------
// Time estimation (for --dry-run)
// ---------------------------------------------------------------------------

/**
 * Simulate the scheduler to estimate total wall-clock time.
 *
 * Walks through the DAG level by level, simulating `maxConcurrency` workers
 * processing features in estimated-duration order.
 */
export function estimateTotalTime(dag: DAG, maxConcurrency: number): TimeEstimate {
  // Critical path time = sum of durations along the critical path (irreducible minimum)
  let criticalPathMs = 0
  for (const id of dag.criticalPath) {
    criticalPathMs += dag.nodes.get(id)!.estimatedDurationMs
  }

  // Simulate scheduling: process features level by level with limited workers
  let totalMs = 0
  const pendingFeatures = new Set<string>()

  for (const [id, node] of dag.nodes) {
    if (!node.feature.passes) pendingFeatures.add(id)
  }

  const completed = new Set<string>()
  // Pre-populate with already-passing features
  for (const [id, node] of dag.nodes) {
    if (node.feature.passes) completed.add(id)
  }

  while (pendingFeatures.size > 0) {
    // Find ready features
    const ready: DAGNode[] = []
    for (const id of pendingFeatures) {
      const node = dag.nodes.get(id)!
      let allMet = true
      for (const depId of node.dependsOn) {
        if (!completed.has(depId)) { allMet = false; break }
      }
      if (allMet) ready.push(node)
    }

    if (ready.length === 0) break // deadlock (shouldn't happen with valid DAG)

    // Sort by critical path weight descending (schedule important features first)
    ready.sort((a, b) => b.criticalPathWeight - a.criticalPathWeight)

    // Take up to maxConcurrency features
    const batch = ready.slice(0, maxConcurrency)

    // Batch wall-clock time = max duration in the batch (they run in parallel)
    const batchTime = Math.max(...batch.map(n => n.estimatedDurationMs))
    totalMs += batchTime

    for (const node of batch) {
      completed.add(node.feature.id)
      pendingFeatures.delete(node.feature.id)
    }
  }

  const parallelEfficiency = totalMs > 0 ? criticalPathMs / totalMs : 1

  return { estimatedMs: totalMs, criticalPathMs, parallelEfficiency }
}

// ---------------------------------------------------------------------------
// DAG visualization (for logging)
// ---------------------------------------------------------------------------

/**
 * Format the DAG as a human-readable summary for console output.
 */
export function formatDAGSummary(dag: DAG, maxConcurrency: number): string {
  const lines: string[] = []

  lines.push(`DAG: ${dag.nodes.size} features, ${dag.maxLevel + 1} levels, max parallelism: ${dag.maxParallelism}`)
  lines.push(`Critical path (${dag.criticalPath.length} features): ${dag.criticalPath.join(' → ')}`)
  lines.push(`Effective workers: min(${dag.maxParallelism} DAG width, ${maxConcurrency} max) = ${Math.min(dag.maxParallelism, maxConcurrency)}`)

  lines.push('')
  for (let level = 0; level <= dag.maxLevel; level++) {
    const ids = dag.levels.get(level) ?? []
    const names = ids.map(id => {
      const node = dag.nodes.get(id)!
      const cp = node.onCriticalPath ? '*' : ' '
      const status = node.feature.passes ? '✓' : '○'
      return `${cp}${status}${id}`
    })
    lines.push(`  L${level}: ${names.join(', ')}`)
  }

  return lines.join('\n')
}
