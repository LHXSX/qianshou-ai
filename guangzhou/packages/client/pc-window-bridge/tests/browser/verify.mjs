/** Exercise real IndexedDB across page reload; all PC/account responses are explicit fixtures. */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { createServer } from '../../../../../apps/web/node_modules/vite/dist/node/index.js'
import { chromium } from '../../../../../apps/web/node_modules/playwright/index.mjs'

const output = resolve('.artifacts/mobile-pc-window-browser')
await mkdir(output, { recursive: true })
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const address = server.httpServer.address()
  const dbName = `qianshou-window-fixture-${Date.now()}`
  await page.goto(`http://127.0.0.1:${address.port}/packages/client/pc-window-bridge/tests/browser/index.html`)
  const beforeReload = await page.evaluate(async (name) => {
    const { IndexedDbWindowJournalStore } = await import('/packages/client/pc-window-bridge/src/indexeddb-store.ts')
    const { PcWindowController } = await import('/packages/client/pc-window-bridge/src/controller.ts')
    const store = await IndexedDbWindowJournalStore.open(indexedDB, name)
    const binding = { accountId: 'fixture-owner', pcId: 'fixture-pc', sessionId: 'original-session', sourceDeviceId: 'fixture-phone' }
    let submissions = 0
    const port = { access: async () => ({ state: 'offline', allowedActions: ['dispatch'] }), submit: async () => { submissions += 1; throw new Error('Must not submit offline') }, sync: async () => { throw new Error('Must not sync offline') } }
    const controller = new PcWindowController({ store, port, requestId: () => 'stable-request-id', now: () => 1000 })
    await controller.connect(binding)
    await controller.enqueue({ type: 'dispatch', text: 'Fixture task survives reload' }, 5000)
    const snapshot = controller.snapshot()
    controller.disconnect()
    store.close()
    return { state: snapshot.records[0].state, id: snapshot.records[0].command.requestId, submissions }
  }, dbName)
  assert.deepEqual(beforeReload, { state: 'queued', id: 'stable-request-id', submissions: 0 })
  await page.reload()
  const afterReload = await page.evaluate(async (name) => {
    const { IndexedDbWindowJournalStore } = await import('/packages/client/pc-window-bridge/src/indexeddb-store.ts')
    const { PcWindowController } = await import('/packages/client/pc-window-bridge/src/controller.ts')
    const binding = { accountId: 'fixture-owner', pcId: 'fixture-pc', sessionId: 'original-session', sourceDeviceId: 'fixture-phone' }
    const store = await IndexedDbWindowJournalStore.open(indexedDB, name)
    const otherWindow = await IndexedDbWindowJournalStore.open(indexedDB, name)
    const persisted = await store.load(binding)
    const otherAccount = await store.load({ ...binding, accountId: 'another-fixture-owner' })
    const first = { ...persisted, revision: persisted.revision + 1 }
    await store.save(first, persisted.revision)
    let collision = null
    try { await otherWindow.save(first, persisted.revision) } catch (error) { collision = error.message }
    let submissions = 0
    const port = { access: async () => ({ state: 'online', allowedActions: ['dispatch'] }), submit: async command => { submissions += 1; return { requestId: command.requestId, origin: command.origin, revision: 1, state: 'received', childSessionId: 'fixture-child', reason: null } }, sync: async () => { throw new Error('Not requested') } }
    const controller = new PcWindowController({ store, port, requestId: () => 'unused-id', now: () => 2000 })
    await controller.connect(binding)
    await controller.flush()
    const snapshot = controller.snapshot()
    await controller.forget()
    const removed = await store.load(binding)
    store.close()
    otherWindow.close()
    await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = resolve; request.onerror = () => reject(request.error) })
    return { restoredId: persisted.records[0].command.requestId, restoredState: persisted.records[0].state, otherAccount, collision, receivedState: snapshot.records[0].state, childSessionId: snapshot.records[0].receipt.childSessionId, submissions, removed }
  }, dbName)
  assert.deepEqual(afterReload, { restoredId: 'stable-request-id', restoredState: 'queued', otherAccount: null, collision: 'PC_WINDOW_STALE_LOCAL_REVISION', receivedState: 'received', childSessionId: 'fixture-child', submissions: 1, removed: null })
  assert.deepEqual(errors, [])
  const evidence = { observedAt: new Date().toISOString(), fixture: true, actualIndexedDb: true, authenticatedPcGateway: false, accountLogin: false, installedMobileApp: false, realTaskExecuted: false, beforeReload, afterReload, errors }
  await writeFile(resolve(output, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  await browser.close()
  await server.close()
}
