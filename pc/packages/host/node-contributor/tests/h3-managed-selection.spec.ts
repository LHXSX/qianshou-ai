import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { canonicalNativeH3ReviewJson } from '@deepseek-ai/dsh-compute-core/native-h3-review'
import { H3ExecutionCoordinator, type H3TrialTransaction } from '../src/h3-execution-coordinator.ts'
import { H3ManagedSelection, type H3ManagedRuntime } from '../src/h3-managed-selection.ts'
import { H3OwnerSetup } from '../src/h3-owner-setup.ts'
import type { H3OwnerManagedConfigState, H3OwnerSetupSelection } from '../src/h3-owner-setup-types.ts'

const roots: string[] = []
const setups: H3OwnerSetup[] = []
const encode = (value: unknown): string => canonicalNativeH3ReviewJson(value)
const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const signal = (): AbortSignal => new AbortController().signal
afterEach(async () => {
  vi.doUnmock('node:fs/promises'); vi.resetModules()
  for (const setup of setups.splice(0)) await setup.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const homePath = await mkdtemp(join(await realpath(tmpdir()), 'h3-managed-selection-')); roots.push(homePath)
  let ownerId = 167
  const states = new Map<string, H3OwnerManagedConfigState>()
  const scopeId = (owner = ownerId): string => sha(encode({ ownerId: owner, profileDir: homePath }))
  let onRead: ((runtime: H3ManagedRuntime) => Promise<void>) | null = null
  const options = { homePath, readScope: async () => ({ ownerId, profileDir: homePath }),
    readV2Current: async () => { await onRead?.('v2'); return states.get(`${ownerId}:v2`) ?? null },
    readCanonicalCurrent: async () => { await onRead?.('canonical'); return states.get(`${ownerId}:canonical`) ?? null } }
  const selector = new H3ManagedSelection(options)
  const coordinator = new H3ExecutionCoordinator(homePath, async () => {})
  async function save(runtime: H3ManagedRuntime, revision: number, owner = ownerId) {
    const root = join(homePath, 'qianshou-h3-owner', runtime, String(owner), scopeId(owner))
    const directory = randomUUID(); const configPath = join(root, directory, 'owner.json')
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 })
    const config = encode({ schema: runtime === 'v2' ? 'qianshou.h3-owner.v2' : 'qianshou.h3-owner.canonical.v1', revision })
    await writeFile(configPath, config, { mode: 0o600 })
    await writeFile(join(root, 'current.json'), encode({
      schema: runtime === 'v2' ? 'qianshou.h3-managed-owner.v2' : 'qianshou.h3-managed-owner.canonical.v1',
      scopeId: scopeId(owner), directory, revision, configSha256: sha(config) }), { mode: 0o600 })
    const state = { configPath, scopeId: scopeId(owner), revision }; states.set(`${owner}:${runtime}`, state)
    return state
  }
  const selectedPath = (owner = ownerId): string => join(homePath, 'qianshou-h3-owner', 'selection',
    String(owner), scopeId(owner), 'current.json')
  const select = (runtime: H3ManagedRuntime, state: H3OwnerManagedConfigState) => coordinator.withTransaction(
    transaction => selector.selectSaved(runtime, state, transaction))
  return { homePath, selector, coordinator, options, save, select, selectedPath,
    owner: (owner: number) => { ownerId = owner },
    onRead: (read: ((runtime: H3ManagedRuntime) => Promise<void>) | null) => { onRead = read } }
}

it('keeps legacy V2 only when the actual canonical current pointer is absent', async () => {
  const f = await fixture()
  expect(await f.selector.readCurrent()).toBeNull()
  const state = await f.save('v2', 1)
  expect(await f.selector.readCurrent()).toEqual({ ...state, runtime: 'v2', selectionRevision: 0,
    configSha256: sha(await readFile(state.configPath)) })
  expect(await readFile(f.selectedPath()).catch(() => null)).toBeNull()
  await f.save('canonical', 1)
  await expect(f.selector.readCurrent()).rejects.toMatchObject({ code: 'H3_MANAGED_SELECTION_REQUIRED' })
})

it('selects V2 to canonical to V2 with independent increasing revisions, despite equal helper revisions', async () => {
  const f = await fixture(); const v2 = await f.save('v2', 1)
  const first = await f.select('v2', v2)
  const canonical = await f.save('canonical', 1)
  const second = await f.select('canonical', canonical)
  const third = await f.select('v2', v2)
  expect([first.runtime, second.runtime, third.runtime]).toEqual(['v2', 'canonical', 'v2'])
  expect([first.selectionRevision, second.selectionRevision, third.selectionRevision]).toEqual([1, 2, 3])
  expect(third.configSha256).toBe(first.configSha256)
  expect(await f.selector.readCurrent()).toEqual(third)
  expect(await lstat(join(f.homePath, 'qianshou-h3-owner', '.trial-lock')).catch(() => null)).toBeNull()
})

