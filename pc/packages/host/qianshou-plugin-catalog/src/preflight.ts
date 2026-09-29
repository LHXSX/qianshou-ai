/**
 * Ordered install preflight for one market listing: signature, dependencies, model, resources.
 *
 * The run is fail-fast: the first failing step stops it, later steps stay `not-checked`, and the
 * report names the failing step with a stable reason code plus the observed facts. A passed run is
 * the only condition under which the catalog writes a declaration. Nothing here writes files,
 * installs packages or opens the network; the catalog service supplies every observation.
 */
import { createHash } from 'node:crypto'
import type {
  InstallPreflightReport,
  HostCompatibilityCheck,
  MarketListing,
  PreflightActionId,
  PreflightStep,
  PreflightStepId,
} from './types.ts'

/** Check order. A failure leaves every later step `not-checked`. */
export const PREFLIGHT_STEP_IDS: readonly PreflightStepId[] = ['signature', 'dependencies', 'model', 'resources']

/** Choices a failed preflight offers the owner, in the order this host reports them. */
export const PREFLIGHT_ACTION_IDS: readonly PreflightActionId[] = ['fix', 'recheck', 'cancel', 'rollback']

/** Step state for a check that never ran because an earlier step failed. */
export const PREFLIGHT_PENDING_REASON = 'PENDING_EARLIER_STEP'

/** No package is downloaded for a built-in capability declaration. */
export const PREFLIGHT_DECLARATION_ONLY_REASON = 'DECLARATION_ONLY'

/** Longest observed-fact string one step reports. Longer facts are truncated. */
const MAX_DETAIL = 200

/** Verdict of a publisher signature check against the operator's trusted keys. */
export type SignatureVerdict = 'valid' | 'invalid' | 'unknown-publisher'

/** Facts the preflight reads. The catalog service owns how each one is observed. */
export interface PreflightObservations {
  /** Catalog source that supplied the listing. `shipped` accepts the built-in digest. */
  mode: 'shipped' | 'api'
  /** Installed version of one required module, or null when this computer cannot resolve it. */
  resolvePackage(name: string): { version: string } | null
  /** Model routes registered here (`LlmProviderInfo.id`). Empty when none is. */
  modelRoutes(): readonly string[]
  /** Free bytes at the declaration directory. */
  freeDiskBytes(): number
  /** Physical memory bytes this computer has. */
  totalMemoryBytes(): number
  /** Node's actual operating-system identifier for this process. */
  platform(): string
  /** Node's actual CPU architecture for this process. */
  architecture(): string
  /** Check one detached publisher signature over the declaration bytes. */
  signatureVerdict(publisher: string, payload: string, signature: string): SignatureVerdict
}

/**
 * Signature payload of one listing: every declaration field except the signature itself.
 * @param listing - Listing as presented by the catalog.
 * @returns Canonical JSON the signature or built-in digest covers.
 */
export function declarationBytes(listing: MarketListing): string {
  const { packages, model, minFreeDiskBytes, minTotalMemoryBytes, platforms, architectures } = listing.requirements
  return JSON.stringify({
    id: listing.id,
    capabilityId: listing.capabilityId,
    version: listing.version,
    packageSpec: listing.packageSpec,
    packages: packages.map(dependency => ({ name: dependency.name, minimumVersion: dependency.minimumVersion })),
    model,
    minFreeDiskBytes,
    minTotalMemoryBytes,
    ...(platforms === undefined ? {} : { platforms }),
    ...(architectures === undefined ? {} : { architectures }),
  })
}

/**
 * SHA-256 of {@link declarationBytes}: the built-in signature of a shipped catalog row.
 * @param listing - Listing as presented by the catalog.
 * @returns Lowercase hex digest.
 */
export function catalogDigest(listing: MarketListing): string {
  return createHash('sha256').update(declarationBytes(listing), 'utf8').digest('hex')
}

