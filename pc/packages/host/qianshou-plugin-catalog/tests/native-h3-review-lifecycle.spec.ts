import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { NATIVE_H3_RUNTIME, NATIVE_H3_RUNTIME_ABI, type NativeH3Declaration }
  from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { isVerifiedNativeH3ReviewChallenge, type NativeH3ReviewChallenge, type NativeH3ReviewExecution,
  type NativeH3ReviewArtifact, type VerifiedNativeH3ReviewChallenge }
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
const binding = { runtimeAbi: NATIVE_H3_RUNTIME_ABI, runtime: NATIVE_H3_RUNTIME,
  ownerConfigDigest: `sha256:${'b'.repeat(64)}`, executionRecipeSha256: 'd'.repeat(64), modelSha256: 'e'.repeat(64) }
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

async function fixture() {
  const qaRoot = process.env.QIANSHOU_TEST_TMPDIR ?? tmpdir()
  await mkdir(qaRoot, { recursive: true })
  const home = await realpath(await mkdtemp(join(qaRoot, 'native-h3-lifecycle-')))
  homes.push(home)
  const current = { ownerId: OWNER, workerId: WORKER, connectionId: 'unit-live-connection', token: TOKEN, profileDir: home }
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
    const template = nativeH3AuthoringTemplate(binding, name, `qianshou_${name.replaceAll('-', '_')}_v1`)
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
    return { schema: 'qianshou.native-h3-review-challenge.v1', purpose: 'qianshou:native-h3-review-challenge',
      publication_id: text(row.id), owner_id: Number(row.owner_id), device_id: current.workerId,
      task_type: source.declaration.taskType, capability_id: 'video.render', contract_version: 'v1',
      contract_sha256: 'c'.repeat(64), artifact_digest: text(row.artifact_digest), source_digest: text(row.artifact_digest),
      config_digest: binding.ownerConfigDigest, challenge_nonce: `unit-review-${text(row.id)}-g${generation}-${index}`,
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
    if (url.pathname.endsWith('/native-review-samples/start') || url.pathname.endsWith('/native-review-samples/restart')) {
      const generation = (sessions.get(text(id)) ?? 0) + 1
      sessions.set(text(id), generation)
      events.push(`${url.pathname.endsWith('/restart') ? 'samples-restart' : 'samples-start'}:${id}`)
      return Response.json({ schema: 'qianshou.native-h3-review-session.v1', publication_id: id,
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
      return Response.json({ schema: 'qianshou.native-h3-review-upload-intent.v1', object_key: objectKey,
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
      expect(Object.keys(execution)).toHaveLength(18)
      expect(verifies(text(enrollment.public_key), execution, text(signed.signature))).toBe(true)
      const index = ++reports
      const status = hooks.reportStatus?.(index) ?? (index % 2 === 1 ? 'awaiting_second_sample' : 'independent_sample_verified')
      events.push(`reported:${index}`)
      return Response.json({ schema: 'qianshou.native-h3-review-report-response.v1', publication_id: id,
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
    acknowledgedWorkerId: () => current.workerId,
    acknowledgedConnectionId: () => current.connectionId,
    selectNativeH3AuthorBinding: async (selection: RunInput['selection']) => ({
      taskType: selection.declaration.taskType, artifactDigest: selection.sourceDigest,
      packageDigest: selection.declaration.ownerConfigDigest, inventoryAlgorithm: NATIVE_BINDING_INVENTORY_ALGORITHM,
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
        return { schema: 'qianshou.native-h3-review-execution.v1', purpose: 'qianshou:native-h3-review-execution',
          publication_id: p.publication_id, owner_id: p.owner_id, device_id: p.device_id, task_type: p.task_type,
          capability_id: p.capability_id, contract_version: p.contract_version, contract_sha256: p.contract_sha256,
          artifact_digest: p.artifact_digest, source_digest: p.source_digest, config_digest: p.config_digest,
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

it('does not queue GPU review from inventory or publication reads', async () => {
  const f = await fixture()
  expect((await f.catalog.localOrderSkillEligibility()).items).toHaveLength(1)
  expect(await f.list()).toEqual({ items: [] })
  expect(f.calls.map(call => call.url.pathname)).toEqual(['/api/v8/task-adapter-publications/mine'])
  expect(f.runs).toHaveLength(0)
})

it('queues only after user publication and the exact canonical source ZIP is locked, then deposits two samples without approval', async () => {
  const f = await fixture()
  const entered = deferred(); const gate = deferred()
  f.hooks.archive = async () => { entered.resolve(); await gate.promise; return undefined }
  const pending = f.publish()
  await entered.promise
  expect(f.events.filter(event => event.startsWith('publication:'))).toHaveLength(1)
  expect(f.events.some(event => event.startsWith('author-manifest:'))).toBe(true)
  expect(f.events).not.toContain('device-challenge')
  expect(f.runs).toHaveLength(0)
  gate.resolve()
  expect(await pending).toMatchObject({ archiveStatus: 'confirmed', reviewSampleStatus: 'pending', status: 'review', platformReady: false })
  await expect.poll(f.status).toBe('evidence_deposited')
  expect(f.runs).toHaveLength(2)
  expect(f.runs[0]?.challenge.payload.challenge_nonce).not.toBe(f.runs[1]?.challenge.payload.challenge_nonce)
  expect(f.runs[0]?.challenge.payload.challenge_input).not.toEqual(f.runs[1]?.challenge.payload.challenge_input)
  const result = (await f.list()).items[0]
  expect(result).toMatchObject({ status: 'review', reviewSampleStatus: 'evidence_deposited', mediaEvidenceStatus: 'missing' })
  expect(result?.marketProductStatus).toBeUndefined()
  expect(f.events.indexOf('device-challenge')).toBeGreaterThan(f.events.findIndex(event => event.startsWith('source-locked:')))
  expect(f.events.indexOf('device-register')).toBeGreaterThan(f.events.indexOf('socket-observed'))
})

it('does not enroll or run samples when source upload fails', async () => {
  const f = await fixture()
  f.hooks.archive = async () => new Response(null, { status: 503 })
  expect(await f.publish()).toMatchObject({ status: 'review', archiveStatus: 'pending', archiveError: 'order-archive-unavailable', platformReady: false })
  expect(f.events).not.toContain('device-challenge')
  expect(f.runs).toHaveLength(0)
})

it('blocks failed immutable media uploads without reporting verified evidence or starting the second sample', async () => {
  const f = await fixture()
  f.hooks.mediaPut = () => new Response(null, { status: 503 })
  await f.publish()
  await expect.poll(f.status).toBe('blocked')
  expect(f.runs).toHaveLength(1)
  expect(f.events.filter(event => event.startsWith('reported:'))).toEqual([])
  expect((await f.list()).items[0]).toMatchObject({ status: 'review', reviewSampleStatus: 'blocked' })
})

it('coalesces repeated archive retries for the same owner, publication and source while review is pending', async () => {
  const f = await fixture()
  const entered = deferred(); const gate = deferred()
  f.hooks.observe = async () => { entered.resolve(); await gate.promise }
  const first = await f.publish()
  await entered.promise
  expect(await f.catalog.retryInstalledOrderSkillArchive({ source: 'user-agents', name: f.skill.name }))
    .toMatchObject({ publicationId: first.publicationId, reviewSampleStatus: 'pending', status: 'review' })
  expect(f.events.filter(event => event === 'device-challenge')).toHaveLength(1)
  expect(f.events.filter(event => event.startsWith('samples-start:'))).toEqual([])
  gate.resolve()
  await expect.poll(f.status).toBe('evidence_deposited')
  expect(f.runs).toHaveLength(2)
})

it.each(['owner', 'worker', 'connection', 'token', 'profile'] as const)(
  'stops the scoped queue when current %s changes during socket observation', async (field) => {
    const f = await fixture()
    const entered = deferred(); const gate = deferred()
    f.hooks.observe = async () => { entered.resolve(); await gate.promise }
    await f.publish()
    await entered.promise
    if (field === 'owner') f.current.ownerId++
    if (field === 'worker') f.current.workerId = 'other-worker'
    if (field === 'connection') f.current.connectionId = 'new-live-connection'
    if (field === 'token') f.current.token = 'rotated-token'
    if (field === 'profile') {
      f.current.profileDir = join(f.home, 'other-profile')
      await mkdir(f.current.profileDir)
    }
    gate.resolve()
    // Owner changes must hide the old publication immediately, but its old queue must still stop.
    if (field === 'owner') {
      await f.ownerChangedRead.promise
      expect(await f.list()).toEqual({ items: [] })
    }
    else await expect.poll(f.status).toBe('blocked')
    if (field === 'owner') {
      f.current.ownerId = OWNER
      await expect.poll(f.status).toBe('blocked')
    }
    expect(f.events).not.toContain('device-register')
    expect(f.runs).toHaveLength(0)
  })

it('rejects a valid source byte change before upload and does not project old review state onto the new source', async () => {
  const f = await fixture()
  const entered = deferred(); const gate = deferred()
  f.hooks.run = async () => { entered.resolve(); await gate.promise }
  await f.publish(); await entered.promise
  const file = join(dirname(f.skill.path), 'scripts/order_adapter/package.json')
  const before = await readFile(file, 'utf8')
  const packageJson = record(JSON.parse(before) as unknown)
  await writeFile(file, canonical({ ...packageJson, version: '0.0.2' }))
  expect((await f.list()).items).toEqual([])
  gate.resolve()
  await f.runFinished.promise
  // Only this fixture is restored, after the actual upload guard has already rejected its changed source.
  await writeFile(file, before)
  await expect.poll(f.status).toBe('blocked')
  expect((await f.list()).items[0]).toMatchObject({ reviewSampleError: 'order-local-verification-failed' })
  expect(f.events).not.toContain('media-put')
  expect(f.events.filter(event => event.startsWith('reported:'))).toEqual([])
  expect(f.runs).toHaveLength(1)
})

it('keeps another publication source pending while one scoped queue is blocked', async () => {
  const f = await fixture()
  const other = await f.addSkill('native-lifecycle-b')
  f.hooks.mediaPut = () => new Response(null, { status: 503 })
  const first = await f.publish()
  await expect.poll(f.status).toBe('blocked')
  const otherSource = [...f.sources.values()].find(source => source.declaration.taskType.endsWith('_b_v1'))
  if (otherSource === undefined) throw new Error('Expected independent second source')
  f.rows.push({ id: '00000000-0000-4000-8000-000000000099', owner_id: OWNER,
    task_type: otherSource.declaration.taskType, artifact_digest: `sha256:${otherSource.digest}`,
    package_digest: binding.ownerConfigDigest, status: 'review', review_reasons: [], review_sample_status: 'pending' })
  expect((await f.list()).items.map(item => ({ name: item.name, publicationId: item.publicationId, status: item.reviewSampleStatus })))
    .toEqual([{ name: f.skill.name, publicationId: first.publicationId, status: 'blocked' },
      { name: other.name, publicationId: '00000000-0000-4000-8000-000000000099', status: 'pending' }])
  expect(f.runs).toHaveLength(1)
})

it('rejects a premature first-sample verified report without exposing evidence_deposited or running the second sample', async () => {
  const f = await fixture()
  f.hooks.reportStatus = () => 'independent_sample_verified'
  await f.publish()
  await expect.poll(f.status).toBe('blocked')
  expect((await f.list()).items[0]).toMatchObject({ status: 'review', reviewSampleStatus: 'blocked',
    reviewSampleError: 'order-review-samples-not-ready' })
  expect(f.events.filter(event => event.startsWith('reported:'))).toHaveLength(1)
  expect(f.runs).toHaveLength(1)
})

it('keeps running after the first accepted report until the second sample is uploaded and independently verified', async () => {
  const f = await fixture()
  const entered = deferred(); const gate = deferred()
  f.hooks.run = async () => { if (f.runs.length === 2) { entered.resolve(); await gate.promise } }
  await f.publish(); await entered.promise
  expect(f.events.filter(event => event.startsWith('reported:'))).toHaveLength(1)
  expect(await f.status()).toBe('running')
  expect((await f.list()).items[0]?.status).toBe('review')
  gate.resolve()
  await expect.poll(f.status).toBe('evidence_deposited')
  expect(f.events.filter(event => event.startsWith('reported:'))).toHaveLength(2)
})

it.each(['verified', 'approved', 'sample-valid', 'media-valid'] as const)(
  'keeps authoritative cloud %s visible instead of overwriting it with an old local blocked task', async (cloud) => {
    const f = await fixture()
    f.hooks.mediaPut = () => new Response(null, { status: 503 })
    await f.publish()
    await expect.poll(f.status).toBe('blocked')
    const row = f.rows[0]
    if (row === undefined) throw new Error('Expected actual submitted publication')
    if (cloud === 'verified') row.review_sample_status = 'verified'
    if (cloud === 'approved') row.status = 'approved'
    if (cloud === 'sample-valid') row.evidence_status = { sample: 'valid' }
    if (cloud === 'media-valid') row.media_evidence_status = 'valid'
    const item = (await f.list()).items[0]
    expect(item?.reviewSampleStatus).toBe(cloud === 'verified' ? 'verified' : 'pending')
    expect(item?.reviewSampleError).toBeUndefined()
    expect(item?.status).toBe(cloud === 'approved' ? 'approved' : 'review')
    expect(f.runs).toHaveLength(1)
  })

it('retries a blocked native publication only from its explicit button, acquiring two fresh nonces through restart', async () => {
  const f = await fixture()
  f.hooks.mediaPut = () => new Response(null, { status: 503 })
  const publication = await f.publish()
  await expect.poll(f.status).toBe('blocked')
  const oldNonce = f.runs[0]?.challenge.payload.challenge_nonce
  expect(oldNonce).toBeDefined()
  expect(await f.catalog.retryInstalledOrderSkillArchive({ source: 'user-agents', name: f.skill.name }))
    .toMatchObject({ publicationId: publication.publicationId, reviewSampleStatus: 'blocked' })
  expect(f.events.filter(event => event === 'device-challenge')).toHaveLength(1)
  expect(f.runs).toHaveLength(1)
  delete f.hooks.mediaPut
  const button = await f.catalog.startOrderReviewSamples({ publicationId: publication.publicationId })
  expect(button).toMatchObject({ publicationId: publication.publicationId, status: 'pending', mediaEvidenceStatus: 'missing' })
  await expect.poll(f.status).toBe('evidence_deposited')
  expect(f.events.filter(event => event.startsWith('samples-start:'))).toHaveLength(1)
  expect(f.events.filter(event => event.startsWith('samples-restart:'))).toHaveLength(1)
  expect(f.events.filter(event => event.startsWith('generic-start:'))).toEqual([])
  const fresh = f.runs.slice(1).map(run => run.challenge.payload.challenge_nonce)
  expect(fresh).toHaveLength(2)
  expect(new Set(fresh).size).toBe(2)
  expect(fresh).not.toContain(oldNonce)
  expect(fresh.every(nonce => nonce.includes('-g2-'))).toBe(true)
  const reports = f.calls.filter(call => call.url.pathname.endsWith('/report'))
  expect(reports).toHaveLength(2)
  expect(reports.every(call => !call.url.pathname.includes(text(oldNonce)))).toBe(true)
  expect((await f.list()).items[0]).toMatchObject({ status: 'review', reviewSampleStatus: 'evidence_deposited' })
})

it.each(['pending', 'running'] as const)('does not duplicate a %s native queue when its real review button is clicked', async (state) => {
  const f = await fixture()
  const entered = deferred(); const gate = deferred()
  if (state === 'pending') f.hooks.observe = async () => { entered.resolve(); await gate.promise }
  else f.hooks.run = async () => { if (f.runs.length === 1) { entered.resolve(); await gate.promise } }
  const publication = await f.publish()
  await entered.promise
  expect(await f.status()).toBe(state)
  expect(await f.catalog.startOrderReviewSamples({ publicationId: publication.publicationId }))
    .toMatchObject({ publicationId: publication.publicationId, status: state })
  expect(f.events.filter(event => event === 'device-challenge')).toHaveLength(1)
  expect(f.events.filter(event => event.startsWith('samples-restart:') || event.startsWith('generic-start:'))).toEqual([])
  expect(f.runs).toHaveLength(state === 'pending' ? 0 : 1)
  gate.resolve()
  await expect.poll(f.status).toBe('evidence_deposited')
  expect(f.runs).toHaveLength(2)
})

it.each(['owner', 'source-digest', 'config-digest', 'missing-source', 'archive', 'author-manifest'] as const)(
  'rejects a native retry button with mismatched %s without falling through to generic review', async (reason) => {
    const f = await fixture()
    f.hooks.mediaPut = () => new Response(null, { status: 503 })
    const publication = await f.publish()
    await expect.poll(f.status).toBe('blocked')
    const row = f.rows[0]
    if (row === undefined) throw new Error('Expected actual submitted publication')
    if (reason === 'owner') { f.current.ownerId++; f.current.token = 'other-owner-token' }
    if (reason === 'source-digest') row.artifact_digest = `sha256:${'a'.repeat(64)}`
    if (reason === 'config-digest') row.package_digest = `sha256:${'a'.repeat(64)}`
    if (reason === 'missing-source') await rm(dirname(f.skill.path), { recursive: true })
    if (reason === 'archive') row.package_upload_status = 'missing'
    if (reason === 'author-manifest') row.author_manifest_status = 'missing'
    await expect(f.catalog.startOrderReviewSamples({ publicationId: publication.publicationId })).rejects.toThrow()
    expect(f.events.filter(event => event.startsWith('samples-restart:') || event.startsWith('generic-start:'))).toEqual([])
    expect(f.events.filter(event => event === 'device-challenge')).toHaveLength(1)
    expect(f.runs).toHaveLength(1)
  })
