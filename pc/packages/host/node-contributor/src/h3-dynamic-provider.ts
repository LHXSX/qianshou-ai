/** Reload owner-scoped H3 configuration without reusing readiness from another revision. */
import { createHash } from 'node:crypto'
import { ComputeError } from '@deepseek-ai/dsh-compute-core'
import { createH3VideoProvider, readH3BoundedFile, type H3VideoReadiness } from './h3-video.ts'
import { createH3VideoProviderV2 } from './h3-video-v2.ts'
import { createH3CanonicalProvider } from './h3-canonical-provider.ts'
import { readOwnedH3ExecutionPermit, type OwnedH3ExecutionPermit } from './native-h3-publication.ts'
import type { ArtifactOrderAdapter } from './artifact-order.ts'
import { readOwnedNativeH3ReviewExecutionPermit, type OwnedNativeH3ReviewExecutionPermit } from './native-h3-review.ts'

/** Host-resolved configuration identity; clients cannot choose this scope or revision. */
export interface H3ProviderConfiguration {
  readonly path: string
  readonly identity: string
}

/** Configuration comes from the current account; provider factories never start a GPU trial. */
export interface DynamicH3ProviderOptions {
  readonly resolveConfiguration: () => Promise<H3ProviderConfiguration | null>
  readonly onChanged: () => void
  /** Fresh new-work admission; pure identity rechecks and existing results do not use this gate. */
  readonly assertNewExecution?: () => Promise<void>
  readonly createV1?: typeof createH3VideoProvider
  readonly createV2?: typeof createH3VideoProviderV2
  readonly createCanonical?: typeof createH3CanonicalProvider
}

interface Snapshot {
  readonly key: string
  readonly generation: 'v1' | 'v2' | 'canonical'
  readonly v1: ReturnType<typeof createH3VideoProvider>
  readonly v2: ReturnType<typeof createH3VideoProviderV2>
  readonly canonical: ReturnType<typeof createH3CanonicalProvider>
}

interface DynamicH3VideoProvider {
  invalidate(configured?: boolean): void
  status(): H3VideoReadiness
  refreshStatus(): Promise<H3VideoReadiness>
  nativeAuthorBinding: ReturnType<typeof createH3VideoProvider>['nativeAuthorBinding']
  nativeAuthorBindingV2: ReturnType<typeof createH3VideoProviderV2>['nativeAuthorBindingV2']
  nativeAuthorBindingCanonical: ReturnType<typeof createH3CanonicalProvider>['nativeAuthorBindingCanonical']
  nativeAuthorBindingCurrent(): Promise<Awaited<ReturnType<ReturnType<typeof createH3VideoProviderV2>['nativeAuthorBindingV2']>>
    | Awaited<ReturnType<ReturnType<typeof createH3CanonicalProvider>['nativeAuthorBindingCanonical']>>>
  loadAndSelfTest(): Promise<ArtifactOrderAdapter | null>
  loadAndSelfTestV2(): Promise<ArtifactOrderAdapter | null>
  loadAndSelfTestCanonical(): Promise<ArtifactOrderAdapter | null>
  runAdmittedExecution(permit: OwnedH3ExecutionPermit): ReturnType<ArtifactOrderAdapter['run']>
  runReviewedExecution(permit: OwnedNativeH3ReviewExecutionPermit): ReturnType<ArtifactOrderAdapter['run']>
}

function changed(): never { throw new ComputeError('H3_OWNER_CONFIGURATION_CHANGED', 409) }

/** Read the current configuration for each preparation and refuse late completion from an old revision.
 * @param options - Authenticated configuration resolver and fixed provider factories.
 * @returns Separate V1/V2 preparations, a cached status and explicit invalidation.
 */
