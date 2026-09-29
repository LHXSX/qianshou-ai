import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  }
}

test('website enterprise registration sends intent without a role grant', async () => {
  const local = memoryStorage()
  const session = memoryStorage()
  const original = {
    window: globalThis.window,
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
    fetch: globalThis.fetch,
    Request: globalThis.Request,
  }
  const calls = []
  const directory = await mkdtemp(join(tmpdir(), 'qianshou-register-http-'))
  try {
    globalThis.window = {
      location: { origin: 'https://qianshou.example' },
      localStorage: local,
      sessionStorage: session,
      addEventListener() {},
    }
    globalThis.localStorage = local
    globalThis.sessionStorage = session
    globalThis.Request = class BrowserRequest extends original.Request {
      constructor(input, init) {
        super(typeof input === 'string' ? new URL(input, globalThis.window.location.origin) : input, init)
      }
    }
    globalThis.fetch = async input => {
      const request = input instanceof Request ? input : new Request(input)
      calls.push({ url: request.url, body: JSON.parse(await request.text()) })
      return new Response(JSON.stringify({
        ok: true,
        account: { id: 17, status: 'active', role: 'personal' },
        tokens: { access_token: 'test-access', refresh_token: 'test-refresh' },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    const bundle = await build({
      entryPoints: [resolve('src/services/api.ts')],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
    })
    const modulePath = join(directory, 'api.mjs')
    await writeFile(modulePath, bundle.outputFiles[0].text)
    const { auth } = await import(pathToFileURL(modulePath).href)
    await auth.register('company-user', 'Test-2026!', 'enterprise')
    await auth.register('person-user', 'Test-2026!', 'individual')

    assert.equal(calls.length, 2)
    assert.ok(calls.every(call => call.url === 'https://qianshou.example/api/v8/auth/register'))
    assert.equal(calls[0].body.company, 'enterprise')
    assert.equal(calls[0].body.username, 'company-user')
    assert.equal(calls[1].body.username, 'person-user')
    assert.equal('company' in calls[1].body, false)
    assert.ok(calls.every(call => !('role' in call.body)))
  } finally {
    globalThis.window = original.window
    globalThis.localStorage = original.localStorage
    globalThis.sessionStorage = original.sessionStorage
    globalThis.fetch = original.fetch
    globalThis.Request = original.Request
    await rm(directory, { recursive: true, force: true })
  }
})
