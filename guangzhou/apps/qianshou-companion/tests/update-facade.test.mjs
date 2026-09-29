/** Exercise the shipped companion update facade with updater and native process effects isolated. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const entry = new URL('../src/updates.ts', import.meta.url)
const location = '/private/isolated-companion/resources/app/lib'
const userData = '/private/isolated-companion/data'
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const turn = () => new Promise(resolve => setImmediate(resolve))

const shippedMetadata = { name: 'qianshou-companion', distribution: 'bundled', version: '0.2.1' }

async function fixture({ packaged = false, bootstrap = { action: 'continue' }, env = {}, hooks = {},
  metadata = shippedMetadata, metadataText = JSON.stringify(metadata), readError } = {}) {
  const events = []
  const calls = []
  const centers = []
  let imports = 0
  let quits = 0
  const metadataReads = []
  const readMetadata = (filename, encoding) => {
    assert.equal(filename, join(location, '..', 'package.json'))
    assert.equal(encoding, 'utf8')
    metadataReads.push(filename)
    if (readError) throw readError
    return metadataText
  }
  const runtime = {
    UpdateCenter: class {
      constructor(options) { this.options = options; centers.push(this) }
      start() { events.push('center:start') }
      async open() { events.push('center:open') }
      dispose() { events.push('center:dispose') }
    },
    bootstrapUpdate: async options => { calls.push(['bootstrap', options]); return bootstrap },
    prepareActivation: async (receipt, options) => {
      calls.push(['prepare', receipt, options]); events.push('prepare')
      return { attemptId: 'new-preparation' }
    },
    launchActivation: async (activation, options) => { calls.push(['launch', activation, options]); events.push('launch') },
    cancelActivation: async activation => { calls.push(['cancel', activation]); events.push('cancel') },
    acknowledgeDataAccess: async options => { calls.push(['data', options]); events.push('data') },
    acknowledgeReady: async options => { calls.push(['ready', options]); events.push('ready') },
    ...hooks,
  }
  const app = { isPackaged: packaged, getPath: name => { assert.equal(name, 'userData'); return userData },
    getVersion: () => '44.0.0', getLocale: () => 'zh-CN', quit: () => { quits++; events.push('quit') } }
  const context = createContext({ process: { platform: 'darwin', arch: 'arm64', pid: 31415,
    execPath: '/private/isolated-companion/Contents/MacOS/Electron', env } })
  const synthetic = async values => {
    const module = new SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value)
    }, { context })
    await module.link(() => assert.fail('synthetic dependency imported another module'))
    await module.evaluate()
    return module
  }
  const source = new SourceTextModule(ts.transpileModule(await readFile(entry, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText, {
    context, identifier: entry.href,
    importModuleDynamically: async specifier => {
      assert.equal(specifier, pathToFileURL(join(location, 'updater', 'entry.mjs')).href)
      imports++
      return synthetic(runtime)
    },
  })
  const importsByName = { electron: { app }, 'node:path': { join }, 'node:url': { pathToFileURL },
    'node:fs/promises': { readFile: async (...args) => readMetadata(...args) } }
  await source.link(specifier => {
    assert.ok(importsByName[specifier], `unexpected dependency ${specifier}`)
    return synthetic(importsByName[specifier])
  })
  await source.evaluate()
  const facade = await source.namespace.companionUpdates(location)
  return { facade, events, calls, centers, metadataReads, imports: () => imports, quits: () => quits }
}

function configure(fixture, overrides = {}) {
  fixture.facade.configure({ readiness: async () => ({ ready: true }),
    prepareRestart: async () => ({ leaseId: 'fake-lease' }),
    commitRestart: async () => { fixture.events.push('commit') }, cancelRestart: async () => {}, ...overrides })
  return fixture.centers[0].options
}

test('a source launch does not import or initialize the packaged updater', async () => {
  for (const packaged of [false, true]) {
    const f = await fixture({ packaged, metadata: { name: '@qianshou/companion', version: '0.2.1' } })
    assert.equal(f.facade, undefined)
    assert.equal(f.imports(), 0)
    assert.deepEqual(f.calls, [])
  }
})

test('the shipped Mac companion enables updates despite Electron reporting isPackaged false and uses its release metadata version', async () => {
  const f = await fixture({ packaged: false })
  assert.ok(f.facade)
  assert.equal(f.imports(), 1)
  assert.deepEqual(f.metadataReads, [join(location, '..', 'package.json')])
  const options = configure(f)
  assert.equal(options.currentVersion, shippedMetadata.version)
  assert.equal(f.calls.find(call => call[0] === 'bootstrap')[1].currentVersion, shippedMetadata.version)
  await options.prepareInstallation({ version: '0.2.2' })
  assert.equal(f.calls.find(call => call[0] === 'prepare')[2].currentVersion, shippedMetadata.version)
})

test('missing or unreadable package metadata never activates the updater through the Electron flag', async () => {
  for (const code of ['ENOENT', 'EACCES']) {
    const f = await fixture({ packaged: true, readError: Object.assign(new Error('fixture read failed'), { code }) })
    assert.equal(f.facade, undefined)
    assert.equal(f.imports(), 0)
    assert.deepEqual(f.calls, [])
    assert.equal(f.quits(), 0)
  }
})

test('invalid JSON and non-release package metadata cannot bootstrap an update', async () => {
  const values = [null, [], 'bundled', 1, {},
    { ...shippedMetadata, name: '@qianshou/companion' },
    { ...shippedMetadata, name: 'qianshou-agent' },
    { name: 'qianshou-companion', version: '0.2.1' },
    { ...shippedMetadata, distribution: 'source' },
    { ...shippedMetadata, distribution: true }]
  for (const metadataText of ['{broken-json', ...values.map(value => JSON.stringify(value))]) {
    const f = await fixture({ packaged: true, metadataText })
    assert.equal(f.facade, undefined)
    assert.equal(f.imports(), 0)
    assert.deepEqual(f.calls, [])
  }
})

test('release metadata requires a strict numeric x.y.z version before updater import', async () => {
  for (const version of [undefined, null, 2, '', '0.2', 'v0.2.1', '00.2.1', '0.02.1', '0.2.01', '0.2.1-beta', '0.2.1+build', ' 0.2.1', '0.2.1\n']) {
    const f = await fixture({ packaged: true, metadata: { ...shippedMetadata, version } })
    assert.equal(f.facade, undefined, `invalid version ${JSON.stringify(version)}`)
    assert.equal(f.imports(), 0)
    assert.deepEqual(f.calls, [])
  }
})

test('first installation and an ordinary active restart open data without a pending-upgrade acknowledgement', async () => {
  for (const bootstrap of [{ action: 'continue' }, { action: 'continue', pending: false }]) {
    const f = await fixture({ bootstrap, env: { QIANSHOU_UPDATE_ATTEMPT: 'stale-attempt', QIANSHOU_UPDATE_TOKEN: 'stale-test-token' } })
    assert.equal(f.facade.forwarded, false)
    configure(f)
    await f.facade.beforeDataAccess()
    await f.facade.ready()
    assert.deepEqual(f.calls.map(call => call[0]), ['bootstrap'])
    assert.deepEqual(f.events, ['center:start'])
    assert.equal(f.quits(), 0)
  }
})

test('a pending upgrade commits data before readiness and a retry uses bootstrap identity instead of stale environment', async () => {
  const data = deferred()
  const ready = deferred()
  const acknowledged = []
  const f = await fixture({ bootstrap: { action: 'continue', pending: true, attemptId: 'retry-from-bootstrap', token: 'retry-test-token' },
    env: { QIANSHOU_UPDATE_ATTEMPT: 'stale-attempt', QIANSHOU_UPDATE_TOKEN: 'stale-test-token' },
    hooks: {
      acknowledgeDataAccess: async options => { acknowledged.push(['data', options]); return data.promise },
      acknowledgeReady: async options => { acknowledged.push(['ready', options]); return ready.promise },
    } })
  configure(f)
  let accessed = false
  const startup = (async () => { await f.facade.beforeDataAccess(); accessed = true; await f.facade.ready() })()
  await turn()
  assert.equal(accessed, false)
  assert.deepEqual(acknowledged.map(call => call[0]), ['data'])
  assert.deepEqual(f.events, [])
  data.resolve(); await turn()
  assert.equal(accessed, true)
  assert.deepEqual(acknowledged.map(call => call[0]), ['data', 'ready'])
  assert.deepEqual(f.events, [], 'periodic updates must not start while real readiness is uncommitted')
  ready.resolve(); await startup
  assert.deepEqual(f.events, ['center:start'])
  for (const [, options] of acknowledged) {
    assert.equal(options.attemptId, 'retry-from-bootstrap')
    assert.equal(options.token, 'retry-test-token')
    assert.equal(options.currentVersion, '0.2.1')
    assert.equal(options.updatesDirectory, join(userData, 'updates'))
    assert.equal(options.target.role, 'companion')
  }
})

test('a rejected data-access commit prevents the caller from opening its store or starting the update center', async () => {
  let accessed = false
  const f = await fixture({ bootstrap: { action: 'continue', pending: true }, hooks: {
    acknowledgeDataAccess: async () => { throw Object.assign(new Error('receipt no longer current'), { code: 'UPDATE_ATTEMPT_MISMATCH' }) },
  } })
  configure(f)
  await assert.rejects((async () => { await f.facade.beforeDataAccess(); accessed = true; await f.facade.ready() })(), { code: 'UPDATE_ATTEMPT_MISMATCH' })
  assert.equal(accessed, false)
  assert.deepEqual(f.events, [])
  assert.equal(f.quits(), 0)
})

test('forwarding launches only the returned activation, while wait starts nothing and native quit remains caller-owned', async () => {
  const activation = { attemptId: 'forwarded-attempt' }
  for (const action of ['forward', 'wait']) {
    const f = await fixture({ bootstrap: { action, activation } })
    assert.equal(f.facade.forwarded, true)
    assert.equal(f.centers.length, 0)
    assert.equal(f.quits(), 0)
    const launches = f.calls.filter(call => call[0] === 'launch')
    assert.equal(launches.length, action === 'forward' ? 1 : 0)
    if (action === 'forward') {
      assert.equal(launches[0][1], activation)
      assert.equal(launches[0][2].helperScript, join(location, 'updater', 'runner.mjs'))
      assert.equal(launches[0][2].electronRunAsNode, true)
    }
  }
})

test('prepared restart revalidates its exact lease on both sides of helper launch before quitting', async () => {
  const launching = deferred()
  const f = await fixture({ hooks: { launchActivation: async activation => {
    assert.equal(activation.attemptId, 'new-preparation'); return launching.promise
  } } })
  const lease = { leaseId: 'exact-lease' }
  const commits = []
  const options = configure(f, { commitRestart: async value => { commits.push(value); f.events.push('commit') } })
  const receipt = { version: '0.2.2' }
  const prepared = await options.prepareInstallation(receipt)
  assert.equal(f.calls.find(call => call[0] === 'prepare')[1], receipt)
  const restart = options.restart(receipt, lease, prepared)
  await turn()
  assert.deepEqual(commits, [lease])
  assert.equal(f.quits(), 0)
  launching.resolve(); await restart
  assert.deepEqual(commits, [lease, lease])
  assert.deepEqual(f.events, ['prepare', 'commit', 'commit', 'quit'])
  assert.equal(f.quits(), 1)
})

test('a failed final lease check after helper launch refuses application shutdown and preserves the preparation for cleanup', async () => {
  const f = await fixture()
  let commits = 0
  const options = configure(f, { commitRestart: async () => {
    if (++commits === 2) throw Object.assign(new Error('expired lease'), { code: 'UPDATE_LEASE_EXPIRED' })
  } })
  const receipt = { version: '0.2.2' }
  const prepared = await options.prepareInstallation(receipt)
  await assert.rejects(options.restart(receipt, { leaseId: 'expiring' }, prepared), { code: 'UPDATE_LEASE_EXPIRED' })
  assert.equal(f.calls.filter(call => call[0] === 'launch').length, 1)
  assert.equal(f.quits(), 0)
  await options.discardInstallation(prepared)
  assert.equal(f.calls.find(call => call[0] === 'cancel')[1], prepared)
})
