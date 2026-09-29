import { createHash } from 'node:crypto'
import { execFile, type ExecFileOptions } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { ComputeCapabilityId, ComputeExecutorRegistry, ComputeTaskId } from '@deepseek-ai/dsh-compute-core'
import { NATIVE_H3_RUNTIME, NATIVE_H3_RUNTIME_ABI } from '../../compute-core/src/native-h3-binding.ts'
import type { ComputeResidentAttemptExecution } from '@deepseek-ai/dsh-compute-core/resident'
import { createArtifactOrderConsumer } from '../src/artifact-order.ts'
import { createH3VideoProvider, H3_FIXED_NEGATIVE, h3ComputeExecutor, h3OwnerIdentity, prepareH3OrderInput,
  readH3BoundedFile, readH3ExecutionIdentity, readH3OwnerConfig, type H3OwnerConfig } from '../src/h3-video.ts'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))
const media = Buffer.from('0000ftyp-h3-simulated-runner-fixture')
const sha = createHash('sha256').update(media).digest('hex')
const probe = JSON.stringify({ format: { duration: '5.000' }, streams: [{ codec_type: 'video',
  codec_name: 'h264', width: 32, height: 32 }] })
const healthy = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true, workflows: ['qs_new4'] })))

async function fixture(adapterBase = 'http://127.0.0.1:8790') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'h3-owner-fixture-')))
  roots.push(root)
  const program = await realpath(process.execPath)
  const config: H3OwnerConfig = { schema: 'qianshou.h3-owner.v1', pythonPath: program, ffmpegPath: program,
    ffprobePath: program, entryPath: join(root, 'video_generate.py'), runtimePath: join(root, 'h3_runtime.py'),
    firstFramePath: join(root, 'first.png'), workflowPath: join(root, 'workflow.json'), modelPath: join(root, 'model.bin'),
    workflow: 'qs_new4', adapterBase, outputRoot: root, selfTestReceiptPath: join(root, 'trial.json') }
  const executionIdentity = { executionRecipeSha256: 'b'.repeat(64), modelSha256: 'c'.repeat(64) }
  for (const file of ['video_generate.py', 'h3_runtime.py']) {
    await copyFile(new URL(`../runtime/h3/${file}`, import.meta.url), join(root, file))
  }
  await writeFile(config.firstFramePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]))
  await writeFile(config.workflowPath, '{"fixture":"simulated adapter; not real GPU"}')
  await writeFile(config.modelPath, 'fixture; not installed H3 weights')
  const configPath = join(root, 'owner.json')
  await writeFile(configPath, JSON.stringify(config))
  const programRunner = vi.fn(async (_program: string, args: string[], options: ExecFileOptions) => {
    if (args[0] === '-v') return { stdout: probe }
    const environment = options as { env: NodeJS.ProcessEnv }
    const path = join(environment.env.EC_OUTPUT_DIR!, 'generated.mp4')
    await writeFile(path, media)
    return { stdout: JSON.stringify({ status: 'ok', delivery_state: 'pending_node_upload', video_path: path,
      execution_identity: executionIdentity,
      local_output: { sha256: sha, size_bytes: media.length } }) }
  })
  const writeProof = async () => {
    const videoPath = join(root, 'prior-owner-trial.mp4')
    await writeFile(videoPath, media)
    const ownerIdentity = await h3OwnerIdentity(config)
    const nativeIdentity = JSON.stringify(Object.fromEntries(Object.entries({ ownerIdentity, ...executionIdentity })
      .sort(([a], [b]) => a.localeCompare(b))))
    await writeFile(config.selfTestReceiptPath, JSON.stringify({ schema: 'qianshou.h3-self-test.v1',
      generationExecuted: true, ownerIdentity, videoPath, bytes: media.length, sha256: sha,
      nativeBinding: { runtimeAbi: NATIVE_H3_RUNTIME_ABI, runtime: NATIVE_H3_RUNTIME,
        ownerConfigDigest: `sha256:${createHash('sha256').update(nativeIdentity).digest('hex')}`, ...executionIdentity } }))
    return videoPath
  }
  return { root, config, configPath, programRunner, writeProof, executionIdentity }
}

