import { createHash, createPublicKey, verify } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeH3ReviewExecution } from '@deepseek-ai/dsh-compute-core/native-h3-review'
import { nativeH3DeviceIdentity, type NativeH3DeviceIdentity } from '../src/native-h3-device-identity.ts'
import { accountOrderPublisherIdentity } from '../src/order-publisher-identity.ts'

const NOW = 1_800_000_000
const OWNER = 7
const WORKER = 'unit-native-device-a'
const homes: string[] = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW * 1000)
})
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

async function profile(): Promise<string> {
  const root = process.env.QIANSHOU_TEST_TMPDIR ?? tmpdir()
  await mkdir(root, { recursive: true })
  const path = await realpath(await mkdtemp(join(root, 'native-h3-device-identity-')))
  homes.push(path)
  return path
}

// Independent signature bytes: the verifier does not call the production canonicalizer.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`
  }
  const result = JSON.stringify(value)
  if (typeof result !== 'string') throw new Error('Expected JSON signature fixture')
  return result
}

function verifies(publicKey: string, payload: unknown, signature: string): boolean {
  const raw = Buffer.from(publicKey, 'base64url')
  expect(raw).toHaveLength(32)
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
    format: 'der', type: 'spki' })
  expect(key.asymmetricKeyType).toBe('ed25519')
  const bytes = Buffer.from(signature, 'base64url')
  expect(bytes).toHaveLength(64)
  return verify(null, Buffer.from(canonical(payload), 'utf8'), key, bytes)
}

function enrollment(identity: NativeH3DeviceIdentity): Record<string, unknown> {
  return { schema: 'qianshou.native-h3-device-enrollment.v1',
    purpose: 'qianshou:native-h3-device-key-enrollment', owner_id: identity.ownerId,
    device_id: identity.workerId, key_id: identity.keyId, public_key: identity.publicKey,
    challenge_id: '00000000-0000-4000-8000-000000000001', nonce: 'n'.repeat(43),
    issued_at: NOW, expires_at: NOW + 300 }
}

function execution(identity: NativeH3DeviceIdentity): NativeH3ReviewExecution {
  const artifact: NativeH3ReviewExecution['artifact'] = { schema: 'artifact.v1',
    object_key: 'native-review/00000000-0000-4000-8000-000000000001/result.mp4',
    object_version_id: 'unit-immutable-version', filename: 'result.mp4', size_bytes: 2048,
    content_type: 'video/mp4', sha256: '1'.repeat(64), result_id: 'unit-native-review-result' }
  return { schema: 'qianshou.native-h3-review-execution.v1', purpose: 'qianshou:native-h3-review-execution',
    publication_id: '00000000-0000-4000-8000-000000000001', owner_id: identity.ownerId,
    device_id: identity.workerId, task_type: 'qianshou_h3_unit_v1', capability_id: 'video.render',
    contract_version: 'v1', contract_sha256: 'c'.repeat(64), artifact_digest: `sha256:${'a'.repeat(64)}`,
    source_digest: `sha256:${'a'.repeat(64)}`, config_digest: `sha256:${'b'.repeat(64)}`,
    challenge_nonce: 'unit-independent-challenge', challenge_input_sha256: 'f'.repeat(64),
    challenge_result_sha256: createHash('sha256').update(canonical(artifact)).digest('hex'), artifact,
    issued_at: NOW, expires_at: NOW + 900 }
}

function artifactField(payload: NativeH3ReviewExecution, field: string, value: unknown): void {
  Reflect.set(payload.artifact, field, value)
  Reflect.set(payload, 'challenge_result_sha256', createHash('sha256').update(canonical(payload.artifact)).digest('hex'))
}

it('stores a separate device namespace and verifies enrollment with the actual Ed25519 key', async () => {
  const home = await profile()
  const author = await accountOrderPublisherIdentity(home, OWNER)
  const device = await nativeH3DeviceIdentity(home, OWNER, WORKER)
  expect(author.keyId).toMatch(/^author-[a-f0-9]{24}$/u)
  expect(device.keyId).toMatch(/^native-h3-device-[a-f0-9]{24}$/u)
  expect(device.publicKey).not.toBe(author.publicKey)
  expect((await readdir(home)).sort()).toEqual(['native-h3-device-identities', 'order-publisher-identities'])
  const payload = enrollment(device)
  expect(Object.keys(payload)).toHaveLength(10)
  const signature = device.signEnrollment(payload, NOW)
  expect(verifies(device.publicKey, payload, signature)).toBe(true)
  expect(verifies(author.publicKey, payload, signature)).toBe(false)
  expect(verifies(device.publicKey, payload, author.sign(payload))).toBe(false)
  expect(verifies(device.publicKey, { ...payload, owner_id: OWNER + 1 }, signature)).toBe(false)
  expect(JSON.stringify(device)).not.toContain('PRIVATE KEY')
})

