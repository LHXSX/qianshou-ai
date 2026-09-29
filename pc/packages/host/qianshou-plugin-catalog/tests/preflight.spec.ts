import { describe, expect, it } from 'vitest'
import { shippedListings } from '../src/market.ts'
import {
  PREFLIGHT_ACTION_IDS,
  PREFLIGHT_DECLARATION_ONLY_REASON,
  PREFLIGHT_PENDING_REASON,
  catalogDigest,
  runInstallPreflight,
  versionAtLeast,
  type PreflightObservations,
} from '../src/preflight.ts'
import type { MarketListing } from '../src/types.ts'

function listing(overrides: Partial<MarketListing> = {}): MarketListing {
  const base: MarketListing = {
    id: 'qianshou.article',
    title: '文章',
    summary: 'article',
    capabilityId: 'text.transform',
    version: '1',
    packageSpec: '',
    installable: true,
    requirements: { signature: null, packages: [], model: '', minFreeDiskBytes: 0, minTotalMemoryBytes: 0 },
  }
  return {
    ...base,
    ...overrides,
    requirements: { ...base.requirements, ...overrides.requirements },
  }
}

/** A row whose built-in digest matches its own declaration fields. */
function catalogRow(overrides: Partial<MarketListing> = {}): MarketListing {
  const row = listing(overrides)
  const digest = catalogDigest(row)
  return { ...row, requirements: { ...row.requirements, signature: { kind: 'catalog-digest', publisher: 'qianshou', value: digest } } }
}

function observed(overrides: Partial<PreflightObservations> = {}): PreflightObservations {
  return {
    mode: 'shipped',
    resolvePackage: () => ({ version: '1.0.0' }),
    modelRoutes: () => [],
    freeDiskBytes: () => 8 * 1024 * 1024 * 1024,
    totalMemoryBytes: () => 16 * 1024 * 1024 * 1024,
    platform: () => 'darwin',
    architecture: () => 'arm64',
    signatureVerdict: () => 'valid',
    ...overrides,
  }
}

describe('install preflight order', () => {
  it('checks the declaration digest and resources without claiming an empty package passed package checks', () => {
    const report = runInstallPreflight(catalogRow(), observed())
    expect(report.verdict).toBe('passed')
    expect(report.steps.map(step => [step.id, step.state])).toEqual([
      ['signature', 'not-applicable'], ['dependencies', 'not-applicable'],
      ['model', 'not-applicable'], ['resources', 'passed'],
    ])
    expect(report.steps.slice(0, 3).map(step => step.reason)).toEqual(Array(3).fill(PREFLIGHT_DECLARATION_ONLY_REASON))
    expect(report.failedStep).toBeNull()
    expect(report.actions).toEqual([])
    expect(report.compatibility).toEqual({
      platform: { state: 'not-declared', observed: 'darwin', required: null },
      architecture: { state: 'not-declared', observed: 'arm64', required: null },
      gpuMemory: { state: 'not-probed' },
    })
  })

  it('stops at the first failure, leaves later steps not-checked, and offers all four actions', () => {
    const report = runInstallPreflight(listing(), observed())
    expect(report.verdict).toBe('failed')
    expect(report.failedStep).toBe('signature')
    expect(report.steps.map(step => [step.id, step.state, step.reason])).toEqual([
      ['signature', 'failed', 'SIGNATURE_MISSING'],
      ['dependencies', 'not-checked', PREFLIGHT_PENDING_REASON],
      ['model', 'not-checked', PREFLIGHT_PENDING_REASON],
      ['resources', 'not-checked', PREFLIGHT_PENDING_REASON],
    ])
    expect(report.actions).toEqual([...PREFLIGHT_ACTION_IDS])
    expect(report.actions).toEqual(['fix', 'recheck', 'cancel', 'rollback'])
  })

  it('reports a dependency failure before it ever reaches the model or resource steps', () => {
    const report = runInstallPreflight(catalogRow({
      requirements: {
        signature: null, packages: [{ name: 'qianshou-absent', minimumVersion: '1.0.0' }],
        model: 'deepseek', minFreeDiskBytes: 10 ** 15, minTotalMemoryBytes: 10 ** 15,
      },
    }), observed({ resolvePackage: () => null }))
    expect(report.steps.map(step => step.state)).toEqual(['not-applicable', 'failed', 'not-checked', 'not-checked'])
    expect(report.steps[1]).toMatchObject({ reason: 'DEPENDENCY_MISSING', detail: 'name=qianshou-absent min=1.0.0' })
  })
})

