import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { runGenericOrderChallenge, verifyGenericOrderAdapter } from '../src/generic-order-adapter.ts'
import { readGenericOrderSource } from '../src/generic-order-source.ts'
import { installVerifiedOrderAdapterSource,
  loadInstalledVerifiedOrderAdapterSource } from '../src/order-buyer-install.ts'
import type { VerifiedOrderAdapterSource } from '../src/order-products-http.ts'
import { prepareRegisteredOrderAdapter } from '../src/registered-order-adapters.ts'
import { buildCanonicalOrderArchive } from '../src/order-source-archive.ts'

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'quickjs-order-v3-'))
  const skillRoot = join(home, 'skill')
  await cp(fileURLToPath(new URL('../examples/quickjs-char-count-skill/', import.meta.url)),
    skillRoot, { recursive: true })
  const skill = join(skillRoot, 'SKILL.md')
  const source = await readGenericOrderSource(skill)
  return { home, skill, source }
}

async function simulatedWindows<T>(run: () => Promise<T>): Promise<T> {
  const property = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try { return await run() }
  finally { if (property) Object.defineProperty(process, 'platform', property) }
}

it('self-tests and archives a new v3 task type without a Node adapter', async () => {
  const { home, skill, source } = await fixture()
  try {
    expect(source).toMatchObject({ entryPath: 'src/adapter.quickjs.js',
      declaration: { schema: 'qianshou.local-adapter-candidate.v3',
        runtime: { engine: 'quickjs-wasm', version: '0.32.0' } } })
    const prepared = await prepareRegisteredOrderAdapter(skill)
    expect(prepared.taskDefinition?.taskType).toBe('qianshou_quickjs_char_count_v1')
    expect(await prepared.verifyLocal(undefined)).toMatchObject({ localVerified: true,
      platformReady: false, taskType: source.declaration.taskType })
    const result = await runGenericOrderChallenge(source, Buffer.from('{"text":"你好🙂"}'))
    expect(result.output).toEqual({ count: 3 })
    const archive = await buildCanonicalOrderArchive(source.root, `sha256:${source.digest}`,
      source.inventoryAlgorithm)
    expect(archive.files.map(file => file.path)).toContain('src/adapter.quickjs.js')
    expect(archive.files.map(file => file.path)).not.toContain('src/adapter.mjs')
    await writeFile(join(source.root, 'src/adapter.quickjs.js'), 'function run() { return { count: 9 } }')
    await expect(buildCanonicalOrderArchive(source.root, `sha256:${source.digest}`,
      source.inventoryAlgorithm)).rejects.toMatchObject({ code: 'order-adapter-invalid' })
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('uses v3 on a simulated Windows Host and keeps the v2 Node sandbox closed there', async () => {
  const { home, skill, source } = await fixture()
  try {
    await simulatedWindows(async () => {
      expect(await verifyGenericOrderAdapter(source)).toMatchObject({ localVerified: true })
      expect(await (await prepareRegisteredOrderAdapter(skill)).verifyLocal(undefined))
        .toMatchObject({ localVerified: true })
      expect((await runGenericOrderChallenge(source, Buffer.from('{"text":"Windows"}'))).output)
        .toEqual({ count: 7 })
      const old = await readGenericOrderSource(fileURLToPath(new URL(
        '../examples/text-reverse-skill/SKILL.md', import.meta.url)))
      await expect(verifyGenericOrderAdapter(old))
        .rejects.toMatchObject({ code: 'order-runtime-unavailable' })
    })
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('installs and reopens exact reviewed v3 bytes under simulated Windows without host code access', async () => {
  const { home, source } = await fixture()
  try {
    const archive = await buildCanonicalOrderArchive(source.root, `sha256:${source.digest}`,
      source.inventoryAlgorithm)
    const signed: VerifiedOrderAdapterSource = {
      taskType: source.declaration.taskType, capabilityId: source.declaration.capabilityId,
      acceptedInputKinds: ['inline'], outputKind: 'inline_json', contractVersion: 'v1',
      inventoryAlgorithm: source.inventoryAlgorithm,
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
    await simulatedWindows(async () => {
      const installed = await installVerifiedOrderAdapterSource(signed, {
        home, trustedArchiveHostname: 'archive.example', fetch: send as typeof fetch,
      })
      expect(installed).toMatchObject({ taskType: signed.taskType, localVerified: true,
        deviceInstalled: false, orderAvailable: false })
      const loaded = await loadInstalledVerifiedOrderAdapterSource(signed, home)
      expect(loaded.runtimeDigest).toBe(installed.runtimeDigest)
      expect((await runGenericOrderChallenge(loaded.source,
        Buffer.from('{"text":"Win🙂"}'))).output).toEqual({ count: 4 })
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect((await readFile(join(source.root, 'src/adapter.quickjs.js'), 'utf8')))
      .toContain('function run(input)')
  } finally { await rm(home, { recursive: true, force: true }) }
})
