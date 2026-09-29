import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { NATIVE_H3_RUNTIME_V2, NATIVE_H3_RUNTIME_ABI_V2, NATIVE_H3_RUNTIME_ABI_CANONICAL, NATIVE_H3_RUNTIME_CANONICAL,
  nativeH3PublicBindingDigest, nativeH3LogicalBindingSha256,
  type AnyNativeH3Declaration as NativeH3Declaration }
  from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { isVerifiedNativeH3ReviewChallengeV2 as isVerifiedNativeH3ReviewChallenge,
  type NativeH3ReviewChallengeV2 as NativeH3ReviewChallenge, type NativeH3ReviewExecutionV2 as NativeH3ReviewExecution,
  type NativeH3ReviewArtifact, type VerifiedNativeH3ReviewChallengeV2 as VerifiedNativeH3ReviewChallenge }
  from '@deepseek-ai/dsh-compute-core/native-h3-review'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Catalog, { type Config } from '../src/index.ts'
import { nativeH3AuthoringTemplate, readNativeH3OrderSource } from '../src/native-h3-order-source.ts'
import { buildCanonicalOrderArchive } from '../src/order-source-archive.ts'
import { NATIVE_BINDING_INVENTORY_ALGORITHM } from '../src/order-source-inventory.ts'

const NOW = 1_800_000_000
const OWNER = 7
const WORKER = 'unit-native-lifecycle-worker'
const TOKEN = 'unit-private-lifecycle-token'
const ORIGIN = 'https://platform.invalid'
const binding = { schema: 'qianshou.native-h3-execution-binding.v2' as const, runtimeAbi: NATIVE_H3_RUNTIME_ABI_V2,
  runtime: NATIVE_H3_RUNTIME_V2,
  firstFrameSha256: 'a'.repeat(64), executionRecipeSha256: 'd'.repeat(64), modelSha256: 'e'.repeat(64) }
const PRIVATE = 'sha256:' + 'b'.repeat(64)
const attestor = generateKeyPairSync('ed25519')
const issuance = generateKeyPairSync('ed25519')
const presence = generateKeyPairSync('ed25519')
const contexts: Context[] = []
const homes: string[] = []
const gates: Array<() => void> = []

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW * 1000) })
afterEach(async () => {
  for (const release of gates.splice(0)) release()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
  vi.useRealTimers()
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

// Independent JSON and RFC 8410 bytes verify real signatures without the production canonicalizer.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`
  }
  const result = JSON.stringify(value)
  if (typeof result !== 'string') throw new Error('Expected JSON fixture')
  return result
}
function sha(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }
function rawKey(key: typeof attestor.publicKey): string {
  const bytes = key.export({ format: 'der', type: 'spki' })
  if (!Buffer.isBuffer(bytes) || bytes.length !== 44) throw new Error('Expected Ed25519 SPKI')
  return bytes.subarray(12).toString('base64url')
}
function verifies(publicKey: string, value: unknown, signature: string): boolean {
  const raw = Buffer.from(publicKey, 'base64url')
  expect(raw).toHaveLength(32)
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
    format: 'der', type: 'spki' })
  return verify(null, Buffer.from(canonical(value)), key, Buffer.from(signature, 'base64url'))
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected metadata object')
  return value as Record<string, unknown>
}
function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('Expected metadata JSON request')
  return record(JSON.parse(init.body) as unknown)
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected fixture text')
  return value
}
function deferred() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => { resolve = done })
  gates.push(resolve)
  return { promise, resolve }
}

interface RunInput {
  selection: { declaration: NativeH3Declaration; sourceDigest: string; taskDefinitionSha256: string }
  publicationId: string
  contractSha256: string
  challenge: VerifiedNativeH3ReviewChallenge
  signal: AbortSignal
  upload(input: { filename: 'result.mp4'; contentType: 'video/mp4'; bytes: Uint8Array; sha256: string },
    signal: AbortSignal): Promise<NativeH3ReviewArtifact>
}