/**
 * Compare dotted numeric versions, as declared by `minimumVersion`.
 * @param installed - Version read from the resolved module.
 * @param minimum - Version the listing requires.
 * @returns False when any compared segment is below the minimum.
 */
export function versionAtLeast(installed: string, minimum: string): boolean {
  const left = installed.replace(/^v/, '').split('.')
  const right = minimum.replace(/^v/, '').split('.')
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? '0'
    const b = right[index] ?? '0'
    const numericA = /^\d+$/.test(a)
    const numericB = /^\d+$/.test(b)
    if (numericA && numericB) {
      const difference = Number(a) - Number(b)
      if (difference !== 0) return difference > 0
      continue
    }
    if (a === b) continue
    return false
  }
  return true
}

/** One step's finding: an empty reason means the step passed. */
interface StepOutcome { reason: string; detail: string }

const PASSED: StepOutcome = { reason: '', detail: '' }

function failed(reason: string, detail: string): StepOutcome {
  return { reason, detail: detail.length <= MAX_DETAIL ? detail : detail.slice(0, MAX_DETAIL) }
}

function checkSignature(listing: MarketListing, observed: PreflightObservations): StepOutcome {
  const signature = listing.requirements.signature
  if (signature === null) return failed('SIGNATURE_MISSING', `listing=${listing.id}`)
  if (signature.kind === 'catalog-digest') {
    if (observed.mode !== 'shipped') return failed('SIGNATURE_PUBLISHER_REQUIRED', `publisher=${signature.publisher}`)
    if (!/^[a-f0-9]{64}$/.test(signature.value)) return failed('SIGNATURE_MALFORMED', `publisher=${signature.publisher}`)
    const expected = catalogDigest(listing)
    if (signature.value !== expected) return failed('SIGNATURE_DIGEST_MISMATCH', `expected=${expected}`)
    return PASSED
  }
  if (signature.publisher === '' || !/^[A-Za-z0-9+/_=-]{16,8192}$/.test(signature.value)) {
    return failed('SIGNATURE_MALFORMED', `publisher=${signature.publisher}`)
  }
  const verdict = observed.signatureVerdict(signature.publisher, declarationBytes(listing), signature.value)
  if (verdict === 'unknown-publisher') return failed('SIGNATURE_PUBLISHER_UNKNOWN', `publisher=${signature.publisher}`)
  if (verdict === 'invalid') return failed('SIGNATURE_INVALID', `publisher=${signature.publisher}`)
  return PASSED
}

function checkDependencies(listing: MarketListing, observed: PreflightObservations): StepOutcome {
  for (const dependency of listing.requirements.packages) {
    const installed = observed.resolvePackage(dependency.name)
    const minimum = dependency.minimumVersion === '' ? '' : ` min=${dependency.minimumVersion}`
    if (installed === null) return failed('DEPENDENCY_MISSING', `name=${dependency.name}${minimum}`)
    if (dependency.minimumVersion !== '' && !versionAtLeast(installed.version, dependency.minimumVersion)) {
      return failed('DEPENDENCY_VERSION_LOW', `name=${dependency.name} installed=${installed.version}${minimum}`)
    }
  }
  return PASSED
}

function checkModel(listing: MarketListing, observed: PreflightObservations): StepOutcome {
  const required = listing.requirements.model
  if (required === '') return PASSED
  const routes = observed.modelRoutes()
  if (routes.length === 0) return failed('MODEL_PROVIDER_MISSING', `required=${required}`)
  if (!routes.includes(required)) {
    return failed('MODEL_ROUTE_MISSING', `required=${required} available=${routes.slice(0, 8).join(',')}`)
  }
  return PASSED
}

