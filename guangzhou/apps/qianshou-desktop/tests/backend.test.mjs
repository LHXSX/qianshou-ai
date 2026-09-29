import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBackend } from '../backend.mjs'

async function port() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const value = server.address().port
  await new Promise(resolve => server.close(resolve))
  return value
}
async function fixture(program) {
  const dir = mkdtempSync(join(tmpdir(), 'qianshou-shell-'))
  const cliDir = join(dir, 'source/apps/cli/lib')
  mkdirSync(cliDir, { recursive: true })
  writeFileSync(join(cliDir, 'bin.js'), program)
  return { dir, config: { sourcePath: join(dir, 'source'), nodePath: process.execPath, home: join(dir, 'home'), host: '127.0.0.1', port: await port(), startupTimeoutMs: 2000 } }
}
const liveProgram = `const net = require('node:net');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const server = net.createServer().listen(port, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + port + '/?token=fixture-private-token'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));`

test('owns a real CLI child, consumes its private auth URL, and awaits its shutdown', async () => {
  const value = await fixture(liveProgram)
  let service
  try {
    service = await startBackend(value.config)
    assert.match(await service.url, /token=fixture-private-token/)
    assert.equal(statSync(service.logPath).mode & 0o777, 0o600)
    assert.equal(readFileSync(service.logPath, 'utf8').includes('fixture-private-token'), false)
    await service.stop()
    assert.throws(() => process.kill(service.pid, 0), { code: 'ESRCH' })
    await service.stop()
  } finally { await service?.stop(); rmSync(value.dir, { recursive: true, force: true }) }
})
test('never takes over an occupied port', async () => {
  const value = await fixture(liveProgram)
  const existing = createServer()
  try {
    await new Promise(resolve => existing.listen(value.config.port, value.config.host, resolve))
    await assert.rejects(startBackend(value.config), /PORT_IN_USE/)
    assert.equal(existing.listening, true)
  } finally { await new Promise(resolve => existing.close(resolve)); rmSync(value.dir, { recursive: true, force: true }) }
})
test('packaged profile uses its relocated entry, writable user directory and Node HMR flag', async () => {
  const value = await fixture(`if (!process.execArgv.includes('--expose-internals')) process.exit(2);\nif (process.cwd() !== require('node:fs').realpathSync(process.env.DSH_HOME)) process.exit(3);\n${liveProgram}`)
  mkdirSync(value.config.home, { recursive: true })
  const config = { ...value.config, sourcePath: '/no/source/checkout', cliPath: join(value.config.sourcePath, 'apps/cli/lib/bin.js'), workingDirectory: value.config.home, packaged: true }
  let service
  try {
    service = await startBackend(config)
    assert.match(await service.url, /fixture-private-token/u)
    await service.stop()
    assert.throws(() => process.kill(service.pid, 0), { code: 'ESRCH' })
  } finally { await service?.stop(); rmSync(value.dir, { recursive: true, force: true }) }
})
test('Quit before readiness cancels startup and releases its child', async () => {
  const value = await fixture('setInterval(() => {}, 1000)')
  const service = await startBackend(value.config)
  try {
    await service.stop()
    await assert.rejects(service.url, /START_CANCELLED/)
    assert.throws(() => process.kill(service.pid, 0), { code: 'ESRCH' })
  } finally { await service.stop(); rmSync(value.dir, { recursive: true, force: true }) }
})
test('startup timeout stops its own process and gives a separate error', async () => {
  const value = await fixture('setInterval(() => {}, 1000)')
  value.config.startupTimeoutMs = 80
  const service = await startBackend(value.config)
  try {
    await assert.rejects(service.url, /START_TIMEOUT/)
    await service.done
    assert.throws(() => process.kill(service.pid, 0), { code: 'ESRCH' })
  } finally { await service.stop(); rmSync(value.dir, { recursive: true, force: true }) }
})