function execution(): ComputeResidentAttemptExecution {
  const taskId = ComputeTaskId('h3-fixture.shard')
  return { task: { version: 'qianshou.task.v1', taskId, capabilityId: ComputeCapabilityId('video.render'),
    capabilityVersion: '1.0.0', inputRefs: [], parameters: { taskType: 'video_generate', inlineInput: '镜头缓慢移动',
      runtime: 'python3', taskParams: { seconds: 5, seed: 2147483647 } },
    deadlineAt: '2026-09-27T23:00:00.000Z', maxOutputBytes: 16 * 1024 * 1024, idempotencyKey: 'a'.repeat(64) },
  attempt: { taskId, attempt: 1, leaseId: 'h3-lease', leaseExpiresAt: '2026-09-27T23:00:00.000Z',
    idempotencyKey: 'a'.repeat(64), envelopeFingerprint: 'b'.repeat(64), capabilityId: 'video.render',
    capabilityVersion: '1.0.0', capabilityPluginDigest: 'c'.repeat(64) },
  signal: new AbortController().signal, reportProgress: async () => undefined,
  source: { open: async () => new ReadableStream() }, dataSource: {} }
}

it('keeps H3 disabled without explicit owner configuration and never generates on health checks', async () => {
  const f = await fixture()
  const disabled = createH3VideoProvider('', healthy, f.programRunner)
  expect(await disabled.loadAndSelfTest()).toBeNull()
  expect(disabled.status()).toMatchObject({ configured: false, ready: false })
  const provider = createH3VideoProvider(f.configPath, healthy, f.programRunner, async () => f.executionIdentity)
  expect(await provider.loadAndSelfTest()).toBeNull()
  expect(provider.status()).toMatchObject({ ready: false, code: 'H3_REAL_SELF_TEST_REQUIRED' })
  expect(f.programRunner).not.toHaveBeenCalled()
})

it('pins real source files, first frame, workflow, model facts and matches the shipped owner CLI identity', async () => {
  const f = await fixture()
  const identity = await h3OwnerIdentity(await readH3OwnerConfig(f.configPath))
  // No adapter or subprocess generation: Python only reads this isolated fixture config.
  const script = fileURLToPath(new URL('../runtime/h3/owner_self_test.py', import.meta.url))
  const { stdout } = await promisify(execFile)('python3', ['-c',
    'import runpy,sys; x=runpy.run_path(sys.argv[1]); print(x["prepare"](sys.argv[2])[1])', script, f.configPath])
  expect(stdout.trim()).toBe(identity)
  await writeFile(f.config.runtimePath, '# modified runtime')
  await expect(h3OwnerIdentity(f.config)).rejects.toMatchObject({ code: 'H3_RUNTIME_SOURCE_CHANGED' })
})

it.each([{ image_path: '/buyer.png' }, { workflow: 'qs_other' }, { dry_run: true }, { seconds: 10 },
  { seed: 2147483648 }])('rejects buyer configuration override %j before execution', (parameters) => {
  expect(() => prepareH3OrderInput('描述', parameters)).toThrow('H3_PUBLIC_INPUT_INVALID')
})

