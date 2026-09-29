import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveConfig, backendEnvironment } from '../config.mjs'
import { authenticatedUrl, externalUrl, microphoneRequest, redactLog, trustedUrl, validRustDeskId } from '../security.mjs'
import { openRustDesk } from '../native.mjs'

const origin = 'http://127.0.0.1:3081'
test('local shell reserves the old port and rejects non-loopback installation settings', () => {
  assert.equal(resolveConfig({}, {}, '/tmp/person').home, '/tmp/person/.local/share/qianshou-agent/home')
  assert.throws(() => resolveConfig({ port: 3080 }, {}, '/tmp/person'), /INVALID_PORT/)
  assert.throws(() => resolveConfig({ host: '0.0.0.0' }, {}, '/tmp/person'), /LOOPBACK_REQUIRED/)
  assert.throws(() => resolveConfig({ sourcePath: '../code' }, {}, '/tmp/person'), /INVALID_CONFIG/)
  assert.equal(resolveConfig({}, { QIANSHOU_PORT: '3092' }, '/tmp/person').port, 3092)
})
test('readiness authenticates only the owned local service and logging removes credentials', () => {
  assert.equal(authenticatedUrl(`dsh web: ${origin}/?token=private`, origin), `${origin}/?token=private`)
  assert.equal(authenticatedUrl('dsh web: http://127.0.0.1:3080/?token=private', origin), null)
  assert.equal(authenticatedUrl(`fake ${origin}/?token=private`, origin), null)
  assert.equal(authenticatedUrl(`dsh web: ${origin}/`, origin), null)
  assert.equal(redactLog(`dsh web: ${origin}/?token=private&view=home api_key=other`), `dsh web: ${origin}/?token=[redacted]&view=home api_key=[redacted]`)
})
test('navigation rejects credentialed origins, custom external protocols and bearer token links', () => {
  assert.equal(trustedUrl(`${origin}/session/abc`, origin), true)
  assert.equal(trustedUrl('http://127.0.0.1:3081.attacker.test', origin), false)
  assert.equal(trustedUrl('http://user@127.0.0.1:3081', origin), false)
  assert.equal(externalUrl('https://example.com/docs', origin), true)
  assert.equal(externalUrl('file:///etc/passwd', origin), false)
  assert.equal(externalUrl('rustdesk://123456', origin), false)
  assert.equal(externalUrl('https://example.com/?token=secret', origin), false)
})
test('only audio from the owned main page can request microphone access', () => {
  const request = { isMainFrame: true, requestingUrl: origin, mediaTypes: ['audio'] }
  assert.equal(microphoneRequest(request, origin), true)
  assert.equal(microphoneRequest({ ...request, isMainFrame: false }, origin), false)
  assert.equal(microphoneRequest({ ...request, requestingUrl: 'https://example.com' }, origin), false)
  assert.equal(microphoneRequest({ ...request, mediaTypes: ['audio', 'video'] }, origin), false)
})
test('backend environment excludes ambient secrets and Electron Node switches', () => {
  const env = backendEnvironment({ home: '/tmp/qianshou' }, { PATH: '/usr/bin', DEEPSEEK_API_KEY: 'private', AUTH_TOKEN: 'private', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '1' })
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.DSH_HOME, '/tmp/qianshou')
  assert.equal(env.DEEPSEEK_API_KEY, undefined)
  assert.equal(env.AUTH_TOKEN, undefined)
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(env.NODE_OPTIONS, undefined)
})
test('native remote control validates one numeric ID and reports a missing installation', async () => {
  assert.equal(validRustDeskId('123456789'), true)
  assert.equal(validRustDeskId('123456; open x'), false)
  assert.deepEqual(await openRustDesk('--password=secret'), { ok: false, error: 'INVALID_ID' })
  assert.deepEqual(await openRustDesk('123456789', '/definitely/not-installed/rustdesk'), { ok: false, error: 'NOT_INSTALLED' })
})
