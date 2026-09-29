import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { CSV_SEED_IDENTITY } from '../src/official-seed-csv.ts'
import { approvalPayload, releasePayload } from '../src/release-preview.ts'
import { acquireReviewedSeedCsvFromMarket, type ReviewedSeedLicenseRequest } from '../src/reviewed-seed-consumer.ts'
import { installReviewedSeedCsvForOwner, runReviewedSeedCsvForOwner } from '../src/reviewed-seed-install.ts'

const accountToken = 'account-test-token-with-more-than-32-characters'
const artifactToken = 'artifact-test-token-with-more-than-32-characters'
const publisher = generateKeyPairSync('ed25519')
const reviewer = generateKeyPairSync('ed25519')
const publisherKeys = { studio: publisher.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
const operatorKeys = { reviewer: reviewer.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }

async function fixture(run: (input: {
  acquire: () => ReturnType<typeof acquireReviewedSeedCsvFromMarket>
  license: ReviewedSeedLicenseRequest
  privateDir: string
  stagingDir: string
  account: { snapshot: ReturnType<typeof vi.fn>; ensureAccessToken: ReturnType<typeof vi.fn> }
  control: { claimStatus: number; accountId: string; licenseId: string; packageBytes: Buffer;
    checks: number; claims: number; legacyRequests: number; artifacts: number }
}) => Promise<void>) {
  const packageBytes = await readFile(new URL('../seed/csv-profile/qianshou.csv-profile-1.0.0.qspkg', import.meta.url))
  const release = {
    pluginId: CSV_SEED_IDENTITY.pluginId, version: CSV_SEED_IDENTITY.version,
    releaseId: CSV_SEED_IDENTITY.releaseId, title: 'CSV 结构体检', summary: '本机体检 CSV 列结构。',
    packageSha256: createHash('sha256').update(packageBytes).digest('hex'), packageBytes: packageBytes.length,
    platforms: [platform()], architectures: [arch()],
    operations: [{ capabilityId: CSV_SEED_IDENTITY.capabilityId,
      operationId: CSV_SEED_IDENTITY.operationId, executorKind: 'node',
      inputSchemaSha256: CSV_SEED_IDENTITY.inputSchemaSha256,
      outputSchemaSha256: CSV_SEED_IDENTITY.outputSchemaSha256, permissions: [] }],
    publisher: { id: 'studio', signature: '' },
    approval: { reviewId: 'seed-review-1', reviewedAt: Date.now(), operatorId: 'reviewer', signature: '' },
    verificationScope: 'opaque-archive-bytes', installable: false,
  }
  release.publisher.signature = sign(null, Buffer.from(releasePayload(release as never)), publisher.privateKey).toString('base64')
  release.approval.signature = sign(null, Buffer.from(approvalPayload(release as never)), reviewer.privateKey).toString('base64')
  const control = { claimStatus: 200, accountId: '167', licenseId: 'csv-free-license-167',
    packageBytes, checks: 0, claims: 0, legacyRequests: 0, artifacts: 0 }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/qianshou-market/releases' && url.searchParams.size === 0) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ releases: [release] })); return
    }
    if (url.pathname === '/api/qianshou/ai/plugins/license') {
      control.legacyRequests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, accountId: control.accountId,
          authMode: 'bearer-request-bound' }))
      return
    }
    if (url.pathname === '/qianshou-market/license') {
      if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${accountToken}`) {
        response.writeHead(401).end(); return
      }
      const parts: Buffer[] = []
      request.on('data', (part: Buffer) => parts.push(part))
      request.on('end', () => {
        let body: unknown
        try { body = JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown }
        catch { response.writeHead(400).end(); return }
        if (JSON.stringify(body) === JSON.stringify({ action: 'check' })) {
          control.checks += 1
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
            ok: true, accountId: control.accountId, authMode: 'bearer-request-bound',
          }))
          return
        }
        if (JSON.stringify(body) !== JSON.stringify({ action: 'claim', releaseId: release.releaseId })) {
          response.writeHead(400).end(); return
        }
        control.claims += 1
        if (control.claimStatus !== 200) { response.writeHead(control.claimStatus).end(); return }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          ok: true, releaseId: release.releaseId, pluginId: release.pluginId,
          version: release.version, packageSha256: release.packageSha256,
          license: { licenseId: control.licenseId, kind: 'free', accountId: control.accountId,
            claimedAt: Date.now() },
          download: { url: `/qianshou-market/releases?artifact=${release.releaseId}`,
            token: artifactToken, expiresAt: Date.now() + 5 * 60_000 },
        }))
      })
      return
    }
    if (url.pathname === '/qianshou-market/releases' && url.searchParams.get('artifact') === release.releaseId) {
      control.artifacts += 1
      if (request.headers.authorization !== `Bearer ${artifactToken}`) {
        response.writeHead(403).end(); return
      }
      response.writeHead(200, { 'content-type': 'application/octet-stream',
        'content-length': String(control.packageBytes.length),
        'x-qianshou-package-sha256': release.packageSha256 }).end(control.packageBytes)
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server failed')
  const stagingDir = await mkdtemp(join(tmpdir(), 'qianshou-market-stage-'))
  const privateDir = await mkdtemp(join(tmpdir(), 'qianshou-market-private-'))
  const account = { snapshot: vi.fn(async () => ({ phase: 'authenticated', account: { id: control.accountId } })),
    ensureAccessToken: vi.fn(async () => accountToken) }
  const license: ReviewedSeedLicenseRequest = { apiBaseUrl: `http://127.0.0.1:${address.port}/`,
    publisherKeys, operatorKeys, account, timeoutMs: 5_000 }
  try {
    await run({ acquire: () => acquireReviewedSeedCsvFromMarket({ ...license, stagingDir }),
      license, privateDir, stagingDir, account, control })
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => { server.close(() => resolve()) })
    await rm(stagingDir, { recursive: true, force: true })
    await rm(privateDir, { recursive: true, force: true })
  }
}

