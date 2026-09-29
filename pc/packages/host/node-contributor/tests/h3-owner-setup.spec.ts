import { createHash } from 'node:crypto'
import { constants, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { NATIVE_H3_RUNTIME_ABI_V2, NATIVE_H3_RUNTIME_V2 } from '../../compute-core/src/native-h3-binding.ts'
import { canonicalNativeH3ReviewJson } from '../../compute-core/src/native-h3-review.ts'
import { H3OwnerSetup, type H3OwnerSetupScope } from '../src/h3-owner-setup.ts'
import type { H3OwnerSetupSelection, H3OwnerSetupContextId } from '../src/h3-owner-setup-types.ts'
import { h3OwnerIdentityV2, readH3OwnerConfigV2 } from '../src/h3-video-v2.ts'
import type { NativeProgramRunner } from '../src/command-artifact.ts'

const fixtures: { root: string; setup: H3OwnerSetup }[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) { await fixture.setup.dispose(); await rm(fixture.root, { recursive: true, force: true }) }
})
const signal = (): AbortSignal => new AbortController().signal
const sha = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex')
const canonical = canonicalNativeH3ReviewJson
function deferred() {
  let resolve: () => void = () => { throw new Error('not initialized') }
  const promise = new Promise<void>((accept) => { resolve = accept })
  return { promise, resolve }
}

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'h3-owner-setup-'))
  const runtimeDirectory = join(root, 'runtime')
  await mkdir(runtimeDirectory, { mode: 0o700 })
  for (const name of ['video_generate.py', 'h3_runtime.py', 'owner_self_test.py']) {
    await copyFile(fileURLToPath(new URL('../runtime/h3-v2/' + name, import.meta.url)), join(runtimeDirectory, name))
  }
  const selection: H3OwnerSetupSelection = { runtime: 'v2', pythonPath: join(root, 'python'),
    ffmpegPath: join(root, 'ffmpeg'), ffprobePath: join(root, 'ffprobe'), firstFramePath: join(root, 'frame.png'),
    workflowPath: join(root, 'workflow.json'), modelPath: join(root, 'model.safetensors'), adapterBase: 'http://127.0.0.1:8790',
    adapterOutputRoot: join(root, 'actual-comfy-output') }
  await mkdir(selection.adapterOutputRoot)
  for (const path of [selection.pythonPath, selection.ffmpegPath, selection.ffprobePath]) {
    await writeFile(path, '# fixed fixture executable', { mode: 0o700 })
  }
  const frame = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
  await writeFile(selection.firstFramePath, frame)
  await writeFile(selection.workflowPath, '{}')
  await writeFile(selection.modelPath, 'fixed fixture weights; not a GPU model')
  const actual = { executionRecipeSha256: 'a'.repeat(64), modelSha256: 'b'.repeat(64),
    firstFrameSha256: sha(frame), localConfigSha256: 'd'.repeat(64) }
  const state: {
    owner: H3OwnerSetupScope | null
    gate: ReturnType<typeof deferred> | null
    throwAfterStart: boolean
    mutateAfterStart: (() => Promise<void>) | null
    readScopeGate: ReturnType<typeof deferred> | null
  } = {
    owner: { ownerId: 167, profileDir: root }, gate: null, throwAfterStart: false, mutateAfterStart: null, readScopeGate: null }
  const requests: URL[] = []
  const fetchImpl = vi.fn<typeof fetch>(async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); requests.push(url)
    expect(options?.method ?? 'GET').toBe('GET')
    expect(options?.redirect).toBe('error')
    expect(options?.credentials).toBe('omit')
    if (url.pathname === '/health') return Response.json({ ok: true, workflows: ['qs_new4'] })
    expect(url.pathname).toBe('/v2/recipes/qs_new4/identity')
    return Response.json({ schemaVersion: 'qs.h3.recipe-identity.v2', workflow: 'qs_new4', recipeVersion: 'fixture-v2',
      graphTemplateSha256: 'e'.repeat(64), builderSourceSha256: 'f'.repeat(64), ...actual,
      firstFrameSha256: url.searchParams.get('firstFrameSha256'), negativeSha256: url.searchParams.get('negativeSha256'),
      modelSetSha256: actual.modelSha256, weightSha256ByRole: { audioVae: '1'.repeat(64), clip: '2'.repeat(64),
        lora: '3'.repeat(64), unet: '4'.repeat(64), videoVae: '5'.repeat(64) } })
  })
  const program = vi.fn<NativeProgramRunner>(async (programPath, args, options) => {
    if (programPath === selection.ffprobePath) return { stdout: JSON.stringify({ format: { duration: '5.0' },
      streams: [{ codec_type: 'video', width: 512, height: 512, codec_name: 'h264' }] }) }
    expect(programPath).toBe(selection.pythonPath)
    expect(args.slice(1, 3)).toEqual(['--run-local-trial', '--config'])
    expect(options.env).not.toHaveProperty('EC_OWNER_TOKEN')
    expect(options.timeout).toBe(1_500_000)
    if (state.gate) await Promise.race([state.gate.promise, new Promise<never>((_, reject) => {
      options.signal?.addEventListener('abort', () => { reject(new Error('child aborted; remote GPU unknown')) }, { once: true })
    })])
    if (state.throwAfterStart) throw new Error('child ended without a confirmed Comfy outcome')
    const configPath = args[3]!
    const config = await readH3OwnerConfigV2(configPath)
    expect(config.outputRoot).toBe(selection.adapterOutputRoot)
    expect(args[7]).not.toContain(selection.adapterOutputRoot)
    const ownerIdentity = await h3OwnerIdentityV2(config)
    const bytes = Buffer.from('0000ftyp-mock video; no GPU execution in this test')
    const videoPath = join(args[7]!, 'local-trial.mp4')
    await writeFile(videoPath, bytes, { mode: 0o600 })
    await writeFile(config.selfTestReceiptPath, JSON.stringify({ schema: 'qianshou.h3-self-test.v2', generationExecuted: true,
      nativeBinding: { schema: 'qianshou.native-h3-execution-binding.v2', runtimeAbi: NATIVE_H3_RUNTIME_ABI_V2,
        runtime: NATIVE_H3_RUNTIME_V2, executionRecipeSha256: actual.executionRecipeSha256,
        modelSha256: actual.modelSha256, firstFrameSha256: actual.firstFrameSha256 }, ownerIdentity,
      localOwnerConfigDigest: 'sha256:' + sha(canonical({ ownerIdentity, ...actual })),
      videoPath, sha256: sha(bytes), bytes: bytes.length }), { mode: 0o600 })
    await state.mutateAfterStart?.()
    return { stdout: '{}' }
  })
  const onSaved = vi.fn(async (path: string) => { await readH3OwnerConfigV2(path) })
  const assertIdle = vi.fn(async () => {})
  const activity = vi.fn<(active: boolean) => void>()
  const options = { homePath: root, runtimeDirectory, readScope: async () => { await state.readScopeGate?.promise; return state.owner },
    assertIdle, onSaved, onTrialActivity: activity, program, fetchImpl }
  const setup = new H3OwnerSetup(options); fixtures.push({ root, setup })
  let context: H3OwnerSetupContextId | undefined
  const contextId = () => { if (!context) throw new Error('configuration not saved'); return context }
  async function save(expectedRevision = 0) {
    const inspection = await setup.inspect(selection)
    if (inspection.kind !== 'inspection') throw new Error('missing inspection')
    const result = await setup.save({ inspectionId: inspection.inspectionId, expectedRevision }, signal())
    context = result.contextId
    return result
  }
  const settle = async (operationId: Parameters<H3OwnerSetup['selfTestStatus']>[0], controller = setup) => {
    await vi.waitFor(async () => {
      const operation = await controller.selfTestStatus(operationId)
      expect(operation.state).not.toBe('pending')
      if (operation.state === 'ready' || operation.state === 'failed') {
        expect(await controller.readTrialAdmission()).toEqual({ state: 'clear' })
        expect(activity).toHaveBeenLastCalledWith(false)
      }
    }, { timeout: 3000, interval: 10 })
    return controller.selfTestStatus(operationId)
  }
  return { root, options, setup, selection, state, program, fetchImpl, requests, activity, onSaved, assertIdle, save, settle, contextId }
}