it('reopens the same persisted key and isolates another worker, account and profile', async () => {
  const home = await profile()
  const first = await nativeH3DeviceIdentity(home, OWNER, WORKER)
  const same = await nativeH3DeviceIdentity(home, OWNER, WORKER)
  const worker = await nativeH3DeviceIdentity(home, OWNER, 'unit-native-device-b')
  const owner = await nativeH3DeviceIdentity(home, OWNER + 1, WORKER)
  const otherProfile = await nativeH3DeviceIdentity(await profile(), OWNER, WORKER)
  expect(same.keyId).toBe(first.keyId)
  expect(same.publicKey).toBe(first.publicKey)
  expect(same.signEnrollment(enrollment(same), NOW)).toBe(first.signEnrollment(enrollment(first), NOW))
  expect(new Set([first, worker, owner, otherProfile].map(item => item.publicKey)).size).toBe(4)
  expect((await readdir(join(home, 'native-h3-device-identities')))).toHaveLength(3)
})

it('settles concurrent creation to one persisted device key', async () => {
  const home = await profile()
  const devices = await Promise.all(Array.from({ length: 3 }, () => nativeH3DeviceIdentity(home, OWNER, WORKER)))
  expect(new Set(devices.map(device => device.publicKey)).size).toBe(1)
  const reopened = await nativeH3DeviceIdentity(home, OWNER, WORKER)
  expect(reopened.publicKey).toBe(devices[0]?.publicKey)
})

it.skipIf(process.platform === 'win32')('protects the private device directory and rejects a loosened directory', async () => {
  const home = await profile()
  await nativeH3DeviceIdentity(home, OWNER, WORKER)
  const namespace = join(home, 'native-h3-device-identities')
  const privateHome = join(namespace, createHash('sha256').update(`${OWNER}\0${WORKER}`).digest('hex'))
  expect((await lstat(namespace)).mode & 0o777).toBe(0o700)
  expect((await lstat(privateHome)).mode & 0o777).toBe(0o700)
  await chmod(privateHome, 0o755)
  await expect(nativeH3DeviceIdentity(home, OWNER, WORKER)).rejects.toMatchObject({ code: 'order-author-key-unavailable' })
})

it.skipIf(process.platform === 'win32').each(['profile', 'namespace', 'worker-home'] as const)(
  'rejects a symbolic %s directory without generating a replacement key', async (level) => {
    const home = await profile()
    let source = home
    const parent = await profile()
    if (level !== 'profile') {
      await nativeH3DeviceIdentity(home, OWNER, WORKER)
      source = join(home, 'native-h3-device-identities')
      if (level === 'worker-home') source = join(source, createHash('sha256').update(`${OWNER}\0${WORKER}`).digest('hex'))
    }
    const displaced = join(parent, 'displaced')
    await rename(source, displaced)
    await symlink(displaced, source, 'dir')
    const before = (await readdir(displaced)).sort()
    await expect(nativeH3DeviceIdentity(home, OWNER, WORKER)).rejects.toMatchObject({ code: 'order-author-key-unavailable' })
    expect((await readdir(displaced)).sort()).toEqual(before)
  })

it.each([
  ['owner', 'owner_id', OWNER + 1], ['worker', 'device_id', 'different-worker'],
  ['author purpose', 'purpose', 'qianshou:order-adapter-author-manifest'],
  ['execution purpose', 'purpose', 'qianshou:native-h3-review-execution'],
  ['schema', 'schema', 'qianshou.native-h3-device-enrollment.v2'],
  ['key identity', 'key_id', 'author-' + 'a'.repeat(24)], ['public key', 'public_key', 'a'.repeat(43)],
  ['challenge UUID', 'challenge_id', 'not-a-uuid'], ['nonce', 'nonce', 'n'.repeat(42)],
  ['expired', 'expires_at', NOW], ['future-issued', 'issued_at', NOW + 31],
  ['overlong lifetime', 'expires_at', NOW + 301], ['fractional timestamp', 'issued_at', NOW + 0.5],
  ['additional field', 'private_key', 'not-a-key'],
] as const)('refuses enrollment with %s', async (_reason, key, value) => {
  const device = await nativeH3DeviceIdentity(await profile(), OWNER, WORKER)
  const payload = enrollment(device)
  payload[key] = value
  expect(() => device.signEnrollment(payload, NOW)).toThrow()
})

