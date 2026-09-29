import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { canonicalFileMetadata, parseEdgeFileContract } from '../../src/edge-worker/file-task-contract.ts'
import { requestAttachmentReadCredential } from '../../src/edge-worker/attachment-read-credential.ts'
import { EdgeWorkerConnection } from '../../src/edge-worker/connection.ts'
import type { EdgeTaskOffer } from '../../src/edge-worker/types.ts'
import { createInlineEdgeBinding } from '../../src/transport/inline-edge-bridge.ts'

const id = { workerId: '9fd28bf0-f11a-4db3-bcb2-57d16c541e40', workloadId: '905aefc8-5573-4cda-baa0-d57ca40e8f1c',
  shardId: '15b7880b-68c8-42e4-a401-eac6b4983335', attempt: 1 }
const source = { workload_id: 'b4c76414-f6cd-4eb5-9e7e-7298b04a327c', shard_id: '793e2117-0a4a-4c61-8d10-5d2fd64c6208',
  result_id: '3bd2ad68-eb29-46d0-a3c4-ec3a02980103' }
const bytes = Buffer.from('private-attachment')
const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const artifact = { schema: 'artifact.v1' as const, ...source, account_id: 42, filename: 'source.txt', content_type: 'text/plain',
  size_bytes: bytes.length, sha256: sha(bytes), object_version_id: 'locked-v1',
  object_key: `v8/account-42/workload-${source.workload_id}/shard-${source.shard_id}/result/${source.result_id}/source.txt` }
function contract() {
  const unsigned = { schema: 'qianshou.file-attachment-bindings.v1' as const, account_id: 42, task_type: 'file_copy_v1',
    contract_sha256: `sha256:${'a'.repeat(64)}`, file_schema_sha256: 'b'.repeat(64), attachments: { source: { source, artifact } } }
  return { ...unsigned, bindings_sha256: 'sha256:' + sha(canonicalFileMetadata(unsigned)) }
}
function grant(body: Record<string, unknown>) {
  const { lease_token: _private, ...binding } = body
  return { schema: 'qianshou.file-attachment-read-credential.v1', ...binding,
    object_key: artifact.object_key, object_version_id: artifact.object_version_id, sha256: artifact.sha256,
    size_bytes: artifact.size_bytes, content_type: artifact.content_type,
    file_schema_sha256: contract().file_schema_sha256, bindings_sha256: contract().bindings_sha256,
    method: 'GET', url: `https://storage.example/${artifact.object_key}?versionId=locked-v1`,
    expires_at: Math.floor(Date.now() / 1000) + 60 }
}
const credentialTestNow = Date.now()
it('copies exact frozen metadata and rejects mutation of its complete digest', () => {
  const input = contract()
  const result = parseEdgeFileContract(input, 'file_copy_v1', 42)
  expect(result).toEqual(input)
  expect(Object.isFrozen(result.attachments.source!.artifact)).toBe(true)
  expect(() => parseEdgeFileContract({ ...input, bindings_sha256: 'sha256:' + '0'.repeat(64) }, 'file_copy_v1', 42)).toThrow()
})
it('bounds nested and wide invalid metadata before canonical serialization', () => {
  let nested: unknown = []
  for (let depth = 0; depth < 1000; depth++) nested = [nested]
  expect(() => parseEdgeFileContract({ ...contract(), attachments: nested }, 'file_copy_v1', 42)).toThrow('EDGE_FILE_CONTRACT_INVALID')
  expect(() => canonicalFileMetadata(Array.from({ length: 257 }, () => 1))).toThrow('EDGE_FILE_CONTRACT_INVALID')
})
it.each([
  { schema: 'other' }, { account_id: '42' }, { account_id: 6 }, { task_type: 'other' },
  { unknown: true }, { file_schema_sha256: 'sha256:' + 'b'.repeat(64) }, { attachments: { other: {} } },
])('rejects an altered assignment contract %j', (change) => {
  expect(() => parseEdgeFileContract({ ...contract(), ...change }, 'file_copy_v1', 42)).toThrow()
})
it('requests only current assignment metadata and retains account bearer inside Shanghai transport', async () => {
  const send = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe('https://shanghai.example/api/v8/files/attachment-read-credential')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-account')
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body).toEqual({ workload_id: id.workloadId, shard_id: id.shardId, worker_id: id.workerId, attempt: 1,
      account_id: 42, task_type: 'file_copy_v1', contract_sha256: contract().contract_sha256, slot: 'source', lease_token: 'fixture-lease' })
    expect(String(init?.body)).not.toContain('private-attachment')
    return Response.json(grant(body))
  })
  const result = await requestAttachmentReadCredential({ origin: new URL('https://shanghai.example'), token: 'fixture-account',
    leaseToken: 'fixture-lease', identity: id, fileContract: contract(), slot: 'source', fetch: send as typeof fetch })
  expect(result).toMatchObject({ objectKey: artifact.object_key, objectVersionId: 'locked-v1', sha256: sha(bytes) })
  expect(JSON.stringify(result)).not.toContain('fixture-')
})
it.each([{ attempt: 2 }, { worker_id: source.workload_id }, { account_id: 6 }, { contract_sha256: 'sha256:' + 'd'.repeat(64) },
  { bindings_sha256: 'sha256:' + 'd'.repeat(64) }, { file_schema_sha256: 'c'.repeat(64) }, { object_version_id: 'replacement' },
  { expires_at: 1 }, { expires_at: Math.floor(credentialTestNow / 1000) + 61 }, { method: 'PUT' }, { injected: true }])(
  'rejects a successful HTTP response with mismatched credential metadata %j', async (change) => {
    await expect(requestAttachmentReadCredential({ origin: new URL('https://shanghai.example'), token: 'fixture-account',
      leaseToken: 'fixture-lease', identity: id, fileContract: contract(), slot: 'source', now: () => credentialTestNow,
      fetch: vi.fn(async (_url, init) => Response.json({ ...grant(JSON.parse(String(init?.body))),
        expires_at: Math.floor(credentialTestNow / 1000) + 60, ...change })) as typeof fetch,
    })).rejects.toThrow()
  })
