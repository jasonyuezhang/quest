/**
 * Tests for the feature refinement module (planner-feature-refinement-14).
 */

import { describe, it, expect } from 'vitest'
import type { Feature } from '../../src/agents/types.js'
import {
  splitFeature,
  mergeFeatures,
  reorderFeaturePriorities,
  applyRefinementPlan,
} from '../../src/refiner.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFeature(overrides: Partial<Feature> & { id: string }): Feature {
  return {
    name: overrides.id,
    description: `${overrides.id} description`,
    category: 'api',
    priority: 'medium',
    acceptanceCriteria: ['criterion 1', 'criterion 2'],
    passes: false,
    ...overrides,
  }
}

const SAMPLE_FEATURES: Feature[] = [
  makeFeature({ id: 'feature-a', priority: 'high', acceptanceCriteria: ['a1', 'a2', 'a3', 'a4', 'a5'] }),
  makeFeature({ id: 'feature-b', priority: 'medium', acceptanceCriteria: ['b1', 'b2'] }),
  makeFeature({ id: 'feature-c', priority: 'low', acceptanceCriteria: ['c1'] }),
  makeFeature({ id: 'feature-d', priority: 'high', passes: true, acceptanceCriteria: ['d1', 'd2'] }),
]

// ---------------------------------------------------------------------------
// splitFeature
// ---------------------------------------------------------------------------