it('signs the exact eighteen execution fields and immutable artifact metadata with a real device key', async () => {
  const device = await nativeH3DeviceIdentity(await profile(), OWNER, WORKER)
  const payload = execution(device)
  expect(Object.keys(payload)).toHaveLength(18)
  expect(Object.keys(payload.artifact)).toHaveLength(8)
  const signature = device.signExecution(payload)
  expect(verifies(device.publicKey, payload, signature)).toBe(true)
  expect(verifies(device.publicKey, { ...payload, contract_sha256: '9'.repeat(64) }, signature)).toBe(false)
  expect(() => device.signEnrollment(payload, NOW)).toThrow()
})

it('accepts the exact artifact size and lifetime limits, then refuses the expired execution', async () => {
  const device = await nativeH3DeviceIdentity(await profile(), OWNER, WORKER)
  const payload = execution(device)
  artifactField(payload, 'size_bytes', 16 * 1024 * 1024)
  const signature = device.signExecution(payload)
  expect(verifies(device.publicKey, payload, signature)).toBe(true)
  vi.setSystemTime((NOW + 900) * 1000)
  expect(() => device.signExecution(payload)).toThrow()
})

const badExecutions: readonly [string, (payload: NativeH3ReviewExecution) => void][] = [
  ['other owner', (payload) => { Reflect.set(payload, 'owner_id', OWNER + 1) }],
  ['other worker', (payload) => { Reflect.set(payload, 'device_id', 'different-worker') }],
  ['enrollment purpose', (payload) => { Reflect.set(payload, 'purpose', 'qianshou:native-h3-device-key-enrollment') }],
  ['missing field', (payload) => { Reflect.deleteProperty(payload, 'artifact') }],
  ['additional field', (payload) => { Reflect.set(payload, 'unexpected', true) }],
  ['same-count substituted field', (payload) => {
    const artifact = payload.artifact
    Reflect.deleteProperty(payload, 'artifact')
    Reflect.set(payload, 'artifact_alias', artifact)
  }],
  ['invalid publication', (payload) => { Reflect.set(payload, 'publication_id', 'not-a-uuid') }],
  ['invalid task type', (payload) => { Reflect.set(payload, 'task_type', 'bad/task') }],
  ['other capability', (payload) => { Reflect.set(payload, 'capability_id', 'text.transform') }],
  ['other version', (payload) => { Reflect.set(payload, 'contract_version', 'v2') }],
  ['prefixed contract SHA', (payload) => { Reflect.set(payload, 'contract_sha256', `sha256:${'c'.repeat(64)}`) }],
  ['raw source digest', (payload) => { Reflect.set(payload, 'source_digest', 'a'.repeat(64)) }],
  ['different source and artifact digest', (payload) => { Reflect.set(payload, 'artifact_digest', `sha256:${'2'.repeat(64)}`) }],
  ['wrong result hash', (payload) => { Reflect.set(payload, 'challenge_result_sha256', '0'.repeat(64)) }],
  ['expired execution', (payload) => { Reflect.set(payload, 'expires_at', NOW) }],
  ['future-issued execution', (payload) => { Reflect.set(payload, 'issued_at', NOW + 31) }],
  ['overlong execution', (payload) => { Reflect.set(payload, 'expires_at', NOW + 901) }],
  ['fractional execution time', (payload) => { Reflect.set(payload, 'issued_at', NOW + 0.5) }],
  ['substituted artifact field', (payload) => {
    Reflect.deleteProperty(payload.artifact, 'object_version_id')
    artifactField(payload, 'unversioned_alias', 'unit-version')
  }],
  ['empty artifact version', (payload) => { artifactField(payload, 'object_version_id', '') }],
  ['null artifact version', (payload) => { artifactField(payload, 'object_version_id', 'null') }],
  ['URL artifact key', (payload) => { artifactField(payload, 'object_key', 'https://example.invalid/result.mp4') }],
  ['traversal artifact key', (payload) => { artifactField(payload, 'object_key', '../result.mp4') }],
  ['wrong artifact filename', (payload) => { artifactField(payload, 'filename', 'not-video.txt') }],
  ['wrong artifact media type', (payload) => { artifactField(payload, 'content_type', 'text/plain') }],
  ['oversized artifact', (payload) => { artifactField(payload, 'size_bytes', 16 * 1024 * 1024 + 1) }],
  ['empty artifact', (payload) => { artifactField(payload, 'size_bytes', 0) }],
  ['nonfinite artifact size', (payload) => { artifactField(payload, 'size_bytes', Number.POSITIVE_INFINITY) }],
]

it.each(badExecutions)('refuses execution with %s instead of minting a signature', async (_reason, mutate) => {
  const device = await nativeH3DeviceIdentity(await profile(), OWNER, WORKER)
  const payload = execution(device)
  mutate(payload)
  expect(() => device.signExecution(payload)).toThrow()
})