export function createDynamicH3VideoProvider(options: DynamicH3ProviderOptions): DynamicH3VideoProvider {
  let epoch = 0
  let current: Snapshot | null = null
  const ownedRunners = new WeakMap<ArtifactOrderAdapter, { raw: ArtifactOrderAdapter; key: string }>()
  let observation: H3VideoReadiness = { configured: false, ready: false, code: 'H3_OWNER_CONFIG_NOT_CONFIGURED' }
  const invalidate = (configured = false): void => {
    epoch++
    current = null
    observation = { configured, ready: false, code: configured ? 'H3_NOT_CHECKED' : 'H3_OWNER_CONFIG_NOT_CONFIGURED' }
    options.onChanged()
  }
  const admit = async (): Promise<void> => {
    try { await options.assertNewExecution?.() }
    catch (error) {
      observation = { configured: observation.configured, ready: false,
        code: error instanceof ComputeError ? error.code : 'H3_SETUP_TRIAL_GUARD_INVALID' }
      throw error
    }
  }
  const guarded = (adapter: ArtifactOrderAdapter | null): ArtifactOrderAdapter | null => {
    if (adapter === null || current === null) return null
    const owned = Object.freeze({ ...adapter, async run(input: Parameters<ArtifactOrderAdapter['run']>[0]) {
      await admit(); return adapter.run(input)
    } })
    ownedRunners.set(owned, { raw: adapter, key: current.key })
    return owned
  }
  const read = async (): Promise<Snapshot | null> => {
    const started = epoch
    const location = await options.resolveConfiguration()
    if (started !== epoch) changed()
    if (location === null) {
      if (current !== null || observation.configured) invalidate()
      return null
    }
    const bytes = await readH3BoundedFile(location.path, 16 * 1024)
    const after = await options.resolveConfiguration()
    if (started !== epoch || after?.path !== location.path || after.identity !== location.identity) changed()
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    const schema = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>).schema : undefined
    const generation = schema === 'qianshou.h3-owner.v1' ? 'v1' : schema === 'qianshou.h3-owner.v2' ? 'v2'
      : schema === 'qianshou.h3-owner.canonical.v1' ? 'canonical' : null
    if (generation === null) throw new ComputeError('H3_OWNER_CONFIG_INVALID', 409)
    const key = location.identity + '\0' + location.path + '\0' + createHash('sha256').update(bytes).digest('hex')
    if (current?.key !== key) {
      options.onChanged()
      current = { key, generation, v1: (options.createV1 ?? createH3VideoProvider)(location.path),
        v2: (options.createV2 ?? createH3VideoProviderV2)(location.path),
        canonical: (options.createCanonical ?? createH3CanonicalProvider)(location.path) }
      observation = { configured: true, ready: false, code: 'H3_NOT_CHECKED' }
    }
    return current
  }
  const observe = async <T>(generation: Snapshot['generation'], operation: (snapshot: Snapshot) => Promise<T>): Promise<T> => {
    const started = epoch
    let ownedKey: string | undefined
    let unconfigured = false
    try {
      const initial = await read()
      if (initial === null) { unconfigured = true; throw new ComputeError('H3_OWNER_CONFIG_NOT_CONFIGURED', 409) }
      if (initial.generation !== generation) throw new ComputeError(generation === 'v2'
        ? 'H3_V2_OWNER_CONFIG_REQUIRED' : 'H3_OWNER_CONFIG_INVALID', 409)
      ownedKey = initial.key
      const result = await operation(initial)
      const after = await read()
      if (started !== epoch || after?.key !== initial.key) changed()
      observation = generation === 'v1' ? initial.v1.status() : generation === 'v2' ? initial.v2.status() : initial.canonical.status()
      return result
    } catch (error) {
      if (!unconfigured && started === epoch && (ownedKey === undefined || current?.key === ownedKey)) {
        observation = { configured: current !== null, ready: false,
          code: error instanceof ComputeError ? error.code : 'H3_OWNER_CONFIG_INVALID' }
      }
      throw error
    }
  }
  return {
    invalidate,
    status: (): H3VideoReadiness => ({ ...observation }),
    async refreshStatus(): Promise<H3VideoReadiness> {
      const started = epoch
      try { await admit() }
      catch { return { ...observation } }
      try { await read() }
      catch (error) {
        if (started === epoch) {
          const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT'
          const code = missing ? 'H3_OWNER_CONFIG_NOT_CONFIGURED'
            : error instanceof ComputeError ? error.code : 'H3_OWNER_CONFIG_INVALID'
          const changed = current !== null || observation.configured !== !missing || observation.code !== code
          current = null
          observation = { configured: !missing, ready: false, code }
          if (changed) options.onChanged()
        }
      }
      return { ...observation }
    },
    nativeAuthorBinding: () => observe('v1', snapshot => snapshot.v1.nativeAuthorBinding()),
    nativeAuthorBindingV2: () => observe('v2', snapshot => snapshot.v2.nativeAuthorBindingV2()),
    nativeAuthorBindingCanonical: () => observe('canonical', snapshot => snapshot.canonical.nativeAuthorBindingCanonical()),
    async nativeAuthorBindingCurrent() {
      const snapshot = await read()
      if (snapshot?.generation === 'canonical') return observe('canonical', value => value.canonical.nativeAuthorBindingCanonical())
      if (snapshot?.generation === 'v2') return observe('v2', value => value.v2.nativeAuthorBindingV2())
      throw new ComputeError('H3_V2_OWNER_CONFIG_REQUIRED', 409)
    },
    async runAdmittedExecution(permit) {
      const facts = readOwnedH3ExecutionPermit(permit)
      const runner = ownedRunners.get(facts.runtime)
      if (facts.state !== 'executing' || runner === undefined) throw new ComputeError('H3_NATIVE_SELECTION_INVALID', 409)
      const started = epoch
      if ((await read())?.key !== runner.key || epoch !== started) changed()
      const result = await runner.raw.run(facts.input)
      if ((await read())?.key !== runner.key || epoch !== started) changed()
      return result
    },
    async runReviewedExecution(permit) {
      const facts = readOwnedNativeH3ReviewExecutionPermit(permit)
      const runner = ownedRunners.get(facts.runtime)
      if (facts.state !== 'executing' || runner === undefined) throw new ComputeError('H3_REVIEW_EXECUTION_REFUSED', 409)
      const started = epoch
      if ((await read())?.key !== runner.key || epoch !== started) changed()
      const result = await runner.raw.run(facts.input)
      if ((await read())?.key !== runner.key || epoch !== started) changed()
      return result
    },
    async loadAndSelfTest() {
      try {
        await admit()
        if ((await read())?.generation !== 'v1') return null
        return guarded(await observe('v1', snapshot => snapshot.v1.loadAndSelfTest()))
      } catch { await this.refreshStatus(); return null }
    },
    async loadAndSelfTestV2() {
      try {
        await admit()
        if ((await read())?.generation !== 'v2') return null
        return guarded(await observe('v2', snapshot => snapshot.v2.loadAndSelfTestV2()))
      } catch { await this.refreshStatus(); return null }
    },
    async loadAndSelfTestCanonical() {
      try {
        await admit()
        if ((await read())?.generation !== 'canonical') return null
        return guarded(await observe('canonical', snapshot => snapshot.canonical.loadAndSelfTestCanonical()))
      } catch { await this.refreshStatus(); return null }
    },
  }
}
