/** Run the actual update controller with native-window effects isolated behind VM imports. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm'
import { test } from 'node:test'

const entry = new URL('../electron.mjs', import.meta.url)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const turn = () => new Promise(resolve => setImmediate(resolve))

async function fixture(t, hooks = {}, dependencies = {}) {
  const ipc = new Map()
  const windows = []
  class Window extends EventEmitter {
    constructor() {
      super(); windows.push(this); this.destroyed = false
      this.webContents = Object.assign(new EventEmitter(), { mainFrame: { url: '' }, send() {},
        isDestroyed: () => this.destroyed, setWindowOpenHandler() {} })
    }
    async loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href }
    removeMenu() {} showInactive() {} show() {} focus() {} hide() {}
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
  }
  const mocks = {
    electron: { BrowserWindow: Window, ipcMain: { handle: (key, handler) => ipc.set(key, handler), removeHandler: key => ipc.delete(key) } },
    'node:path': { dirname, join }, 'node:url': { fileURLToPath, pathToFileURL },
    './manifest.mjs': { checkForUpdate: async () => ({ status: 'current' }) },
    './download.mjs': { downloadUpdate: async () => ({ path: '/unused' }) },
    './stage.mjs': { stageUpdate: async () => ({ version: '0.2.2' }) },
  }
  const context = createContext({ console, AbortController, setTimeout, clearTimeout, setInterval, clearInterval })
  const source = new SourceTextModule(await readFile(entry, 'utf8'), {
    context, identifier: entry.href, initializeImportMeta(meta) { meta.url = entry.href },
  })
  await source.link(specifier => {
    const values = mocks[specifier]
    assert.ok(values, `unexpected dependency ${specifier}`)
    return new SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value)
    }, { context })
  })
  await source.evaluate()
  const center = new source.namespace.UpdateCenter({ role: 'controller', platform: 'darwin', arch: 'arm64',
    currentVersion: '0.2.1', packaged: true, locale: 'en', updatesDirectory: '/private/updater-test',
    readiness: async () => ({ ready: false }), prepareRestart: async () => ({ leaseId: 'fake-lease' }),
    restart: async () => {}, cancelRestart: async () => {}, ...hooks }, dependencies)
  t.after(() => center.dispose())
  return { center, ipc, windows }
}

test('same-window subframes, foreign windows and navigated frames cannot issue any update IPC', async t => {
  const { center, ipc, windows } = await fixture(t)
  await center.open(); await center.operation
  const window = windows[0]
  let calls = 0
  center.check = () => { calls++; return Promise.resolve() }
  center.install = async () => { calls++ }
  const handler = ipc.get('qianshou:update-center')
  const frame = window.webContents.mainFrame
  const events = [
    { sender: window.webContents, senderFrame: { url: frame.url } },
    { sender: { mainFrame: frame }, senderFrame: frame },
    { sender: window.webContents, senderFrame: undefined },
  ]
  for (const event of events) for (const action of ['check', 'install', 'cancel', 'hide', 'snapshot']) {
    assert.equal((await handler(event, action)).error, 'UNTRUSTED_SENDER')
  }
  const originalUrl = frame.url
  frame.url = 'https://foreign.example'
  assert.equal((await handler({ sender: window.webContents, senderFrame: frame }, 'check')).error, 'UNTRUSTED_SENDER')
  frame.url = originalUrl
  assert.equal(calls, 0)
  assert.equal((await handler({ sender: window.webContents, senderFrame: frame }, 'snapshot')).ok, true)
})

test('concurrent checks share one pipeline and cancellation prevents late stage admission', async t => {
  const pending = deferred()
  let checks = 0
  let downloads = 0
  const { center } = await fixture(t, {}, { checkForUpdate: async () => { checks++; return pending.promise },
    downloadUpdate: async () => { downloads++; return {} } })
  const first = center.check()
  assert.equal(center.check(), first)
  center.abort.abort()
  pending.resolve({ status: 'available', version: '0.2.2', artifact: { notes: [] } })
  await first
  assert.equal(checks, 1)
  assert.equal(downloads, 0)
  assert.equal(center.state.error, 'CANCELLED')
})

test('a late readiness response cannot overwrite a newer busy observation', async t => {
  const old = deferred()
  const latest = deferred()
  let count = 0
  const { center } = await fixture(t, { readiness: () => (++count === 1 ? old.promise : latest.promise) })
  center.staged = { version: '0.2.2' }; center.state.version = '0.2.2'
  const earlier = center.refreshReadiness()
  const later = center.refreshReadiness()
  latest.resolve({ ready: false }); await later
  old.resolve({ ready: true }); await earlier
  assert.equal(center.state.phase, 'waiting')
})

test('readiness started before install cannot restore the restart button while restarting', async t => {
  const old = deferred()
  const exiting = deferred()
  const { center } = await fixture(t, { readiness: () => old.promise, restart: () => exiting.promise })
  center.staged = { version: '0.2.2' }; center.state = { ...center.state, version: '0.2.2', phase: 'ready' }
  const checking = center.refreshReadiness()
  const installing = center.install()
  await turn()
  old.resolve({ ready: true }); await checking
  assert.equal(center.state.phase, 'restarting')
  exiting.resolve(); await installing
})

test('disposal during lease acquisition releases that lease without starting a replacement app', async t => {
  const pending = deferred()
  const cancelled = []
  let restarted = 0
  const { center } = await fixture(t, { prepareRestart: () => pending.promise,
    restart: async () => { restarted++ }, cancelRestart: async lease => { cancelled.push(lease.leaseId) } })
  center.staged = { version: '0.2.2' }; center.state.phase = 'ready'
  const installing = center.install()
  await turn()
  center.dispose()
  pending.resolve({ leaseId: 'late-lease' })
  await installing
  assert.equal(restarted, 0)
  assert.deepEqual(cancelled, ['late-lease'])
})

test('a disposed late stage result cannot create another readiness poll or trigger UI work', async t => {
  const stage = deferred()
  let readiness = 0
  const { center } = await fixture(t, { readiness: async () => { readiness++; return { ready: true } } }, {
    checkForUpdate: async () => ({ status: 'available', version: '0.2.2', artifact: { notes: [] } }),
    stageUpdate: () => stage.promise,
  })
  const checking = center.check()
  await turn()
  center.dispose()
  stage.resolve({ version: '0.2.2' })
  await checking
  assert.equal(readiness, 0)
  assert.equal(center.readyPoll, undefined)
  assert.equal(center.staged, undefined)
})

test('failed restarts release the acquired lease so normal work can resume', async t => {
  const cancelled = []
  const { center } = await fixture(t, { restart: async () => { throw Object.assign(new Error('not ready'), { code: 'UPDATE_BUSY' }) },
    cancelRestart: async lease => { cancelled.push(lease.leaseId) } })
  center.staged = { version: '0.2.2' }; center.state.phase = 'ready'
  await center.install()
  assert.equal(center.state.phase, 'waiting')
  assert.equal(center.operation, undefined)
  assert.deepEqual(cancelled, ['fake-lease'])
})

test('slow installation verification completes before acquiring the work lease and restart receives that exact preparation', async t => {
  const verification = deferred()
  const exiting = deferred()
  const events = []
  const receipt = { version: '0.2.2' }
  const installation = { attemptId: 'prepared-attempt' }
  const lease = { leaseId: 'idle-lease' }
  const { center } = await fixture(t, {
    prepareInstallation: async value => { assert.equal(value, receipt); events.push('verify'); return verification.promise },
    prepareRestart: async () => { events.push('lease'); return lease },
    restart: async (value, acquired, prepared) => {
      assert.equal(value, receipt); assert.equal(acquired, lease); assert.equal(prepared, installation)
      events.push('restart'); return exiting.promise
    },
  })
  center.staged = receipt; center.state.phase = 'ready'
  const installing = center.install()
  await turn()
  await center.install()
  assert.deepEqual(events, ['verify'], 'verification must not hold the short task-admission lease')
  assert.equal(center.state.phase, 'restarting')
  verification.resolve(installation)
  await turn()
  assert.deepEqual(events, ['verify', 'lease', 'restart'])
  exiting.resolve(); await installing
})

test('disposing during installation verification discards the returned preparation without ever fencing work', async t => {
  const verification = deferred()
  const discarded = []
  let leases = 0
  let restarts = 0
  const installation = { attemptId: 'late-verification' }
  const { center } = await fixture(t, {
    prepareInstallation: () => verification.promise,
    discardInstallation: async value => { discarded.push(value) },
    prepareRestart: async () => { leases++; return { leaseId: 'unexpected' } },
    restart: async () => { restarts++ },
  })
  center.staged = { version: '0.2.2' }; center.state.phase = 'ready'
  const installing = center.install()
  await turn()
  center.dispose()
  verification.resolve(installation)
  await installing
  assert.deepEqual(discarded, [installation])
  assert.equal(leases, 0)
  assert.equal(restarts, 0)
})

test('failed installation verification leaves ordinary work admission untouched', async t => {
  const events = []
  const { center } = await fixture(t, {
    prepareInstallation: async () => { throw Object.assign(new Error('archive changed'), { code: 'UPDATE_INTEGRITY' }) },
    prepareRestart: async () => { events.push('lease'); return { leaseId: 'unexpected' } },
    discardInstallation: async () => { events.push('discard') },
    cancelRestart: async () => { events.push('cancel') },
    restart: async () => { events.push('restart') },
  })
  center.staged = { version: '0.2.2' }; center.state.phase = 'ready'
  await center.install()
  assert.deepEqual(events, [])
  assert.equal(center.state.error, 'UPDATE_INTEGRITY')
  assert.equal(center.operation, undefined)
})

test('work becoming busy after verification discards only the new prepared activation', async t => {
  const verification = deferred()
  const installation = { attemptId: 'prepared-but-busy' }
  const discarded = []
  let busy = false
  let cancelled = 0
  let restarted = 0
  const { center } = await fixture(t, {
    prepareInstallation: () => verification.promise,
    prepareRestart: async () => {
      assert.equal(busy, true)
      throw Object.assign(new Error('existing task is still running'), { code: 'UPDATE_BUSY' })
    },
    discardInstallation: async value => { discarded.push(value) },
    cancelRestart: async () => { cancelled++ },
    restart: async () => { restarted++ },
  })
  center.staged = { version: '0.2.2' }; center.state.phase = 'ready'
  const installing = center.install()
  busy = true
  verification.resolve(installation)
  await installing
  assert.deepEqual(discarded, [installation])
  assert.equal(center.state.phase, 'waiting')
  assert.equal(cancelled, 0, 'no lease was acquired, so no task fence may be cancelled')
  assert.equal(restarted, 0)
})