it('reads, inspects and durably saves a private revision without starting a process or platform mutation', async () => {
  const f = await fixture()
  expect(await f.setup.inspect()).toMatchObject({ state: 'unconfigured', configured: false, revision: 0 })
  expect(await f.save()).toMatchObject({ state: 'saved', revision: 1 })
  const current = await f.setup.resolveCurrentConfigState()
  expect(current?.revision).toBe(1)
  expect(await readH3OwnerConfigV2(current!.configPath)).toMatchObject({ schema: 'qianshou.h3-owner.v2' })
  expect(await f.setup.inspect()).toMatchObject({ state: 'saved', revision: 1 })
  expect(f.onSaved).toHaveBeenCalledOnce()
  expect(f.program).not.toHaveBeenCalled()
  expect(f.activity).not.toHaveBeenCalled()
  expect(f.requests).toHaveLength(1)
  await expect(f.setup.freshVerifiedBinding(1, f.contextId())).rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_REQUIRED' })
})

it.each(['canonical', 'remote', 'symlink', 'runtime'])('rejects unsupported or unsafe %s selection before execution', async (kind) => {
  const f = await fixture(); let selection = f.selection
  if (kind === 'canonical') selection = { ...selection, runtime: 'canonical' }
  if (kind === 'remote') selection = { ...selection, adapterBase: 'https://platform.invalid' }
  if (kind === 'symlink') { await symlink(selection.firstFramePath, join(f.root, 'linked.png')); selection = { ...selection, firstFramePath: join(f.root, 'linked.png') } }
  if (kind === 'runtime') await writeFile(join(f.options.runtimeDirectory, 'h3_runtime.py'), 'unapproved source')
  await expect(f.setup.inspect(selection)).rejects.toThrow()
  expect(f.program).not.toHaveBeenCalled()
  expect(await f.setup.inspect()).toMatchObject({ configured: false })
})

it('keeps an unavailable adapter separate from valid files and does not fabricate local readiness', async () => {
  const f = await fixture(); vi.mocked(f.fetchImpl).mockRejectedValueOnce(new Error('offline'))
  expect(await f.setup.inspect(f.selection)).toMatchObject({ kind: 'inspection', adapterAvailable: false, code: 'H3_SETUP_ADAPTER_UNAVAILABLE' })
  expect(f.program).not.toHaveBeenCalled()
})

it('consumes each inspection once, checks exact file freshness and preserves revision on a changed file', async () => {
  const f = await fixture(); const inspection = await f.setup.inspect(f.selection)
  if (inspection.kind !== 'inspection') throw new Error('missing inspection')
  await writeFile(f.selection.workflowPath, '{"changed":true}')
  await expect(f.setup.save({ inspectionId: inspection.inspectionId, expectedRevision: 0 }, signal())).rejects.toMatchObject({ code: 'H3_SETUP_FILES_CHANGED' })
  await expect(f.setup.save({ inspectionId: inspection.inspectionId, expectedRevision: 0 }, signal())).rejects.toMatchObject({ code: 'H3_SETUP_INSPECTION_EXPIRED' })
  expect(await f.setup.inspect()).toMatchObject({ revision: 0 })
  expect(f.program).not.toHaveBeenCalled()
})

it('rejects stale revision CAS and changes A to B to A without reviving an old revision', async () => {
  const f = await fixture(); const old = await f.setup.inspect(f.selection)
  if (old.kind !== 'inspection') throw new Error('missing inspection')
  await f.save()
  await expect(f.setup.save({ inspectionId: old.inspectionId, expectedRevision: 0 }, signal())).rejects.toMatchObject({ code: 'H3_SETUP_REVISION_CONFLICT' })
  await f.save(1); await f.save(2)
  expect(await f.setup.resolveCurrentConfigState()).toMatchObject({ revision: 3 })
  expect(f.onSaved).toHaveBeenCalledTimes(3)
  expect(f.program).not.toHaveBeenCalled()
})

it('isolates authenticated owner changes and rejects a disappeared or altered saved configuration', async () => {
  const f = await fixture(); const inspection = await f.setup.inspect(f.selection)
  if (inspection.kind !== 'inspection') throw new Error('missing inspection')
  f.state.owner = { ownerId: 168, profileDir: f.root }
  await expect(f.setup.save({ inspectionId: inspection.inspectionId, expectedRevision: 0 }, signal())).rejects.toThrow()
  expect(await f.setup.inspect()).toMatchObject({ configured: false })
  f.state.owner = { ownerId: 167, profileDir: f.root }; await f.save()
  const current = await f.setup.resolveCurrentConfigState()
  await unlink(current!.configPath)
  await expect(f.setup.inspect()).rejects.toMatchObject({ code: 'H3_SETUP_CONFIG_CHANGED' })
  expect(f.program).not.toHaveBeenCalled()
})

