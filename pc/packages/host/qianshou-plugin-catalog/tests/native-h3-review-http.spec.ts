import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NATIVE_H3_RUNTIME, NATIVE_H3_RUNTIME_ABI, type NativeH3Declaration }
  from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { isVerifiedNativeH3ReviewChallenge, type NativeH3ReviewChallenge, type NativeH3ReviewExecution }
  from '@deepseek-ai/dsh-compute-core/native-h3-review'
import { nativeH3DeviceIdentity } from '../src/native-h3-device-identity.ts'
import { enrollNativeH3DeviceKey, reportNativeH3ReviewSample, startNativeH3ReviewSamples,
  uploadNativeH3ReviewArtifact, type NativeH3ReviewControl } from '../src/native-h3-review-http.ts'

const NOW = 1_800_000_000
const OWNER = 7
const WORKER = 'unit-native-http-worker'
const TOKEN = 'unit-private-control-token'
const PUBLICATION = '00000000-0000-4000-8000-000000000001'
const SOURCE = `sha256:${'a'.repeat(64)}`
const declaration: NativeH3Declaration = { schema: 'qianshou.native-h3-binding.v1',
  runtimeAbi: NATIVE_H3_RUNTIME_ABI, runtime: NATIVE_H3_RUNTIME,
  ownerConfigDigest: `sha256:${'b'.repeat(64)}`, executionRecipeSha256: 'd'.repeat(64), modelSha256: 'e'.repeat(64),
  taskType: 'qianshou_h3_http_unit_v1', capabilityId: 'video.render', category: 'video',
  inputKinds: ['inline'], outputKind: 'artifact_ref', contractVersion: 'v1', platformDispatchable: true }
const attestor = generateKeyPairSync('ed25519')
const challengeKeys = new Map([['unit-independent-review-key', attestor.publicKey]])
const homes: string[] = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW * 1000)
})
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

// Independent bytes keep signature assertions separate from the production canonicalizer.
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
function verifies(publicKey: string, value: unknown, signature: string): boolean {
  const raw = Buffer.from(publicKey, 'base64url')
  expect(raw).toHaveLength(32)
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
    format: 'der', type: 'spki' })
  return verify(null, Buffer.from(canonical(value)), key, Buffer.from(signature, 'base64url'))
}
function jsonBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('Expected metadata JSON request')
  const value: unknown = JSON.parse(init.body)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected metadata object')
  return value as Record<string, unknown>
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function challenge(index: number): NativeH3ReviewChallenge {
  const input = { prompt: index === 1 ? '雪山清晨，镜头缓慢向前' : '海边傍晚，波浪轻拍岸边', seconds: 5 as const, seed: index }
  return { schema: 'qianshou.native-h3-review-challenge.v1', purpose: 'qianshou:native-h3-review-challenge',
    publication_id: PUBLICATION, owner_id: OWNER, device_id: WORKER, task_type: declaration.taskType,
    capability_id: 'video.render', contract_version: 'v1', contract_sha256: 'c'.repeat(64),
    artifact_digest: SOURCE, source_digest: SOURCE, config_digest: declaration.ownerConfigDigest,
    challenge_nonce: `unit-review-nonce-${index}`, challenge_input: input,
    challenge_input_sha256: sha(input), issued_at: NOW, expires_at: NOW + 900 }
}
function signed(payload: NativeH3ReviewChallenge) {
  return { key_id: 'unit-independent-review-key', payload,
    signature: sign(null, Buffer.from(canonical(payload)), attestor.privateKey).toString('base64url') }
}

