import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { readPinnedFileAttachment } from '../../compute-core/src/edge-worker/artifact-read.ts'
import { uploadEdgeArtifact } from '../../compute-core/src/edge-worker/artifact-upload.ts'
import { canonicalOrderJson } from '../src/order-json-canonical.ts'
import { readGenericOrderSource } from '../src/generic-order-source.ts'
import { runGenericOrderChallenge, verifyGenericOrderAdapter } from '../src/generic-order-adapter.ts'
import { executeGenericOrderFile, runGenericOrderFileChallenge } from '../src/generic-file-runtime.ts'
import { FILE_ABI, FILE_BYTES_POLICY, fileGuestInput, fileGuestOutput, parseGenericFileSchema } from '../src/generic-file-contract.ts'

const schema = { schema: FILE_ABI, verificationPolicy: FILE_BYTES_POLICY,
  inputs: [{ name: 'source', contentTypes: ['application/octet-stream'], maxBytes: 32 }],
  outputs: [{ name: 'result', filename: 'output.bin', contentType: 'application/octet-stream', maxBytes: 32, encoding: 'base64' }] }
const bytes = Buffer.from([0, 255, 10, 3])
const digest = createHash('sha256').update(bytes).digest('hex')
const result = { schema: 'qianshou.quickjs-file-result.v1', files: [{ name: 'result', encoding: 'base64', content: bytes.toString('base64') }] }
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'qianshou-file-abi-'))
  const root = join(home, 'skill')
  await cp(fileURLToPath(new URL('../examples/quickjs-char-count-skill/', import.meta.url)), root, { recursive: true })
  const sourceRoot = join(root, 'scripts/order_adapter')
  const definitionPath = join(sourceRoot, 'task-definition.json')
  const declarationPath = join(sourceRoot, 'local-adapter.json')
  const definition = JSON.parse(await readFile(definitionPath, 'utf8'))
  Object.assign(definition, { outputKind: 'artifact_ref', resultStrategy: FILE_BYTES_POLICY, fileSchema: schema })
  delete definition.outputSchema
  const declaration = JSON.parse(await readFile(declarationPath, 'utf8'))
  declaration.outputKind = 'artifact_ref'
  for (const sample of declaration.selfTests) {
    sample.attachments = { source: { path: 'samples/source.bin', contentType: 'application/octet-stream' } }
    await writeFile(join(sourceRoot, sample.expected), canonicalOrderJson(result))
  }
  await writeFile(definitionPath, canonicalOrderJson(definition))
  await writeFile(declarationPath, canonicalOrderJson(declaration))
  await writeFile(join(sourceRoot, 'samples/source.bin'), bytes)
  await writeFile(join(sourceRoot, 'src/adapter.quickjs.js'), `function run(input) {
    if (typeof process !== 'undefined' || typeof require !== 'undefined' || typeof fetch !== 'undefined') throw Error('unsafe');
    return {schema:'qianshou.quickjs-file-result.v1',files:[{name:'result',encoding:'base64',content:input.attachments[0].content}]};
  }`)
  return { home, sourceRoot, skill: join(root, 'SKILL.md') }
}

it('runs actual isolated v3 samples and a bounded binary attachment without an inline fallback', async () => {
  const sample = await fixture()
  try {
    const source = await readGenericOrderSource(sample.skill)
    expect(await verifyGenericOrderAdapter(source)).toMatchObject({ localVerified: true, platformReady: false })
    const read = vi.fn(async () => ({ contentType: 'application/octet-stream', bytes, sha256: digest }))
    const actual = await runGenericOrderFileChallenge(source, Buffer.from('{"text":"测试"}'), read)
    expect(actual.output).toEqual(result)
    expect(Buffer.from(actual.files[0]!.bytes)).toEqual(bytes)
    expect(actual.files[0]).toMatchObject({ filename: 'output.bin', sha256: digest })
    expect(read.mock.calls[0]).toEqual([schema.inputs[0]])
    await expect(runGenericOrderChallenge(source, Buffer.from('{"text":"测试"}'))).rejects.toMatchObject({ code: 'order-runtime-unavailable' })
  } finally { await rm(sample.home, { recursive: true, force: true }) }
})