const signal = new AbortController().signal
const input = { csv: '商品,数量,金额\n苹果,2,3.50\n香蕉,1,4.00\n', sampleRows: 2 }

it('takes a signed free release through owner-approved buyer install and same-account online use', async () => {
  await fixture(async ({ acquire, license, privateDir, control }) => {
    const candidate = await acquire()
    const approveOwner = vi.fn(async identity => identity.accountId === '167'
      && identity.licenseId === 'csv-free-license-167'
      && identity.releaseId === CSV_SEED_IDENTITY.releaseId
      && identity.packageSha256 === CSV_SEED_IDENTITY.packageSha256)
    const installed = await installReviewedSeedCsvForOwner({ candidate, license, privateDir, signal, approveOwner })
    expect(installed).toMatchObject({ installed: true, scope: 'account-bound-private', dispatchable: false,
      accountId: '167', licenseId: 'csv-free-license-167',
      packageSha256: CSV_SEED_IDENTITY.packageSha256 })
    expect(approveOwner).toHaveBeenCalledOnce()
    expect((await readdir(privateDir)).sort()).toEqual([
      'market-qianshou.csv-profile-1.0.0.json', 'market-qianshou.csv-profile-1.0.0.qspkg',
    ])
    const result = await runReviewedSeedCsvForOwner({ privateDir, license, input, signal })
    expect(result).toMatchObject({ rowCount: 2, columnCount: 3,
      sampleRows: [['苹果', '2', '3.50'], ['香蕉', '1', '4.00']] })
    expect(control.claims).toBe(4) // first acquisition, before and after approval, each use
    expect(control.checks).toBe(4)
    expect(control.legacyRequests).toBe(0)
    expect(control.artifacts).toBe(1) // use reclaims online license without redownloading
  })
})