async function fixture() {
  const qaRoot = process.env.QIANSHOU_TEST_TMPDIR ?? tmpdir()
  await mkdir(qaRoot, { recursive: true })
  const profileDir = await realpath(await mkdtemp(join(qaRoot, 'native-h3-review-http-')))
  homes.push(profileDir)
  const signer = await nativeH3DeviceIdentity(profileDir, OWNER, WORKER)
  const enrollment = { schema: 'qianshou.native-h3-device-enrollment.v1',
    purpose: 'qianshou:native-h3-device-key-enrollment', owner_id: OWNER, device_id: WORKER,
    key_id: signer.keyId, public_key: signer.publicKey,
    challenge_id: '00000000-0000-4000-8000-000000000002', nonce: 'n'.repeat(43), issued_at: NOW, expires_at: NOW + 300 }
  const registered: Record<string, unknown> = { schema: 'qianshou.native-h3-device-key.v1', owner_id: OWNER,
    device_id: WORKER, key_id: signer.keyId, public_key: signer.publicKey, status: 'active' }
  const envelopes = [signed(challenge(1)), signed(challenge(2))]
  const session: Record<string, unknown> = { schema: 'qianshou.native-h3-review-session.v1',
    publication_id: PUBLICATION, worker_id: WORKER, challenges: envelopes }
  const artifact: NativeH3ReviewExecution['artifact'] = { schema: 'artifact.v1',
    object_key: 'native-review/unit/result.mp4', object_version_id: 'unit-version', filename: 'result.mp4',
    size_bytes: 2048, content_type: 'video/mp4', sha256: '1'.repeat(64), result_id: 'unit-result' }
  const execution: NativeH3ReviewExecution = { schema: 'qianshou.native-h3-review-execution.v1',
    purpose: 'qianshou:native-h3-review-execution', publication_id: PUBLICATION, owner_id: OWNER, device_id: WORKER,
    task_type: declaration.taskType, capability_id: 'video.render', contract_version: 'v1', contract_sha256: 'c'.repeat(64),
    artifact_digest: SOURCE, source_digest: SOURCE, config_digest: declaration.ownerConfigDigest,
    challenge_nonce: envelopes[0]!.payload.challenge_nonce, challenge_input_sha256: envelopes[0]!.payload.challenge_input_sha256,
    challenge_result_sha256: sha(artifact), artifact, issued_at: NOW, expires_at: NOW + 900 }
  const report: Record<string, unknown> = { schema: 'qianshou.native-h3-review-report-response.v1',
    publication_id: PUBLICATION, worker_id: WORKER, challenge_nonce: execution.challenge_nonce,
    status: 'awaiting_second_sample', sample_receipt: null, approval_required: true }
  const current = { ownerId: OWNER, workerId: WORKER, token: TOKEN }
  const events: string[] = []
  const calls: { url: URL; init: RequestInit | undefined; body: Record<string, unknown> }[] = []
  const hooks: { observe?: () => Promise<void>; response?: (url: URL) => Response | undefined } = {}
  const abort = new AbortController()
  const fetcher: typeof fetch = async (value, init) => {
    const url = new URL(value instanceof Request ? value.url : value.toString())
    events.push(`request:${url.pathname.split('/').at(-1)}`)
    calls.push({ url, init, body: jsonBody(init) })
    const override = hooks.response?.(url)
    if (override !== undefined) return override
    if (url.pathname.endsWith('/challenge')) return Response.json(enrollment)
    if (url.pathname.endsWith('/register')) return Response.json(registered)
    if (url.pathname.endsWith('/start')) return Response.json(session)
    if (url.pathname.endsWith('/report')) return Response.json(report)
    throw new Error('Unexpected control route')
  }
  const control: NativeH3ReviewControl = { origin: 'https://platform.invalid', token: TOKEN, ownerId: OWNER,
    workerId: WORKER, profileDir, signal: abort.signal, fetch: fetcher,
    async assertCurrent() {
      events.push('current')
      if (current.ownerId !== OWNER || current.workerId !== WORKER || current.token !== TOKEN) throw new Error('Current identity changed')
    },
    async observeDeviceKey(input) {
      events.push('observe')
      expect(input.challengeId).toBe(enrollment.challenge_id)
      expect(verifies(signer.publicKey, enrollment, input.signature)).toBe(true)
      await hooks.observe?.()
      events.push('observed')
    } }
  const start = { ...control, publicationId: PUBLICATION, sourceDigest: SOURCE, declaration,
    deviceKeyId: signer.keyId, challengeKeys }
  return { control, start, signer, enrollment, registered, envelopes, session, execution, report, current, events, calls, hooks, abort }
}

