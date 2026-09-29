/** Real readiness listener rejects foreign frames and cannot survive timeout or cancellation. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { waitForApplicationReady, controllerUpdateHooks } from '../update-integration.mjs'

test('only the exact main frame at the owned backend origin acknowledges application readiness', async () => {
  const ipcMain = new EventEmitter()
  const mainFrame = { url: 'data:text/html,splash' }
  const window = { webContents: { mainFrame } }
  const signal = new AbortController().signal
  let ready = false
  const wait = waitForApplicationReady({ window, ipcMain, origin: 'http://127.0.0.1:3081', signal, timeoutMs: 1000 }).then(() => { ready = true })
  const emit = event => ipcMain.emit('qianshou:application-ready', event)
  emit({ sender: window.webContents, senderFrame: mainFrame })
  emit({ sender: window.webContents, senderFrame: { url: 'http://127.0.0.1:3081/' } })
  emit({ sender: {}, senderFrame: mainFrame })
  mainFrame.url = 'https://foreign.example'
  emit({ sender: window.webContents, senderFrame: mainFrame })
  await Promise.resolve()
  assert.equal(ready, false)
  assert.equal(ipcMain.listenerCount('qianshou:application-ready'), 1)
  mainFrame.url = 'http://127.0.0.1:3081/'
  emit({ sender: window.webContents, senderFrame: mainFrame })
  await wait
  assert.equal(ready, true)
  assert.equal(ipcMain.listenerCount('qianshou:application-ready'), 0)
})

test('timeout and pre/mid cancellation remove the exact owned listener', async () => {
  const ipcMain = new EventEmitter()
  const window = { webContents: { mainFrame: { url: 'http://127.0.0.1:3081/' } } }
  const options = { window, ipcMain, origin: 'http://127.0.0.1:3081' }
  await assert.rejects(waitForApplicationReady({ ...options, timeoutMs: 5 }), /APPLICATION_READY_TIMEOUT/)
  assert.equal(ipcMain.listenerCount('qianshou:application-ready'), 0)
  for (const preAborted of [true, false]) {
    const controller = new AbortController()
    if (preAborted) controller.abort()
    const waiting = waitForApplicationReady({ ...options, signal: controller.signal, timeoutMs: 1000 })
    controller.abort()
    await assert.rejects(waiting, /APPLICATION_READY_CANCELLED/)
    assert.equal(ipcMain.listenerCount('qianshou:application-ready'), 0)
  }
})

test('unready backend or missing loopback cookie cannot acquire an update lease', async () => {
  let cookies = 0
  const hooks = controllerUpdateHooks({ origin: 'http://127.0.0.1:3081', ready: () => false,
    webSession: { cookies: { get: async () => { cookies++; return [] } } } })
  await assert.rejects(hooks.prepareRestart(), { code: 'READINESS_UNAVAILABLE' })
  assert.equal(cookies, 0)
  const missing = controllerUpdateHooks({ origin: 'http://127.0.0.1:3081', ready: () => true,
    webSession: { cookies: { get: async ({ url }) => { assert.equal(url, 'http://127.0.0.1:3081'); return [] } } } })
  await assert.rejects(missing.prepareRestart(), { code: 'READINESS_UNAVAILABLE' })
})