it('uses the configured real-entry call and disk hashes through lease-bound upload in a simulated runner integration', async () => {
  const f = await fixture()
  await f.writeProof()
  const provider = createH3VideoProvider(f.configPath, healthy, f.programRunner, async () => f.executionIdentity)
  const adapter = await provider.loadAndSelfTest()
  expect(adapter).not.toBeNull()
  const workspacePath = join(f.root, 'task')
  await mkdir(workspacePath)
  const upload = vi.fn(async (_taskId: string, _attempt: number, input: { filename: string; contentType: string; bytes: Uint8Array }) => ({
    schema: 'artifact.v1' as const, object_key: 'v8/fixture/h3.mp4', object_version_id: 'immutable-fixture-version',
    filename: input.filename, content_type: input.contentType, size_bytes: input.bytes.length,
    sha256: createHash('sha256').update(input.bytes).digest('hex'), result_id: 'fixture-result',
    shard_id: 'shard', workload_id: 'h3-fixture', account_id: 7,
  }))
  const remember = vi.fn()
  const receipt = await createArtifactOrderConsumer(adapter!, { upload, remember }).consume({ execution: execution(),
    workspace: { path: workspacePath, outputs: [], close: async () => undefined }, signal: new AbortController().signal })
  expect(receipt.outputs).toEqual([{ name: 'result.mp4', bytes: media.length, sha256: sha }])
  expect(upload).toHaveBeenCalledOnce()
  expect(remember).toHaveBeenCalledWith('h3-fixture.shard', expect.objectContaining({
    object_version_id: 'immutable-fixture-version', sha256: sha }), expect.any(Number))
  const call = f.programRunner.mock.calls.find(([, args]) => args[0] === f.config.entryPath)!
  expect(call[1]).toEqual([f.config.entryPath])
  expect((call[2] as { env: NodeJS.ProcessEnv }).env).toMatchObject({ H3_FIRST_FRAME_PATH: f.config.firstFramePath,
    H3_RUNTIME_SCRIPT: f.config.runtimePath, H3_WORKFLOW: 'qs_new4', H3_FFMPEG: f.config.ffmpegPath,
    H3_ADAPTER_OUTPUT_ROOT: f.config.outputRoot,
    H3_EXPECTED_EXECUTION_RECIPE_SHA256: f.executionIdentity.executionRecipeSha256,
    H3_EXPECTED_MODEL_SHA256: f.executionIdentity.modelSha256 })
  expect((call[2] as { env: NodeJS.ProcessEnv }).env.H3_PREPARATION_ONLY).toBeUndefined()
  expect(JSON.parse((call[2] as { env: NodeJS.ProcessEnv }).env.EC_PARAMS!)).toEqual({
    prompt: '镜头缓慢移动', seconds: 5, seed: 2147483647 })
  const registry = new ComputeExecutorRegistry()
  const release = registry.register(h3ComputeExecutor(adapter!))
  const localTask = { ...execution().task, parameters: { prompt: '本机试用', seconds: 5 } }
  const local = await registry.execute(localTask, { workspacePath, signal: new AbortController().signal,
    interactionPolicy: 'autonomous', inputs: [], reportProgress: async () => undefined })
  expect(local.outputs[0]).toMatchObject({ bytes: media.length, sha256: sha })
  release()
  expect(registry.list()).toEqual([])
})

it('withdraws readiness when the trial output or the selected configuration changes', async () => {
  const f = await fixture()
  const video = await f.writeProof()
  const provider = createH3VideoProvider(f.configPath, healthy, f.programRunner, async () => f.executionIdentity)
  expect(await provider.loadAndSelfTest()).not.toBeNull()
  await writeFile(video, Buffer.from('0000ftyp-changed-output'))
  expect(await provider.loadAndSelfTest()).toBeNull()
  expect(provider.status()).toMatchObject({ ready: false, code: 'H3_SELF_TEST_OUTPUT_CHANGED' })
  await writeFile(f.config.firstFramePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]))
  expect(await provider.loadAndSelfTest()).toBeNull()
  expect(provider.status()).toMatchObject({ ready: false, code: 'H3_OWNER_CONFIGURATION_CHANGED' })
})