it('starts one explicit trial, keeps intake paused, and validates actual local receipt before draft eligibility', async () => {
  const f = await fixture(); await f.save(); f.state.gate = deferred()
  const pending = await f.setup.startSelfTest({ contextId: f.contextId(), revision: 1, prompt: '五秒中文试片' }, signal())
  expect(pending.state).toBe('pending')
  expect(await f.setup.startSelfTest({ contextId: f.contextId(), revision: 1, prompt: '不同描述不能重跑' }, signal())).toEqual(pending)
  await expect(f.setup.resolveCurrentConfigState()).rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_PENDING' })
  await expect(f.setup.freshVerifiedBinding(1, f.contextId())).rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_REQUIRED' })
  expect(f.activity).toHaveBeenCalledWith(true)
  f.state.gate.resolve()
  expect(await f.settle(pending.operationId)).toMatchObject({ state: 'ready', code: 'H3_SETUP_SELF_TEST_VERIFIED' })
  expect(f.activity).toHaveBeenLastCalledWith(false)
  const binding = await f.setup.freshVerifiedBinding(1, f.contextId())
  expect(binding.binding.runtimeAbi).toBe(NATIVE_H3_RUNTIME_ABI_V2)
  expect(vi.mocked(f.program).mock.calls.filter(([path]) => path === f.selection.pythonPath)).toHaveLength(1)
})

it('retains unknown after an ambiguous process exit and after restart, without releasing intake or retrying GPU', async () => {
  const f = await fixture(); await f.save(); f.state.throwAfterStart = true
  const operation = await f.setup.startSelfTest({ contextId: f.contextId(), revision: 1, prompt: '五秒试片' }, signal())
  const current = await f.setup.inspect()
  expect(current).toMatchObject({ state: 'pending' })
  expect(await f.settle(operation.operationId)).toMatchObject({ state: 'unknown' })
  expect(f.activity).not.toHaveBeenCalledWith(false)
  // A real Host restart first settles its owned command and terminal commits; raw unknown can precede those commits.
  await f.setup.dispose()
  expect(await f.setup.readTrialAdmission()).toEqual({ state: 'unknown' })
  expect(f.activity).not.toHaveBeenCalledWith(false)
  const restarted = new H3OwnerSetup(f.options); fixtures.push({ root: f.root, setup: restarted })
  await expect(restarted.resolveCurrentConfigState()).rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_UNKNOWN' })
  expect((await restarted.startSelfTest({ contextId: (await restarted.inspect()).contextId, revision: 1, prompt: '不能重试' }, signal())).state).toBe('unknown')
  expect(vi.mocked(f.program).mock.calls.filter(([path]) => path === f.selection.pythonPath)).toHaveLength(1)
  const inspected = await restarted.inspect(f.selection)
  if (inspected.kind !== 'inspection') throw new Error('missing inspection')
  await expect(restarted.save({ inspectionId: inspected.inspectionId, expectedRevision: 1 }, signal())).rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_UNSETTLED' })
})

it('cannot claim ready from a late result after authenticated owner changes', async () => {
  const f = await fixture(); await f.save(); f.state.gate = deferred()
  const savedPath = f.onSaved.mock.calls[0]![0]
  const operation = await f.setup.startSelfTest({ contextId: f.contextId(), revision: 1, prompt: '五秒试片' }, signal())
  await vi.waitFor(() => { expect(f.program).toHaveBeenCalled() })
  f.state.owner = { ownerId: 168, profileDir: f.root }; f.state.gate.resolve()
  await vi.waitFor(async () => {
    expect(JSON.parse(await readFile(join(dirname(savedPath), 'self-test.json'), 'utf8'))).toMatchObject({ state: 'unknown' })
  })
  expect(f.activity).not.toHaveBeenCalledWith(false)
  expect(await f.setup.inspect()).toMatchObject({ configured: false })
  await expect(f.setup.selfTestStatus(operation.operationId)).rejects.toMatchObject({ code: 'H3_SETUP_OPERATION_NOT_FOUND' })
  f.state.owner = { ownerId: 167, profileDir: f.root }
  expect((await f.settle(operation.operationId)).state).toBe('unknown')
})

it('rejects a modified real trial output when refreshing a previously ready binding', async () => {
  const f = await fixture(); await f.save()
  const operation = await f.setup.startSelfTest({ contextId: f.contextId(), revision: 1, prompt: '五秒试片' }, signal())
  expect(await f.settle(operation.operationId)).toMatchObject({ state: 'ready', code: 'H3_SETUP_SELF_TEST_VERIFIED' })
  const current = await f.setup.resolveCurrentConfigState()
  const config = await readH3OwnerConfigV2(current!.configPath)
  const receipt: unknown = JSON.parse(await readFile(config.selfTestReceiptPath, 'utf8'))
  if (!receipt || typeof receipt !== 'object' || !('videoPath' in receipt) || typeof receipt.videoPath !== 'string') {
    throw new Error('missing video path')
  }
  await writeFile(receipt.videoPath, '0000ftyp-new bytes')
  await expect(f.setup.freshVerifiedBinding(1, f.contextId())).rejects.toMatchObject({ code: 'H3_SELF_TEST_OUTPUT_CHANGED' })
})

