import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

// Electron's ESM entry must settle before the host is allowed to emit ready.
// Evaluate the actual entry with ready withheld, then exercise its registered boot.
const probe = String.raw`
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm'
const entry = new URL('../main.mjs', process.env.QIANSHOU_ENTRY_TEST)
const origin = 'http://127.0.0.1:3081'
let resolveReady
const ready = new Promise(resolve => { resolveReady = resolve })
let readyRequested = false
let windows = 0
let backends = 0
let stopped = 0
let exits = 0
const urls = []
const errors = []
const app = new EventEmitter()
Object.assign(app, {
  setName() {}, setPath() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => true,
  whenReady() { readyRequested = true; return ready }, getLocale: () => 'zh-CN',
  setAboutPanelOptions() {}, exit() { exits += 1 },
  quit() { app.emit('before-quit', { preventDefault() {} }) },
})
class Window extends EventEmitter {
  constructor() {
    super(); windows += 1
    this.webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler() {}, mainFrame: { url: origin },
      getURL: () => origin, isDestroyed: () => false,
    })
  }
  async loadURL(url) { urls.push(url); this.emit('ready-to-show') }
  show() {} focus() {} setTitle() {} isDestroyed() { return false }
}
const electron = {
  app, BrowserWindow: Window, dialog: { showErrorBox(...values) { errors.push(values) } },
  safeStorage: {}, ipcMain: { handle() {}, removeHandler() {} }, Menu: { buildFromTemplate: value => value, setApplicationMenu() {} },
  session: { fromPartition: () => ({ setPermissionCheckHandler() {}, setPermissionRequestHandler() {} }) },
  shell: { openExternal: async () => {} }, systemPreferences: { askForMediaAccess: async () => true },
}
const dependencies = {
  electron,
  'node:fs': { mkdirSync() {} }, 'node:os': { homedir: () => '/private/qianshou-test' },
  'node:path': { dirname, join }, 'node:url': { fileURLToPath },
  './config.mjs': { localOrigin: () => origin, readOptionalConfig: () => ({}), resolveConfig: () => ({}), resolvePackagedConfig: () => ({}) },
  './backend.mjs': { startBackend: async () => {
    backends += 1
    return { url: Promise.resolve(origin + '/?token=test-auth'), stop: async () => { stopped += 1 } }
  } },
  './security.mjs': { externalUrl: () => false, microphoneRequest: () => false, trustedUrl: () => true },
  './relay/service.mjs': { RelayService: class { async close() {} } },
  './relay/ipc.mjs': { registerRelayIpc: () => () => {} },
  './native.mjs': { openRustDesk: async () => ({ ok: false, error: 'NOT_INSTALLED' }) },
}
const context = createContext({ process: { platform: process.env.QIANSHOU_TEST_PLATFORM, on() {} }, console })
const source = new SourceTextModule(await readFile(entry, 'utf8'), {
  context, identifier: entry.href, initializeImportMeta(meta) { meta.url = entry.href },
})
await source.link(specifier => {
  const values = dependencies[specifier]
  assert.ok(values, 'unexpected dependency ' + specifier)
  return new SyntheticModule(Object.keys(values), function () {
    for (const [name, value] of Object.entries(values)) this.setExport(name, value)
  }, { context })
})
let evaluated = false
const evaluation = source.evaluate().then(() => { evaluated = true })
await new Promise(resolve => setImmediate(resolve))
assert.equal(readyRequested, true)
assert.equal(evaluated, true, 'entry must finish evaluating before Electron ready')
assert.equal(windows, 0, 'window must wait for ready')
assert.equal(backends, 0, 'backend must wait for ready')
if (process.env.QIANSHOU_QUIT_BEFORE_READY === '1') {
  app.quit()
  await new Promise(resolve => setImmediate(resolve))
}
resolveReady()
await evaluation
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(errors, [])
if (process.env.QIANSHOU_QUIT_BEFORE_READY === '1') {
  assert.equal(windows, 0)
  assert.equal(backends, 0)
  assert.equal(exits, 1)
} else {
  assert.equal(windows, 1)
  assert.equal(backends, 1)
  assert.equal(urls.length, 2)
  assert.ok(urls[0].startsWith('data:text/html'))
  assert.equal(urls[1], origin + '/?token=test-auth')
  app.quit()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stopped, 1)
  assert.equal(exits, 1)
}
`

for (const platform of ['darwin', 'win32']) for (const earlyQuit of [false, true]) {
  test(platform + ': ' + (earlyQuit ? 'quit before ready cannot create a window or owned backend' : 'entry settles before ready then opens the authenticated workbench'), async () => {
    const result = await run(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', probe], {
      env: { ...process.env, QIANSHOU_ENTRY_TEST: import.meta.url, QIANSHOU_QUIT_BEFORE_READY: earlyQuit ? '1' : '0', QIANSHOU_TEST_PLATFORM: platform },
      timeout: 5000,
    })
    assert.equal(result.stdout, '')
  })
}
