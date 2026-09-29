/**
 * Real IndexedDB for the mobile sync cursor, in a real browser, across a reload.
 *
 * The Node lane cannot load the DOM library, so this is the browser-grade evidence for
 * `IndexedDbMobileSyncState`: it writes the cursor through the shell's own state port,
 * reloads the page, reopens the store, and asserts the cursor came back. The Host sync
 * responses are fixtures; every IndexedDB operation is real. The shell entry itself is
 * not imported here because it resolves a package subpath export that only the Client
 * TypeScript build maps.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { createServer } from '../../../../../apps/web/node_modules/vite/dist/node/index.js'
import { chromium } from '../../../../../apps/web/node_modules/playwright/index.mjs'

const output = resolve('.artifacts/mobile-sync-browser')
await mkdir(output, { recursive: true })
const server = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const address = server.httpServer.address()
  const dbName = `qianshou-mobile-sync-${Date.now()}`
  const key = 'agent\u0000agent-mobile'
  await page.goto(`http://127.0.0.1:${address.port}/packages/client/mobile-agent-shell/tests/browser/index.html`)

  const beforeReload = await page.evaluate(async ({ name, key }) => {
    const { IndexedDbMobileSyncState } = await import('/packages/client/mobile-agent-shell/src/indexeddb-sync-state.ts')
    const { parseMobileSyncState } = await import('/packages/client/mobile-agent-shell/src/sync-state.ts')
    const store = await IndexedDbMobileSyncState.open(indexedDB, name, key)
    const initial = store.snapshot()
    await store.save({ cursor: 'agent-agent-mobile-r1', lastSyncRevision: 1, sequence: 1 })
    const saved = store.snapshot()
    store.close()
    return {
      initialIsNull: initial === null,
      saved,
      refusesGarbage: parseMobileSyncState({ cursor: 'bad cursor!', lastSyncRevision: 1, sequence: 1 }) === null,
    }
  }, { name: dbName, key })

  assert.deepEqual(beforeReload, {
    initialIsNull: true,
    saved: { cursor: 'agent-agent-mobile-r1', lastSyncRevision: 1, sequence: 1 },
    refusesGarbage: true,
  })

  // A full page reload proves the cursor survives the browser reload boundary.
  await page.reload()

  const afterReload = await page.evaluate(async ({ name, key }) => {
    const { IndexedDbMobileSyncState } = await import('/packages/client/mobile-agent-shell/src/indexeddb-sync-state.ts')
    const store = await IndexedDbMobileSyncState.open(indexedDB, name, key)
    const restored = store.snapshot()
    const other = await IndexedDbMobileSyncState.open(indexedDB, name, 'device\u0000another-phone')
    const otherIsolated = other.snapshot()
    await store.save({ cursor: 'agent-agent-mobile-r2', lastSyncRevision: 2, sequence: 2 })
    const advanced = store.snapshot()
    store.close()
    other.close()
    await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = resolve; request.onerror = () => reject(request.error) })
    return { restored, otherIsolated, advanced }
  }, { name: dbName, key })

  assert.deepEqual(afterReload, {
    restored: { cursor: 'agent-agent-mobile-r1', lastSyncRevision: 1, sequence: 1 },
    otherIsolated: null,
    advanced: { cursor: 'agent-agent-mobile-r2', lastSyncRevision: 2, sequence: 2 },
  })
  assert.deepEqual(errors, [])

  const evidence = {
    observedAt: new Date().toISOString(), realIndexedDb: true, realBrowserReload: true,
    hostSyncResponseIsFixture: true, actualHostRoundTrip: false, installedMobileApp: false,
    beforeReload, afterReload, errors,
  }
  await writeFile(resolve(output, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  await browser.close()
  await server.close()
}