it.skipIf(process.platform === 'win32')('waits for the durable terminal gate instead of treating visible scoped ready as settled', async () => {
  const f = await fixture(); await f.save()
  const globalRoot = join(f.root, 'qianshou-h3-owner')
  const filesystem = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const release = deferred(); const entered = deferred(); const statusRead = deferred()
  let paused = false; let observeSettlement = false
  vi.doMock('node:fs/promises', () => ({ ...filesystem, async open(...args: Parameters<typeof filesystem.open>) {
    const handle = await filesystem.open(...args)
    if (observeSettlement && String(args[0]).endsWith('/self-test.json')) statusRead.resolve()
    if (String(args[0]) === globalRoot) {
      const originalSync = handle.sync.bind(handle)
      handle.sync = async () => {
        if (!paused && f.program.mock.calls.length >= 2) {
          const raw: unknown = JSON.parse(await filesystem.readFile(join(globalRoot, 'trial-guard.json'), 'utf8'))
          if (raw !== null && typeof raw === 'object' && 'state' in raw && raw.state === 'clear') {
            paused = true; entered.resolve(); await release.promise
          }
        }
        await originalSync()
      }
    }
    return handle
  } }))
  vi.resetModules()
  const { H3OwnerSetup: ActualSetup } = await import('../src/h3-owner-setup.ts')
  const actual = new ActualSetup(f.options); fixtures.push({ root: f.root, setup: actual })
  try {
    const contextId = (await actual.inspect()).contextId
    const operation = await actual.startSelfTest({ contextId, revision: 1, prompt: '等待真实终态提交' }, signal())
    await entered.promise
    const current = await actual.readCurrentConfigIdentity()
    const rawPath = join(dirname(current!.configPath), 'self-test.json')
    expect(JSON.parse(await readFile(rawPath, 'utf8'))).toMatchObject({ state: 'ready', code: 'H3_SETUP_SELF_TEST_VERIFIED' })
    expect(await actual.selfTestStatus(operation.operationId)).toMatchObject({ state: 'pending', code: 'H3_SETUP_SELF_TEST_PENDING' })
    expect(await actual.inspect()).toMatchObject({ state: 'pending', operation: { operationId: operation.operationId, state: 'pending' } })
    expect(await actual.startSelfTest({ contextId, revision: 1, prompt: '状态未提交不能再开片' }, signal())).toMatchObject({
      state: 'pending', operationId: operation.operationId,
    })
    expect(await actual.readTrialAdmission()).toEqual({ state: 'unknown' })
    await expect(actual.resolveCurrentConfigState()).rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_UNKNOWN' })
    expect(f.activity).not.toHaveBeenCalledWith(false)
    observeSettlement = true
    const settling = f.settle(operation.operationId, actual)
    expect(await Promise.race([settling.then(() => 'prematurely-settled'),
      statusRead.promise.then(() => 'pending-status-observed')])).toBe('pending-status-observed')
    release.resolve()
    expect(await settling).toMatchObject({ state: 'ready' })
    expect(await actual.readTrialAdmission()).toEqual({ state: 'clear' })
    expect(f.activity).toHaveBeenLastCalledWith(false)
    expect(vi.mocked(f.program).mock.calls.filter(([path]) => path === f.selection.pythonPath)).toHaveLength(1)
  } finally {
    release.resolve(); await actual.dispose()
    vi.doUnmock('node:fs/promises'); vi.resetModules()
  }
})

it('requires private owner permissions and refuses linked managed state', async () => {
  const f = await fixture(); await f.save()
  const current = await f.setup.resolveCurrentConfigState()
  await chmod(current!.configPath, 0o644)
  await expect(f.setup.inspect()).rejects.toMatchObject({ code: 'H3_SETUP_UNSAFE_PATH' })
  await chmod(current!.configPath, 0o600)
  const pointer = join(dirname(dirname(current!.configPath)), 'current.json')
  const bytes = await readFile(pointer); await unlink(pointer)
  await writeFile(join(f.root, 'outside.json'), bytes, { mode: 0o600 }); await symlink(join(f.root, 'outside.json'), pointer)
  await expect(f.setup.inspect()).rejects.toThrow()
  expect(f.program).not.toHaveBeenCalled()
})

it('serializes a delayed save and old-revision start with the same Host lock, before any process starts', async () => {
  const f = await fixture(); await f.save()
  const inspection = await f.setup.inspect(f.selection)
  if (inspection.kind !== 'inspection') throw new Error('missing inspection')
  const gate = deferred(); const inside = deferred(); let idleCalls = 0
  f.assertIdle.mockImplementation(async () => { if (++idleCalls === 2) { inside.resolve(); await gate.promise } })
  const saving = f.setup.save({ inspectionId: inspection.inspectionId, expectedRevision: 1 }, signal())
  await inside.promise
  await expect(f.setup.startSelfTest({ contextId: f.contextId(), revision: 1, prompt: '旧配置不能开片' }, signal())).rejects.toMatchObject({ code: 'H3_SETUP_BUSY' })
  expect(f.program).not.toHaveBeenCalled()
  gate.resolve(); expect(await saving).toMatchObject({ state: 'saved', revision: 2 })
})

it('rejects saving while a durable trial is pending and keeps its exact current revision', async () => {
  const f = await fixture(); await f.save(); f.state.gate = deferred()
  const operation = await f.setup.startSelfTest({ contextId: f.contextId(), revision: 1, prompt: '五秒试片' }, signal())
  const inspection = await f.setup.inspect(f.selection)
  if (inspection.kind !== 'inspection') throw new Error('missing inspection')
  await expect(f.setup.save({ inspectionId: inspection.inspectionId, expectedRevision: 1 }, signal())).rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_UNSETTLED' })
  expect(await f.setup.inspect()).toMatchObject({ revision: 1, state: 'pending' })
  f.state.gate.resolve(); await f.settle(operation.operationId)
  expect(vi.mocked(f.program).mock.calls.filter(([path]) => path === f.selection.pythonPath)).toHaveLength(1)
})

it('uses the real pinned Python cell-output reader on the adapter root, and rejects substituting a trial workspace', async () => {
  const f = await fixture(); const job = 'fixture_job'
  await mkdir(join(f.selection.adapterOutputRoot, job))
  await writeFile(join(f.selection.adapterOutputRoot, job, 'result.mp4'), '0000ftyp-fixed synthetic adapter bytes')
  const privateWorkspace = join(f.root, 'private-trial'); await mkdir(privateWorkspace)
  const script = 'import importlib.util,sys\nfrom pathlib import Path\ns=importlib.util.spec_from_file_location(\'fixed_h3_runtime\',sys.argv[1])\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\np,b=m.cell_output(sys.argv[2],\'fixture_job\')\nassert p==Path(sys.argv[2])/\'fixture_job\'/\'result.mp4\' and b==b\'0000ftyp-fixed synthetic adapter bytes\'\ntry:\n m.cell_output(sys.argv[3],\'fixture_job\')\nexcept m.H3RuntimeError as e:\n assert str(e)==\'H3_LOCAL_OUTPUT_MISSING\'\nelse:\n raise AssertionError(\'trial workspace must not substitute adapter output root\')\nprint(\'ACTUAL_ADAPTER_ROOT_ONLY\')\n'
  const { stdout } = await promisify(execFile)('python3', ['-I', '-B', '-c', script,
    join(f.options.runtimeDirectory, 'h3_runtime.py'), f.selection.adapterOutputRoot, privateWorkspace], { timeout: 10_000 })
  expect(stdout.trim()).toBe('ACTUAL_ADAPTER_ROOT_ONLY')
  expect(f.program).not.toHaveBeenCalled()
})

