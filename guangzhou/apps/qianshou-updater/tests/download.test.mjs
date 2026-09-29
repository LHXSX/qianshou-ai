/** Real filesystem and loopback streaming prove download integrity, cancellation and private cache cleanup. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, realpath, readdir, readFile, lstat, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { checkForUpdate, verifyReleaseEnvelope } from '../manifest.mjs'
import { downloadUpdate, verifyArchive } from '../download.mjs'
import { body, envelope, target, dependencies } from './fixtures.mjs'

async function available() { return checkForUpdate(target, { ...dependencies, fetchImpl: async () => new Response(envelope()) }) }
async function cache(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'qianshou-updater-test-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('streams a real local HTTP response, reports progress, atomically publishes 0600 and re-verifies offline', async (t) => {
  const directory = await cache(t)
  const update = await available()
  let requests = 0
  const server = createServer((_request, response) => {
    requests++
    response.writeHead(200, { 'Content-Length': body.length })
    response.write(body.subarray(0, 40_000))
    setTimeout(() => response.end(body.subarray(40_000)), 20)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const values = []
  const downloaded = await downloadUpdate(update, { cacheDirectory: directory, onProgress: value => values.push(value) }, {
    fetchImpl: async (url, options) => {
      assert.equal(url, update.artifact.url)
      assert.equal(options.redirect, 'error')
      const local = await fetch(`http://127.0.0.1:${server.address().port}/archive`, options)
      // Only the test transport maps the fixed production URL to its loopback server.
      return new Response(local.body, { status: local.status, headers: local.headers })
    },
  })
  assert.equal(requests, 1)
  assert.deepEqual(await readFile(downloaded.path), body)
  assert.equal((await lstat(downloaded.path)).mode & 0o777, 0o600)
  assert.equal((await lstat(path.dirname(downloaded.path))).mode & 0o777, 0o700)
  assert.deepEqual(await readdir(path.dirname(downloaded.path)), [update.artifact.fileName])
  assert.equal(values[0].received, 0)
  assert.equal(values.at(-1).received, body.length)
  assert.ok(values.length >= 3)
  assert.ok(values.every((value, index) => index === 0 || value.received >= values[index - 1].received))
  const restored = verifyReleaseEnvelope(Buffer.from(downloaded.envelope, 'base64'), target, dependencies)
  assert.deepEqual(await verifyArchive(restored, downloaded.path), { path: downloaded.path, size: body.length, sha256: update.artifact.sha256 })
})

test('same-size corruption, truncation, overflow and inconsistent Content-Length leave no cached archive', async (t) => {
  const directory = await cache(t)
  const update = await available()
  for (const response of [() => new Response(Buffer.alloc(body.length)), () => new Response(body.subarray(1)),
    () => new Response(Buffer.concat([body, Buffer.from('extra')])),
    () => new Response(body, { headers: { 'content-length': body.length - 1 } })]) {
    await assert.rejects(downloadUpdate(update, { cacheDirectory: directory }, { fetchImpl: async () => response() }), error => ['UPDATE_SIZE', 'UPDATE_INTEGRITY'].includes(error.code))
    assert.deepEqual(await readdir(directory), [])
  }
})

test('redirects and HTTP errors are refused and cleaned without following another location', async (t) => {
  const directory = await cache(t)
  const update = await available()
  for (const status of [302, 404, 500]) {
    await assert.rejects(downloadUpdate(update, { cacheDirectory: directory }, { fetchImpl: async () => new Response('', { status, headers: { location: 'https://evil.example' } }) }), { code: 'UPDATE_HTTP' })
    assert.deepEqual(await readdir(directory), [])
  }
})

test('cancellation during streaming cancels the reader and removes its partial directory', async (t) => {
  const directory = await cache(t)
  const controller = new AbortController()
  let cancelled = false
  const update = await available()
  await assert.rejects(downloadUpdate(update, { cacheDirectory: directory, signal: controller.signal,
    onProgress: ({ received }) => { if (received) controller.abort(new Error('stop download')) } }, {
    fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({
      start(stream) {
        stream.enqueue(body.subarray(0, 1024))
        signal.addEventListener('abort', () => { cancelled = true; stream.error(signal.reason) }, { once: true })
      },
    })),
  }), /stop download/)
  assert.equal(cancelled, true)
  assert.deepEqual(await readdir(directory), [])
})

test('presentation exceptions do not abort a verified download', async (t) => {
  const directory = await cache(t)
  const result = await downloadUpdate(await available(), { cacheDirectory: directory,
    onProgress: () => { throw new Error('unmounted UI') } }, { fetchImpl: async () => new Response(body) })
  assert.deepEqual(await readFile(result.path), body)
})

test('forged selections and current releases cannot trigger a download', async (t) => {
  const directory = await cache(t)
  const update = await available()
  await assert.rejects(downloadUpdate({ ...update }, { cacheDirectory: directory }), { code: 'UNVERIFIED_RELEASE' })
  const current = await checkForUpdate({ ...target, currentVersion: '0.2.2' }, { ...dependencies, fetchImpl: async () => new Response(envelope()) })
  await assert.rejects(downloadUpdate(current, { cacheDirectory: directory }), { code: 'UNVERIFIED_RELEASE' })
  assert.deepEqual(await readdir(directory), [])
})

test('symlink cache roots and ancestors are rejected without writing into their targets', async (t) => {
  const directory = await cache(t)
  const destination = path.join(directory, 'real')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(destination, { mode: 0o700 })
  const link = path.join(directory, 'link')
  await symlink(destination, link, 'dir')
  for (const cacheDirectory of [link, path.join(link, 'nested')]) {
    await assert.rejects(downloadUpdate(await available(), { cacheDirectory }), { code: 'UNSAFE_CACHE' })
  }
  assert.deepEqual(await readdir(destination), [])
})

test('offline verification rejects modified archives and symlink files', async (t) => {
  const directory = await cache(t)
  const selected = await available()
  const downloaded = await downloadUpdate(selected, { cacheDirectory: directory }, { fetchImpl: async () => new Response(body) })
  const link = path.join(path.dirname(downloaded.path), 'linked.zip')
  await symlink(downloaded.path, link)
  await assert.rejects(verifyArchive(selected, link), { code: 'UNSAFE_ARCHIVE' })
  await writeFile(downloaded.path, Buffer.alloc(body.length))
  await assert.rejects(verifyArchive(selected, downloaded.path), { code: 'UPDATE_INTEGRITY' })
})

test('download and filesystem failures expose stable messages without private paths', async (t) => {
  const directory = await cache(t)
  const selected = await available()
  await assert.rejects(downloadUpdate(selected, { cacheDirectory: directory }, { fetchImpl: async () => {
    throw new Error('server body /private/example key=not-real')
  } }), error => error.code === 'UPDATE_DOWNLOAD' && !error.message.includes('/private/') && !error.message.includes('key='))
  assert.deepEqual(await readdir(directory), [])
  await assert.rejects(verifyArchive(selected, path.join(directory, 'missing.zip')),
    error => error.code === 'UPDATE_IO' && !error.message.includes(directory))
})