it('keeps native publication closed without real adapter recipe identity and a matching native-bound trial', async () => {
  const f = await fixture()
  await f.writeProof()
  const oldReceipt = JSON.parse(await readFile(f.config.selfTestReceiptPath, 'utf8')) as Record<string, unknown>
  delete oldReceipt.nativeBinding
  await writeFile(f.config.selfTestReceiptPath, JSON.stringify(oldReceipt))
  const legacy = createH3VideoProvider(f.configPath, healthy, f.programRunner)
  await expect(legacy.nativeAuthorBinding()).rejects.toMatchObject({ code: 'H3_RECIPE_IDENTITY_INVALID' })
  let actual = { executionRecipeSha256: 'b'.repeat(64), modelSha256: 'c'.repeat(64) }
  const provider = createH3VideoProvider(f.configPath, healthy, f.programRunner, async () => actual)
  await expect(provider.nativeAuthorBinding()).rejects.toMatchObject({ code: 'H3_NATIVE_SELF_TEST_REQUIRED' })
  const ownerIdentity = await h3OwnerIdentity(f.config)
  const identity = JSON.stringify(Object.fromEntries(Object.entries({ ownerIdentity, ...actual })
    .sort(([a], [b]) => a.localeCompare(b))))
  const nativeBinding = { runtimeAbi: NATIVE_H3_RUNTIME_ABI, runtime: NATIVE_H3_RUNTIME,
    ownerConfigDigest: `sha256:${createHash('sha256').update(identity).digest('hex')}`, ...actual }
  const videoPath = join(f.root, 'prior-owner-trial.mp4')
  await writeFile(f.config.selfTestReceiptPath, JSON.stringify({ schema: 'qianshou.h3-self-test.v1',
    generationExecuted: true, ownerIdentity, videoPath, bytes: media.length, sha256: sha, nativeBinding }))
  expect(await provider.nativeAuthorBinding()).toEqual(nativeBinding)
  actual = { ...actual, executionRecipeSha256: 'd'.repeat(64) }
  await expect(provider.nativeAuthorBinding()).rejects.toMatchObject({ code: 'H3_NATIVE_SELF_TEST_CHANGED' })
  expect(f.programRunner.mock.calls.every(([, args]) => args[0] === '-v')).toBe(true)
})

async function loopback(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error)
      else resolve()
    })) }
}

function identityResponse(request: IncomingMessage) {
  const url = new URL(request.url!, 'http://127.0.0.1')
  return { schemaVersion: 'qs.h3.recipe-identity.v1', workflow: 'qs_new4', recipeVersion: 'isolated-http-fixture-v1',
    graphTemplateSha256: 'd'.repeat(64), builderSourceSha256: 'e'.repeat(64),
    firstFrameSha256: url.searchParams.get('firstFrameSha256'), negativeSha256: url.searchParams.get('negativeSha256'),
    executionRecipeSha256: 'b'.repeat(64), modelSha256: 'c'.repeat(64), modelSetSha256: 'c'.repeat(64),
    weightSha256ByRole: Object.fromEntries(['audioVae', 'clip', 'lora', 'unet', 'videoVae'].map(role => [role, 'f'.repeat(64)])) }
}

it('uses the real bounded loopback recipe HTTP contract and the fixed Python negative bytes without running a job', async () => {
  const seen: IncomingMessage[] = []
  const adapter = await loopback((request, response) => {
    seen.push(request)
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(request.url?.startsWith('/health')
      ? { ok: true, workflows: ['qs_new4'] } : identityResponse(request)))
  })
  try {
    const f = await fixture(adapter.base)
    await f.writeProof()
    const provider = createH3VideoProvider(f.configPath, fetch, f.programRunner)
    expect(await provider.nativeAuthorBinding()).toMatchObject(f.executionIdentity)
    const request = seen.find(request => request.url?.startsWith('/v1/recipes/'))!
    const url = new URL(request.url!, adapter.base)
    expect(url.pathname).toBe('/v1/recipes/qs_new4/identity')
    expect([...url.searchParams.keys()].sort()).toEqual(['firstFrameSha256', 'negativeSha256'])
    expect(url.searchParams.get('firstFrameSha256')).toBe(createHash('sha256').update(await readFile(f.config.firstFramePath)).digest('hex'))
    expect(url.searchParams.get('negativeSha256')).toBe('1b9ba6eb9403d5414eee0cf941011b3d6eecaa5add6b2b0b481ad6d88e8d0bf0')
    expect(createHash('sha256').update(H3_FIXED_NEGATIVE, 'utf8').digest('hex')).toBe(url.searchParams.get('negativeSha256'))
    expect(request.headers.authorization).toBeUndefined()
    expect(request.headers.cookie).toBeUndefined()
    expect(request.headers.origin).toBeUndefined()
    expect(f.programRunner.mock.calls.every(([, args]) => args[0] === '-v')).toBe(true)
  } finally { await adapter.close() }
})