it('does not choose an existing V2 after the selected canonical configuration is missing', async () => {
  const f = await fixture(); await f.save('v2', 1); const canonical = await f.save('canonical', 1)
  await f.select('canonical', canonical); await rm(canonical.configPath)
  await expect(f.selector.readCurrent()).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects old selected facts after a helper pointer advances until its own save explicitly selects them', async () => {
  const f = await fixture(); const first = await f.save('v2', 1); await f.select('v2', first)
  const second = await f.save('v2', 2)
  await expect(f.selector.readCurrent()).rejects.toMatchObject({ code: 'H3_MANAGED_SELECTION_STALE' })
  expect(await f.select('v2', second)).toMatchObject({ revision: 2, selectionRevision: 2 })
})

it('does not bind an A save to B at the same configuration revision', async () => {
  const f = await fixture(); const a = await f.save('v2', 1); await f.save('v2', 1, 168)
  f.owner(168)
  await expect(f.select('v2', a)).rejects.toMatchObject({ code: 'H3_MANAGED_SELECTION_STALE' })
  expect(await readFile(f.selectedPath()).catch(() => null)).toBeNull()
  await expect(f.coordinator.withTransaction(async () => {})).rejects.toBeDefined()
})

it('rejects scope changes during pure observation and leaves the existing selection bytes unchanged', async () => {
  const f = await fixture(); const a = await f.save('v2', 1); await f.select('v2', a)
  await f.save('v2', 1, 168); const before = await readFile(f.selectedPath(167))
  f.onRead(async (runtime) => { if (runtime === 'canonical') f.owner(168) })
  await expect(f.selector.readCurrent()).rejects.toMatchObject({ code: 'H3_SETUP_OWNER_CHANGED' })
  expect(await readFile(f.selectedPath(167))).toEqual(before)
})

it('catches actual configuration bytes changing during pure reads instead of returning stale facts', async () => {
  const f = await fixture(); const state = await f.save('v2', 1); await f.select('v2', state)
  let reads = 0
  f.onRead(async (runtime) => {
    if (runtime === 'canonical' && ++reads === 1) await writeFile(state.configPath, 'foreign same-path config')
  })
  await expect(f.selector.readCurrent()).rejects.toBeDefined()
})

it.each(['invalid JSON', '{"schema":"qianshou.h3-managed-selection.v1","runtime":"canonical","runtime":"v2"}'])(
  'fails closed for a corrupt or duplicate-key selection: %s', async (corrupt) => {
    const f = await fixture(); const state = await f.save('v2', 1); await f.select('v2', state)
    await writeFile(f.selectedPath(), corrupt)
    await expect(f.selector.readCurrent()).rejects.toBeDefined()
  })

it('rejects a symlink selection and preserves the foreign target', async () => {
  const f = await fixture(); const state = await f.save('v2', 1); await f.select('v2', state)
  const foreign = join(f.homePath, 'foreign'); await writeFile(foreign, 'do not overwrite', { mode: 0o600 })
  await rm(f.selectedPath()); await symlink(foreign, f.selectedPath())
  await expect(f.selector.readCurrent()).rejects.toMatchObject({ code: 'H3_SETUP_UNSAFE_PATH' })
  expect(await readFile(foreign, 'utf8')).toBe('do not overwrite')
})

it('rejects a changed old selection at CAS and preserves foreign same-inode bytes', async () => {
  const f = await fixture(); const state = await f.save('v2', 1); await f.select('v2', state)
  const parsed: unknown = JSON.parse(await readFile(f.selectedPath(), 'utf8'))
  if (parsed === null || typeof parsed !== 'object') throw new Error('missing selection fixture')
  const foreign = encode({ ...parsed, selectionRevision: 77 }); let reads = 0
  f.onRead(async (runtime) => {
    if (runtime === 'v2' && ++reads === 2) await writeFile(f.selectedPath(), foreign)
  })
  await expect(f.select('v2', state)).rejects.toMatchObject({ code: 'H3_MANAGED_SELECTION_STALE' })
  expect(await readFile(f.selectedPath(), 'utf8')).toBe(foreign)
  await expect(f.coordinator.withTransaction(async () => {})).rejects.toBeDefined()
})

it('rejects a transaction capability retained after the original mutex lifetime', async () => {
  const f = await fixture(); const state = await f.save('v2', 1)
  let retained: H3TrialTransaction | null = null
  await f.coordinator.withTransaction(async (transaction) => { retained = transaction })
  if (retained === null) throw new Error('missing original transaction')
  await expect(f.selector.selectSaved('v2', state, retained)).rejects.toBeDefined()
  expect(await readFile(f.selectedPath()).catch(() => null)).toBeNull()
})