it('leaves no installed files when the owner declines the exact release', async () => {
  await fixture(async ({ acquire, license, privateDir }) => {
    const candidate = await acquire()
    await expect(installReviewedSeedCsvForOwner({ candidate, license, privateDir, signal,
      approveOwner: async () => false })).rejects.toThrow('QIANSHOU_REVIEWED_SEED_INSTALL_INVALID')
    expect(await readdir(privateDir)).toEqual([])
  })
})

it('refuses license replacement during approval and does not leave an installed archive', async () => {
  await fixture(async ({ acquire, license, privateDir, control }) => {
    const candidate = await acquire()
    await expect(installReviewedSeedCsvForOwner({ candidate, license, privateDir, signal,
      approveOwner: async () => { control.licenseId = 'different-license'; return true },
    })).rejects.toThrow('QIANSHOU_REVIEWED_SEED_INSTALL_INVALID')
    expect(await readdir(privateDir)).toEqual([])
  })
})

it('blocks local use on account switch, offline license check and package tampering', async () => {
  await fixture(async ({ acquire, license, privateDir, account, control }) => {
    const candidate = await acquire()
    await installReviewedSeedCsvForOwner({ candidate, license, privateDir, signal,
      approveOwner: async () => true })
    account.snapshot.mockImplementation(async () => ({ phase: 'authenticated', account: { id: '217' } }))
    const claimsBefore = control.claims
    await expect(runReviewedSeedCsvForOwner({ privateDir, license, input, signal }))
      .rejects.toThrow('QIANSHOU_REVIEWED_SEED_INSTALL_INVALID')
    expect(control.claims).toBe(claimsBefore)
    account.snapshot.mockImplementation(async () => ({ phase: 'authenticated', account: { id: '167' } }))
    control.claimStatus = 503
    await expect(runReviewedSeedCsvForOwner({ privateDir, license, input, signal })).rejects.toThrow()
    control.claimStatus = 200
    const archivePath = join(privateDir, 'market-qianshou.csv-profile-1.0.0.qspkg')
    const broken = await readFile(archivePath)
    broken[100] = broken[100]! ^ 1
    await writeFile(archivePath, broken)
    await expect(runReviewedSeedCsvForOwner({ privateDir, license, input, signal })).rejects.toThrow()
  })
})

it('refuses a changed buyer receipt even while an offline development trial exists', async () => {
  await fixture(async ({ acquire, license, privateDir }) => {
    const candidate = await acquire()
    await installReviewedSeedCsvForOwner({ candidate, license, privateDir, signal,
      approveOwner: async () => true })
    await writeFile(join(privateDir, 'qianshou.csv-profile-1.0.0.json'), '{}', { mode: 0o600 })
    const receiptPath = join(privateDir, 'market-qianshou.csv-profile-1.0.0.json')
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>
    receipt.licenseId = 'tampered'
    await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 })
    await expect(runReviewedSeedCsvForOwner({ privateDir, license, input, signal }))
      .rejects.toThrow('QIANSHOU_REVIEWED_SEED_INSTALL_INVALID')
  })
})

it('recovers an exact archive left before receipt publication with one fresh owner approval', async () => {
  await fixture(async ({ acquire, license, privateDir, control }) => {
    const candidate = await acquire()
    const archivePath = join(privateDir, 'market-qianshou.csv-profile-1.0.0.qspkg')
    await writeFile(archivePath, await readFile(candidate.archivePath), { mode: 0o600 })
    const approveOwner = vi.fn(async identity => identity.accountId === '167'
      && identity.licenseId === 'csv-free-license-167'
      && identity.packageSha256 === CSV_SEED_IDENTITY.packageSha256)
    const installed = await installReviewedSeedCsvForOwner({ candidate, license, privateDir, signal, approveOwner })
    expect(installed.archivePath).toBe(join(await realpath(privateDir), 'market-qianshou.csv-profile-1.0.0.qspkg'))
    expect(approveOwner).toHaveBeenCalledOnce()
    expect((await readdir(privateDir)).sort()).toEqual([
      'market-qianshou.csv-profile-1.0.0.json', 'market-qianshou.csv-profile-1.0.0.qspkg',
    ])
    expect((await runReviewedSeedCsvForOwner({ privateDir, license, input, signal })).rowCount).toBe(2)
    expect(control.claims).toBe(4)
  })
})