it('rejects a late save after login changes while the actual idle port is awaiting', async () => {
  const f = await fixture(); const inspection = await f.setup.inspect(f.selection)
  if (inspection.kind !== 'inspection') throw new Error('missing inspection')
  const gate = deferred(); const entered = deferred()
  f.assertIdle.mockImplementation(async () => { entered.resolve(); await gate.promise })
  const saving = f.setup.save({ inspectionId: inspection.inspectionId, expectedRevision: 0 }, signal())
  await entered.promise; f.state.owner = { ownerId: 168, profileDir: f.root }; gate.resolve()
  await expect(saving).rejects.toMatchObject({ code: 'H3_SETUP_OWNER_CHANGED' })
  f.state.owner = { ownerId: 167, profileDir: f.root }
  expect(await f.setup.inspect()).toMatchObject({ configured: false, revision: 0 })
  expect(f.program).not.toHaveBeenCalled()
})

it('keeps an abandoned durable pending operation unknown in a new controller and never starts it again', async () => {
  const f = await fixture(); await f.save(); f.state.gate = deferred()
  const operation = await f.setup.startSelfTest({ contextId: f.contextId(), revision: 1, prompt: '五秒试片' }, signal())
  await vi.waitFor(() => { expect(f.program).toHaveBeenCalled() })
  const restarted = new H3OwnerSetup(f.options); fixtures.push({ root: f.root, setup: restarted })
  expect(await restarted.selfTestStatus(operation.operationId)).toMatchObject({ state: 'unknown' })
  await expect(restarted.resolveCurrentConfigState()).rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_UNKNOWN' })
  expect((await restarted.startSelfTest({ contextId: (await restarted.inspect()).contextId, revision: 1, prompt: '不能重复' }, signal())).operationId).toBe(operation.operationId)
  expect(vi.mocked(f.program).mock.calls.filter(([path]) => path === f.selection.pythonPath)).toHaveLength(1)
  await f.setup.dispose()
  expect(await restarted.selfTestStatus(operation.operationId)).toMatchObject({ state: 'unknown' })
  expect(f.activity).not.toHaveBeenCalledWith(false)
})

it('rejects otherwise matching local evidence whose video was moved into the adapter output directory', async () => {
  const f = await fixture(); await f.save()
  const operation = await f.setup.startSelfTest({ contextId: f.contextId(), revision: 1, prompt: '五秒试片' }, signal()); await f.settle(operation.operationId)
  const current = await f.setup.resolveCurrentConfigState()
  const config = await readH3OwnerConfigV2(current!.configPath)
  const receipt: unknown = JSON.parse(await readFile(config.selfTestReceiptPath, 'utf8'))
  if (!receipt || typeof receipt !== 'object' || !('videoPath' in receipt) || typeof receipt.videoPath !== 'string') {
    throw new Error('missing video path')
  }
  const outside = join(f.selection.adapterOutputRoot, 'copied-old-video.mp4')
  await copyFile(receipt.videoPath, outside)
  await writeFile(config.selfTestReceiptPath, JSON.stringify({ ...receipt, videoPath: outside }), { mode: 0o600 })
  await expect(f.setup.freshVerifiedBinding(1, f.contextId())).rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_REQUIRED' })
  expect(vi.mocked(f.program).mock.calls.filter(([path]) => path === f.selection.pythonPath)).toHaveLength(1)
})

it.each(['start', 'draft'])('binds %s to A before its first asynchronous account read switches to B with the same revision', async (command) => {
  const f = await fixture(); await f.save(); const authorAContext = f.contextId()
  f.state.owner = { ownerId: 168, profileDir: f.root }; await f.save()
  expect(await f.setup.inspect()).toMatchObject({ revision: 1, configured: true })
  f.state.owner = { ownerId: 167, profileDir: f.root }; f.state.readScopeGate = deferred()
  const result = command === 'start'
    ? f.setup.startSelfTest({ contextId: authorAContext, revision: 1, prompt: 'A请求不能在B开GPU' }, signal())
    : f.setup.freshVerifiedBinding(1, authorAContext)
  f.state.owner = { ownerId: 168, profileDir: f.root }; f.state.readScopeGate.resolve()
  await expect(result).rejects.toMatchObject({ code: 'H3_SETUP_OWNER_CHANGED' })
  expect(f.program).not.toHaveBeenCalled()
  expect(await f.setup.inspect()).toMatchObject({ revision: 1, state: 'saved' })
})

async function readyOtherOwner(f: Awaited<ReturnType<typeof fixture>>) {
  f.state.owner = { ownerId: 168, profileDir: join(f.root, 'profile-b') }
  await mkdir(f.state.owner.profileDir, { mode: 0o700 })
  await f.save()
  const trial = await f.setup.startSelfTest({ contextId: f.contextId(), revision: 1, prompt: 'B明确试片' }, signal())
  expect((await f.settle(trial.operationId)).state).toBe('ready')
  f.state.owner = { ownerId: 167, profileDir: f.root }
  await f.save()
}

it.each(['pending', 'unknown'])('blocks fresh Host B with ready evidence after A leaves a durable %s trial in the same home', async (state) => {
  const f = await fixture(); await readyOtherOwner(f)
  f.state.gate = deferred()
  const a = await f.setup.startSelfTest({ contextId: f.contextId(), revision: 1, prompt: 'A明确试片' }, signal())
  await vi.waitFor(() => { expect(f.program.mock.calls.filter(([path]) => path === f.selection.pythonPath)).toHaveLength(2) })
  if (state === 'unknown') await f.setup.dispose()
  const b = new H3OwnerSetup({ ...f.options, readScope: async () => ({ ownerId: 168, profileDir: join(f.root, 'profile-b') }) })
  fixtures.push({ root: f.root, setup: b })
  const current = await b.inspect()
  expect(current).toMatchObject({ configured: true, state: 'unknown', code: 'H3_SETUP_SELF_TEST_UNKNOWN', revision: 1 })
  if (current.kind !== 'current' || current.operation === undefined) throw new Error('missing retained B operation')
  const bConfig = await b.readCurrentConfigIdentity()
  expect(JSON.parse(await readFile(join(dirname(bConfig!.configPath), 'self-test.json'), 'utf8'))).toMatchObject({ state: 'ready' })
  expect(await b.readTrialAdmission()).toEqual({ state: 'unknown' })
  const calls = f.program.mock.calls.length
  await expect(b.assertTrialAdmission()).rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_UNKNOWN' })
  await expect(b.resolveCurrentConfigState()).rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_UNKNOWN' })
  await expect(b.freshVerifiedBinding(1, current.contextId)).rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_UNKNOWN' })
  expect(await b.startSelfTest({ contextId: current.contextId, revision: 1, prompt: 'B不能开新片' }, signal())).toMatchObject({
    state: 'unknown', code: 'H3_SETUP_SELF_TEST_UNKNOWN', operationId: current.operation?.operationId,
  })
  const inspection = await b.inspect(f.selection)
  if (inspection.kind !== 'inspection') throw new Error('missing B inspection')
  await expect(b.save({ inspectionId: inspection.inspectionId, expectedRevision: 1 }, signal())).rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_UNSETTLED' })
  expect(f.program).toHaveBeenCalledTimes(calls)
  expect(JSON.parse(await readFile(join(f.root, 'qianshou-h3-owner', 'trial-guard.json'), 'utf8'))).toMatchObject({ operationId: a.operationId, state })
  if (state === 'pending') await f.setup.dispose()
  expect(await b.readTrialAdmission()).toEqual({ state: 'unknown' })
})

