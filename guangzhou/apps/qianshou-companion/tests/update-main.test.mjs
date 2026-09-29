/** Execute the actual companion main and renderer while isolating native dialogs, storage and app launch. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'
import { JSDOM } from 'jsdom'

const entry = new URL('../src/main.ts', import.meta.url)
const turn = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

async function fixture(t, { flush = async () => {}, dialogResult = async () => ({ canceled: true, filePaths: [] }) } = {}) {
  const ipc = new Map()
  const windows = []
  let hooks
  let ack = 0
  let dialogs = 0
  let dataAccessApproved = false
  let clock = 10_000
  class Clock extends Date { static now() { return clock } }
  const app = Object.assign(new EventEmitter(), { setName() {}, requestSingleInstanceLock: () => true,
    getPath: () => '/private/fake-companion', getLocale: () => 'en', whenReady: () => Promise.resolve(), quit() {} })
  class Window {
    constructor() {
      windows.push(this)
      this.webContents = Object.assign(new EventEmitter(), { mainFrame: { url: '' }, send() {}, setWindowOpenHandler() {} })
    }
    async loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href }
    show() {} focus() {}
  }
  const values = {
    electron: { app, BrowserWindow: Window, clipboard: { writeText() {} },
      dialog: { showErrorBox: (...args) => assert.fail(`unexpected startup failure ${args[0]}`), showOpenDialog: async () => { dialogs++; return dialogResult() } },
      ipcMain: { handle: (key, value) => ipc.set(key, value) }, safeStorage: {},
      Menu: { buildFromTemplate: value => value, setApplicationMenu() {} } },
    'node:os': { hostname: () => 'test-computer', platform: () => 'darwin', arch: () => 'arm64' },
    'node:path': { basename, dirname, join }, 'node:url': { fileURLToPath, pathToFileURL },
    'node:fs/promises': { realpath: async value => value }, 'node:crypto': { randomUUID: () => 'fixture-lease' },
    '@deepseek-ai/dsh-host-remote-devices/protocol': { record: value => value, textField: value => value },
    './peer.ts': { CompanionPeer: class {}, deviceEndpoint: value => value },
    './local-store.ts': { LocalStore: class {
      async read(value) { assert.equal(dataAccessApproved, true, 'bootstrap must commit before user data is read'); return value }
      async save() {}
      flush() { return flush() }
    } },
    './executor.ts': { openRustDesk: async () => {} },
    './updates.ts': { companionUpdates: async () => ({ forwarded: false, configure: value => { hooks = value },
      beforeDataAccess: async () => { dataAccessApproved = true }, ready: async () => { ack++ }, open: async () => {}, dispose() {} }) },
  }
  const context = createContext({ console, process: Object.assign(new EventEmitter(), { platform: 'darwin' }), Date: Clock, setTimeout, clearTimeout })
  const source = new SourceTextModule(ts.transpileModule(await readFile(entry, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText, { context, identifier: entry.href, initializeImportMeta(meta) { meta.url = entry.href } })
  await source.link(specifier => {
    const imports = values[specifier]
    assert.ok(imports, `unexpected dependency ${specifier}`)
    return new SyntheticModule(Object.keys(imports), function () {
      for (const [name, value] of Object.entries(imports)) this.setExport(name, value)
    }, { context })
  })
  await source.evaluate()
  await turn()
  assert.ok(hooks)
  assert.equal(windows.length, 1)
  const window = windows[0]
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  t.after(() => app.emit('before-quit'))
  return { hooks, event, ipc, dialogs: () => dialogs, ack: () => ack,
    invoke: (action, payload) => ipc.get(`qianshou:${action}`)(event, payload), advance: milliseconds => { clock += milliseconds } }
}

test('an outstanding local dialog keeps restart busy; foreign frames cannot invoke mutations or ready acknowledgement', async t => {
  const dialog = deferred()
  const f = await fixture(t, { dialogResult: () => dialog.promise })
  const action = f.invoke('choose-folder')
  assert.equal(f.dialogs(), 1)
  assert.equal((await f.hooks.readiness()).ready, false)
  await assert.rejects(f.hooks.prepareRestart(), { code: 'UPDATE_BUSY' })
  const foreign = { sender: f.event.sender, senderFrame: { url: f.event.senderFrame.url } }
  for (const key of ['qianshou:choose-folder', 'qianshou:connect', 'qianshou:approve', 'qianshou:application-ready', 'qianshou:updates']) {
    await assert.rejects(f.ipc.get(key)(foreign, {}), /UNTRUSTED_RENDERER/)
  }
  const localUrl = f.event.senderFrame.url
  f.event.senderFrame.url = 'https://foreign.example'
  await assert.rejects(f.invoke('application-ready'), /UNTRUSTED_RENDERER/)
  f.event.senderFrame.url = localUrl
  assert.equal(f.ack(), 0)
  assert.equal(f.dialogs(), 1)
  dialog.resolve({ canceled: true, filePaths: [] }); await action
  assert.equal((await f.hooks.readiness()).ready, true)
})

test('a prepared lease fences new work while storage drains and cancellation reopens ordinary actions', async t => {
  const saving = deferred()
  const f = await fixture(t, { flush: () => saving.promise })
  const preparing = f.hooks.prepareRestart()
  assert.equal((await f.invoke('choose-folder')).error, 'UPDATE_PREPARING')
  assert.equal((await f.invoke('connect')).error, 'UPDATE_PREPARING')
  assert.equal((await f.invoke('approve', 'job')).error, 'UPDATE_PREPARING')
  assert.equal((await f.invoke('snapshot')).ok, true)
  assert.equal(f.dialogs(), 0)
  saving.resolve()
  const lease = await preparing
  await f.hooks.cancelRestart({ leaseId: 'wrong-lease' })
  assert.equal((await f.hooks.readiness()).ready, false)
  await f.hooks.cancelRestart(lease)
  assert.equal((await f.hooks.readiness()).ready, true)
  assert.equal((await f.invoke('choose-folder')).ok, true)
  assert.equal(f.dialogs(), 1)
})

test('a delayed preparation cannot commit after its exact lease expires', async t => {
  const f = await fixture(t)
  const lease = await f.hooks.prepareRestart()
  f.advance(31_000)
  await assert.rejects(f.hooks.commitRestart(lease), { code: 'UPDATE_LEASE_EXPIRED' })
  await f.hooks.cancelRestart(lease)
  assert.equal((await f.hooks.readiness()).ready, true)
})

test('companion renderer acknowledges readiness only after its initial snapshot renders', async () => {
  const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8')
  const script = await readFile(new URL('../src/renderer.js', import.meta.url), 'utf8')
  for (const ok of [true, false]) {
    const dom = new JSDOM(html, { url: 'file:///isolated-companion/index.html', runScripts: 'outside-only' })
    try {
      const initial = deferred()
      let acknowledged = 0
      dom.window.qianshou = { onState() {}, invoke: async action => {
        if (action === 'snapshot') return initial.promise
        if (action === 'application-ready') {
          assert.equal(dom.window.document.getElementById('connection').textContent, '未连接')
          assert.equal(dom.window.document.getElementById('task-count').textContent, '0')
          acknowledged++
        }
        return { ok: true }
      } }
      dom.window.eval(script)
      await turn()
      assert.equal(acknowledged, 0)
      initial.resolve(ok ? { ok: true, value: { connected: false, connecting: false, name: 'test', endpoint: 'http://127.0.0.1:9999', jobs: [], workspaces: [] } }
        : { ok: false, error: 'SNAPSHOT_UNAVAILABLE' })
      await turn()
      assert.equal(acknowledged, ok ? 1 : 0)
    } finally { dom.window.close() }
  }
})