it('enrolls only after current worker observation and verifies its real device signature', async () => {
  const f = await fixture()
  const device = await enrollNativeH3DeviceKey(f.control)
  expect(device.keyId).toBe(f.signer.keyId)
  expect(f.events.filter(item => item !== 'current')).toEqual(['request:challenge', 'observe', 'observed', 'request:register'])
  expect(f.calls.map(item => item.body)).toEqual([
    { worker_id: WORKER, key_id: device.keyId, public_key: device.publicKey },
    { worker_id: WORKER, challenge_id: f.enrollment.challenge_id, signature: device.signEnrollment(f.enrollment, NOW) },
  ])
  for (const call of f.calls) {
    expect(call.url.origin).toBe('https://platform.invalid')
    expect(call.init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' })
    expect(new Headers(call.init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(call.init?.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.stringify(call.body)).not.toContain('PRIVATE KEY')
  }
})

it('does not register while the current worker observation is still pending', async () => {
  const f = await fixture()
  const entered = deferred()
  const gate = deferred()
  f.hooks.observe = async () => { entered.resolve(); await gate.promise }
  const pending = enrollNativeH3DeviceKey(f.control)
  await entered.promise
  expect(f.calls).toHaveLength(1)
  gate.resolve()
  await pending
  expect(f.calls).toHaveLength(2)
})

it.each(['owner', 'worker', 'token'] as const)('stops enrollment when current %s changes after worker observation', async (field) => {
  const f = await fixture()
  f.hooks.observe = async () => {
    if (field === 'owner') f.current.ownerId++
    if (field === 'worker') f.current.workerId = 'other-worker'
    if (field === 'token') f.current.token = 'other-token'
  }
  await expect(enrollNativeH3DeviceKey(f.control)).rejects.toThrow('Current identity changed')
  expect(f.calls).toHaveLength(1)
})

it.each(['owner_id', 'device_id', 'key_id', 'public_key', 'purpose'] as const)(
  'rejects an enrollment challenge with wrong %s before socket observation', async (field) => {
    const f = await fixture()
    Reflect.set(f.enrollment, field, field === 'owner_id' ? OWNER + 1 : 'wrong-value')
    await expect(enrollNativeH3DeviceKey(f.control)).rejects.toThrow()
    expect(f.events).not.toContain('observe')
    expect(f.calls).toHaveLength(1)
  })

it.each(['owner_id', 'device_id', 'key_id', 'public_key', 'status', 'extra', 'same-count'] as const)(
  'rejects a registration response with wrong %s', async (field) => {
    const f = await fixture()
    if (field === 'same-count') { Reflect.deleteProperty(f.registered, 'public_key'); f.registered.public_alias = f.signer.publicKey }
    else f.registered[field] = field === 'owner_id' ? OWNER + 1 : 'wrong-value'
    await expect(enrollNativeH3DeviceKey(f.control)).rejects.toThrow()
    expect(f.calls).toHaveLength(2)
  })

it('verifies both actual seventeen-field Ed25519 challenges, with different nonces and public inputs', async () => {
  const f = await fixture()
  const admitted = await startNativeH3ReviewSamples(f.start)
  expect(admitted).toHaveLength(2)
  for (const [index, credential] of admitted.entries()) {
    const payload = credential.payload
    if (payload.schema !== 'qianshou.native-h3-review-challenge.v1') throw new Error('Expected the V1 review fixture')
    expect(Object.keys(credential.payload)).toHaveLength(17)
    expect(isVerifiedNativeH3ReviewChallenge(credential, f.envelopes[index]!.payload, NOW)).toBe(true)
    expect(isVerifiedNativeH3ReviewChallenge(JSON.parse(JSON.stringify(credential)) as unknown, payload, NOW)).toBe(false)
  }
  expect(admitted[0]?.payload.challenge_nonce).not.toBe(admitted[1]?.payload.challenge_nonce)
  expect(admitted[0]?.payload.challenge_input).not.toEqual(admitted[1]?.payload.challenge_input)
  expect(f.calls[0]?.body).toEqual({ worker_id: WORKER, key_id: f.signer.keyId })
})

it.each(['owner_id', 'device_id', 'source_digest', 'config_digest', 'purpose', 'signature', 'key'] as const)(
  'rejects the two-sample session with wrong %s even when other metadata matches', async (field) => {
    const f = await fixture()
    const envelope = f.envelopes[0]!
    if (field === 'signature') envelope.signature = 'A'.repeat(86)
    else if (field === 'key') envelope.key_id = 'unenrolled-review-key'
    else {
      Reflect.set(envelope.payload, field, field === 'owner_id' ? OWNER + 1 : 'wrong-value')
      envelope.signature = sign(null, Buffer.from(canonical(envelope.payload)), attestor.privateKey).toString('base64url')
    }
    await expect(startNativeH3ReviewSamples(f.start)).rejects.toThrow()
  })

it.each(['duplicate-nonce', 'same-input', 'different-contract', 'one-sample', 'extra-session-field'] as const)(
  'rejects %s instead of treating it as two independent samples', async (reason) => {
    const f = await fixture()
    const first = f.envelopes[0]!.payload
    const second = f.envelopes[1]!
    if (reason === 'duplicate-nonce') Reflect.set(second.payload, 'challenge_nonce', first.challenge_nonce)
    if (reason === 'same-input') {
      Reflect.set(second.payload, 'challenge_input', first.challenge_input)
      Reflect.set(second.payload, 'challenge_input_sha256', sha(first.challenge_input))
    }
    if (reason === 'different-contract') Reflect.set(second.payload, 'contract_sha256', '9'.repeat(64))
    second.signature = sign(null, Buffer.from(canonical(second.payload)), attestor.privateKey).toString('base64url')
    if (reason === 'one-sample') f.session.challenges = [f.envelopes[0]]
    if (reason === 'extra-session-field') f.session.approved = true
    await expect(startNativeH3ReviewSamples(f.start)).rejects.toThrow()
  })

it('reports a real device-signed execution and keeps sample verification separate from public approval', async () => {
  const f = await fixture()
  expect(await reportNativeH3ReviewSample({ ...f.control, signer: f.signer, execution: f.execution })).toBe('awaiting_second_sample')
  const signedExecution = f.calls[0]?.body.execution
  if (signedExecution === null || typeof signedExecution !== 'object' || Array.isArray(signedExecution)) throw new Error('Expected signed metadata')
  const body = signedExecution as Record<string, unknown>
  expect(Object.keys(body).sort()).toEqual(['key_id', 'payload', 'signature'])
  if (typeof body.signature !== 'string') throw new Error('Expected execution signature')
  expect(body.key_id).toBe(f.signer.keyId)
  expect(body.payload).toEqual(f.execution)
  expect(verifies(f.signer.publicKey, body.payload, body.signature)).toBe(true)
  expect(f.calls[0]?.url.pathname).toBe(`/api/v8/task-adapter-publications/${PUBLICATION}/native-review-samples/unit-review-nonce-1/report`)
  expect(JSON.stringify(body)).not.toContain('video_bytes')
  f.report.status = 'independent_sample_verified'
  f.report.sample_receipt = { schema: 'unit-sample-receipt', status: 'pass' }
  expect(await reportNativeH3ReviewSample({ ...f.control, signer: f.signer, execution: f.execution })).toBe('independent_sample_verified')
  f.report.approval_required = false
  expect(await reportNativeH3ReviewSample({ ...f.control, signer: f.signer, execution: f.execution })).toBe('independent_sample_verified')
  expect(f.calls.every(call => call.url.origin === 'https://platform.invalid')).toBe(true)
})

it.each(['worker_id', 'publication_id', 'challenge_nonce', 'approval_required', 'status', 'extra', 'receipt'] as const)(
  'refuses a review report response with wrong %s', async (field) => {
    const f = await fixture()
    if (field === 'approval_required') f.report[field] = 'not-a-boolean'
    else if (field === 'receipt') f.report.sample_receipt = { status: 'pass' }
    else f.report[field] = 'wrong-value'
    await expect(reportNativeH3ReviewSample({ ...f.control, signer: f.signer, execution: f.execution })).rejects.toThrow()
  })

it('refuses a signer for another owner or physical worker before reporting', async () => {
  const f = await fixture()
  for (const [ownerId, workerId] of [[OWNER + 1, WORKER], [OWNER, 'other-worker']] as const) {
    const signer = await nativeH3DeviceIdentity(f.control.profileDir, ownerId, workerId)
    await expect(reportNativeH3ReviewSample({ ...f.control, signer, execution: f.execution })).rejects.toThrow()
  }
  expect(f.calls).toHaveLength(0)
})

it('rejects a changed token after a platform response, before accepting its review session', async () => {
  const f = await fixture()
  f.hooks.response = () => { f.current.token = 'rotated-token'; return Response.json(f.session) }
  await expect(startNativeH3ReviewSamples(f.start)).rejects.toThrow('Current identity changed')
  expect(f.calls).toHaveLength(1)
})

it.each([401, 403, 409, 500])('handles platform HTTP %s without exposing its private response body', async (status) => {
  const f = await fixture()
  f.hooks.response = () => new Response('untrusted-private-detail', { status })
  await expect(startNativeH3ReviewSamples(f.start)).rejects.toMatchObject({
    code: status === 401 || status === 403 ? 'order-auth-required'
      : status === 409 ? 'order-review-samples-not-ready' : 'order-review-samples-unavailable',
  })
})

it('cancels an oversized streamed response at the 64KiB limit', async () => {
  const f = await fixture()
  let cancelled = false
  f.hooks.response = () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)) },
    cancel() { cancelled = true },
  }))
  await expect(startNativeH3ReviewSamples(f.start)).rejects.toMatchObject({ code: 'order-review-samples-unavailable' })
  expect(cancelled).toBe(true)
})

