import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { CSV_SEED_IDENTITY } from '../src/official-seed-csv.ts'
import { approvalPayload, releasePayload } from '../src/release-preview.ts'
import { acquireReviewedSeedCsvFromMarket, reviewedSeedClaimAuthChannel,
  type ReviewedSeedAcquireRequest } from '../src/reviewed-seed-consumer.ts'

const accountToken = 'account-test-token-with-more-than-32-characters'
const artifactToken = 'artifact-test-token-with-more-than-32-characters'
const publisher = generateKeyPairSync('ed25519')
const reviewer = generateKeyPairSync('ed25519')
const publisherKeys = { 'qianshou-studio': publisher.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
const operatorKeys = { 'qianshou-review': reviewer.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }

type Release = ReturnType<typeof signedRelease>
function signedRelease(archive: Buffer) {
  const release = {
    pluginId: CSV_SEED_IDENTITY.pluginId, version: CSV_SEED_IDENTITY.version,
    releaseId: CSV_SEED_IDENTITY.releaseId, title: 'CSV 结构体检', summary: '本机检查 CSV 列结构。',
    packageSha256: createHash('sha256').update(archive).digest('hex'), packageBytes: archive.length,
    platforms: [platform()], architectures: [arch()],
    operations: [{ capabilityId: CSV_SEED_IDENTITY.capabilityId,
      operationId: CSV_SEED_IDENTITY.operationId, executorKind: 'node',
      inputSchemaSha256: CSV_SEED_IDENTITY.inputSchemaSha256,
      outputSchemaSha256: CSV_SEED_IDENTITY.outputSchemaSha256, permissions: [] }],
    publisher: { id: 'qianshou-studio', signature: '' },
    approval: { reviewId: 'review-csv-1', reviewedAt: Date.now(), operatorId: 'qianshou-review', signature: '' },
    verificationScope: 'opaque-archive-bytes', installable: false,
  }
  release.publisher.signature = sign(null, Buffer.from(releasePayload(release as never)), publisher.privateKey).toString('base64')
  release.approval.signature = sign(null, Buffer.from(approvalPayload(release as never)), reviewer.privateKey).toString('base64')
  return release
}

async function fixture(run: (input: {
  request: ReviewedSeedAcquireRequest
  release: Release
  control: { check: unknown; checkStatus: number; newRouteEnabled: boolean;
    claim: unknown; claimStatus: number; archive: Buffer; metadata: unknown;
    secondMetadata?: unknown; metadataRequests: number; checkRequests: number;
    claimRequests: number; legacyRequests: number; artifactRequests: number }
  stagingDir: string
}) => Promise<void>) {
  const archive = await readFile(new URL('../seed/csv-profile/qianshou.csv-profile-1.0.0.qspkg', import.meta.url))
  const release = signedRelease(archive)
  const stagingDir = await mkdtemp(join(tmpdir(), 'qianshou-seed-consumer-'))
  const control = {
    check: { ok: true, accountId: '167', authMode: 'bearer-request-bound' } as unknown,
    checkStatus: 200, newRouteEnabled: true,
    claim: { ok: true, releaseId: release.releaseId, pluginId: release.pluginId,
      version: release.version, packageSha256: release.packageSha256,
      license: { licenseId: 'license-csv-1', kind: 'free', accountId: '167', claimedAt: Date.now() },
      download: { url: `/qianshou-market/releases?artifact=${release.releaseId}`,
        token: artifactToken, expiresAt: Date.now() + 5 * 60_000 } } as unknown,
    claimStatus: 200, archive, metadata: { releases: [release] } as unknown,
    secondMetadata: undefined as unknown,
    metadataRequests: 0, checkRequests: 0, claimRequests: 0, legacyRequests: 0,
    artifactRequests: 0,
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/qianshou-market/releases' && url.searchParams.size === 0) {
      control.metadataRequests += 1
      const metadata = control.metadataRequests > 1 && control.secondMetadata !== undefined
        ? control.secondMetadata : control.metadata
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(metadata)); return
    }
    if (url.pathname === '/api/qianshou/ai/plugins/license') {
      control.legacyRequests += 1
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(control.claim))
      return
    }
    if (url.pathname === '/qianshou-market/license' && control.newRouteEnabled) {
      if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${accountToken}`) {
        res.writeHead(401).end(); return
      }
      const body: Buffer[] = []
      req.on('data', (chunk: Buffer) => body.push(chunk))
      req.on('end', () => {
        const input = JSON.parse(Buffer.concat(body).toString('utf8')) as unknown
        if (JSON.stringify(input) === JSON.stringify({ action: 'check' })) {
          control.checkRequests += 1
          res.writeHead(control.checkStatus, { 'content-type': 'application/json' })
            .end(JSON.stringify(control.check)); return
        }
        if (JSON.stringify(input) !== JSON.stringify({ action: 'claim', releaseId: release.releaseId })) {
          res.writeHead(400).end(); return
        }
        control.claimRequests += 1
        res.writeHead(control.claimStatus, { 'content-type': 'application/json' }).end(JSON.stringify(control.claim))
      })
      return
    }
    if (url.pathname === '/qianshou-market/releases' && url.searchParams.get('artifact') === release.releaseId) {
      control.artifactRequests += 1
      if (req.headers.authorization !== `Bearer ${artifactToken}`) { res.writeHead(403).end(); return }
      res.writeHead(200, { 'content-type': 'application/octet-stream',
        'content-length': String(control.archive.length),
        'x-qianshou-package-sha256': release.packageSha256 }).end(control.archive)
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server failed')
  const account = { snapshot: vi.fn(async () => ({ phase: 'authenticated', account: { id: '167' } })),
    ensureAccessToken: vi.fn(async () => accountToken) }
  const request: ReviewedSeedAcquireRequest = {
    apiBaseUrl: `http://127.0.0.1:${address.port}/`, stagingDir, account,
    publisherKeys, operatorKeys, timeoutMs: 5_000,
  }
  try { await run({ request, release, control, stagingDir }) }
  finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => { server.close(() => resolve()) })
    await rm(stagingDir, { recursive: true, force: true })
  }
}