it('completes authorized exact-version read, actual WASM execution and lease-bound storage PUT; only metadata goes to Shanghai', async () => {
  const sample = await fixture()
  try {
    const source = await readGenericOrderSource(sample.skill)
    const identity = { workerId: 'ff4230bd-0891-5e1b-b139-8b6603eb2930', workloadId: '7ea3d752-44e9-430a-becc-5fbd125a0e1c',
      shardId: '4d580819-e70f-41fd-983f-495f5294817e', attempt: 1 }
    const resultId = '4870318e-d2f4-53af-9582-aefb06d25314'
    const key = `v8/account-167/workload-${identity.workloadId}/shard-${identity.shardId}/result/${resultId}/output.bin`
    const oldKey = 'v8/account-167/previous/source.bin'
    const pinned = { objectKey: oldKey, objectVersionId: 'locked-input-1', sha256: digest, sizeBytes: bytes.length, contentType: 'application/octet-stream' }
    const authorize = vi.fn(async () => ({ ...pinned, url: `https://storage.example/${oldKey}?versionId=locked-input-1`, expiresAt: 10_000 }))
    const send = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const address = String(url)
      if (init?.method === 'GET') {
        expect(address).toContain('storage.example')
        expect(init.headers).toBeUndefined()
        return new Response(bytes, { headers: { 'content-length': String(bytes.length), 'x-cos-version-id': 'locked-input-1' } })
      }
      if (address.includes('/api/v8/files/result-upload-url')) {
        const metadata = JSON.parse(String(init?.body))
        expect(metadata).not.toHaveProperty('bytes')
        expect(metadata).not.toHaveProperty('content')
        expect(metadata).toMatchObject({ sha256: digest, size_bytes: bytes.length, lease_token: 'host-only-lease' })
        return new Response(JSON.stringify({ schema_version: 'artifact.v1', method: 'PUT', object_key: key,
          upload_url: 'https://storage.example/upload', expires_at: 10_000,
          headers: { 'x-amz-checksum-sha256': Buffer.from(digest, 'hex').toString('base64') } }))
      }
      expect(address).toBe('https://storage.example/upload')
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
      expect(Buffer.from(init?.body as Uint8Array)).toEqual(bytes)
      return new Response(null, { headers: { 'x-cos-version-id': 'locked-output-1' } })
    })
    const artifact = await executeGenericOrderFile(source, Buffer.from('{"text":"复制附件"}'), slot => readPinnedFileAttachment({
      coreOrigin: new URL('https://shanghai.example'), trustedStorageHostname: 'storage.example',
      pinned, maxBytes: slot.maxBytes, contentTypes: slot.contentTypes, authorize, fetch: send as typeof fetch, now: () => 1000,
    }), file => uploadEdgeArtifact({ origin: new URL('https://shanghai.example'), token: 'host-only-account', leaseToken: 'host-only-lease',
      identity, resultId, filename: file.filename, contentType: file.contentType, bytes: file.bytes,
      fetch: send as typeof fetch, now: () => 1000 }))
    expect(artifact).toMatchObject({ schema: 'artifact.v1', sha256: digest, object_version_id: 'locked-output-1', size_bytes: bytes.length })
    expect(JSON.stringify(artifact)).not.toContain(bytes.toString('base64'))
    expect(send).toHaveBeenCalledTimes(3)
    expect(authorize).toHaveBeenCalledOnce()
  } finally { await rm(sample.home, { recursive: true, force: true }) }
})

it.each([
  { ...schema, command: 'curl' }, { ...schema, verificationPolicy: 'author-verifier.v1' },
  { ...schema, inputs: [...schema.inputs, ...schema.inputs] },
  { ...schema, outputs: [{ ...schema.outputs[0], maxBytes: 16385 }] },
  { ...schema, outputs: [{ ...schema.outputs[0], filename: '../out' }] },
  { ...schema, outputs: [{ ...schema.outputs[0], contentType: 'text/plain; charset=utf-8' }] },
  { ...schema, outputs: [{ ...schema.outputs[0], encoding: 'hex' }] },
  { ...schema, outputs: [{ ...schema.outputs[0], encoding: ['base64'] }] },
])('rejects unsupported declaration %j', invalid => {
  expect(() => parseGenericFileSchema(invalid)).toThrow()
})

it('uses the same canonical file declaration digest as the shared Shanghai/Guangzhou fixture', () => {
  expect(createHash('sha256').update(canonicalOrderJson(parseGenericFileSchema(schema))).digest('hex'))
    .toBe('0996d734806641dc7439eb7ad8322a32018bcb2233cfa366ca7c7dd3953068a0')
})

it.each([
  { ...result, object_key: 'elsewhere' },
  { ...result, files: [{ ...result.files[0], filename: 'author-path' }] },
  { ...result, files: [{ ...result.files[0], name: 'other' }] },
  { ...result, files: [{ ...result.files[0], content: ' A P8KAw==' }] },
  { ...result, files: [{ ...result.files[0], content: 'AB==' }] },
  { ...result, files: [{ ...result.files[0], content: Buffer.alloc(33).toString('base64') }] },
  { ...result, files: [] },
])('rejects guest path/format/size bypass %j', invalid => {
  expect(() => fileGuestOutput(parseGenericFileSchema(schema), invalid)).toThrow()
})

it('rejects mismatched attachment bytes before the guest runs and leaves zero-input generators without read authority', async () => {
  await expect(fileGuestInput(parseGenericFileSchema(schema), {}, async () => ({ contentType: 'application/octet-stream', sha256: digest, bytes: Buffer.from('wrong') }))).rejects.toThrow()
  const read = vi.fn()
  const encoded = await fileGuestInput(parseGenericFileSchema({ ...schema, inputs: [] }), { text: 'generate' }, read)
  expect(JSON.parse(encoded.toString()).attachments).toEqual([])
  expect(read).not.toHaveBeenCalled()
})
