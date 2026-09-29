import { createHash } from 'node:crypto'
import { once } from 'node:events'
import type { NodeContributorService } from '../src/index.ts'
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecFileOptions } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { NATIVE_H3_RUNTIME_ABI_V2, NATIVE_H3_RUNTIME_V2, nativeH3LogicalBindingSha256 } from '../../compute-core/src/native-h3-binding.ts'
import { canonicalNativeH3ReviewJson } from '../../compute-core/src/native-h3-review.ts'
import { createH3VideoProviderV2, h3OwnerIdentityV2, readH3ExecutionIdentityV2,
  type H3OwnerConfigV2 } from '../src/h3-video-v2.ts'
const roots: string[] = []
afterEach(async () => {
  try { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) }
  finally { vi.unstubAllEnvs() }
})
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const media = Buffer.from('0000ftyp-isolated-V2-test; no GPU output')
const healthy = vi.fn<typeof fetch>(async () => new Response('{"ok":true,"workflows":["qs_new4"]}'))
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'h3-owner-v2-')))
  roots.push(root)
  vi.stubEnv('DSH_HOME', root)
  const program = await realpath(process.execPath)
  const config: H3OwnerConfigV2 = { schema: 'qianshou.h3-owner.v2', pythonPath: program, ffmpegPath: program,
    ffprobePath: program, entryPath: join(root, 'video_generate.py'), runtimePath: join(root, 'h3_runtime.py'),
    firstFramePath: join(root, 'first.png'), workflowPath: join(root, 'workflow.json'), modelPath: join(root, 'model.bin'),
    workflow: 'qs_new4', adapterBase: 'http://127.0.0.1:8790', outputRoot: root, selfTestReceiptPath: join(root, 'trial.json') }
  for (const file of ['video_generate.py', 'h3_runtime.py']) await copyFile(new URL(`../runtime/h3-v2/${file}`,
    import.meta.url), join(root, file))
  await writeFile(config.firstFramePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]))
  await writeFile(config.workflowPath, '{"isolated":"not a real graph"}')
  await writeFile(config.modelPath, 'isolated; not GPU weights')
  const path = join(root, 'owner.json')
  await writeFile(path, JSON.stringify(config))
  const actual = { executionRecipeSha256: 'a'.repeat(64), modelSha256: 'b'.repeat(64),
    firstFrameSha256: hash(await readFile(config.firstFramePath)), localConfigSha256: hash(root) }
  const binding = { schema: 'qianshou.native-h3-execution-binding.v2' as const,
    runtimeAbi: NATIVE_H3_RUNTIME_ABI_V2, runtime: NATIVE_H3_RUNTIME_V2,
    executionRecipeSha256: actual.executionRecipeSha256, modelSha256: actual.modelSha256, firstFrameSha256: actual.firstFrameSha256 }
  const ownerIdentity = await h3OwnerIdentityV2(config)
  const digest = 'sha256:' + hash(canonicalNativeH3ReviewJson({ ownerIdentity, ...actual }))
  const videoPath = join(root, 'prior.mp4')
  await writeFile(videoPath, media)
  await writeFile(config.selfTestReceiptPath, JSON.stringify({ schema: 'qianshou.h3-self-test.v2', generationExecuted: true,
    ownerIdentity, nativeBinding: binding, localOwnerConfigDigest: digest, videoPath, bytes: media.length, sha256: hash(media) }))
  const programRunner = vi.fn(async (_program: string, args: string[], options: ExecFileOptions) => {
    if (args[0] === '-v') return { stdout: '{"format":{"duration":"5.000"},"streams":[{"codec_type":"video","codec_name":"h264","width":32,"height":32}]}' }
    const env = options.env!
    const output = join(env.EC_OUTPUT_DIR!, 'result.mp4')
    await writeFile(output, media)
    return { stdout: JSON.stringify({ schema_version: 'v2', status: 'ok', delivery_state: 'pending_node_upload', video_path: output,
      execution_identity: actual, local_output: { sha256: hash(media), size_bytes: media.length } }) }
  })
  const reader = vi.fn(async () => ({ ...actual }))
  return { root, config, path, reader, actual, binding, digest, programRunner }
}
it('prepares independently executed v2 local trials with equal public identity and unequal private path/routing identity', async () => {
  const a = await fixture(); const b = await fixture()
  const pa = createH3VideoProviderV2(a.path, healthy, a.programRunner, a.reader)
  const pb = createH3VideoProviderV2(b.path, healthy, b.programRunner, b.reader)
  const left = await pa.nativeAuthorBindingV2(); const right = await pb.nativeAuthorBindingV2()
  expect(left.binding).toEqual(right.binding)
  expect(nativeH3LogicalBindingSha256(left.binding)).toBe(nativeH3LogicalBindingSha256(right.binding))
  expect(left.localOwnerConfigDigest).toBe(a.digest)
  expect(left.localOwnerConfigDigest).not.toBe(right.localOwnerConfigDigest)
  expect(a.programRunner.mock.calls.every(([, args]) => args[0] === '-v')).toBe(true)
  await copyFile(a.config.selfTestReceiptPath, b.config.selfTestReceiptPath)
  await expect(pb.nativeAuthorBindingV2()).rejects.toMatchObject({ code: 'H3_V2_REAL_SELF_TEST_REQUIRED' })
})
it('requires independent v2 config and selftest, including the measured private routing digest', async () => {
  const f = await fixture()
  const p = createH3VideoProviderV2(f.path, healthy, f.programRunner, f.reader)
  f.actual.localConfigSha256 = 'f'.repeat(64)
  await expect(p.nativeAuthorBindingV2()).rejects.toMatchObject({ code: 'H3_V2_REAL_SELF_TEST_REQUIRED' })
  const receipt = JSON.parse(await readFile(f.config.selfTestReceiptPath, 'utf8')) as Record<string, unknown>
  await writeFile(f.config.selfTestReceiptPath, JSON.stringify({ ...receipt, schema: 'qianshou.h3-self-test.v1' }))
  expect(await p.loadAndSelfTestV2()).toBeNull()
  await writeFile(f.path, JSON.stringify({ ...f.config, schema: 'qianshou.h3-owner.v1' }))
  await expect(p.nativeAuthorBindingV2()).rejects.toMatchObject({ code: 'H3_V2_OWNER_CONFIG_REQUIRED' })
  expect(f.programRunner).not.toHaveBeenCalled()
})
it('uses only v2 reader12 and passes all four actual identities to the independent pinned entry', async () => {
  const f = await fixture()
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input)
    expect(url.pathname).toBe('/v2/recipes/qs_new4/identity')
    return new Response(JSON.stringify({ schemaVersion: 'qs.h3.recipe-identity.v2', workflow: 'qs_new4', recipeVersion: 'isolated',
      graphTemplateSha256: 'c'.repeat(64), builderSourceSha256: 'd'.repeat(64), ...f.actual,
      negativeSha256: url.searchParams.get('negativeSha256'), modelSetSha256: f.actual.modelSha256,
      weightSha256ByRole: Object.fromEntries(['audioVae', 'clip', 'lora', 'unet', 'videoVae'].map(role => [role, 'e'.repeat(64)])) }))
  })
  expect(await readH3ExecutionIdentityV2(f.config, new AbortController().signal, fetchImpl)).toEqual(f.actual)
  const provider = createH3VideoProviderV2(f.path, healthy, f.programRunner, f.reader)
  const runtime = await provider.loadAndSelfTestV2()
  expect(runtime).not.toBeNull()
  await runtime!.run({ recipeJson: '{"prompt":"中文镜头","seconds":5}', outputFormat: 'mp4', workspacePath: f.root,
    signal: new AbortController().signal })
  const invocation = f.programRunner.mock.calls.find(([, args]) => args[0] !== '-v')!
  expect(invocation[1]).toEqual([f.config.entryPath])
  expect(invocation[2].env).toMatchObject({ H3_EXPECTED_FIRST_FRAME_SHA256: f.actual.firstFrameSha256,
    H3_EXPECTED_LOCAL_CONFIG_SHA256: f.actual.localConfigSha256, H3_EXPECTED_MODEL_SHA256: f.actual.modelSha256,
    H3_EXPECTED_EXECUTION_RECIPE_SHA256: f.actual.executionRecipeSha256 })
  expect(f.programRunner.mock.calls.filter(([, args]) => args[0] !== '-v')).toHaveLength(1)
})