it.each(['malformed', 'symlink', 'stale-mutex', 'oversized'])('fails closed on a %s shared guard before any new program or save', async (kind) => {
  const f = await fixture(); await f.save()
  const inspection = await f.setup.inspect(f.selection)
  if (inspection.kind !== 'inspection') throw new Error('missing inspection')
  const root = join(f.root, 'qianshou-h3-owner'); const path = join(root, 'trial-guard.json')
  if (kind === 'malformed') await writeFile(path, '{"state":"clear"}', { mode: 0o600 })
  if (kind === 'oversized') await writeFile(path, Buffer.alloc(32 * 1024 + 1), { mode: 0o600 })
  if (kind === 'symlink') {
    const elsewhere = join(f.root, 'outside-guard.json')
    await writeFile(elsewhere, canonical({ schema: 'qianshou.h3-owner-trial-guard.v1', state: 'clear' }), { mode: 0o600 })
    await symlink(elsewhere, path)
  }
  if (kind === 'stale-mutex') await writeFile(join(root, '.trial-lock'), 'previous Host exclusive mutex', { mode: 0o600 })
  if (kind === 'stale-mutex') expect(await f.setup.readTrialAdmission()).toEqual({ state: 'unknown' })
  else await expect(f.setup.readTrialAdmission()).rejects.toMatchObject({ code: 'H3_SETUP_TRIAL_GUARD_INVALID' })
  await expect(f.setup.assertTrialAdmission()).rejects.toThrow()
  await expect(f.setup.save({ inspectionId: inspection.inspectionId, expectedRevision: 1 }, signal())).rejects.toThrow()
  await expect(f.setup.startSelfTest({ contextId: f.contextId(), revision: 1, prompt: '不允许试片' }, signal())).rejects.toThrow()
  expect(f.program).not.toHaveBeenCalled()
  expect(f.activity).not.toHaveBeenCalledWith(false)
  expect(await f.setup.inspect()).toMatchObject({ revision: 1 })
})

it('keeps legacy A unknown blocked for fresh B when no shared guard has ever been retained', async () => {
  const f = await fixture(); await readyOtherOwner(f); f.state.gate = deferred()
  await f.setup.startSelfTest({ contextId: f.contextId(), revision: 1, prompt: '旧版未决试片' }, signal())
  await vi.waitFor(() => { expect(f.program.mock.calls.filter(([path]) => path === f.selection.pythonPath)).toHaveLength(2) })
  await f.setup.dispose()
  // This removes only the test-owned new-format record to reproduce an older installed layout.
  await unlink(join(f.root, 'qianshou-h3-owner', 'trial-guard.json'))
  const b = new H3OwnerSetup({ ...f.options, readScope: async () => ({ ownerId: 168, profileDir: join(f.root, 'profile-b') }) })
  fixtures.push({ root: f.root, setup: b })
  const before = f.program.mock.calls.length
  expect(await b.readTrialAdmission()).toEqual({ state: 'unknown' })
  await expect(b.resolveCurrentConfigState()).rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_UNKNOWN' })
  expect(f.program).toHaveBeenCalledTimes(before)
  expect(await b.inspect()).toMatchObject({ state: 'unknown', code: 'H3_SETUP_SELF_TEST_UNKNOWN' })
  const bConfig = await b.readCurrentConfigIdentity()
  expect(JSON.parse(await readFile(join(dirname(bConfig!.configPath), 'self-test.json'), 'utf8'))).toMatchObject({ state: 'ready' })
})

it('does not clear a replaced operation guard when an older successful child settles late', async () => {
  const f = await fixture(); await f.save(); f.state.gate = deferred()
  const trial = await f.setup.startSelfTest({ contextId: f.contextId(), revision: 1, prompt: '迟到完成' }, signal())
  await vi.waitFor(() => { expect(f.program).toHaveBeenCalled() })
  const path = join(f.root, 'qianshou-h3-owner', 'trial-guard.json')
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (value === null || typeof value !== 'object' || !('operationId' in value)) throw new Error('missing test guard')
  const replacement = canonical({ ...value, operationId: '00000000-0000-4000-8000-000000000001' })
  await writeFile(path, replacement, { mode: 0o600 })
  f.state.gate.resolve()
  await vi.waitFor(async () => { expect((await f.setup.selfTestStatus(trial.operationId)).state).toBe('unknown') })
  expect(await readFile(path, 'utf8')).toBe(replacement)
  expect(f.activity).not.toHaveBeenCalledWith(false)
  expect(await f.setup.readTrialAdmission()).toEqual({ state: 'unknown' })
})

it('serializes two authenticated scopes through the same persistent mutex before starting one child', async () => {
  const f = await fixture()
  await f.save()
  const ownerA = f.state.owner
  f.state.owner = { ownerId: 168, profileDir: join(f.root, 'profile-b') }
  await f.save()
  const ownerB = f.state.owner
  const a = new H3OwnerSetup({ ...f.options, readScope: async () => ownerA })
  const b = new H3OwnerSetup({ ...f.options, readScope: async () => ownerB })
  fixtures.push({ root: f.root, setup: a }, { root: f.root, setup: b })
  const currentA = await a.inspect(); const currentB = await b.inspect()
  f.state.gate = deferred()
  const results = await Promise.allSettled([
    a.startSelfTest({ contextId: currentA.contextId, revision: 1, prompt: 'A' }, signal()),
    b.startSelfTest({ contextId: currentB.contextId, revision: 1, prompt: 'B' }, signal()),
  ])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  await vi.waitFor(() => { expect(f.program.mock.calls.filter(([path]) => path === f.selection.pythonPath)).toHaveLength(1) })
  await a.dispose(); await b.dispose()
  expect(await f.setup.readTrialAdmission()).toEqual({ state: 'unknown' })
})