it('claims once for the authenticated account and stages the exact signed five-file seed as a private candidate', async () => {
  await fixture(async ({ request, release, control, stagingDir }) => {
    const result = await acquireReviewedSeedCsvFromMarket(request)
    expect(result).toMatchObject({ accountId: '167', licenseId: 'license-csv-1',
      releaseId: CSV_SEED_IDENTITY.releaseId, pluginId: CSV_SEED_IDENTITY.pluginId,
      version: CSV_SEED_IDENTITY.version, packageSha256: release.packageSha256,
      samplePassed: true, scope: 'account-bound-private-candidate', installable: false, dispatchable: false })
    expect(await readFile(result.archivePath)).toEqual(control.archive)
    expect(await readdir(stagingDir)).toHaveLength(1)
    expect(control.metadataRequests).toBe(2)
    expect(control.checkRequests).toBe(1)
    expect(control.claimRequests).toBe(1)
    expect(control.legacyRequests).toBe(0)
    expect(control.artifactRequests).toBe(1)
    expect(JSON.stringify(result)).not.toContain(artifactToken)
    expect(JSON.stringify(result)).not.toContain(accountToken)
  })
})

it('refuses missing account carrier or untrusted release before claiming or downloading', async () => {
  await fixture(async ({ request, release, control, stagingDir }) => {
    const missingAccount = { ...request }
    delete missingAccount.account
    await expect(acquireReviewedSeedCsvFromMarket(missingAccount)).rejects.toThrow('QIANSHOU_REVIEWED_SEED_INVALID')
    expect(control.metadataRequests).toBe(0)
    control.metadata = { releases: [{ ...release, title: 'tampered' }] }
    await expect(acquireReviewedSeedCsvFromMarket(request)).rejects.toThrow()
    expect(control.claimRequests).toBe(0)
    expect(control.checkRequests).toBe(0)
    expect(control.artifactRequests).toBe(0)
    expect(await readdir(stagingDir)).toEqual([])
  })
})

it('rejects a validly re-signed release that names a different operation', async () => {
  await fixture(async ({ request, control, stagingDir }) => {
    const original = signedRelease(control.archive)
    const changed = { ...original, operations: original.operations.map(operation =>
      ({ ...operation, operationId: 'unreviewed.run' })) }
    changed.publisher.signature = sign(null, Buffer.from(releasePayload(changed as never)),
      publisher.privateKey).toString('base64')
    changed.approval.signature = sign(null, Buffer.from(approvalPayload(changed as never)),
      reviewer.privateKey).toString('base64')
    control.metadata = { releases: [changed] }
    await expect(acquireReviewedSeedCsvFromMarket(request)).rejects.toThrow('QIANSHOU_REVIEWED_SEED_INVALID')
    expect(control.claimRequests).toBe(0)
    expect(control.checkRequests).toBe(0)
    expect(control.artifactRequests).toBe(0)
    expect(await readdir(stagingDir)).toEqual([])
  })
})