it('loads the actual Node service through Cordis Loader and reads the independent V2 provider without opening GPU supply', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const Loader = (await import('@deepseek-ai/cordis-plugin-loader')).default
  const Include = (await import('@deepseek-ai/cordis-plugin-include')).default
  const NodeContributor = await import('../src/index.ts')
  const { createServer } = await import('node:http')
  const { pathToFileURL } = await import('node:url')
  const { chmod } = await import('node:fs/promises')
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1')
    response.end(JSON.stringify(url.pathname === '/health' ? { ok: true, workflows: ['qs_new4'] }
      : { schemaVersion: 'qs.h3.recipe-identity.v2', workflow: 'qs_new4', recipeVersion: 'isolated-loader',
        graphTemplateSha256: 'c'.repeat(64), builderSourceSha256: 'd'.repeat(64), ...f.actual,
        negativeSha256: url.searchParams.get('negativeSha256'), modelSetSha256: f.actual.modelSha256,
        weightSha256ByRole: Object.fromEntries(['audioVae', 'clip', 'lora', 'unet', 'videoVae'].map(role => [role, 'e'.repeat(64)])) }))
  })
  const f = await fixture()
  const ctx = new Context()
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address(); if (address === null || typeof address === 'string') throw new Error('No loopback address')
    const probe = join(f.root, 'ffprobe.mjs')
    await writeFile(probe, '#!' + process.execPath + '\nconsole.log(JSON.stringify({format:{duration:"5"},streams:[{codec_type:"video",codec_name:"h264",width:32,height:32}]}))\n')
    await chmod(probe, 0o700)
    const config = { ...f.config, adapterBase: `http://127.0.0.1:${address.port}`, ffprobePath: probe }
    await writeFile(f.path, JSON.stringify(config))
    const ownerIdentity = await h3OwnerIdentityV2(config)
    await writeFile(config.selfTestReceiptPath, JSON.stringify({ schema: 'qianshou.h3-self-test.v2', generationExecuted: true,
      ownerIdentity, nativeBinding: f.binding,
      localOwnerConfigDigest: 'sha256:' + hash(canonicalNativeH3ReviewJson({ ownerIdentity, ...f.actual })),
      videoPath: join(f.root, 'prior.mp4'), bytes: media.length, sha256: hash(media) }))
    const configPath = join(f.root, 'cordis.json')
    await writeFile(configPath, JSON.stringify([{ id: 'connection', name: 'connection-fixture' },
      { id: 'node', name: 'node-fixture', config: { autoStart: false, mode: 'OFF', h3OwnerConfigPath: f.path,
        storePath: join(f.root, 'store.json'), workspaceRoot: join(f.root, 'workspaces') } }]))
    ctx.baseUrl = pathToFileURL(f.root).href + '/'
    await ctx.plugin(Loader); ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([['connection-fixture', { name: 'connection-fixture', apply(context: typeof ctx) {
      context.provide('connection', { fetch: { register: () => () => undefined } })
    } }], ['node-fixture', { name: 'node-fixture', inject: ['connection'], apply: NodeContributor.apply, Config: NodeContributor.Config }]])
    ctx.loader.internal = { version: 'v2',
      import: async (name: string) => modules.get(name) } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } }); await ctx.loader.await()
    const node = ctx.get('nodeContributor') as NodeContributorService
    expect(node.h3VideoReadiness()).toMatchObject({ ready: false, code: 'H3_SETUP_SELF_TEST_UNKNOWN' })
    // Pure identity does not grant intake. The real admission read first checks
    // this fixture's isolated durable guard while OFF supply remains unavailable.
    expect(await node.nativeH3OrderAdapterReady('video_generate')).toBe(false)
    expect((await node.nativeH3AuthorBindingV2()).binding).toEqual(f.binding)
    expect(node.h3VideoReadiness()).toMatchObject({ ready: true, code: 'H3_V2_REAL_SELF_TEST_VERIFIED' })
    expect(node.status().intake).toBe('paused')
    expect(node.acknowledgedConnectionId()).toBeNull()
    await writeFile(config.selfTestReceiptPath, '{}')
    await expect(node.nativeH3AuthorBindingV2()).rejects.toThrow()
    expect(node.h3VideoReadiness()).toMatchObject({ ready: false, code: 'H3_V2_REAL_SELF_TEST_REQUIRED' })
    await writeFile(f.path, JSON.stringify({ ...config, schema: 'qianshou.h3-owner.v1' }))
    await expect(node.nativeH3AuthorBinding()).rejects.toMatchObject({ code: 'H3_RUNTIME_SOURCE_CHANGED' })
    expect(node.h3VideoReadiness()).toMatchObject({ ready: false, code: 'H3_RUNTIME_SOURCE_CHANGED' })
  } finally {
    await ctx.fiber.dispose(); server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
})