it.each([0, -1])('rejects stale/invalid caller attempt %s before current lease access', async (attempt) => {
  const send = vi.fn()
  await expect(requestAttachmentReadCredential({ origin: new URL('https://shanghai.example'), token: 'fixture-account',
    leaseToken: 'fixture-lease', identity: { ...id, attempt }, fileContract: contract(), slot: 'source', fetch: send,
  })).rejects.toThrow()
  expect(send).not.toHaveBeenCalled()
})
class Socket extends EventTarget {
  static OPEN = 1
  static latest: Socket
  readyState = 1
  sent: { type: string; payload: Record<string, unknown> }[] = []
  constructor() { super(); Socket.latest = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
  send(data: string) {
    const frame = JSON.parse(data); this.sent.push(frame)
    if (frame.type === 'hello') this.reply('welcome', { hb_interval_s: 60 })
    if (frame.type === 'auth') this.reply('auth_ok', { worker_id: id.workerId, owner_id: 7 })
    if (frame.type === 'hb') this.reply('hb_ack', {})
  }
  reply(type: string, payload: Record<string, unknown>) {
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ v: '8.0', type, payload }) })))
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
}
afterEach(() => { vi.unstubAllGlobals() })
it('uses current private lease to read storage directly and refuses old attempts, changed contracts and completed leases', async () => {
  vi.stubGlobal('WebSocket', Socket)
  const send = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(url)).hostname === 'shanghai.example') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (new URL(String(url)).pathname.endsWith('result-upload-url')) {
        expect(String(init?.body)).not.toContain('private-attachment')
        return Response.json({ schema_version: 'artifact.v1', method: 'PUT',
          object_key: `v8/account-42/workload-${id.workloadId}/shard-${id.shardId}/result/${body.result_id}/${body.filename}`,
          upload_url: 'https://storage.example/put', expires_at: Math.floor(Date.now() / 1000) + 60,
          headers: { 'content-type': body.content_type, 'Content-MD5': body.content_md5,
            'x-amz-checksum-sha256': Buffer.from(body.sha256 as string, 'hex').toString('base64') } })
      }
      return Response.json(grant(body))
    }
    expect(new URL(String(url)).hostname).toBe('storage.example')
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
    expect(init?.redirect).toBe('error')
    if (init?.method === 'PUT') {
      expect(Buffer.from(init.body as Buffer)).toEqual(bytes)
      return new Response(null, { headers: { 'x-cos-version-id': 'output-v1' } })
    }
    return new Response(bytes, { headers: { 'content-length': String(bytes.length), 'x-cos-version-id': 'locked-v1' } })
  })
  vi.stubGlobal('fetch', send)
  const onOffer = vi.fn(async (_offer: EdgeTaskOffer) => undefined)
  const connection = new EdgeWorkerConnection({ origin: 'https://shanghai.example', loopbackOnly: false,
    tokenProvider: () => 'fixture-account', expectedOwnerId: 7, name: 'test', clientBuild: 'test', os: 'test', arch: 'test',
    capabilities: {}, allowedTaskTypes: ['file_copy_v1'], handshakeTimeoutMs: 1000, maxFrameBytes: 65536, maxOutputBytes: 4096,
    readLoad: () => 0, onOffer, onEvent: vi.fn() })
  try {
    await connection.connect(); connection.updateMode('running')
    Socket.latest.reply('shard_assign', { workload_id: id.workloadId, shard_id: id.shardId, attempt: 1,
      task_type: 'file_copy_v1', account_id: 42, file_contract: contract(), runtime: 'quickjs-wasm', input_kind: 'inline',
      inline_input: '{"text":"copy"}', input_ref: '', input_refs: [], code_url: '', code_sha256: '', timeout_s: 60,
      verification_policy: 'semantic', execution_model: '', capability: '', capability_version: '', lease_token: 'fixture-lease' })
    await vi.waitFor(() => expect(onOffer).toHaveBeenCalledOnce())
    const offer = onOffer.mock.calls[0]![0]
    expect(JSON.stringify(offer)).not.toContain('fixture-lease')
    const input = { slot: 'source', maxBytes: 32, contentTypes: ['text/plain'], contractSha256: contract().contract_sha256,
      fileSchemaSha256: contract().file_schema_sha256, trustedStorageHostname: 'storage.example' }
    await expect(connection.readFileAttachment({ ...offer, attempt: 2 }, input)).rejects.toThrow('EDGE_LEASE_NOT_ACTIVE')
    await expect(connection.readFileAttachment(offer, { ...input, contractSha256: 'sha256:' + 'd'.repeat(64) })).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
    const result = await connection.readFileAttachment(offer, input)
    expect(Buffer.from(result.bytes)).toEqual(bytes)
    expect(send).toHaveBeenCalledTimes(2)
    const upload = { filename: 'output.txt', contentType: 'text/plain', bytes,
      contractSha256: input.contractSha256, fileSchemaSha256: input.fileSchemaSha256 }
    await expect(connection.uploadFileArtifact({ ...offer, attempt: 2 }, upload)).rejects.toThrow('EDGE_LEASE_NOT_ACTIVE')
    await expect(connection.uploadFileArtifact(offer, { ...upload, bytes: Buffer.alloc(16385) })).rejects.toThrow()
    const manifest = await connection.uploadFileArtifact(offer, upload)
    expect(manifest).toMatchObject({ account_id: 42, object_version_id: 'output-v1', size_bytes: bytes.length, sha256: sha(bytes) })
    expect(() => connection.completeArtifact(offer, { artifact: { ...manifest, object_version_id: 'changed' }, elapsedMs: 1 })).toThrow()
    connection.completeArtifact(offer, { artifact: manifest, elapsedMs: 1 })
    expect(Socket.latest.sent.at(-1)).toMatchObject({ type: 'shard_result', payload: { attempt: 1, lease_token: 'fixture-lease', artifact: manifest } })
    expect(JSON.stringify(Socket.latest.sent.at(-1))).not.toContain('private-attachment')
    await expect(connection.readFileAttachment(offer, input)).rejects.toThrow('EDGE_LEASE_NOT_ACTIVE')
  } finally { await connection.close() }
})
it('file admission requires the dedicated provider and metadata; ordinary offer envelopes stay unchanged', () => {
  const offer: EdgeTaskOffer = { ...id, taskType: 'file_copy_v1', runtime: 'quickjs-wasm', inputKind: 'inline', inlineInput: '{"text":"copy"}',
    inputRef: '', inputRefs: [], codeUrl: '', codeSha256: '', timeoutSeconds: 60, verificationPolicy: 'semantic',
    executionModel: '', capability: '', capabilityVersion: '' }
  const context = { workerId: id.workerId, receivedAt: new Date().toISOString() }
  const ordinary = createInlineEdgeBinding({ nodeId: id.workerId, allowedTaskTypes: ['file_copy_v1'], maxOutputBytes: 4096 })
  const file = createInlineEdgeBinding({ nodeId: id.workerId, allowedTaskTypes: ['file_copy_v1'], maxOutputBytes: 4096,
    fileTaskTypeAllowed: () => true })
  expect(ordinary.bridge.toNodeOffer({ ...offer, fileContract: contract() }, context)).toEqual({ refuse: 'FILE_RUNTIME_UNAVAILABLE' })
  expect(file.bridge.toNodeOffer(offer, context)).toEqual({ refuse: 'FILE_CONTRACT_MISSING' })
  const admitted = file.bridge.toNodeOffer({ ...offer, fileContract: contract() }, context)
  expect(admitted).toMatchObject({ envelope: { maxOutputBytes: 16384, parameters: { fileContract: contract() } } })
  const legacy = ordinary.bridge.toNodeOffer(offer, context)
  if ('envelope' in legacy) expect(legacy.envelope.parameters).not.toHaveProperty('fileContract')
})