describe('signature step', () => {
  it('records the digest of every shipped row', () => {
    for (const row of shippedListings()) {
      expect(row.requirements.signature).toMatchObject({ kind: 'catalog-digest', value: catalogDigest(row) })
    }
  })

  it('refuses a shipped row whose declaration bytes were edited', () => {
    const row = catalogRow()
    const tampered: MarketListing = { ...row, version: '2' }
    const report = runInstallPreflight(tampered, observed())
    expect(report.steps[0]).toMatchObject({ id: 'signature', state: 'failed', reason: 'SIGNATURE_DIGEST_MISMATCH' })
  })

  it('covers declared OS and CPU requirements with the listing signature', () => {
    const row = catalogRow({ requirements: {
      signature: null, packages: [], model: '', minFreeDiskBytes: 0, minTotalMemoryBytes: 0,
      platforms: ['darwin'], architectures: ['arm64'],
    } })
    const changedOs = { ...row, requirements: { ...row.requirements, platforms: ['win32'] as ['win32'] } }
    const changedCpu = { ...row, requirements: { ...row.requirements, architectures: ['x64'] as ['x64'] } }
    expect(runInstallPreflight(changedOs, observed()).steps[0])
      .toMatchObject({ state: 'failed', reason: 'SIGNATURE_DIGEST_MISMATCH' })
    expect(runInstallPreflight(changedCpu, observed()).steps[0])
      .toMatchObject({ state: 'failed', reason: 'SIGNATURE_DIGEST_MISMATCH' })
  })

  it('refuses a built-in digest offered by a remote catalog', () => {
    const report = runInstallPreflight(catalogRow(), observed({ mode: 'api' }))
    expect(report.steps[0]).toMatchObject({ state: 'failed', reason: 'SIGNATURE_PUBLISHER_REQUIRED' })
  })

  it('separates an unknown publisher from an invalid signature', () => {
    const signed = listing({
      requirements: {
        signature: { kind: 'publisher', publisher: 'qianshou-tools', value: 'A'.repeat(44) },
        packages: [], model: '', minFreeDiskBytes: 0, minTotalMemoryBytes: 0,
      },
    })
    expect(runInstallPreflight(signed, observed({ mode: 'api', signatureVerdict: () => 'unknown-publisher' })).steps[0])
      .toMatchObject({ state: 'failed', reason: 'SIGNATURE_PUBLISHER_UNKNOWN', detail: 'publisher=qianshou-tools' })
    expect(runInstallPreflight(signed, observed({ mode: 'api', signatureVerdict: () => 'invalid' })).steps[0])
      .toMatchObject({ state: 'failed', reason: 'SIGNATURE_INVALID' })
    expect(runInstallPreflight(signed, observed({ mode: 'api' })).verdict).toBe('passed')
  })

  it('refuses a truncated signature value', () => {
    const short = listing({
      requirements: {
        signature: { kind: 'publisher', publisher: 'qianshou-tools', value: 'short' },
        packages: [], model: '', minFreeDiskBytes: 0, minTotalMemoryBytes: 0,
      },
    })
    expect(runInstallPreflight(short, observed({ mode: 'api' })).steps[0])
      .toMatchObject({ state: 'failed', reason: 'SIGNATURE_MALFORMED' })
  })
})

describe('dependency step', () => {
  it('fails an unresolved module and a version below the declared floor', () => {
    const declared = catalogRow({
      requirements: {
        signature: null, packages: [{ name: 'zod', minimumVersion: '4.0.0' }],
        model: '', minFreeDiskBytes: 0, minTotalMemoryBytes: 0,
      },
    })
    expect(runInstallPreflight(declared, observed({ resolvePackage: () => null })).steps[1])
      .toMatchObject({ state: 'failed', reason: 'DEPENDENCY_MISSING', detail: 'name=zod min=4.0.0' })
    expect(runInstallPreflight(declared, observed({ resolvePackage: () => ({ version: '3.9.0' }) })).steps[1])
      .toMatchObject({ state: 'failed', reason: 'DEPENDENCY_VERSION_LOW', detail: 'name=zod installed=3.9.0 min=4.0.0' })
    expect(runInstallPreflight(declared, observed({ resolvePackage: () => ({ version: '4.4.3' }) })).verdict).toBe('passed')
  })

  it('compares dotted versions', () => {
    expect(versionAtLeast('4.4.3', '4.0.0')).toBe(true)
    expect(versionAtLeast('4.4.3', '4.4.3')).toBe(true)
    expect(versionAtLeast('4.4', '4.4.0')).toBe(true)
    expect(versionAtLeast('4.4.2', '4.4.10')).toBe(false)
    expect(versionAtLeast('v5.0.0', '4.0.0')).toBe(true)
    expect(versionAtLeast('4.4.3-beta.1', '4.5.0')).toBe(false)
  })
})