async function fixture(runtime: 'python-v2' | 'canonical' = 'python-v2', canonicalAvailable = true) {
  const selectedBinding = runtime === 'canonical' ? { ...binding, runtimeAbi: NATIVE_H3_RUNTIME_ABI_CANONICAL, runtime: NATIVE_H3_RUNTIME_CANONICAL } : binding
  const qaRoot = process.env.QIANSHOU_TEST_TMPDIR ?? tmpdir()
  await mkdir(qaRoot, { recursive: true })
  const home = await realpath(await mkdtemp(join(qaRoot, 'native-h3-lifecycle-')))
  homes.push(home)
  const current = { ownerId: OWNER, workerId: WORKER, connectionId: '11111111-1111-4111-8111-111111111111', token: TOKEN, profileDir: home }
  const ownerChangedRead = deferred()
  const runFinished = deferred()
  const events: string[] = []
  const rows: Array<Record<string, unknown>> = []
  const skills: Array<{ name: string; source: 'user-agents'; path: string }> = []
  const sources = new Map<string, Awaited<ReturnType<typeof readNativeH3OrderSource>>>()
  const archives = new Map<string, Awaited<ReturnType<typeof buildCanonicalOrderArchive>>>()
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = []
  const runs: RunInput[] = []
  const enrollments = new Map<string, Record<string, unknown>>()
  const sessions = new Map<string, number>()
  const configHeads = new Set<string>()
  const hooks: {
    archive?: () => Promise<Response | undefined>
    observe?: () => Promise<void>
    run?: (input: RunInput) => Promise<void>
    mediaPut?: () => Response
    reportStatus?: (index: number) => 'awaiting_second_sample' | 'independent_sample_verified'
  } = {}
  let sequence = 0
  let reports = 0
  const addSkill = async (name: string) => {
    const root = join(home, 'skills', name)
    const template = nativeH3AuthoringTemplate(selectedBinding, name, `qianshou_${name.replaceAll('-', '_')}_v2`)
    for (const [member, bytes] of Object.entries(template.files)) {
      await mkdir(dirname(join(root, member)), { recursive: true })
      await writeFile(join(root, member), bytes)
    }
    const path = join(root, 'SKILL.md')
    const source = await readNativeH3OrderSource(path)
    sources.set(`sha256:${source.digest}`, source)
    archives.set(`sha256:${source.digest}`, await buildCanonicalOrderArchive(source.root,
      `sha256:${source.digest}`, NATIVE_BINDING_INVENTORY_ALGORITHM))
    const skill = { name, source: 'user-agents' as const, path }
    skills.push(skill)
    return skill
  }
  const skill = await addSkill('native-lifecycle-a')
  const nativeChallenge = (row: Record<string, unknown>, index: number, generation: number): NativeH3ReviewChallenge => {
    const source = sources.get(text(row.artifact_digest))
    if (source === undefined) throw new Error('Expected actual source')
    const input = { prompt: index === 1 ? '清晨雪山缓慢推进' : '傍晚海边缓慢平移', seconds: 5 as const, seed: index }
    return { schema: 'qianshou.native-h3-review-challenge.v2', purpose: 'qianshou:native-h3-review-challenge.v2',
      publication_id: text(row.id), owner_id: Number(row.owner_id), device_id: current.workerId,
      task_type: source.declaration.taskType, capability_id: 'video.render', contract_version: 'v2',
      contract_sha256: 'c'.repeat(64), artifact_digest: text(row.artifact_digest), source_digest: text(row.artifact_digest),
      logical_binding_sha256: nativeH3LogicalBindingSha256(selectedBinding), local_owner_config_digest: PRIVATE, device_binding_revision: 1,
      challenge_nonce: createHash('sha256').update(`${text(row.id)}:${generation}:${index}`).digest('base64url'),
      challenge_input: input, challenge_input_sha256: sha(input), issued_at: NOW, expires_at: NOW + 900 }
  }
  const fetcher: typeof fetch = async (value, init) => {
    const url = new URL(value instanceof Request ? value.url : value.toString())
    calls.push({ url, init })
    if (url.origin === 'https://storage.invalid') {
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
      expect(init?.body).toBeInstanceOf(Uint8Array)
      events.push('media-put')
      return hooks.mediaPut?.() ?? new Response(null, { headers: { 'x-amz-version-id': 'unit-immutable-version' } })
    }
    expect(url.origin).toBe(ORIGIN)
    expect(init?.redirect).toBe('error')
    const body = init?.method === 'POST' && typeof init.body === 'string' ? bodyOf(init) : {}
    if (url.pathname.endsWith('/mine')) return Response.json({ items: rows.filter(row => row.owner_id === current.ownerId) })
    if (url.pathname === '/api/v8/task-adapter-publications') {
      const id = `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`
      const row = { id, owner_id: current.ownerId, task_type: body.task_type, artifact_digest: body.artifact_digest,
        package_digest: body.package_digest, name: body.name, status: 'review', currency: 'CNY', price_yuan: '0.50',
        review_reasons: ['等待独立样例及管理员审核'], package_upload_status: 'confirmed', author_manifest_status: 'recorded',
        review_sample_status: 'pending', media_evidence_status: 'missing' }
      rows.push(row); events.push(`publication:${id}`)
      return Response.json(row)
    }
    if (url.pathname.endsWith('/task-adapter-publisher-keys/challenge')) return Response.json({
      schema: 'qianshou.order-adapter-key-enrollment.v1', owner_id: current.ownerId,
      challenge_id: '00000000-0000-4000-8000-000000000011', nonce: 'n'.repeat(43), expires_at: NOW + 240 })
    if (url.pathname.endsWith('/task-adapter-publisher-keys')) return Response.json({
      schema: 'qianshou.order-adapter-publisher-key.v1', owner_id: current.ownerId,
      key_id: body.key_id, public_key: body.public_key, status: 'active' })
    const id = url.pathname.split('/')[4]
    const row = rows.find(item => item.id === id)
    if (url.pathname.endsWith('/author-manifest')) {
      const manifest = record(body.author_manifest)
      events.push(`author-manifest:${id}`)
      return Response.json({ publication_id: id, owner_id: current.ownerId, key_id: manifest.key_id, status: 'recorded' })
    }
    if (url.pathname.endsWith('/package-upload')) {
      const override = await hooks.archive?.()
      if (override !== undefined) return override
      if (row === undefined) throw new Error('Expected exact publication source')
      const archive = archives.get(text(row.artifact_digest))
      if (archive === undefined) throw new Error('Expected actual canonical ZIP')
      events.push(`source-locked:${id}`)
      return Response.json({ publication_id: id, status: 'confirmed',
        object_key: `v8/account-${row.owner_id}/publication/${id}/adapter/source.zip`,
        archive_digest: archive.archiveDigest, size_bytes: archive.sizeBytes, version_id: 'unit-source-version' })
    }
    if (url.pathname.endsWith('/native-device-keys/challenge')) {
      const enrollment = { schema: 'qianshou.native-h3-device-enrollment.v1',
        purpose: 'qianshou:native-h3-device-key-enrollment', owner_id: current.ownerId, device_id: current.workerId,
        key_id: body.key_id, public_key: body.public_key, challenge_id: '00000000-0000-4000-8000-000000000012',
        nonce: 'n'.repeat(43), issued_at: NOW, expires_at: NOW + 300 }
      enrollments.set(current.workerId, enrollment)
      events.push('device-challenge')
      return Response.json(enrollment)
    }
    if (url.pathname.endsWith('/native-device-keys/register')) {
      const enrollment = enrollments.get(text(body.worker_id))
      if (enrollment === undefined) throw new Error('Expected observed enrollment')
      expect(verifies(text(enrollment.public_key), enrollment, text(body.signature))).toBe(true)
      events.push('device-register')
      return Response.json({ schema: 'qianshou.native-h3-device-key.v1', owner_id: enrollment.owner_id,
        device_id: enrollment.device_id, key_id: enrollment.key_id, public_key: enrollment.public_key, status: 'active' })
    }
    if (url.pathname.endsWith('/review-samples/start')) {
      events.push(`generic-start:${id}`)
      return Response.json({ publication_id: id, status: 'pending', media_evidence_status: 'missing',
        samples: { gif: { status: 'pending' }, mp4: { status: 'pending' } } })
    }
    if (row === undefined) throw new Error(`Unexpected publication route: ${url.pathname}`)
    if (url.pathname.includes('/native-device-configs')) {
      const registered = configHeads.has(text(id))
      const head = { schema: 'qianshou.native-h3-device-config.v2', publication_id: id, worker_id: current.workerId,
        logical_binding_sha256: nativeH3LogicalBindingSha256(selectedBinding), local_owner_config_digest: registered ? PRIVATE : null,
        device_binding_revision: registered ? 1 : 0, status: registered ? 'registered' : 'absent' }
      if (init?.method === 'GET') return Response.json(head)
      if (url.pathname.endsWith('/challenge')) {
        const payload = { schema: 'qianshou.native-h3-device-config-enrollment.v2',
          purpose: 'qianshou:native-h3-device-config-enrollment.v2',
          publication_id: id, owner_id: current.ownerId, device_id: current.workerId,
          task_type: sources.get(text(row.artifact_digest))!.declaration.taskType,
          capability_id: 'video.render', contract_version: 'v2', contract_sha256: 'c'.repeat(64), artifact_digest: row.artifact_digest,
          source_digest: row.artifact_digest, logical_binding_sha256: head.logical_binding_sha256, local_owner_config_digest: PRIVATE,
          device_binding_revision: 1, challenge_id: '00000000-0000-4000-8000-000000000021', nonce: Buffer.alloc(32,
            9).toString('base64url'),
          key_id: body.key_id, connection_id: current.connectionId, expected_revision: registered ? 1 : 0,
          issued_at: NOW, expires_at: NOW + 300 }
        events.push('config-challenge')
        return Response.json({ key_id: 'unit-review-key', payload, signature: sign(null,
          Buffer.from(canonical(payload)), attestor.privateKey).toString('base64url') })
      }
      configHeads.add(text(id)); events.push('config-registered')
      return Response.json({ ...head, local_owner_config_digest: PRIVATE, device_binding_revision: 1, status: 'registered' })
    }
    if (url.pathname.endsWith('/native-review-samples/start') || url.pathname.endsWith('/native-review-samples/restart')) {
      const generation = (sessions.get(text(id)) ?? 0) + 1
      sessions.set(text(id), generation)
      events.push(`${url.pathname.endsWith('/restart') ? 'samples-restart' : 'samples-start'}:${id}`)
      return Response.json({ schema: 'qianshou.native-h3-review-session.v2', publication_id: id,
        worker_id: current.workerId, challenges: [1, 2].map((index) => {
          const payload = nativeChallenge(row, index, generation)
          return { key_id: 'unit-review-key', payload,
            signature: sign(null, Buffer.from(canonical(payload)), attestor.privateKey).toString('base64url') }
        }) })
    }
    if (url.pathname.endsWith('/upload-intent')) {
      const workload = '00000000-0000-4000-8000-000000000013'
      const shard = '00000000-0000-4000-8000-000000000014'
      const objectKey = `v8/account-${row.owner_id}/workload-${workload}/shard-${shard}/result/${body.result_id}/result.mp4`
      const grant = { schema: 'qianshou.artifact-upload-issuance.v1',
        issuance_id: '00000000-0000-4000-8000-000000000015', account_id: row.owner_id, workload_id: workload,
        shard_id: shard, worker_id: current.workerId, attempt: 1, result_id: body.result_id, object_key: objectKey,
        sha256: body.sha256, size_bytes: body.size_bytes, content_type: 'video/mp4', issued_at: NOW, expires_at: NOW + 300 }
      return Response.json({ schema: 'qianshou.native-h3-review-upload-intent.v2', object_key: objectKey,
        result_id: body.result_id, upload_url: `https://storage.invalid/${objectKey}?unit-presign=fixture`, method: 'PUT',
        headers: { 'Content-Type': 'video/mp4', 'Content-MD5': body.content_md5,
          'x-amz-checksum-sha256': Buffer.from(text(body.sha256), 'hex').toString('base64'),
          'x-amz-object-lock-mode': 'COMPLIANCE',
          'x-amz-object-lock-retain-until-date': new Date((NOW + 50 * 3600) * 1000).toISOString().replace('.000Z', 'Z') },
        expires_at: NOW + 300, issuance_receipt: { key_id: 'unit-issuance-key', payload: grant,
          signature: sign(null, Buffer.from(canonical(grant)), issuance.privateKey).toString('base64url') } })
    }
    if (url.pathname.endsWith('/report')) {
      const signed = record(body.execution)
      const execution = record(signed.payload)
      const enrollment = enrollments.get(text(execution.device_id))
      if (enrollment === undefined) throw new Error('Expected actual device enrollment')
      expect(Object.keys(execution)).toHaveLength(20)
      expect(verifies(text(enrollment.public_key), execution, text(signed.signature))).toBe(true)
      const index = ++reports
      const status = hooks.reportStatus?.(index) ?? (index % 2 === 1 ? 'awaiting_second_sample' : 'independent_sample_verified')
      events.push(`reported:${index}`)
      return Response.json({ schema: 'qianshou.native-h3-review-report-response.v2', publication_id: id,
        worker_id: execution.device_id, challenge_nonce: execution.challenge_nonce, status,
        sample_receipt: status === 'awaiting_second_sample' ? null : { evidence: 'unit-independent-two-sample-receipt' },
        approval_required: true })
    }
    throw new Error(`Unexpected control route: ${url.pathname}`)
  }
  vi.stubGlobal('fetch', fetcher)
  const ctx = new Context()
  contexts.push(ctx)
  const config: Config = { registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000,
    connection: 'shipped', apiBaseUrl: '', installHome: home, publisherKeys: {}, coreOrigin: ORIGIN,
    orderArchiveHostname: 'storage.invalid', orderNativeH3AttestorKeys: { 'unit-presence-key': rawKey(presence.publicKey) },
    orderNativeH3ChallengeKeys: { 'unit-review-key': rawKey(attestor.publicKey) },
    orderNativeH3UploadIssuanceKeys: { 'unit-issuance-key': rawKey(issuance.publicKey) } }
  await ctx.plugin(Catalog, config)
  ctx.provide('profileContext', { get dir() { return current.profileDir } })
  ctx.provide('qianshouSkillImport', { listLocal: async () => ({ skills }) })
  ctx.provide('qianshouAccount', { state: async () => {
    const id = current.ownerId
    if (id !== OWNER) ownerChangedRead.resolve()
    return { phase: 'authenticated', account: { id: String(id) } }
  } })
  ctx.provide('accountSession', { ensureAccessToken: async () => current.token })
  ctx.provide('nodeContributor', {
    nativeH3AuthorBindingV2: async () => {
      expect(runtime).toBe('python-v2')
      return { binding: selectedBinding, localOwnerConfigDigest: PRIVATE }
    },
    nativeH3AuthorBindingCanonical: async () => {
      expect(runtime).toBe('canonical')
      if (!canonicalAvailable) throw new Error('H3_CANONICAL_SELF_TEST_INVALID')
      return { binding: selectedBinding, localOwnerConfigDigest: PRIVATE }
    },
    observeNativeH3DeviceConfigProof: async () => { events.push('config-witness') },
    acknowledgedWorkerId: () => current.workerId,
    acknowledgedConnectionId: () => current.connectionId,
    selectNativeH3AuthorBinding: async (selection: RunInput['selection']) => ({
      taskType: selection.declaration.taskType, artifactDigest: selection.sourceDigest,
      packageDigest: nativeH3PublicBindingDigest(selection.declaration), inventoryAlgorithm: NATIVE_BINDING_INVENTORY_ALGORITHM,
      localVerified: true, platformReady: false }),
    async observeNativeH3DeviceKeyProof(input: { challengeId: string; signature: string }) {
      const enrollment = enrollments.get(current.workerId)
      if (enrollment === undefined) throw new Error('Expected enrollment before socket observation')
      expect(input.challengeId).toBe(enrollment.challenge_id)
      expect(verifies(text(enrollment.public_key), enrollment, input.signature)).toBe(true)
      events.push('socket-observed')
      await hooks.observe?.()
    },
    async runNativeH3ReviewChallenge(input: RunInput): Promise<NativeH3ReviewExecution> {
      runs.push(input)
      try {
        expect(isVerifiedNativeH3ReviewChallenge(input.challenge, input.challenge.payload, NOW)).toBe(true)
        expect(input.selection.sourceDigest).toBe(input.challenge.payload.source_digest)
        expect(input.publicationId).toBe(input.challenge.payload.publication_id)
        await hooks.run?.(input)
        input.signal.throwIfAborted()
        // Port fixture exercises upload/sign/report wiring; it is not a GPU or real MP4 acceptance claim.
        const bytes = new Uint8Array(Buffer.from(`unit-port-bytes:${input.challenge.payload.challenge_nonce}`))
        const artifact = await input.upload({ filename: 'result.mp4', contentType: 'video/mp4', bytes,
          sha256: createHash('sha256').update(bytes).digest('hex') }, input.signal)
        const p = input.challenge.payload
        return { schema: 'qianshou.native-h3-review-execution.v2', purpose: 'qianshou:native-h3-review-execution.v2',
          publication_id: p.publication_id, owner_id: p.owner_id, device_id: p.device_id, task_type: p.task_type,
          capability_id: p.capability_id, contract_version: p.contract_version, contract_sha256: p.contract_sha256,
          artifact_digest: p.artifact_digest, source_digest: p.source_digest, logical_binding_sha256: p.logical_binding_sha256,
          local_owner_config_digest: p.local_owner_config_digest, device_binding_revision: p.device_binding_revision,
          challenge_nonce: p.challenge_nonce, challenge_input_sha256: p.challenge_input_sha256,
          challenge_result_sha256: sha(artifact), artifact, issued_at: NOW, expires_at: NOW + 900 }
      } finally { runFinished.resolve() }
    },
  })
  const catalog = ctx.qianshouPluginCatalog
  const publish = (name = skill.name) => catalog.submitInstalledOrderSkill({ source: 'user-agents', name,
    displayName: '本机 H3 审核接线测试', purpose: '独立验证发布后的两份样例接线', configuration: '', priceYuan: '0.50' })
  const list = () => catalog.myOrderSkillPublications()
  const status = async () => (await list()).items[0]?.reviewSampleStatus
  return { catalog, current, home, skill, runFinished, ownerChangedRead, addSkill,
    sources, rows, calls, runs, events, hooks, publish, list, status }
}


