import { createHash, generateKeyPairSync, sign, verify, createPublicKey } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NATIVE_H3_RUNTIME, NATIVE_H3_RUNTIME_ABI } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { isVerifiedNativeH3PresenceChallenge, verifyNativeH3PresenceChallenge, type VerifiedNativeH3PresenceChallenge }
  from '@deepseek-ai/dsh-compute-core/native-h3-presence'
import { isVerifiedNativeH3DeviceProof } from '@deepseek-ai/dsh-compute-core/native-h3-device-proof'
import { nativeH3DeviceIdentity } from '../src/native-h3-device-identity.ts'
import { renewNativeH3DevicePresence } from '../src/native-h3-presence-http.ts'
import { fetchNativeH3PurposeKeys } from '../src/native-h3-trust-http.ts'

const NOW = 1_800_000_000
const PUBLICATION = '00000000-0000-4000-8000-000000000001'
const CONNECTION = '00000000-0000-4000-8000-000000000002'
const keys = [generateKeyPairSync('ed25519'), generateKeyPairSync('ed25519'), generateKeyPairSync('ed25519')]
const challengeKey = keys[0]!
const attestorKey = keys[1]!
const issuanceKey = keys[2]!
const challengeKeys = new Map([['challenge-unit', challengeKey.publicKey]])
const attestorKeys = new Map([['attestor-unit', attestorKey.publicKey]])
const homes: string[] = []
const native = { runtimeAbi: NATIVE_H3_RUNTIME_ABI, runtime: NATIVE_H3_RUNTIME,
  ownerConfigDigest: `sha256:${'b'.repeat(64)}`, executionRecipeSha256: 'c'.repeat(64), modelSha256: 'd'.repeat(64) }