it('releases only a durably verified terminal operation and permits a new explicit revision trial', async () => {
  const f = await fixture(); await f.save()
  const first = await f.setup.startSelfTest({ contextId: f.contextId(), revision: 1, prompt: '第一次' }, signal())
  expect((await f.settle(first.operationId)).state).toBe('ready')
  await vi.waitFor(async () => { expect(await f.setup.readTrialAdmission()).toEqual({ state: 'clear' }) })
  expect(JSON.parse(await readFile(join(f.root, 'qianshou-h3-owner', 'trial-guard.json'), 'utf8'))).toEqual({ schema: 'qianshou.h3-owner-trial-guard.v1', state: 'clear' })
  await f.save(1)
  const second = await f.setup.startSelfTest({ contextId: f.contextId(), revision: 2, prompt: '第二次明确点击' }, signal())
  expect(second.operationId).not.toBe(first.operationId)
  expect((await f.settle(second.operationId)).state).toBe('ready')
  await vi.waitFor(async () => { expect(await f.setup.readTrialAdmission()).toEqual({ state: 'clear' }) })
  expect(f.program.mock.calls.filter(([path]) => path === f.selection.pythonPath)).toHaveLength(2)
})

it('preserves a proven pre-subprocess failure and projects unknown if its shared gate later becomes invalid', async () => {
  const f = await fixture(); await f.save()
  let changed = false
  f.activity.mockImplementation((active) => {
    if (active && !changed) { changed = true; writeFileSync(f.selection.firstFramePath, 'not a PNG') }
  })
  const trial = await f.setup.startSelfTest({ contextId: f.contextId(), revision: 1, prompt: '不能运行的试片' }, signal())
  expect((await f.settle(trial.operationId)).state).toBe('failed')
  await vi.waitFor(async () => { expect(await f.setup.readTrialAdmission()).toEqual({ state: 'clear' }) })
  expect(f.program).not.toHaveBeenCalled()
  expect(await f.setup.selfTestStatus(trial.operationId)).toMatchObject({ state: 'failed', operationId: trial.operationId })
  const current = await f.setup.readCurrentConfigIdentity()
  const path = join(dirname(current!.configPath), 'self-test.json')
  const raw = await readFile(path)
  await writeFile(join(f.root, 'qianshou-h3-owner', 'trial-guard.json'), '{"state":"clear"}', { mode: 0o600 })
  expect(await f.setup.selfTestStatus(trial.operationId)).toMatchObject({ state: 'unknown', code: 'H3_SETUP_SELF_TEST_UNKNOWN' })
  expect(await f.setup.inspect()).toMatchObject({ state: 'unknown', code: 'H3_SETUP_SELF_TEST_UNKNOWN' })
  expect(await f.setup.startSelfTest({ contextId: f.contextId(), revision: 1, prompt: '失败结果不得自动重试' }, signal())).toMatchObject({
    state: 'unknown', operationId: trial.operationId,
  })
  expect(await readFile(path)).toEqual(raw)
  expect(f.program).not.toHaveBeenCalled()
})

async function filesystemFaultSetup(f: Awaited<ReturnType<typeof fixture>>,
  fail: (path: string, flags: string | number | undefined) => boolean) {
  const filesystem = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.doMock('node:fs/promises', () => ({ ...filesystem, async open(...args: Parameters<typeof filesystem.open>) {
    if (fail(String(args[0]), args[1])) throw Object.assign(new Error('test-owned ENOSPC'), { code: 'ENOSPC' })
    return filesystem.open(...args)
  } }))
  vi.resetModules()
  const { H3OwnerSetup: ActualSetup } = await import('../src/h3-owner-setup.ts')
  const setup = new ActualSetup(f.options)
  fixtures.push({ root: f.root, setup })
  return setup
}