it('refuses and preserves a mismatched or partial orphan archive before owner approval', async () => {
  await fixture(async ({ acquire, license, privateDir }) => {
    const candidate = await acquire()
    const archivePath = join(privateDir, 'market-qianshou.csv-profile-1.0.0.qspkg')
    const mismatched = Buffer.from(await readFile(candidate.archivePath))
    mismatched[100] = mismatched[100]! ^ 1
    await writeFile(archivePath, mismatched, { mode: 0o600 })
    const approveOwner = vi.fn(async () => true)
    await expect(installReviewedSeedCsvForOwner({ candidate, license, privateDir, signal, approveOwner })).rejects.toThrow()
    expect(approveOwner).not.toHaveBeenCalled()
    expect(await readFile(archivePath)).toEqual(mismatched)
    expect(await readdir(privateDir)).toEqual(['market-qianshou.csv-profile-1.0.0.qspkg'])
  })
})

it('never replaces an existing cross-account or incomplete buyer receipt', async () => {
  for (const kind of ['cross-account', 'incomplete'] as const) {
    await fixture(async ({ acquire, license, privateDir }) => {
      const candidate = await acquire()
      const archivePath = join(privateDir, 'market-qianshou.csv-profile-1.0.0.qspkg')
      const receiptPath = join(privateDir, 'market-qianshou.csv-profile-1.0.0.json')
      const archive = await readFile(candidate.archivePath)
      const receipt = kind === 'cross-account' ? JSON.stringify({
        format: 'qianshou.market-csv-seed-install.v1', accountId: '217', licenseId: 'other-license',
        releaseId: CSV_SEED_IDENTITY.releaseId, pluginId: CSV_SEED_IDENTITY.pluginId,
        version: CSV_SEED_IDENTITY.version, packageSha256: CSV_SEED_IDENTITY.packageSha256,
        archiveName: 'market-qianshou.csv-profile-1.0.0.qspkg', installedAt: Date.now(),
        scope: 'account-bound-private', dispatchable: false,
      }) : '{'
      await writeFile(archivePath, archive, { mode: 0o600 })
      await writeFile(receiptPath, receipt, { mode: 0o600 })
      const approveOwner = vi.fn(async () => true)
      await expect(installReviewedSeedCsvForOwner({ candidate, license, privateDir, signal, approveOwner }))
        .rejects.toThrow('QIANSHOU_REVIEWED_SEED_INSTALL_INVALID')
      expect(approveOwner).not.toHaveBeenCalled()
      expect(await readFile(receiptPath, 'utf8')).toBe(receipt)
      expect(await readFile(archivePath)).toEqual(archive)
    })
  }
})

it('handles a same-package archive arriving during approval without replacing it or repeating approval', async () => {
  await fixture(async ({ acquire, license, privateDir }) => {
    const candidate = await acquire()
    const archivePath = join(privateDir, 'market-qianshou.csv-profile-1.0.0.qspkg')
    const bytes = await readFile(candidate.archivePath)
    const approveOwner = vi.fn(async () => {
      await writeFile(archivePath, bytes, { mode: 0o600 })
      return true
    })
    await installReviewedSeedCsvForOwner({ candidate, license, privateDir, signal, approveOwner })
    expect(approveOwner).toHaveBeenCalledOnce()
    expect(await readFile(archivePath)).toEqual(bytes)
    expect((await runReviewedSeedCsvForOwner({ privateDir, license, input, signal })).rowCount).toBe(2)
  })
})