it.each(['python-v2', 'canonical'] as const)('orchestrates actual %s catalog source lock, CAS witness, two distinct signed samples, immutable upload and signed execution20 without approval', async (runtime) => {
  const f = await fixture(runtime)
  expect(await f.list()).toEqual({ items: [] })
  expect(f.runs).toHaveLength(0)
  const submitted = await f.publish()
  expect(submitted).toMatchObject({ status: 'review', archiveStatus: 'confirmed', reviewSampleStatus: 'pending', platformReady: false })
  await expect.poll(f.status).toBe('evidence_deposited')
  expect(f.runs).toHaveLength(2)
  expect(f.runs.map(run => run.challenge.payload.contract_version)).toEqual(['v2', 'v2'])
  expect(f.runs[0]!.challenge.payload.challenge_nonce).not.toBe(f.runs[1]!.challenge.payload.challenge_nonce)
  expect(f.events.indexOf('config-registered')).toBeGreaterThan(f.events.indexOf('config-witness'))
  expect(f.events.indexOf('config-witness')).toBeGreaterThan(f.events.indexOf('config-challenge'))
  expect(f.events.filter(event => event.startsWith('generic-start:'))).toEqual([])
  expect(f.calls.every(call => !/approve|payment|dispatch/u.test(call.url.pathname))).toBe(true)
  expect((await f.list()).items[0]).toMatchObject({ status: 'review', reviewSampleStatus: 'evidence_deposited' })
})
it('blocks a V2 unknown immutable upload after one actual run and does not retry or promote the first sample to approved', async () => {
  const f = await fixture(); f.hooks.mediaPut = () => new Response(null, { status: 503 })
  await f.publish(); await expect.poll(f.status).toBe('blocked')
  expect(f.runs).toHaveLength(1)
  expect(f.events.filter(event => event.startsWith('reported:'))).toEqual([])
  expect((await f.list()).items[0]?.status).toBe('review')
})


it('keeps a confirmed canonical source blocked when its actual canonical preparation fails, without selecting the V2 runner or starting GPU samples', async () => {
  const f = await fixture('canonical', false)
  const submitted = await f.publish()
  expect(submitted).toMatchObject({ status: 'review', archiveStatus: 'confirmed', reviewSampleStatus: 'blocked', platformReady: false })
  expect(f.runs).toHaveLength(0)
  expect(f.calls.some(call => call.url.pathname.endsWith('/native-review-samples/start'))).toBe(false)
})