it.each(['workflow', 'schemaVersion', 'firstFrameSha256', 'negativeSha256', 'modelSetSha256', 'weightSha256ByRole', 'privatePath'])(
  'rejects a mismatched or extra recipe identity field %s over actual HTTP', async (field) => {
    const f = await fixture()
    const adapter = await loopback((request, response) => {
      const value: Record<string, unknown> = identityResponse(request)
      value[field] = field === 'weightSha256ByRole' ? { unet: 'f'.repeat(64) } : 'untrusted'
      response.end(JSON.stringify(value))
    })
    try {
      await expect(readH3ExecutionIdentity({ ...f.config, adapterBase: adapter.base }, new AbortController().signal))
        .rejects.toMatchObject({ code: 'H3_RECIPE_IDENTITY_INVALID' })
    } finally { await adapter.close() }
  },
)

it('refuses redirects and an oversized streamed identity instead of accepting an alternate path', async () => {
  const f = await fixture()
  let alternateRequests = 0
  const adapter = await loopback((request, response) => {
    if (request.url === '/alternate') { alternateRequests++; response.end('{}'); return }
    response.writeHead(302, { Location: '/alternate' })
    response.end()
  })
  try {
    await expect(readH3ExecutionIdentity({ ...f.config, adapterBase: adapter.base }, new AbortController().signal)).rejects.toThrow()
    expect(alternateRequests).toBe(0)
  } finally { await adapter.close() }
  const oversized = await loopback((_request, response) => response.end(Buffer.alloc(65537, 32)))
  try {
    await expect(readH3ExecutionIdentity({ ...f.config, adapterBase: oversized.base }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'H3_ADAPTER_RESPONSE_TOO_LARGE' })
  } finally { await oversized.close() }
})

it('rejects local aliases, paths and unsupported workflows before any recipe HTTP call', async () => {
  const f = await fixture()
  const fetchImpl = vi.fn<typeof fetch>()
  for (const adapterBase of ['http://localhost:8790', 'https://127.0.0.1', 'http://127.0.0.1/private',
    'http://user:secret@127.0.0.1', 'http://127.0.0.1/?key=hidden']) {
    await expect(readH3ExecutionIdentity({ ...f.config, adapterBase }, new AbortController().signal, fetchImpl))
      .rejects.toMatchObject({ code: 'H3_NODE_ADAPTER_MUST_BE_LOOPBACK' })
  }
  await expect(readH3ExecutionIdentity({ ...f.config, workflow: 'qs_base12' }, new AbortController().signal, fetchImpl))
    .rejects.toMatchObject({ code: 'H3_ATTESTED_WORKFLOW_UNSUPPORTED' })
  expect(fetchImpl).not.toHaveBeenCalled()
})

it('bounds real local file reads and refuses linked, empty or oversized files', async () => {
  const f = await fixture()
  expect(await readH3BoundedFile(f.config.firstFramePath, 9)).toEqual(await readFile(f.config.firstFramePath))
  await expect(readH3BoundedFile(f.config.firstFramePath, 8)).rejects.toMatchObject({ code: 'H3_LOCAL_FILE_INVALID' })
  const alias = join(f.root, 'linked.png')
  await symlink(f.config.firstFramePath, alias)
  await expect(readH3BoundedFile(alias, 9)).rejects.toMatchObject({ code: 'H3_LOCAL_FILE_INVALID' })
  await writeFile(f.config.firstFramePath, '')
  await expect(readH3BoundedFile(f.config.firstFramePath, 9)).rejects.toMatchObject({ code: 'H3_LOCAL_FILE_INVALID' })
})

it('does not promote a genuine local v1 trial into a v2 owner identity', async () => {
  const f = await fixture()
  await f.writeProof()
  const provider = createH3VideoProvider(f.configPath, healthy, f.programRunner, async () => f.executionIdentity)
  await expect(provider.nativeAuthorBindingV2()).rejects.toMatchObject({ code: 'H3_V2_OWNER_CONFIG_REQUIRED' })
  expect(f.programRunner).not.toHaveBeenCalled()
})
