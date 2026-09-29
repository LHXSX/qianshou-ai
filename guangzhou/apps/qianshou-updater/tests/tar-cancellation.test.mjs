import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { test } from 'node:test'
import { stageUpdate, updateLayout } from '../stage.mjs'
import { appEntries, currentApp, signedDownload, tarBytes, testing, workspace } from './stage-fixtures.mjs'

test('cancelling a Linux TAR during a real partial file write settles and removes only its unfinished stage', { timeout: 12_000 }, async t => {
  const root = await workspace(t)
  const target = { role: 'companion', platform: 'linux', arch: 'x64', currentVersion: '0.2.1' }
  const original = await currentApp(root, target)
  const originalBytes = await readFile(original)
  const layout = updateLayout(target, '0.2.2')
  const payloadPath = `${layout.root}/resources/payload.bin`
  const payload = randomBytes(8 * 1024 * 1024)
  const entries = [...appEntries(target), { name: payloadPath, data: payload }]
  const download = await signedDownload(root, target, entries, '0.2.2', tarBytes(entries))
  const downloadHash = createHash('sha256').update(await readFile(download.path)).digest('hex')
  const updatesDirectory = path.join(root, 'updates')
  const versions = path.join(updatesDirectory, 'versions')
  const controller = new AbortController()
  const reason = new Error('cancel after observing a partially written TAR file')
  t.after(() => controller.abort(reason))
  let settled
  const completion = stageUpdate(download, { updatesDirectory, target, signal: controller.signal }, testing).then(
    value => (settled = { status: 'fulfilled', value }),
    error => (settled = { status: 'rejected', error }),
  )
  const deadline = Date.now() + 5_000
  let partialBytes = 0
  while (!partialBytes && Date.now() < deadline) {
    const candidates = await readdir(versions).catch(error => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    for (const name of candidates.filter(name => name.startsWith('.staging-'))) {
      const info = await stat(path.join(versions, name, 'content', payloadPath)).catch(error => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (info && info.size > 0 && info.size < payload.length) {
        partialBytes = info.size
        break
      }
    }
    if (settled && !partialBytes) assert.fail(`Stage finished before the cancellation point: ${settled.status}`)
    if (!partialBytes) await pause(1)
  }
  assert.ok(partialBytes > 0 && partialBytes < payload.length, 'the test must abort after real writing begins and before the payload is complete')
  controller.abort(reason)
  let timer
  const result = await Promise.race([
    completion,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TAR cancellation left the stage promise pending')), 3_000) }),
  ]).finally(() => clearTimeout(timer))
  assert.equal(result.status, 'rejected')
  assert.ok(result.error === reason || result.error.code === 'ABORT_ERR' || result.error.cause === reason, 'the failure must report the requested cancellation')
  assert.deepEqual(await readdir(versions), [])
  await pause(20)
  assert.deepEqual(await readdir(versions), [], 'settled background writes must not recreate the removed stage')
  assert.deepEqual(await readFile(original), originalBytes)
  assert.equal(createHash('sha256').update(await readFile(download.path)).digest('hex'), downloadHash)
})