it('rejects unverified, wrong-account, wrong-digest, expired or off-origin claims without an artifact request', async () => {
  for (const kind of ['unauthorized', 'account', 'digest', 'expired', 'url'] as const) {
    await fixture(async ({ request, control, stagingDir }) => {
      const claim = control.claim as Record<string, unknown>
      if (kind === 'unauthorized') control.claimStatus = 401
      if (kind === 'account') control.claim = { ...claim,
        license: { ...(claim.license as Record<string, unknown>), accountId: '217' } }
      if (kind === 'digest') control.claim = { ...claim, packageSha256: 'f'.repeat(64) }
      if (kind === 'expired') control.claim = { ...claim,
        download: { ...(claim.download as Record<string, unknown>), expiresAt: Date.now() - 1 } }
      if (kind === 'url') control.claim = { ...claim,
        download: { ...(claim.download as Record<string, unknown>), url: 'https://attacker.invalid/package' } }
      await expect(acquireReviewedSeedCsvFromMarket(request)).rejects.toThrow()
      expect(control.checkRequests).toBe(1)
      expect(control.artifactRequests).toBe(0)
      expect(await readdir(stagingDir)).toEqual([])
    })
  }
})

it('does not use the old Cookie route as proof of this PC bearer identity', async () => {
  await fixture(async ({ request, control, stagingDir }) => {
    control.newRouteEnabled = false
    expect(await reviewedSeedClaimAuthChannel(request)).toBe('unverified')
    await expect(acquireReviewedSeedCsvFromMarket(request)).rejects.toThrow()
    expect(control.checkRequests).toBe(0)
    expect(control.claimRequests).toBe(0)
    expect(control.legacyRequests).toBe(0)
    expect(control.artifactRequests).toBe(0)
    expect(await readdir(stagingDir)).toEqual([])
  })
})

it('denies missing, unavailable, mismatched or malformed bearer check before any claim or write', async () => {
  for (const kind of ['unauthorized', 'unavailable', 'account', 'mode', 'extra'] as const) {
    await fixture(async ({ request, control, stagingDir }) => {
      if (kind === 'unauthorized') control.checkStatus = 401
      if (kind === 'unavailable') control.checkStatus = 503
      if (kind === 'account') control.check = { ok: true, accountId: '217', authMode: 'bearer-request-bound' }
      if (kind === 'mode') control.check = { ok: true, accountId: '167', authMode: 'cookie' }
      if (kind === 'extra') control.check = { ok: true, accountId: '167',
        authMode: 'bearer-request-bound', trusted: true }
      expect(await reviewedSeedClaimAuthChannel(request)).toBe('unverified')
      await expect(acquireReviewedSeedCsvFromMarket(request)).rejects.toThrow()
      expect(control.checkRequests).toBe(2)
      expect(control.claimRequests).toBe(0)
      expect(control.legacyRequests).toBe(0)
      expect(control.artifactRequests).toBe(0)
      expect(await readdir(stagingDir)).toEqual([])
    })
  }
})

it('removes a downloaded candidate if its bytes or second metadata read change', async () => {
  await fixture(async ({ request, control, stagingDir }) => {
    const altered = Buffer.from(control.archive)
    altered[100] = altered[100]! ^ 1
    control.archive = altered
    await expect(acquireReviewedSeedCsvFromMarket(request)).rejects.toThrow()
    expect(await readdir(stagingDir)).toEqual([])
  })
  await fixture(async ({ request, release, control, stagingDir }) => {
    const replaced = { ...release, approval: { ...release.approval,
      reviewedAt: release.approval.reviewedAt + 1, signature: '' } }
    replaced.approval.signature = sign(null, Buffer.from(approvalPayload(replaced as never)),
      reviewer.privateKey).toString('base64')
    control.secondMetadata = { releases: [replaced] }
    // This check covers a release replacement between the initial claim and the stage's fresh read.
    await expect(acquireReviewedSeedCsvFromMarket(request)).rejects.toThrow()
    expect(control.metadataRequests).toBe(2)
    expect(control.artifactRequests).toBe(1)
    expect(await readdir(stagingDir)).toEqual([])
    expect(release.releaseId).toBe(CSV_SEED_IDENTITY.releaseId)
  })
})

it('rechecks account identity after the claim and refuses a switched account', async () => {
  await fixture(async ({ request, control, stagingDir }) => {
    const account = request.account!
    await expect(acquireReviewedSeedCsvFromMarket({ ...request, account: { ...account,
      snapshot: async () => ({ phase: 'authenticated',
        account: { id: control.claimRequests > 0 ? '217' : '167' } }),
    } })).rejects.toThrow('QIANSHOU_REVIEWED_SEED_INVALID')
    expect(control.claimRequests).toBe(1)
    expect(control.artifactRequests).toBe(0)
    expect(await readdir(stagingDir)).toEqual([])
  })
  await fixture(async ({ request, control, stagingDir }) => {
    const account = request.account!
    await expect(acquireReviewedSeedCsvFromMarket({ ...request, account: { ...account,
      snapshot: async () => ({ phase: 'authenticated',
        account: { id: control.artifactRequests > 0 ? '217' : '167' } }),
    } })).rejects.toThrow('QIANSHOU_REVIEWED_SEED_INVALID')
    expect(control.artifactRequests).toBe(1)
    expect(await readdir(stagingDir)).toEqual([])
  })
})