const tuple = { publication_id: PUBLICATION, owner_id: 7, device_id: 'presence-unit-device',
  task_type: 'qianshou_h3_presence_unit_v1', capability_id: 'video.render' as const,
  contract_version: 'v1' as const, contract_sha256: 'e'.repeat(64),
  artifact_digest: `sha256:${'a'.repeat(64)}`, source_digest: `sha256:${'a'.repeat(64)}`,
  config_digest: native.ownerConfigDigest }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`
  }
  const result = JSON.stringify(value)
  if (result === undefined) throw new Error('Expected JSON')
  return result
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }
function signed(payload: unknown, id: string, key: typeof challengeKey) {
  return { key_id: id, payload, signature: sign(null, Buffer.from(canonical(payload)), key.privateKey).toString('base64url') }
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW * 1000) })
afterEach(async () => { vi.useRealTimers(); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'native-h3-presence-unit-')))
  homes.push(home)
  const signer = await nativeH3DeviceIdentity(home, tuple.owner_id, tuple.device_id)
  const plan = { ...tuple, schema: 'qianshou.native-h3-presence-challenge.v1' as const,
    purpose: 'qianshou:native-h3-presence-challenge' as const, challenge_nonce: Buffer.alloc(32, 1).toString('base64url'),
    native_binding: native, sample_receipt_sha256: 'f'.repeat(64), review_fingerprint: '1'.repeat(64),
    connection_id: CONNECTION, device_key_id: signer.keyId, issued_at: NOW, expires_at: NOW + 120 }
  const events: string[] = []
  const hooks: { current?: () => Promise<void>; observe?: () => Promise<void>; response?: (path: string) => Response | undefined } = {}
  const fetcher: typeof fetch = async (value, init) => {
    const url = new URL(value instanceof Request ? value.url : value.toString())
    expect(url.origin).toBe('https://example.invalid')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' })
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-unit-token')
    events.push(url.pathname.endsWith('/challenge') ? 'challenge' : 'report')
    const overridden = hooks.response?.(url.pathname)
    if (overridden !== undefined) return overridden
    if (url.pathname.endsWith('/challenge')) return Response.json(signed(plan, 'challenge-unit', challengeKey))
    if (typeof init?.body !== 'string') throw new Error('Expected JSON metadata request')
    const body = JSON.parse(init.body) as { worker_id: string; challenge_nonce: string; signature: string }
    expect(Object.keys(body).sort()).toEqual(['challenge_nonce', 'signature', 'worker_id'])
    expect(body.worker_id).toBe(tuple.device_id)
    expect(body.challenge_nonce).toBe(plan.challenge_nonce)
    const presence = { ...plan, schema: 'qianshou.native-h3-device-presence.v1', purpose: 'qianshou:native-h3-device-presence' }
    const deviceKey = createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(signer.publicKey, 'base64url')]) })
    expect(verify(null, Buffer.from(canonical(presence)), deviceKey, Buffer.from(body.signature, 'base64url'))).toBe(true)
    const proof = { ...tuple, schema: 'qianshou.native-h3-device-proof.v1', purpose: 'qianshou:native-h3-device-attestor',
      challenge_nonce: plan.challenge_nonce, challenge_input_sha256: digest(plan), challenge_result_sha256: digest(presence),
      result: 'pass', publication_status: 'approved', installation_state: 'installed', issued_at: NOW, expires_at: NOW + 300 }
    return Response.json({ schema: 'qianshou.native-h3-device-presence-result.v1', publication_id: PUBLICATION,
      worker_id: tuple.device_id, device_proof: signed(proof, 'attestor-unit', attestorKey) })
  }
  const input = { origin: 'https://example.invalid', token: 'private-unit-token', ownerId: tuple.owner_id,
    workerId: tuple.device_id, profileDir: home, signal: new AbortController().signal, signer,
    publicationId: PUBLICATION, connectionId: CONNECTION, challengeKeys, attestorKeys, fetch: fetcher,
    selection: { declaration: { ...native, schema: 'qianshou.native-h3-binding.v1' as const,
      taskType: tuple.task_type, capabilityId: 'video.render' as const, category: 'video' as const,
      inputKinds: ['inline'] as const, outputKind: 'artifact_ref' as const, contractVersion: 'v1' as const,
      platformDispatchable: true as const }, sourceDigest: tuple.source_digest, taskDefinitionSha256: `sha256:${'2'.repeat(64)}` },
    assertCurrent: async () => hooks.current?.(), observeDeviceKey: async () => { throw new Error('No re-enrollment in renewal helper') },
    validate: async (request: Parameters<typeof renewNativeH3DevicePresence>[0]['validate'] extends (arg: infer A) => unknown ? A : never) => {
      expect(isVerifiedNativeH3PresenceChallenge(request.challenge, tuple, NOW)).toBe(true)
      expect(request.challenge.payload.native_binding).toEqual(native)
      events.push('fresh-binding')
    },
    observePresence: async () => { events.push('current-ws'); await hooks.observe?.() },
  }
  return { input, signer, plan, events, hooks }
}

it('renews from the actual signed plan, fresh binding, current socket witness and separate signed device proof without a GPU/upload port', async () => {
  const f = await fixture()
  const proof = await renewNativeH3DevicePresence(f.input)
  expect(f.events).toEqual(['challenge', 'fresh-binding', 'current-ws', 'report'])
  expect(isVerifiedNativeH3DeviceProof(proof, tuple, NOW)).toBe(true)
  expect(proof.payload.expires_at - proof.payload.issued_at).toBe(300)
})

it.each(['owner', 'connection', 'device-key', 'source', 'purpose', 'expired', 'unknown-key'])('refuses signed plan %s before witnessing or reporting', async (reason) => {
  const f = await fixture()
  const changed: Record<string, unknown> = { ...f.plan }
  if (reason === 'owner') changed.owner_id = 8
  if (reason === 'connection') changed.connection_id = PUBLICATION
  if (reason === 'device-key') changed.device_key_id = 'wrong-device-key'
  if (reason === 'source') changed.source_digest = `sha256:${'9'.repeat(64)}`
  if (reason === 'purpose') changed.purpose = 'qianshou:native-h3-review-challenge'
  if (reason === 'expired') changed.expires_at = NOW
  f.hooks.response = () => Response.json(signed(changed, reason === 'unknown-key' ? 'untrusted-key' : 'challenge-unit', challengeKey))
  await expect(renewNativeH3DevicePresence(f.input)).rejects.toThrow()
  expect(f.events).toEqual(['challenge'])
})

it('refuses a serialized challenge credential and a changed current connection at the device signer', async () => {
  const f = await fixture()
  const challenge = verifyNativeH3PresenceChallenge(signed(f.plan, 'challenge-unit', challengeKey), tuple, challengeKeys, NOW)
  const copy = JSON.parse(JSON.stringify(challenge)) as VerifiedNativeH3PresenceChallenge
  expect(() => f.signer.signPresence(copy, CONNECTION)).toThrow()
  expect(() => f.signer.signPresence(challenge, PUBLICATION)).toThrow()
})

it('does not report after the current socket changes during its witness', async () => {
  const f = await fixture()
  let current = true
  f.hooks.current = async () => { if (!current) throw new Error('Connection changed') }
  f.hooks.observe = async () => { current = false }
  await expect(renewNativeH3DevicePresence(f.input)).rejects.toThrow('Connection changed')
  expect(f.events).toEqual(['challenge', 'fresh-binding', 'current-ws'])
})

it.each(['nonce', 'input-hash', 'result-hash'])('rejects a validly signed stale proof with the wrong %s', async (reason) => {
  const f = await fixture()
  const presence = { ...f.plan, schema: 'qianshou.native-h3-device-presence.v1', purpose: 'qianshou:native-h3-device-presence' }
  const proof = { ...tuple, schema: 'qianshou.native-h3-device-proof.v1', purpose: 'qianshou:native-h3-device-attestor',
    challenge_nonce: reason === 'nonce' ? 'old-proof-nonce' : f.plan.challenge_nonce,
    challenge_input_sha256: reason === 'input-hash' ? '9'.repeat(64) : digest(f.plan),
    challenge_result_sha256: reason === 'result-hash' ? '9'.repeat(64) : digest(presence),
    result: 'pass', publication_status: 'approved', installation_state: 'installed', issued_at: NOW, expires_at: NOW + 300 }
  f.hooks.response = path => path.endsWith('/report') ? Response.json({ schema: 'qianshou.native-h3-device-presence-result.v1',
    publication_id: PUBLICATION, worker_id: tuple.device_id, device_proof: signed(proof, 'attestor-unit', attestorKey) }) : undefined
  await expect(renewNativeH3DevicePresence(f.input)).rejects.toThrow()
  expect(f.events).toEqual(['challenge', 'fresh-binding', 'current-ws', 'report'])
})

function raw(key: typeof challengeKey): string { return (key.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64url') }
function trust() { return { schema: 'qianshou.native-h3-proof-trust.v1', challenge_keys: { challenge: raw(challengeKey) },
  device_attestor_keys: { attestor: raw(attestorKey) }, upload_issuance_keys: { issuance: raw(issuanceKey) } } }
function trustInput() { return { origin: 'https://example.invalid', token: 'private-unit-token',
  signal: new AbortController().signal, configured: {}, assertCurrent: async () => undefined } }

it('discovers purpose roots only from the separate configured HTTPS operator endpoint with private auth and no redirects', async () => {
  const result = await fetchNativeH3PurposeKeys({ ...trustInput(), fetch: async (value, init) => {
    expect(value instanceof Request ? value.url : value.toString()).toBe('https://example.invalid/api/v8/task-adapter-publications/native-proof-trust')
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' })
    return Response.json(trust())
  } })
  expect([...result.challenge.keys()]).toEqual(['challenge'])
  expect([...result.attestor.keys()]).toEqual(['attestor'])
  expect([...result.issuance.keys()]).toEqual(['issuance'])
})

it.each(['same-key', 'empty-map', 'inline-key', 'wrong-schema', 'oversized', 'http', 'login'])('refuses unsafe trust discovery %s', async (reason) => {
  const data: Record<string, unknown> = { ...trust() }
  if (reason === 'same-key') data.device_attestor_keys = { attestor: raw(challengeKey) }
  if (reason === 'empty-map') data.challenge_keys = {}
  if (reason === 'inline-key') data.binding_key = raw(attestorKey)
  if (reason === 'wrong-schema') data.schema = 'qianshou.artifact.v1'
  await expect(fetchNativeH3PurposeKeys({ ...trustInput(), origin: reason === 'http' ? 'http://example.invalid' : 'https://example.invalid',
    fetch: async () => reason === 'oversized' ? new Response('x'.repeat(16 * 1024 + 1))
      : reason === 'login' ? new Response(null, { status: 401 }) : Response.json(data) })).rejects.toThrow()
})

it('uses explicitly configured purpose keys without borrowing trust from a response', async () => {
  const configured = { challenge: { challenge: raw(challengeKey) }, attestor: { attestor: raw(attestorKey) },
    issuance: { issuance: raw(issuanceKey) } }
  const result = await fetchNativeH3PurposeKeys({ ...trustInput(), configured,
    fetch: async () => { throw new Error('Configured trust must not fetch') } })
  expect(result.attestor.get('attestor')?.asymmetricKeyType).toBe('ed25519')
})