it.each(['http://platform.invalid', 'https://platform.invalid/private', 'https://user:secret@platform.invalid'])(
  'does not send a bearer token to unsupported origin %s', async (unsafeOrigin) => {
    const f = await fixture()
    await expect(startNativeH3ReviewSamples({ ...f.start, origin: unsafeOrigin })).rejects.toThrow()
    expect(f.calls).toHaveLength(0)
  })

it('does not request an aborted operation or a session without an enrolled challenge key', async () => {
  const f = await fixture()
  f.abort.abort(new Error('Owner cancelled'))
  await expect(startNativeH3ReviewSamples(f.start)).rejects.toThrow('Owner cancelled')
  await expect(startNativeH3ReviewSamples({ ...f.start, challengeKeys: new Map() })).rejects.toThrow()
  expect(f.calls).toHaveLength(0)
})

async function uploadFixture(bytes = new Uint8Array(Buffer.from('unit bytes, not an actual MP4 execution'))) {
  const f = await fixture()
  const issuance = generateKeyPairSync('ed25519')
  const requests: { url: URL; init: RequestInit | undefined }[] = []
  const hooks: {
    intent?: (reply: Record<string, unknown>, grant: Record<string, unknown>, headers: Record<string, unknown>) => void
    receipt?: (receipt: Record<string, unknown>) => void
    afterIntent?: () => void
    put?: () => Response
  } = {}
  let grantSnapshot: Record<string, unknown> | undefined
  const fetcher: typeof fetch = async (value, init) => {
    const url = new URL(value instanceof Request ? value.url : value.toString())
    requests.push({ url, init })
    if (url.origin === 'https://storage.invalid') return hooks.put?.()
      ?? new Response(null, { status: 200, headers: { 'x-amz-version-id': 'unit-immutable-version' } })
    if (url.origin !== 'https://platform.invalid' || !url.pathname.endsWith('/upload-intent')) {
      throw new Error('Unexpected upload route')
    }
    const body = jsonBody(init)
    if (typeof body.result_id !== 'string') throw new Error('Expected generated result UUID')
    const workload = '00000000-0000-4000-8000-000000000003'
    const shard = '00000000-0000-4000-8000-000000000004'
    const objectKey = `v8/account-${OWNER}/workload-${workload}/shard-${shard}/result/${body.result_id}/result.mp4`
    const grant: Record<string, unknown> = { schema: 'qianshou.artifact-upload-issuance.v1',
      issuance_id: '00000000-0000-4000-8000-000000000005', account_id: OWNER, workload_id: workload,
      shard_id: shard, worker_id: WORKER, attempt: 1, result_id: body.result_id, object_key: objectKey,
      sha256: body.sha256, size_bytes: body.size_bytes, content_type: 'video/mp4', issued_at: NOW, expires_at: NOW + 300 }
    const headers: Record<string, unknown> = { 'Content-Type': 'video/mp4', 'Content-MD5': body.content_md5,
      'x-amz-checksum-sha256': createHash('sha256').update(bytes).digest('base64'),
      'x-amz-object-lock-mode': 'COMPLIANCE',
      'x-amz-object-lock-retain-until-date': new Date((NOW + 50 * 3600) * 1000).toISOString().replace('.000Z', 'Z') }
    const receipt: Record<string, unknown> = { key_id: 'unit-upload-issuance-key', payload: grant, signature: '' }
    const reply: Record<string, unknown> = { schema: 'qianshou.native-h3-review-upload-intent.v1', object_key: objectKey,
      result_id: body.result_id, upload_url: `https://storage.invalid/${objectKey}?unit-presign=fixture`,
      method: 'PUT', headers, expires_at: NOW + 300, issuance_receipt: receipt }
    hooks.intent?.(reply, grant, headers)
    receipt.signature = sign(null, Buffer.from(canonical(grant)), issuance.privateKey).toString('base64url')
    hooks.receipt?.(receipt)
    grantSnapshot = grant
    hooks.afterIntent?.()
    return Response.json(reply)
  }
  const input = { ...f.control, fetch: fetcher, publicationId: PUBLICATION, challengeNonce: 'unit-review-nonce-1',
    bytes, sha256: createHash('sha256').update(bytes).digest('hex'), trustedUploadHostname: 'storage.invalid',
    issuanceKeys: new Map([['unit-upload-issuance-key', issuance.publicKey]]) }
  return { f, input, requests, hooks, grantSnapshot: () => grantSnapshot }
}