describe('model and resource steps', () => {

  it('checks a declared operating system and CPU architecture before install', () => {
    const row = catalogRow({ requirements: {
      signature: null, packages: [], model: '', minFreeDiskBytes: 0, minTotalMemoryBytes: 0,
      platforms: ['darwin'], architectures: ['arm64'],
    } })
    const matched = runInstallPreflight(row, observed())
    expect(matched.verdict).toBe('passed')
    expect(matched.compatibility).toEqual({
      platform: { state: 'matched', observed: 'darwin', required: ['darwin'] },
      architecture: { state: 'matched', observed: 'arm64', required: ['arm64'] },
      gpuMemory: { state: 'not-probed' },
    })
    const wrongOs = runInstallPreflight(row, observed({ platform: () => 'win32' }))
    expect(wrongOs.steps[3]).toMatchObject({ state: 'failed', reason: 'RESOURCE_PLATFORM_UNSUPPORTED' })
    expect(wrongOs.compatibility?.platform.state).toBe('mismatched')
    expect(wrongOs.compatibility?.architecture.state).toBe('not-checked')
    const wrongCpu = runInstallPreflight(row, observed({ architecture: () => 'x64' }))
    expect(wrongCpu.steps[3]).toMatchObject({ state: 'failed', reason: 'RESOURCE_ARCHITECTURE_UNSUPPORTED' })
    expect(wrongCpu.compatibility?.platform.state).toBe('matched')
    expect(wrongCpu.compatibility?.architecture.state).toBe('mismatched')
  })

  it('does not say a compatibility requirement passed when an earlier step failed', () => {
    const row = listing({ requirements: {
      signature: null, packages: [], model: '', minFreeDiskBytes: 0, minTotalMemoryBytes: 0,
      platforms: ['darwin'], architectures: ['arm64'],
    } })
    const report = runInstallPreflight(row, observed())
    expect(report.failedStep).toBe('signature')
    expect(report.compatibility?.platform.state).toBe('not-checked')
    expect(report.compatibility?.architecture.state).toBe('not-checked')
  })
  it('needs a route only when the listing declares one', () => {
    const row = catalogRow({
      requirements: { signature: null, packages: [], model: '', minFreeDiskBytes: 0, minTotalMemoryBytes: 0 },
    })
    expect(runInstallPreflight(row, observed({ modelRoutes: () => [] })).steps[2])
      .toMatchObject({ state: 'not-applicable', reason: PREFLIGHT_DECLARATION_ONLY_REASON })
  })

  it('fails a model requirement with no route registered and names the routes it saw', () => {
    const row = catalogRow({
      requirements: { signature: null, packages: [], model: 'deepseek', minFreeDiskBytes: 0, minTotalMemoryBytes: 0 },
    })
    expect(runInstallPreflight(row, observed({ modelRoutes: () => [] })).steps[2])
      .toMatchObject({ state: 'failed', reason: 'MODEL_PROVIDER_MISSING', detail: 'required=deepseek' })
    expect(runInstallPreflight(row, observed({ modelRoutes: () => ['replay'] })).steps[2])
      .toMatchObject({ state: 'failed', reason: 'MODEL_ROUTE_MISSING', detail: 'required=deepseek available=replay' })
    expect(runInstallPreflight(row, observed({ modelRoutes: () => ['deepseek', 'replay'] })).verdict).toBe('passed')
  })

  it('fails when free disk or physical memory is below the declared floor', () => {
    const disk = catalogRow({
      requirements: { signature: null, packages: [], model: '', minFreeDiskBytes: 10 ** 15, minTotalMemoryBytes: 0 },
    })
    expect(runInstallPreflight(disk, observed({ freeDiskBytes: () => 1024 })).steps[3])
      .toMatchObject({ state: 'failed', reason: 'RESOURCE_DISK_LOW', detail: 'free=1024 required=1000000000000000' })
    const memory = catalogRow({
      requirements: { signature: null, packages: [], model: '', minFreeDiskBytes: 0, minTotalMemoryBytes: 10 ** 15 },
    })
    expect(runInstallPreflight(memory, observed({ totalMemoryBytes: () => 1024 })).steps[3])
      .toMatchObject({ state: 'failed', reason: 'RESOURCE_MEMORY_LOW', detail: 'total=1024 required=1000000000000000' })
  })
})