it.each(['write', 'sync', 'directory-sync'] as const)('retains uncertainty after a real %s failure and admits no execution',
  async (kind) => {
    if (kind === 'directory-sync' && process.platform === 'win32') return
    const f = await fixture(); const state = await f.save('v2', 1)
    const actual = await import('node:fs/promises')
    let failures = 0
    vi.doMock('node:fs/promises', () => ({ ...actual, open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const path = String(args[0]); const directory = path === dirname(f.selectedPath())
      const temporary = path.includes('.selection-')
      return new Proxy(handle, { get(target, property) {
        if ((temporary && kind === 'write' && property === 'writeFile')
          || (temporary && kind === 'sync' && property === 'sync')
          || (directory && kind === 'directory-sync' && property === 'sync')) {
          return async () => { failures++; throw Object.assign(new Error('injected owned I/O failure'), { code: 'EIO' }) }
        }
        const value: unknown = Reflect.get(target, property)
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      } })
    } }))
    vi.resetModules()
    const { H3ManagedSelection: FreshSelector } = await import('../src/h3-managed-selection.ts')
    const selector = new FreshSelector(f.options)
    await expect(f.coordinator.withTransaction(transaction => selector.selectSaved('v2', state, transaction)))
      .rejects.toMatchObject({ code: 'EIO' })
    expect(failures).toBe(1)
    const executed = vi.fn(async () => 'no execution')
    await expect(new H3ExecutionCoordinator(f.homePath, async () => {}).runReserved({ runtime: 'canonical',
      bindingSha256: 'a'.repeat(64), inputSha256: 'b'.repeat(64) }, executed, async () => 'c'.repeat(64))).rejects.toBeDefined()
    expect(executed).not.toHaveBeenCalled()
    expect((await lstat(join(f.homePath, 'qianshou-h3-owner', '.trial-lock'))).isFile()).toBe(true)
  })

it('shares the actual V2 setup mutex and selects from a real save callback without executing a program', async () => {
  const f = await fixture(); const runtimeDirectory = join(f.homePath, 'runtime')
  await mkdir(runtimeDirectory, { mode: 0o700 })
  for (const name of ['video_generate.py', 'h3_runtime.py', 'owner_self_test.py']) {
    await copyFile(fileURLToPath(new URL('../runtime/h3-v2/' + name, import.meta.url)), join(runtimeDirectory, name))
  }
  const selection: H3OwnerSetupSelection = { runtime: 'v2', pythonPath: join(f.homePath, 'python'),
    ffmpegPath: join(f.homePath, 'ffmpeg'), ffprobePath: join(f.homePath, 'ffprobe'), firstFramePath: join(f.homePath, 'frame.png'),
    workflowPath: join(f.homePath, 'workflow.json'), modelPath: join(f.homePath, 'model'),
    adapterBase: 'http://127.0.0.1:8790', adapterOutputRoot: join(f.homePath, 'output') }
  await mkdir(selection.adapterOutputRoot)
  for (const path of [selection.pythonPath, selection.ffmpegPath, selection.ffprobePath]) {
    await writeFile(path, 'CPU fixture; never executed', { mode: 0o700 })
  }
  const frame = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
  await writeFile(selection.firstFramePath, frame); await writeFile(selection.workflowPath, '{}')
  await writeFile(selection.modelPath, 'synthetic model; no GPU')
  const program = vi.fn(async () => { throw new Error('program execution forbidden') })
  const setup = new H3OwnerSetup({ homePath: f.homePath, runtimeDirectory, readScope: f.options.readScope,
    assertIdle: async () => {}, program,
    fetchImpl: async () => Response.json({ schemaVersion: 'qs.h3.recipe-identity.v2', workflow: 'qs_new4',
      recipeVersion: 'fixture', graphTemplateSha256: 'e'.repeat(64), builderSourceSha256: 'f'.repeat(64),
      executionRecipeSha256: 'a'.repeat(64), modelSha256: 'b'.repeat(64), firstFrameSha256: sha(frame),
      negativeSha256: sha(''), localConfigSha256: 'c'.repeat(64), modelSetSha256: 'b'.repeat(64),
      weightSha256ByRole: { audioVae: '1'.repeat(64), clip: '2'.repeat(64), lora: '3'.repeat(64),
        unet: '4'.repeat(64), videoVae: '5'.repeat(64) } }),
    onSaved: async (path, transaction) => {
      expect((await lstat(join(f.homePath, 'qianshou-h3-owner', '.trial-lock'))).isFile()).toBe(true)
      await transaction.assertOwned()
      const current = await setup.readCurrentConfigIdentity()
      if (current === null || current.configPath !== path) throw new Error('actual saved configuration missing')
      await realSelector.selectSaved('v2', current, transaction)
    } })
  const realSelector = new H3ManagedSelection({ ...f.options, readV2Current: () => setup.readCurrentConfigIdentity() })
  setups.push(setup)
  expect(setup.coordinationPorts().coordinator).toBe(setup.coordinationPorts().coordinator)
  const inspected = await setup.inspect(selection)
  if (inspected.kind !== 'inspection') throw new Error('inspection missing')
  await setup.save({ inspectionId: inspected.inspectionId, expectedRevision: 0 }, signal())
  expect(await realSelector.readCurrent()).toMatchObject({ runtime: 'v2', revision: 1, selectionRevision: 1 })
  expect(await setup.readTrialAdmission()).toEqual({ state: 'clear' })
  await setup.coordinationPorts().coordinator.withTransaction(async () => {
    await setup.coordinationPorts().assertClearWithinTransaction()
    expect(await setup.readTrialAdmission()).toEqual({ state: 'unknown' })
  })
  expect(program).not.toHaveBeenCalled()
})