describe('splitFeature', () => {
  it('replaces a feature with sub-features using parent ID as prefix', () => {
    const result = splitFeature([...SAMPLE_FEATURES], 'feature-a', [
      { idSuffix: 'part-1', name: 'Part One', description: 'First part', acceptanceCriteria: ['a1', 'a2'], priority: 'high' },
      { idSuffix: 'part-2', name: 'Part Two', description: 'Second part', acceptanceCriteria: ['a3', 'a4', 'a5'], priority: 'medium' },
    ])

    expect(result.find(f => f.id === 'feature-a')).toBeUndefined()
    expect(result.find(f => f.id === 'feature-a-part-1')).toBeDefined()
    expect(result.find(f => f.id === 'feature-a-part-2')).toBeDefined()
  })

  it('sets refinedFrom to parent ID on sub-features', () => {
    const result = splitFeature([...SAMPLE_FEATURES], 'feature-a', [
      { idSuffix: 'x', name: 'X', description: 'X', acceptanceCriteria: ['x1'], priority: 'high' },
      { idSuffix: 'y', name: 'Y', description: 'Y', acceptanceCriteria: ['y1'], priority: 'low' },
    ])
    const sub = result.filter(f => f.refinedFrom === 'feature-a')
    expect(sub).toHaveLength(2)
    expect(sub.every(f => f.refinedAction === 'split')).toBe(true)
  })

  it('inherits category from parent when not specified', () => {
    const parent = makeFeature({ id: 'feat', category: 'auth' })
    const result = splitFeature([parent], 'feat', [
      { idSuffix: '1', name: 'Sub 1', description: 'D', acceptanceCriteria: ['c'], priority: 'high' },
      { idSuffix: '2', name: 'Sub 2', description: 'D', acceptanceCriteria: ['c'], priority: 'low' },
    ])
    expect(result[0]?.category).toBe('auth')
    expect(result[1]?.category).toBe('auth')
  })

  it('preserves sub-features as passes:false', () => {
    const result = splitFeature([...SAMPLE_FEATURES], 'feature-a', [
      { idSuffix: 'p1', name: 'P1', description: 'D', acceptanceCriteria: ['c'], priority: 'high' },
      { idSuffix: 'p2', name: 'P2', description: 'D', acceptanceCriteria: ['c'], priority: 'low' },
    ])
    const subs = result.filter(f => f.id.startsWith('feature-a-'))
    expect(subs.every(f => f.passes === false)).toBe(true)
  })

  it('throws when trying to split a passing feature', () => {
    expect(() =>
      splitFeature([...SAMPLE_FEATURES], 'feature-d', [
        { idSuffix: 'a', name: 'A', description: 'D', acceptanceCriteria: ['c'], priority: 'high' },
        { idSuffix: 'b', name: 'B', description: 'D', acceptanceCriteria: ['c'], priority: 'low' },
      ])
    ).toThrow('Cannot split a passing feature')
  })

  it('throws when feature is not found', () => {
    expect(() =>
      splitFeature([...SAMPLE_FEATURES], 'nonexistent', [
        { idSuffix: 'a', name: 'A', description: 'D', acceptanceCriteria: ['c'], priority: 'high' },
        { idSuffix: 'b', name: 'B', description: 'D', acceptanceCriteria: ['c'], priority: 'low' },
      ])
    ).toThrow('Feature not found')
  })

  it('throws when fewer than 2 sub-features provided', () => {
    expect(() =>
      splitFeature([...SAMPLE_FEATURES], 'feature-a', [
        { idSuffix: 'only', name: 'Only', description: 'D', acceptanceCriteria: ['c'], priority: 'high' },
      ])
    ).toThrow('at least 2 sub-features')
  })

  it('preserves all other features unchanged', () => {
    const result = splitFeature([...SAMPLE_FEATURES], 'feature-a', [
      { idSuffix: 'x', name: 'X', description: 'D', acceptanceCriteria: ['c'], priority: 'high' },
      { idSuffix: 'y', name: 'Y', description: 'D', acceptanceCriteria: ['c'], priority: 'low' },
    ])
    expect(result.find(f => f.id === 'feature-b')).toBeDefined()
    expect(result.find(f => f.id === 'feature-c')).toBeDefined()
    expect(result.find(f => f.id === 'feature-d')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// mergeFeatures
// ---------------------------------------------------------------------------

describe('mergeFeatures', () => {
  it('combines acceptance criteria from all merged features', () => {
    const result = mergeFeatures([...SAMPLE_FEATURES], ['feature-b', 'feature-c'], {
      id: 'feature-bc',
      name: 'BC Combined',
      description: 'B and C merged',
      priority: 'medium',
    })
    const merged = result.find(f => f.id === 'feature-bc')
    expect(merged).toBeDefined()
    expect(merged?.acceptanceCriteria).toContain('b1')
    expect(merged?.acceptanceCriteria).toContain('b2')
    expect(merged?.acceptanceCriteria).toContain('c1')
  })

  it('deduplicates acceptance criteria', () => {
    const fa = makeFeature({ id: 'fa', acceptanceCriteria: ['shared', 'unique-a'] })
    const fb = makeFeature({ id: 'fb', acceptanceCriteria: ['shared', 'unique-b'] })
    const result = mergeFeatures([fa, fb], ['fa', 'fb'], {
      id: 'merged',
      name: 'Merged',
      description: 'D',
      priority: 'low',
    })
    const merged = result.find(f => f.id === 'merged')
    const sharedCount = merged?.acceptanceCriteria.filter(c => c === 'shared').length ?? 0
    expect(sharedCount).toBe(1)
  })

  it('sets refinedFrom to comma-separated source IDs', () => {
    const result = mergeFeatures([...SAMPLE_FEATURES], ['feature-b', 'feature-c'], {
      id: 'feature-bc',
      name: 'BC',
      description: 'D',
      priority: 'medium',
    })
    const merged = result.find(f => f.id === 'feature-bc')
    expect(merged?.refinedFrom).toBe('feature-b,feature-c')
    expect(merged?.refinedAction).toBe('merge')
  })

  it('removes source features from the list', () => {
    const result = mergeFeatures([...SAMPLE_FEATURES], ['feature-b', 'feature-c'], {
      id: 'feature-bc',
      name: 'BC',
      description: 'D',
      priority: 'medium',
    })
    expect(result.find(f => f.id === 'feature-b')).toBeUndefined()
    expect(result.find(f => f.id === 'feature-c')).toBeUndefined()
    expect(result.find(f => f.id === 'feature-bc')).toBeDefined()
  })

  it('throws when trying to merge a passing feature', () => {
    expect(() =>
      mergeFeatures([...SAMPLE_FEATURES], ['feature-b', 'feature-d'], {
        id: 'merged',
        name: 'M',
        description: 'D',
        priority: 'low',
      })
    ).toThrow('Cannot merge a passing feature')
  })

  it('throws when fewer than 2 feature IDs provided', () => {
    expect(() =>
      mergeFeatures([...SAMPLE_FEATURES], ['feature-b'], {
        id: 'merged',
        name: 'M',
        description: 'D',
        priority: 'low',
      })
    ).toThrow('at least 2 features')
  })

  it('throws when a feature is not found', () => {
    expect(() =>
      mergeFeatures([...SAMPLE_FEATURES], ['feature-b', 'nonexistent'], {
        id: 'merged',
        name: 'M',
        description: 'D',
        priority: 'low',
      })
    ).toThrow('Feature not found')
  })

  it('preserves passing features untouched', () => {
    const result = mergeFeatures([...SAMPLE_FEATURES], ['feature-b', 'feature-c'], {
      id: 'feature-bc',
      name: 'BC',
      description: 'D',
      priority: 'medium',
    })
    const passing = result.find(f => f.id === 'feature-d')
    expect(passing?.passes).toBe(true)
    expect(passing?.refinedFrom).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// reorderFeaturePriorities
// ---------------------------------------------------------------------------

describe('reorderFeaturePriorities', () => {
  it('updates priority for specified features', () => {
    const result = reorderFeaturePriorities([...SAMPLE_FEATURES], [
      { featureId: 'feature-a', newPriority: 'low' },
      { featureId: 'feature-b', newPriority: 'high' },
    ])
    expect(result.find(f => f.id === 'feature-a')?.priority).toBe('low')
    expect(result.find(f => f.id === 'feature-b')?.priority).toBe('high')
  })

  it('never changes passing features', () => {
    const result = reorderFeaturePriorities([...SAMPLE_FEATURES], [
      { featureId: 'feature-d', newPriority: 'low' },
    ])
    expect(result.find(f => f.id === 'feature-d')?.priority).toBe('high')
    expect(result.find(f => f.id === 'feature-d')?.refinedFrom).toBeUndefined()
  })

  it('sets refinedAction to reorder', () => {
    const result = reorderFeaturePriorities([...SAMPLE_FEATURES], [
      { featureId: 'feature-a', newPriority: 'low' },
    ])
    expect(result.find(f => f.id === 'feature-a')?.refinedAction).toBe('reorder')
  })

  it('leaves unspecified features unchanged', () => {
    const result = reorderFeaturePriorities([...SAMPLE_FEATURES], [
      { featureId: 'feature-a', newPriority: 'low' },
    ])
    expect(result.find(f => f.id === 'feature-b')?.priority).toBe('medium')
    expect(result.find(f => f.id === 'feature-b')?.refinedAction).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// applyRefinementPlan
// ---------------------------------------------------------------------------

describe('applyRefinementPlan', () => {
  it('applies splits, merges, and reorders in sequence', () => {
    const features: Feature[] = [
      makeFeature({ id: 'big-feat', priority: 'high', acceptanceCriteria: ['x', 'y', 'z'] }),
      makeFeature({ id: 'small-a', priority: 'low', acceptanceCriteria: ['s1'] }),
      makeFeature({ id: 'small-b', priority: 'low', acceptanceCriteria: ['s2'] }),
      makeFeature({ id: 'flaky', priority: 'high', acceptanceCriteria: ['f1'] }),
    ]

    const result = applyRefinementPlan(features, {
      splits: [
        {
          parentId: 'big-feat',
          subFeatures: [
            { idSuffix: 'part-1', name: 'Big Part 1', description: 'D', acceptanceCriteria: ['x'], priority: 'high' },
            { idSuffix: 'part-2', name: 'Big Part 2', description: 'D', acceptanceCriteria: ['y', 'z'], priority: 'medium' },
          ],
        },
      ],
      merges: [
        {
          featureIds: ['small-a', 'small-b'],
          result: { id: 'small-combined', name: 'Small Combined', description: 'D', priority: 'low' },
        },
      ],
      reorders: [
        { featureId: 'flaky', newPriority: 'low' },
      ],
    })

    expect(result.find(f => f.id === 'big-feat')).toBeUndefined()
    expect(result.find(f => f.id === 'big-feat-part-1')).toBeDefined()
    expect(result.find(f => f.id === 'big-feat-part-2')).toBeDefined()
    expect(result.find(f => f.id === 'small-a')).toBeUndefined()
    expect(result.find(f => f.id === 'small-b')).toBeUndefined()
    expect(result.find(f => f.id === 'small-combined')).toBeDefined()
    expect(result.find(f => f.id === 'flaky')?.priority).toBe('low')
  })

  it('skips operations that would affect passing features', () => {
    const features: Feature[] = [
      makeFeature({ id: 'passing-feat', passes: true, acceptanceCriteria: ['p1'] }),
      makeFeature({ id: 'other', passes: false, acceptanceCriteria: ['o1'] }),
    ]

    const result = applyRefinementPlan(features, {
      splits: [
        {
          parentId: 'passing-feat',
          subFeatures: [
            { idSuffix: 'x', name: 'X', description: 'D', acceptanceCriteria: ['p1'], priority: 'high' },
            { idSuffix: 'y', name: 'Y', description: 'D', acceptanceCriteria: ['p1'], priority: 'low' },
          ],
        },
      ],
      merges: [],
      reorders: [],
    })

    // passing-feat should remain unchanged (split was skipped)
    expect(result.find(f => f.id === 'passing-feat')).toBeDefined()
    expect(result.find(f => f.id === 'passing-feat-x')).toBeUndefined()
  })

  it('returns original features when plan has no changes', () => {
    const result = applyRefinementPlan([...SAMPLE_FEATURES], {
      splits: [],
      merges: [],
      reorders: [],
    })
    expect(result).toHaveLength(SAMPLE_FEATURES.length)
  })
})
