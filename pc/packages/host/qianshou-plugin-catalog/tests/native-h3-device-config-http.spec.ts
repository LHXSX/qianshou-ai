import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NATIVE_H3_RUNTIME_ABI_V2, NATIVE_H3_RUNTIME_V2, nativeH3LogicalBindingSha256,
  parseNativeH3DeclarationV2 } from '../../compute-core/src/native-h3-binding.ts'
import { canonicalNativeH3ReviewJson } from '../../compute-core/src/native-h3-review.ts'
import { nativeH3DeviceIdentity } from '../src/native-h3-device-identity.ts'
import { readNativeH3DeviceConfig, registerNativeH3DeviceConfig } from '../src/native-h3-device-config-http.ts'
const NOW = 1800000000
const roots: string[] = []
const pair = generateKeyPairSync('ed25519')
const PUBLICATION = '11111111-1111-4111-8111-111111111111'
const CONNECTION = '22222222-2222-4222-8222-222222222222'
const binding = { schema: 'qianshou.native-h3-execution-binding.v2' as const,
  runtimeAbi: NATIVE_H3_RUNTIME_ABI_V2, runtime: NATIVE_H3_RUNTIME_V2,
  executionRecipeSha256: 'a'.repeat(64), modelSha256: 'b'.repeat(64), firstFrameSha256: 'c'.repeat(64) }
const declaration = parseNativeH3DeclarationV2({ ...binding, schema: 'qianshou.native-h3-binding.v2',
  taskType: 'fixture_native_h3_v2', capabilityId: 'video.render', inputKinds: ['inline'], outputKind: 'artifact_ref',
  contractVersion: 'v2', category: 'video', platformDispatchable: true })
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW * 1000) })
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'h3-v2-config-'))); roots.push(home)
  const signer = await nativeH3DeviceIdentity(home, 167, 'physical-a')
  let head = { schema: 'qianshou.native-h3-device-config.v2', publication_id: PUBLICATION, worker_id: 'physical-a',
    logical_binding_sha256: nativeH3LogicalBindingSha256(binding), local_owner_config_digest: null as string | null,
    device_binding_revision: 0, status: 'absent' }
  const selection = { declaration, sourceDigest: 'sha256:' + 'd'.repeat(64), localOwnerConfigDigest: 'sha256:' + 'e'.repeat(64) }
  const calls: string[] = []
  let unknown = false
  let observed = false
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input); calls.push(`${init!.method} ${url.pathname.split('/').at(-1)}`)
    expect(init).toMatchObject({ redirect: 'error', credentials: 'omit' })
    if (init!.method === 'GET') return Response.json(head)
    if (typeof init?.body !== 'string') throw new Error('Expected actual JSON request')
    const body = JSON.parse(init.body) as Record<string, unknown>
    if (url.pathname.endsWith('/challenge')) {
      expect(Object.keys(body).sort()).toEqual(['expected_revision', 'key_id', 'local_owner_config_digest', 'worker_id'])
      expect(body.expected_revision).toBe(head.device_binding_revision)
      const revision = head.local_owner_config_digest === selection.localOwnerConfigDigest
        ? head.device_binding_revision : head.device_binding_revision + 1
      const payload = { schema: 'qianshou.native-h3-device-config-enrollment.v2', purpose: 'qianshou:native-h3-device-config-enrollment.v2',
        publication_id: PUBLICATION, owner_id: 167, device_id: 'physical-a', task_type: declaration.taskType,
        capability_id: 'video.render', contract_version: 'v2', contract_sha256: 'f'.repeat(64), artifact_digest: selection.sourceDigest,
        source_digest: selection.sourceDigest, logical_binding_sha256: head.logical_binding_sha256,
        local_owner_config_digest: selection.localOwnerConfigDigest, device_binding_revision: revision,
        challenge_id: PUBLICATION, nonce: Buffer.alloc(32, 8).toString('base64url'), key_id: signer.keyId,
        connection_id: CONNECTION, expected_revision: head.device_binding_revision, issued_at: NOW, expires_at: NOW + 300 }
      return Response.json({ key_id: 'config-root', payload,
        signature: sign(null, Buffer.from(canonicalNativeH3ReviewJson(payload)), pair.privateKey).toString('base64url') })
    }
    expect(observed).toBe(true)
    expect(Object.keys(body).sort()).toEqual(['challenge_id', 'signature', 'worker_id'])
    if (unknown) throw new Error('unknown registration outcome')
    head = { ...head, local_owner_config_digest: selection.localOwnerConfigDigest,
      device_binding_revision: head.local_owner_config_digest === selection.localOwnerConfigDigest
        ? head.device_binding_revision : head.device_binding_revision + 1, status: 'registered' }
    return Response.json(head)
  }
  const control = { origin: 'https://operator.invalid', token: 'private-fixture', ownerId: 167, workerId: 'physical-a', profileDir: home,
    signal: new AbortController().signal, assertCurrent: async () => undefined, observeDeviceKey: async () => { throw new Error('No key re-enrollment') },
    publicationId: PUBLICATION, selection, fetch: fetcher }
  const input = { ...control, signer, connectionId: CONNECTION, challengeKeys: new Map([['config-root', pair.publicKey]]),
    assertLocalCurrent: async () => undefined, observeConfig: async () => { observed = true; calls.push('WS config') } }
  return { input, selection, calls, setUnknown: () => { unknown = true } }
}
it('reads only metadata and performs explicit CAS 0→1, unchanged1, different2, back-to-old3 with fresh WS witness', async () => {
  const f = await fixture()
  expect((await readNativeH3DeviceConfig(f.input)).status).toBe('absent')
  expect(f.calls).toEqual(['GET native-device-configs'])
  expect((await registerNativeH3DeviceConfig(f.input)).device_binding_revision).toBe(1)
  expect((await registerNativeH3DeviceConfig(f.input)).device_binding_revision).toBe(1)
  f.selection.localOwnerConfigDigest = 'sha256:' + '9'.repeat(64)
  expect((await registerNativeH3DeviceConfig(f.input)).device_binding_revision).toBe(2)
  f.selection.localOwnerConfigDigest = 'sha256:' + 'e'.repeat(64)
  expect((await registerNativeH3DeviceConfig(f.input)).device_binding_revision).toBe(3)
  expect(f.calls.filter(item => item === 'WS config')).toHaveLength(4)
  expect(f.calls.every(item => !/samples|presence|grant/u.test(item))).toBe(true)
})
it('does not retry an unknown config registration or create samples, and refuses changed local identity before any HTTP', async () => {
  const f = await fixture(); f.setUnknown()
  await expect(registerNativeH3DeviceConfig(f.input)).rejects.toMatchObject({ code: 'order-review-samples-unavailable' })
  expect(f.calls).toEqual(['GET native-device-configs', 'POST challenge', 'WS config', 'POST register'])
  const next = await fixture()
  await expect(registerNativeH3DeviceConfig({ ...next.input, assertLocalCurrent: async () => { throw new Error('changed config') } }))
    .rejects.toThrow('changed config')
  expect(next.calls).toEqual([])
})
