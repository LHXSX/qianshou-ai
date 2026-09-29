import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  HOST_SIDE_MATCHING,
  HOST_SIDE_MATCHING_KINDS,
  helloUnionCapabilityIds,
  softwareNamesProveCapability,
} from '../src/host-side-matching.ts'

/**
 * Vocabulary lock (QS-07): the production `ComputeCapabilityId('…')` literals under
 * `packages/*\/*\/src` must overlap the semantic registry by exactly the pinned
 * number. The number may only grow; when a literal adopts a registry name, raise
 * INTERSECTION_BASELINE deliberately instead of loosening this file.
 */
const INTERSECTION_BASELINE = 2
/** Literals that name no registry capability today; a new one here is a new vocabulary fork. */
// The reviewed, private Mac video trial is local-only and intentionally absent
// from the Shanghai dispatch registry. Keep it explicit so new forks still fail.
const OUT_OF_REGISTRY_BASELINE: string[] = ['video.drawn-mac-5s']

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const REGISTRY = JSON.parse(readFileSync(join(ROOT, 'contracts/v1/capabilities.registry.json'), 'utf8')) as {
  capabilities: { capability: string; implementations: { package_names: string[] }[] }[]
}
const LITERAL = /ComputeCapabilityId\(\s*(['"`])([^'"`]+)\1\s*\)/g

/** Every `packages/<group>/<pkg>/src/**\/*.ts|tsx` file; build outputs and node_modules never sit under `src`. */
function productionSources(): string[] {
  const files: string[] = []
  for (const group of readdirSync(join(ROOT, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const pkg of readdirSync(join(ROOT, 'packages', group.name), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      const src = join(ROOT, 'packages', group.name, pkg.name, 'src')
      let entries: string[]
      try {
        entries = readdirSync(src, { recursive: true, encoding: 'utf8' })
      } catch {
        // Only ENOENT: a package without a `src/` tree has no production literals to scan.
        continue
      }
      for (const entry of entries) if (/\.tsx?$/.test(entry)) files.push(join(src, entry))
    }
  }
  return files
}

/** `capability id → source locations` for every production literal. */
function productionLiterals(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const file of productionSources()) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(LITERAL)) {
      const capabilityId = match[2]
      if (capabilityId === undefined) continue
      const line = text.slice(0, match.index).split('\n').length
      const where = `${relative(ROOT, file)}:${line}`
      found.set(capabilityId, [...(found.get(capabilityId) ?? []), where])
    }
  }
  return found
}

describe('capability vocabulary lock', () => {
  const registryNames = new Set(REGISTRY.capabilities.map(row => row.capability))
  const literals = productionLiterals()
  const intersection = [...literals.keys()].filter(id => registryNames.has(id)).sort()
  const outside = [...literals.keys()].filter(id => !registryNames.has(id)).sort()

  it('scans a non-empty production corpus', () => {
    expect(productionSources().length).toBeGreaterThan(100)
    expect(registryNames.size).toBe(27)
  })

  it('production ComputeCapabilityId literals ∩ registry names equals the pinned baseline (only grows)', () => {
    console.log(`QS-07 vocabulary lock: intersection actual=${intersection.length} baseline=${INTERSECTION_BASELINE}`
      + ` · registry=${registryNames.size} · literals=${literals.size} [${[...literals.keys()].sort().join(', ')}]`)
    expect(intersection, `intersection changed to ${intersection.length} (${intersection.join(', ')}); if a literal adopted a registry name, raise INTERSECTION_BASELINE`)
      .toHaveLength(INTERSECTION_BASELINE)
    expect(intersection.length).toBeGreaterThanOrEqual(INTERSECTION_BASELINE)
  })

  it('names every production literal outside the registry, so a new fork cannot appear silently', () => {
    expect(outside, `out-of-registry literals: ${outside.map(id => `${id} @ ${literals.get(id)?.join(', ')}`).join('; ')}`)
      .toEqual(OUT_OF_REGISTRY_BASELINE)
  })

  it('every empty-package_names capability declares how matching learns it', () => {
    const empty = [...new Set(
      REGISTRY.capabilities.flatMap(row =>
        row.implementations.some(impl => impl.package_names.length === 0) ? [row.capability] : [],
      ),
    )].sort()
    expect(empty, 'a new empty-package_names capability must be added to HOST_SIDE_MATCHING').toEqual(
      Object.keys(HOST_SIDE_MATCHING).sort(),
    )
    for (const kind of Object.values(HOST_SIDE_MATCHING)) {
      expect(HOST_SIDE_MATCHING_KINDS, `unknown matching kind ${kind}`).toContain(kind)
    }
    expect(HOST_SIDE_MATCHING['accelerator.gpu']).toBe('placement-probe')
    expect(HOST_SIDE_MATCHING['text.transform']).toBe('hello-union')
    expect(HOST_SIDE_MATCHING['image.generate']).toBe('plugin-hello')
    expect(HOST_SIDE_MATCHING['media.compose']).toBe('local-service')
    expect(softwareNamesProveCapability('text.transform'), 'python3 must not prove hello-union').toBe(false)
    expect(softwareNamesProveCapability('media.transcode')).toBe(true)
    expect(softwareNamesProveCapability('llm.generate.local')).toBe(false)
    expect(softwareNamesProveCapability('unknown.capability')).toBe(false)
    expect(helloUnionCapabilityIds()).toEqual(['text.transform'])
  })

  it('keeps retired catalogue names out of package and app fixtures', () => {
    const retired = ['image', 'batch'].join('.')
    const hits: string[] = []
    const trees: string[] = []
    for (const group of readdirSync(join(ROOT, 'packages'), { withFileTypes: true })) {
      if (group.isDirectory()) trees.push(join('packages', group.name))
    }
    trees.push('apps')
    for (const tree of trees) {
      let packages: string[]
      try {
        packages = readdirSync(join(ROOT, tree), { encoding: 'utf8' })
      } catch {
        continue
      }
      for (const pkg of packages) {
        const tests = join(ROOT, tree, pkg, 'tests')
        let entries: string[]
        try {
          entries = readdirSync(tests, { recursive: true, encoding: 'utf8' })
        } catch {
          continue
        }
        for (const entry of entries) {
          if (!/\.(?:ts|mjs|tsx)$/.test(entry)) continue
          const file = join(tests, entry)
          const text = readFileSync(file, 'utf8')
          if (!text.includes(retired)) continue
          const line = text.split('\n').findIndex(row => row.includes(retired)) + 1
          hits.push(`${relative(ROOT, file)}:${line}`)
        }
      }
    }
    expect(hits, `retired fixture ${retired} still in ${hits.join(', ')}`).toEqual([])
  })
})