function checkResources(listing: MarketListing, observed: PreflightObservations): StepOutcome {
  const { minFreeDiskBytes, minTotalMemoryBytes, platforms, architectures } = listing.requirements
  const actualPlatform = observed.platform()
  const actualArchitecture = observed.architecture()
  if (platforms !== undefined && !platforms.includes(actualPlatform as (typeof platforms)[number])) {
    return failed('RESOURCE_PLATFORM_UNSUPPORTED', `platform=${actualPlatform} required=${platforms.join(',')}`)
  }
  if (architectures !== undefined && !architectures.includes(actualArchitecture as (typeof architectures)[number])) {
    return failed('RESOURCE_ARCHITECTURE_UNSUPPORTED', `architecture=${actualArchitecture} required=${architectures.join(',')}`)
  }
  if (minFreeDiskBytes > 0) {
    const free = observed.freeDiskBytes()
    if (free < minFreeDiskBytes) return failed('RESOURCE_DISK_LOW', `free=${free} required=${minFreeDiskBytes}`)
  }
  if (minTotalMemoryBytes > 0) {
    const total = observed.totalMemoryBytes()
    if (total < minTotalMemoryBytes) return failed('RESOURCE_MEMORY_LOW', `total=${total} required=${minTotalMemoryBytes}`)
  }
  return PASSED
}

/** Presence of a constraint is not itself a successful compatibility check. */
function compatibilityCheck(required: readonly string[] | undefined, actual: string, reachedResources: boolean): HostCompatibilityCheck {
  return { state: required === undefined ? 'not-declared' : !reachedResources ? 'not-checked'
    : required.includes(actual) ? 'matched' : 'mismatched',
  observed: actual, required: required ?? null }
}

const CHECKS: Record<PreflightStepId, (listing: MarketListing, observed: PreflightObservations) => StepOutcome> = {
  signature: checkSignature,
  dependencies: checkDependencies,
  model: checkModel,
  resources: checkResources,
}

/**
 * Run the four checks in order and stop at the first failure. For a declaration with no
 * package, validate the catalog digest but label package-only checks not applicable.
 * @param listing - Listing as presented by the catalog.
 * @param observed - Host facts, supplied by the catalog service.
 * @returns The report the owner reads. A failed report offers fix, recheck, cancel and rollback.
 */
export function runInstallPreflight(listing: MarketListing, observed: PreflightObservations): InstallPreflightReport {
  const steps: PreflightStep[] = PREFLIGHT_STEP_IDS.map(id => ({
    id,
    state: 'not-checked',
    reason: PREFLIGHT_PENDING_REASON,
    detail: '',
  }))
  const compatibility = (resourceReason: string | null): NonNullable<InstallPreflightReport['compatibility']> => ({
    platform: compatibilityCheck(listing.requirements.platforms, observed.platform(), resourceReason !== null),
    architecture: compatibilityCheck(listing.requirements.architectures, observed.architecture(),
      resourceReason !== null && resourceReason !== 'RESOURCE_PLATFORM_UNSUPPORTED'),
    gpuMemory: { state: 'not-probed' },
  })
  for (const [index, id] of PREFLIGHT_STEP_IDS.entries()) {
    const outcome = CHECKS[id](listing, observed)
    if (outcome.reason === '') {
      const declarationOnly = listing.packageSpec === '' && (id === 'signature'
        || id === 'dependencies' && listing.requirements.packages.length === 0
        || id === 'model' && listing.requirements.model === '')
      steps[index] = declarationOnly
        ? { id, state: 'not-applicable', reason: PREFLIGHT_DECLARATION_ONLY_REASON, detail: '' }
        : { id, state: 'passed', reason: '', detail: '' }
      continue
    }
    steps[index] = { id, state: 'failed', reason: outcome.reason, detail: outcome.detail }
    return {
      listingId: listing.id,
      steps,
      verdict: 'failed',
      failedStep: id,
      actions: [...PREFLIGHT_ACTION_IDS],
      checkedAt: Date.now(),
      compatibility: compatibility(id === 'resources' ? outcome.reason : null),
    }
  }
  return { listingId: listing.id, steps, verdict: 'passed', failedStep: null, actions: [], checkedAt: Date.now(), compatibility: compatibility('') }
}