it('verifies a real fourteen-field issuance and uploads bytes directly with exactly five headers and no bearer', async () => {
  const u = await uploadFixture()
  const artifact = await uploadNativeH3ReviewArtifact(u.input)
  expect(Object.keys(u.grantSnapshot() ?? {})).toHaveLength(14)
  expect(u.requests).toHaveLength(2)
  const intent = u.requests[0]!
  expect(intent.url.origin).toBe('https://platform.invalid')
  expect(Object.keys(jsonBody(intent.init)).sort()).toEqual(['content_md5', 'result_id', 'sha256', 'size_bytes'])
  expect(new Headers(intent.init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
  const upload = u.requests[1]!
  expect(upload.url.origin).toBe('https://storage.invalid')
  expect(decodeURIComponent(upload.url.pathname)).toBe(`/${artifact.object_key}`)
  expect(upload.init).toMatchObject({ method: 'PUT', redirect: 'error', credentials: 'omit' })
  const headers = new Headers(upload.init?.headers)
  expect(headers.get('authorization')).toBeNull()
  expect([...headers.keys()].sort()).toEqual(['content-md5', 'content-type', 'x-amz-checksum-sha256',
    'x-amz-object-lock-mode', 'x-amz-object-lock-retain-until-date'])
  expect(headers.get('content-md5')).toBe(createHash('md5').update(u.input.bytes).digest('base64'))
  expect(headers.get('x-amz-checksum-sha256')).toBe(Buffer.from(u.input.sha256, 'hex').toString('base64'))
  expect(upload.init?.body).toEqual(u.input.bytes)
  expect(artifact).toMatchObject({ schema: 'artifact.v1', filename: 'result.mp4', content_type: 'video/mp4',
    object_version_id: 'unit-immutable-version', size_bytes: u.input.bytes.byteLength, sha256: u.input.sha256 })
})

it.each(['owner', 'worker', 'sha', 'extra-grant', 'same-count-grant', 'unknown-key', 'signature'] as const)(
  'refuses upload issuance with %s before sending bytes', async (reason) => {
    const u = await uploadFixture()
    u.hooks.intent = (_reply, grant) => {
      if (reason === 'owner') grant.account_id = OWNER + 1
      if (reason === 'worker') grant.worker_id = 'different-worker'
      if (reason === 'sha') grant.sha256 = '9'.repeat(64)
      if (reason === 'extra-grant') grant.approved = true
      if (reason === 'same-count-grant') { Reflect.deleteProperty(grant, 'object_key'); grant.object_alias = 'other-object' }
    }
    u.hooks.receipt = (receipt) => {
      if (reason === 'unknown-key') receipt.key_id = 'unit-independent-review-key'
      if (reason === 'signature') receipt.signature = 'A'.repeat(86)
    }
    await expect(uploadNativeH3ReviewArtifact(u.input)).rejects.toThrow()
    expect(u.requests).toHaveLength(1)
  })

it.each(['host', 'http', 'path', 'query', 'extra-header', 'md5', 'sha-header', 'lock-mode', 'short-retention'] as const)(
  'refuses an upload URL or immutable header with wrong %s before sending bytes', async (reason) => {
    const u = await uploadFixture()
    u.hooks.intent = (reply, _grant, headers) => {
      if (reason === 'host') reply.upload_url = String(reply.upload_url).replace('storage.invalid', 'other-storage.invalid')
      if (reason === 'http') reply.upload_url = String(reply.upload_url).replace('https:', 'http:')
      if (reason === 'path') reply.upload_url = 'https://storage.invalid/another-object?unit-presign=fixture'
      if (reason === 'query') reply.upload_url = String(reply.upload_url).split('?')[0]
      if (reason === 'extra-header') headers.Authorization = `Bearer ${TOKEN}`
      if (reason === 'md5') headers['Content-MD5'] = Buffer.alloc(16).toString('base64')
      if (reason === 'sha-header') headers['x-amz-checksum-sha256'] = Buffer.alloc(32).toString('base64')
      if (reason === 'lock-mode') headers['x-amz-object-lock-mode'] = 'GOVERNANCE'
      if (reason === 'short-retention') headers['x-amz-object-lock-retain-until-date'] = new Date((NOW + 3600) * 1000)
        .toISOString().replace('.000Z', 'Z')
    }
    await expect(uploadNativeH3ReviewArtifact(u.input)).rejects.toThrow()
    expect(u.requests).toHaveLength(1)
  })

it.each(['missing', 'null', 'conflicting', 'invalid'] as const)('rejects an uploaded object with %s version evidence', async (reason) => {
  const u = await uploadFixture()
  u.hooks.put = () => {
    const headers = new Headers()
    if (reason === 'null') headers.set('x-amz-version-id', 'null')
    if (reason === 'invalid') headers.set('x-amz-version-id', 'bad/version')
    if (reason === 'conflicting') {
      headers.set('x-amz-version-id', 'version-one')
      headers.set('x-cos-version-id', 'version-two')
    }
    return new Response(null, { status: 200, headers })
  }
  await expect(uploadNativeH3ReviewArtifact(u.input)).rejects.toThrow()
  expect(u.requests).toHaveLength(2)
})

it('accepts exactly 16MiB, rejects larger or incorrectly hashed bytes without requesting a lease', async () => {
  const u = await uploadFixture(new Uint8Array(16 * 1024 * 1024))
  expect((await uploadNativeH3ReviewArtifact(u.input)).size_bytes).toBe(16 * 1024 * 1024)
  u.requests.splice(0)
  const larger = new Uint8Array(16 * 1024 * 1024 + 1)
  await expect(uploadNativeH3ReviewArtifact({ ...u.input, bytes: larger,
    sha256: createHash('sha256').update(larger).digest('hex') })).rejects.toThrow()
  await expect(uploadNativeH3ReviewArtifact({ ...u.input, sha256: '0'.repeat(64) })).rejects.toThrow()
  expect(u.requests).toHaveLength(0)
})

it('stops before COS if the authenticated token changes after issuance', async () => {
  const u = await uploadFixture()
  u.hooks.afterIntent = () => { u.f.current.token = 'rotated-token' }
  await expect(uploadNativeH3ReviewArtifact(u.input)).rejects.toThrow('Current identity changed')
  expect(u.requests).toHaveLength(1)
})
