import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { cp, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { installVerifiedOrderAdapterSource, loadInstalledVerifiedOrderAdapterSource } from '../src/order-buyer-install.ts'
import { runGenericOrderChallenge } from '../src/generic-order-adapter.ts'
import { loadOwnedInstalledRuntime } from '../src/order-purchased-runtime.ts'
import { readGenericOrderSource } from '../src/generic-order-source.ts'
import { buildCanonicalOrderArchive } from '../src/order-source-archive.ts'
import { runInstalledOrderAdapterChallenge } from '../src/order-remote-challenge.ts'
import { activateVerifiedOrderAdapter } from '../src/order-buyer-activation.ts'
import type { VerifiedOrderAdapterSource } from '../src/order-products-http.ts'

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'order-buyer-runtime-'))
  const skillRoot = join(home, 'author-skill')
  await cp(fileURLToPath(new URL('../examples/text-reverse-skill/', import.meta.url)),
    skillRoot, { recursive: true })
  const source = await readGenericOrderSource(join(skillRoot, 'SKILL.md'))
  const archive = await buildCanonicalOrderArchive(source.root, `sha256:${source.digest}`,
    'qianshou.source-package.v1')
  const verified: VerifiedOrderAdapterSource = {
    taskType: source.declaration.taskType, capabilityId: source.declaration.capabilityId,
    acceptedInputKinds: ['inline'], outputKind: source.declaration.outputKind, contractVersion: 'v1',
    inventoryAlgorithm: 'qianshou.source-package.v1',
    check: { productId: 'product', entitlementId: 'entitlement', publicationId: 'publication',
      archiveDigest: archive.archiveDigest, archiveSizeBytes: archive.sizeBytes,
      archiveVersionId: 'version-1', archiveFormat: 'zip-source-v1',
      signatureVerified: true, packageReceiptVerified: true, deviceInstalled: false,
      nextStep: 'archive-download-and-device-verification-required' },
    archiveBucket: 'test-bucket', artifactDigest: archive.artifactDigest,
    reviewedSellerRuntimeDigest: `sha256:${'b'.repeat(64)}`,
    downloadUrl: 'https://archive.example/adapter.zip?versionId=version-1',
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    files: archive.files.map(file => ({ path: file.path, sizeBytes: file.size_bytes,
      sha256: file.sha256 })),
  }
  const send = vi.fn(async () => new Response(Uint8Array.from(archive.bytes), { status: 200,
    headers: { 'content-length': String(archive.sizeBytes) } }))
  return { home, verified, send, archive }
}