it('retains a shared unknown when scoped pending cannot be created after the actual global pending commit', async () => {
  const f = await fixture(); await readyOtherOwner(f)
  const current = await f.setup.resolveCurrentConfigState()
  const localStatus = join(dirname(current!.configPath), 'self-test.json')
  const faulty = await filesystemFaultSetup(f, (path, flags) => path === localStatus && typeof flags === 'number' && (flags & constants.O_CREAT) !== 0)
  try {
    const context = (await faulty.inspect()).contextId
    const before = f.program.mock.calls.length
    await expect(faulty.startSelfTest({ contextId: context, revision: 1, prompt: '写盘失败' }, signal())).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(f.program).toHaveBeenCalledTimes(before)
    const b = new H3OwnerSetup({ ...f.options, readScope: async () => ({ ownerId: 168, profileDir: join(f.root, 'profile-b') }) })
    fixtures.push({ root: f.root, setup: b })
    expect(await b.inspect()).toMatchObject({ state: 'unknown', code: 'H3_SETUP_SELF_TEST_UNKNOWN' })
    const bConfig = await b.readCurrentConfigIdentity()
    expect(JSON.parse(await readFile(join(dirname(bConfig!.configPath), 'self-test.json'), 'utf8'))).toMatchObject({ state: 'ready' })
    expect(await b.readTrialAdmission()).toEqual({ state: 'unknown' })
    await expect(b.resolveCurrentConfigState()).rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_UNKNOWN' })
    await expect(readFile(localStatus)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { vi.doUnmock('node:fs/promises'); vi.resetModules() }
})

it('does not create an unknown scoped operation when a global claim fails before any subprocess is started', async () => {
  const f = await fixture(); await f.save()
  const first = await f.setup.startSelfTest({ contextId: f.contextId(), revision: 1, prompt: '首次' }, signal())
  await f.settle(first.operationId)
  await vi.waitFor(async () => { expect(await f.setup.readTrialAdmission()).toEqual({ state: 'clear' }) })
  await f.save(1)
  const current = await f.setup.resolveCurrentConfigState()
  const root = join(f.root, 'qianshou-h3-owner')
  const faulty = await filesystemFaultSetup(f, path => dirname(path) === root && path.includes('.write-'))
  try {
    const context = (await faulty.inspect()).contextId
    const before = f.program.mock.calls.length
    await expect(faulty.startSelfTest({ contextId: context, revision: 2, prompt: '全局写盘失败' }, signal())).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(f.program).toHaveBeenCalledTimes(before)
    await expect(readFile(join(dirname(current!.configPath), 'self-test.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await faulty.readTrialAdmission()).toEqual({ state: 'clear' })
  } finally { vi.doUnmock('node:fs/promises'); vi.resetModules() }
})

it.each([{ state: 'ready' }, { state: 'failed', code: 'H3_SETUP_SELF_TEST_VERIFIED',
  operationId: '00000000-0000-4000-8000-000000000001', revision: 1, startedAt: 1, finishedAt: 2 }])('does not treat a malformed legacy terminal record as clear: %j', async (invalid) => {
  const f = await fixture(); await readyOtherOwner(f)
  const current = await f.setup.resolveCurrentConfigState()
  await writeFile(join(dirname(current!.configPath), 'self-test.json'), canonical(invalid), { mode: 0o600 })
  await unlink(join(f.root, 'qianshou-h3-owner', 'trial-guard.json'))
  const b = new H3OwnerSetup({ ...f.options, readScope: async () => ({ ownerId: 168, profileDir: join(f.root, 'profile-b') }) })
  fixtures.push({ root: f.root, setup: b })
  const calls = f.program.mock.calls.length
  await expect(b.readTrialAdmission()).rejects.toMatchObject({ code: 'H3_SETUP_TRIAL_GUARD_INVALID' })
  await expect(b.assertTrialAdmission()).rejects.toMatchObject({ code: 'H3_SETUP_TRIAL_GUARD_INVALID' })
  expect(f.program).toHaveBeenCalledTimes(calls)
})

it('keeps pure current identity readable under the durable trial block without admitting new work or changing the guard', async () => {
  const f = await fixture(); await f.save(); const original = await f.setup.readCurrentConfigIdentity()
  f.state.gate = deferred()
  await f.setup.startSelfTest({ contextId: f.contextId(), revision: 1, prompt: '未决' }, signal())
  const path = join(f.root, 'qianshou-h3-owner', 'trial-guard.json')
  await vi.waitFor(() => { expect(f.program).toHaveBeenCalledOnce() })
  const bytes = await readFile(path)
  const before = f.program.mock.calls.length
  expect(await f.setup.readCurrentConfigIdentity()).toEqual(original)
  await expect(f.setup.resolveCurrentConfigState()).rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_PENDING' })
  expect(await readFile(path)).toEqual(bytes)
  expect(f.program).toHaveBeenCalledTimes(before)
  await f.setup.dispose()
  const restarted = new H3OwnerSetup(f.options); fixtures.push({ root: f.root, setup: restarted })
  expect(await restarted.readCurrentConfigIdentity()).toEqual(original)
  expect(await restarted.readTrialAdmission()).toEqual({ state: 'unknown' })
})

it.skipIf(process.platform === 'win32').each(['scoped-directory', 'global-directory'])(
  'keeps B blocked after terminal %s sync fails after its file is visible', async (boundary) => {
    const f = await fixture(); await readyOtherOwner(f)
    const current = await f.setup.readCurrentConfigIdentity()
    const globalRoot = join(f.root, 'qianshou-h3-owner')
    const target = boundary === 'scoped-directory' ? dirname(current!.configPath) : globalRoot
    const filesystem = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let failures = 0
    f.program.mockClear(); f.activity.mockClear()
    vi.doMock('node:fs/promises', () => ({ ...filesystem, async open(...args: Parameters<typeof filesystem.open>) {
      const handle = await filesystem.open(...args)
      if (String(args[0]) === target) {
        const originalSync = handle.sync.bind(handle)
        handle.sync = async () => {
          const raw: unknown = JSON.parse(await filesystem.readFile(join(globalRoot, 'trial-guard.json'), 'utf8'))
          const terminalClear = raw !== null && typeof raw === 'object' && 'state' in raw && raw.state === 'clear'
          if (f.program.mock.calls.length >= 2 && (boundary === 'scoped-directory' || terminalClear)) {
            failures++; throw Object.assign(new Error('test-owned directory sync EIO'), { code: 'EIO' })
          }
          await originalSync()
        }
      }
      return handle
    } }))
    vi.resetModules()
    const { H3OwnerSetup: ActualSetup } = await import('../src/h3-owner-setup.ts')
    const actual = new ActualSetup(f.options); fixtures.push({ root: f.root, setup: actual })
    try {
      const context = (await actual.inspect()).contextId
      const operation = await actual.startSelfTest({ contextId: context, revision: 1, prompt: '实际终态提交写盘失败' }, signal())
      await vi.waitFor(() => { expect(failures).toBe(1) })
      await vi.waitFor(async () => { expect(await actual.selfTestStatus(operation.operationId)).toMatchObject({
        state: 'unknown', code: 'H3_SETUP_SELF_TEST_UNKNOWN',
      }) })
      expect(await actual.inspect()).toMatchObject({ state: 'unknown', code: 'H3_SETUP_SELF_TEST_UNKNOWN' })
      expect(await actual.startSelfTest({ contextId: context, revision: 1, prompt: '不重试未确认结果' }, signal())).toMatchObject({
        state: 'unknown', operationId: operation.operationId,
      })
      expect(JSON.parse(await filesystem.readFile(join(dirname(current!.configPath), 'self-test.json'), 'utf8'))).toMatchObject({
        state: 'ready', code: 'H3_SETUP_SELF_TEST_VERIFIED',
      })
      const b = new H3OwnerSetup({ ...f.options, readScope: async () => ({ ownerId: 168, profileDir: join(f.root, 'profile-b') }) })
      fixtures.push({ root: f.root, setup: b })
      expect(await b.inspect()).toMatchObject({ state: 'unknown', code: 'H3_SETUP_SELF_TEST_UNKNOWN' })
      const bConfig = await b.readCurrentConfigIdentity()
      expect(JSON.parse(await filesystem.readFile(join(dirname(bConfig!.configPath), 'self-test.json'), 'utf8'))).toMatchObject({ state: 'ready' })
      const calls = f.program.mock.calls.length
      expect(await b.readTrialAdmission()).toEqual({ state: 'unknown' })
      await expect(b.resolveCurrentConfigState()).rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_UNKNOWN' })
      await expect(b.assertTrialAdmission()).rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_UNKNOWN' })
      expect(f.program).toHaveBeenCalledTimes(calls)
      expect(f.activity).not.toHaveBeenCalledWith(false)
      expect(JSON.parse(await filesystem.readFile(join(globalRoot, 'trial-guard.json'), 'utf8'))).toMatchObject({
        state: boundary === 'global-directory' ? 'clear' : 'pending',
      })
      expect(await filesystem.readFile(join(globalRoot, '.trial-lock'), 'utf8')).toContain('qianshou.h3-trial-mutex.v1')
    } finally { vi.doUnmock('node:fs/promises'); vi.resetModules() }
  },
)