it('installs and independently runs v5 examples from the private buyer runtime, without advertising it', async () => {
  if (process.platform !== 'darwin') return
  const { home, verified, send } = await fixture()
  try {
    const input = { home, trustedArchiveHostname: 'archive.example', fetch: send as typeof fetch }
    const installed = await installVerifiedOrderAdapterSource(verified, input)
    expect(installed).toMatchObject({ taskType: 'text_reverse_v1', sourceVerified: true,
      localVerified: true, deviceInstalled: false, orderAvailable: false,
      nextStep: 'independent-device-install-attestation-required' })
    expect(installed.runtimeDigest).toMatch(/^sha256:[0-9a-f]{64}$/u)
    const version = digest(Buffer.from('version-1'))
    const target = join(home, 'qianshou', 'order-adapter-runtime', 'product', 'entitlement', version)
    expect(JSON.parse(await readFile(join(target, 'local-install.json'), 'utf8'))).toMatchObject({
      archiveDigest: verified.check.archiveDigest, runtimeDigest: installed.runtimeDigest,
      dependenciesInstalled: 0, status: 'locally-verified-awaiting-independent-attestation',
    })
    expect((await installVerifiedOrderAdapterSource(verified, input)).runtimeDigest)
      .toBe(installed.runtimeDigest)
    const loaded = await loadInstalledVerifiedOrderAdapterSource(verified, home)
    expect(loaded.runtimeDigest).toBe(installed.runtimeDigest)
    const owned = { productId: verified.check.productId, entitlementId: verified.check.entitlementId,
      productName: '文字反转', status: 'installed' as const, deviceInstalled: true,
      runtimeDigest: installed.runtimeDigest, installExpiresAt: null }
    expect((await loadOwnedInstalledRuntime(owned, verified, home))?.runtime).toMatchObject({
      taskType: 'text_reverse_v1', capabilityId: verified.capabilityId,
      artifactDigest: verified.artifactDigest, packageDigest: verified.reviewedSellerRuntimeDigest,
    })
    expect(await loadOwnedInstalledRuntime({ ...owned,
      runtimeDigest: `sha256:${'f'.repeat(64)}` }, verified, home)).toBeNull()
    expect(await loadOwnedInstalledRuntime({ ...owned, deviceInstalled: false }, verified, home)).toBeNull()
    expect(await loadOwnedInstalledRuntime({ ...owned, entitlementId: 'different' }, verified, home)).toBeNull()
    expect(await loadOwnedInstalledRuntime(owned, { ...verified, outputKind: 'artifact_ref' }, home)).toBeNull()
    const executed = await runGenericOrderChallenge(loaded.source,
      Buffer.from(JSON.stringify({ text: 'abc' })))
    expect(executed.output).toEqual({ text: 'cba' })
    expect(send).toHaveBeenCalledTimes(1)
    await writeFile(join(target, 'scripts/order_adapter/src/adapter.mjs'), 'process.stdout.write("{}")\n')
    await expect(loadInstalledVerifiedOrderAdapterSource(verified, home)).rejects.toMatchObject({
      code: 'order-install-manifest-invalid',
    })
    await expect(installVerifiedOrderAdapterSource(verified, input)).rejects.toMatchObject({
      code: 'order-install-manifest-invalid',
    })
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('creates a private home on the first one-click install and refuses a symlink home', async () => {
  if (process.platform !== 'darwin') return
  const { home, verified, send } = await fixture()
  try {
    const fresh = join(home, 'new-market-home')
    const installed = await installVerifiedOrderAdapterSource(verified, {
      home: fresh, trustedArchiveHostname: 'archive.example', fetch: send as typeof fetch,
    })
    expect(installed.localVerified).toBe(true)
    const entry = await lstat(fresh)
    expect(entry.isDirectory() && !entry.isSymbolicLink()).toBe(true)
    const linked = join(home, 'linked-market-home')
    await symlink(fresh, linked)
    await expect(installVerifiedOrderAdapterSource(verified, {
      home: linked, trustedArchiveHostname: 'archive.example', fetch: send as typeof fetch,
    })).rejects.toMatchObject({ code: 'order-install-not-ready' })
    expect(send).toHaveBeenCalledTimes(1)
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('refuses a mismatched reviewed task identity and non-self-contained install contract', async () => {
  if (process.platform !== 'darwin') return
  const { home, verified, send } = await fixture()
  try {
    const input = { home, trustedArchiveHostname: 'archive.example', fetch: send as typeof fetch }
    await expect(installVerifiedOrderAdapterSource({ ...verified, taskType: 'other_task' }, input))
      .rejects.toMatchObject({ code: 'order-install-manifest-invalid' })
    await expect(installVerifiedOrderAdapterSource({ ...verified,
      acceptedInputKinds: ['file_ref'] }, input))
      .rejects.toMatchObject({ code: 'order-install-not-ready' })
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('runs a fresh independently signed input in the installed buyer sandbox and returns its digest', async () => {
  if (process.platform !== 'darwin') return
  const { home, verified, archive } = await fixture()
  try {
    const nonce = '302bcfe7-7ec0-4f4a-b702-bb2a65d39860'
    const nodeId = 'b3cb439c-4adf-4669-8f1f-037ce1f3ecbc'
    const challenge = Buffer.from(JSON.stringify({ text: `fresh-${nonce}` }))
    const now = Math.floor(Date.now() / 1000)
    const payload = {
      schema: 'qianshou.order-adapter-remote-challenge-plan.v1', challenge_nonce: nonce,
      product_id: verified.check.productId, entitlement_id: verified.check.entitlementId,
      buyer_id: 7, publication_id: verified.check.publicationId, device_id: nodeId,
      archive_digest: verified.check.archiveDigest,
      archive_version_id: verified.check.archiveVersionId,
      artifact_digest: verified.artifactDigest,
      reviewed_seller_runtime_digest: verified.reviewedSellerRuntimeDigest,
      input_kind: 'inline',
      challenge_input_sha256: `sha256:${digest(challenge)}`,
      input_ref: `/challenges/${nonce}/input`, issued_at: now, expires_at: now + 90,
    }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const attestorPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
    const signedPlan = (value: typeof payload) => ({ key_id: 'independent-v1', payload: value,
      signature: sign(null, Buffer.from(JSON.stringify(value, Object.keys(value).sort())),
        privateKey).toString('base64url') })
    const inputEnvelope = Buffer.from(JSON.stringify({
      schema: 'qianshou.order-adapter-remote-challenge-input.v1',
      challenge_nonce: nonce, input_kind: 'inline', input: JSON.parse(challenge.toString('utf8')),
      challenge_input_sha256: payload.challenge_input_sha256,
    }))
    const send = vi.fn(async (url: URL) => new Response(
      Uint8Array.from(url.pathname.endsWith('/input') ? inputEnvelope : archive.bytes),
      { status: 200, headers: { 'content-length': String(url.pathname.endsWith('/input')
        ? inputEnvelope.length : archive.sizeBytes) } })) as unknown as typeof fetch
    const input = { source: verified, home, trustedArchiveHostname: 'archive.example',
      attestorOrigin: 'https://attestor.example/', attestorHostname: 'attestor.example',
      attestorKeyId: 'independent-v1', attestorPublicKey, nodeId,
      signedPlan: signedPlan(payload), fetch: send }
    const result = await runInstalledOrderAdapterChallenge(input)
    expect(result.output).toEqual({ text: [...`fresh-${nonce}`].reverse().join('') })
    expect(result.challengeInputSha256).toBe(payload.challenge_input_sha256)
    expect(result.challengeResultSha256).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(result.runtimeDigest).toMatch(/^sha256:[0-9a-f]{64}$/u)
    await expect(runInstalledOrderAdapterChallenge({ ...input,
      signedPlan: signedPlan({ ...payload, device_id: 'another-device' }) }))
      .rejects.toMatchObject({ code: 'order-install-manifest-invalid' })
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('activates only after the independent challenge and Shanghai both confirm the exact device', async () => {
  if (process.platform !== 'darwin') return
  const { home, verified, archive } = await fixture()
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal)
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => nativeTimeout(ms))
  try {
    const workerId = '928e191b-bde8-4b28-a5aa-65bd10844b66'
    const nonce = 'f8e42af1-e7a0-4c60-a53d-aa8d04def69b'
    const now = Math.floor(Date.now() / 1000)
    const challengeInput = { text: `independent-${nonce}` }
    const inputDigest = `sha256:${digest(Buffer.from(JSON.stringify(challengeInput)))}`
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const keyId = 'isolated-attestor'
    const attestorPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
    const signed = (payload: Record<string, unknown>) => ({ key_id: keyId, payload,
      signature: sign(null, Buffer.from(JSON.stringify(payload, Object.keys(payload).sort())),
        privateKey).toString('base64url') })
    const plan = signed({ schema: 'qianshou.order-adapter-remote-challenge-plan.v1',
      challenge_nonce: nonce, product_id: verified.check.productId,
      entitlement_id: verified.check.entitlementId, buyer_id: 7,
      publication_id: verified.check.publicationId, device_id: workerId,
      archive_digest: verified.check.archiveDigest,
      archive_version_id: verified.check.archiveVersionId,
      artifact_digest: verified.artifactDigest,
      reviewed_seller_runtime_digest: verified.reviewedSellerRuntimeDigest,
      input_kind: 'inline', challenge_input_sha256: inputDigest,
      input_ref: `/challenges/${nonce}/input`, issued_at: now, expires_at: now + 90 })
    let accepted = 0
    const send = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.hostname === 'archive.example') return new Response(Uint8Array.from(archive.bytes))
      if (url.pathname.endsWith('/activation-challenge')) return Response.json({
        schema: 'qianshou.order-adapter-activation-challenge.v1',
        product_id: verified.check.productId, worker_id: workerId,
        signed_plan: plan, attestor_origin: 'https://attestor.example/',
        attestor_key_id: keyId, attestor_public_key: attestorPublicKey })
      if (url.pathname.endsWith('/input')) return Response.json({
        schema: 'qianshou.order-adapter-remote-challenge-input.v1',
        challenge_nonce: nonce, input_kind: 'inline', input: challengeInput,
        challenge_input_sha256: inputDigest })
      if (url.pathname.endsWith('/result')) {
        const posted = JSON.parse(String(init?.body)) as Record<string, unknown>
        const output = posted.challenge_output
        const resultDigest = `sha256:${digest(Buffer.from(JSON.stringify(output)))}`
        return Response.json({ schema: 'qianshou.order-adapter-remote-challenge-result-response.v1',
          status: 'passed', receipt: signed({
            schema: 'qianshou.order-adapter-remote-challenge.v1', result: 'passed',
            product_id: verified.check.productId, entitlement_id: verified.check.entitlementId,
            buyer_id: 7, publication_id: verified.check.publicationId, device_id: workerId,
            archive_digest: verified.check.archiveDigest,
            archive_version_id: verified.check.archiveVersionId,
            artifact_digest: verified.artifactDigest,
            reviewed_seller_runtime_digest: verified.reviewedSellerRuntimeDigest,
            runtime_digest: posted.runtime_digest, challenge_nonce: nonce,
            challenge_input_sha256: inputDigest, challenge_result_sha256: resultDigest,
            issued_at: now, expires_at: now + 600,
          }) })
      }
      if (url.pathname.endsWith('/install-receipt')) {
        accepted += 1
        const receipt = JSON.parse(String(init?.body)) as { payload: Record<string, unknown> }
        return Response.json({ product_id: verified.check.productId,
          status: 'installed', device_id: receipt.payload.device_id,
          runtime_digest: receipt.payload.runtime_digest, device_installed: true })
      }
      return new Response(null, { status: 404 })
    }) as unknown as typeof fetch
    const observed = vi.fn(async () => undefined)
    const activation = await activateVerifiedOrderAdapter({ source: verified, home,
      coreOrigin: 'https://core.example/', token: 'buyer-token', workerId,
      trustedArchiveHostname: 'archive.example', trustedAttestorHostname: 'attestor.example',
      observeNodeChallenge: observed, fetch: send })
    expect(timeout).toHaveBeenCalledWith(60_000)
    expect(timeout).toHaveBeenCalledWith(15_000)
    expect(accepted).toBe(1)
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ challengeNonce: nonce,
      inputDigest, artifactDigest: verified.artifactDigest }))
    expect(activation).toMatchObject({ productId: verified.check.productId, deviceId: workerId,
      deviceInstalled: true, dispatchEligible: true })
    expect(activation.runtimeDigest).toMatch(/^sha256:[0-9a-f]{64}$/u)
    const unavailable = vi.fn(async (url: URL, init?: RequestInit) =>
      url.pathname.endsWith('/result') ? new Response(null, { status: 503 })
        : send(url, init)) as unknown as typeof fetch
    await expect(activateVerifiedOrderAdapter({ source: verified, home,
      coreOrigin: 'https://core.example/', token: 'buyer-token', workerId,
      trustedArchiveHostname: 'archive.example', trustedAttestorHostname: 'attestor.example',
      observeNodeChallenge: observed, fetch: unavailable })).rejects.toMatchObject({ code: 'order-attestor-unavailable' })
    expect(accepted).toBe(1)
    await expect(activateVerifiedOrderAdapter({ source: verified, home,
      coreOrigin: 'https://core.example/', token: 'buyer-token', workerId,
      trustedArchiveHostname: 'archive.example', trustedAttestorHostname: 'attestor.example',
      observeNodeChallenge: async () => { throw new Error('ws down') }, fetch: send })).rejects.toThrow('ws down')
    expect(accepted).toBe(1)
  } finally { timeout.mockRestore(); await rm(home, { recursive: true, force: true }) }
})
