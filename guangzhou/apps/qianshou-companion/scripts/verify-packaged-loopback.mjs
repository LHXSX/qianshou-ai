/** Exercise the built web CLI and installed companion modules on an isolated loopback port. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(appRoot, '../..')
const cli = process.argv[3] ?? join(repo, 'apps/cli/lib/bin.js')
const runtimeNode = process.argv[4] ?? process.execPath
const packaged = process.argv[2] ?? join(homedir(), 'Applications/千手协作端.app/Contents/Resources/app')
const receiptPath = join(appRoot, 'dist/PACKAGED_LOOPBACK_RECEIPT.json')
const startedAt = new Date().toISOString()
const receipt = { startedAt, status: 'RUNNING', kind: 'BUILT_CLI_HTTP_AND_PACKAGED_PEER_LOOPBACK', cli, packaged, checks: {}, limitations: ['One machine; no GUI actions or cross-machine connectivity tested.', 'No model invocation, user API key access, desktop stream, or OS permission grants.'] }
let sandbox, child, peer, origin, failure, log = '', exitState
const check = (name, value = true) => { receipt.checks[name] = value }
const digest = value => createHash('sha256').update(value).digest('hex')
const redact = value => String(value).replace(/([?&]token=)[^\s)"'&]+/g, '$1[REDACTED]')
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'"
async function until(operation, label, ms = 15_000) {
  const untilAt = Date.now() + ms
  while (Date.now() < untilAt) {
    const result = await operation()
    if (result) return result
    if (exitState) throw new Error(`CLI_EXITED_${exitState.code ?? exitState.signal}`)
    await delay(75)
  }
  throw new Error(`TIMEOUT_${label}`)
}
async function absent(path) {
  try { await stat(path); return false } catch (error) { if (error.code === 'ENOENT') return true; throw error }
}
async function stopOwnedProcess() {
  if (!child || exitState) return
  child.kill('SIGTERM')
  for (let n = 0; n < 100 && !exitState; n++) await delay(50)
  if (!exitState) {
    receipt.forcedProcessGroupStop = true
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* The owned group may already have exited. */ }
    for (let n = 0; n < 100 && !exitState; n++) await delay(50)
  }
  assert.ok(exitState, 'Owned CLI process must stop before cleanup')
}

try {
  receipt.cliSha256 = digest(await readFile(cli))
  await stat(join(packaged, 'lib/peer.js'))
  await stat(join(packaged, 'lib/executor.js'))
  sandbox = await mkdtemp(join(tmpdir(), 'qianshou-packaged-http-'))
  const testHome = join(sandbox, 'home')
  const workspace = join(sandbox, 'workspace')
  const isolatedApp = join(sandbox, 'companion')
  await mkdir(testHome); await mkdir(workspace)
  await cp(packaged, isolatedApp, { recursive: true })
  const { CompanionPeer, deviceEndpoint } = await import(pathToFileURL(join(isolatedApp, 'lib/peer.js')))
  const { executeJob } = await import(pathToFileURL(join(isolatedApp, 'lib/executor.js')))
  check('installedModulesImportOutsideRepository')
  receipt.companionEntrySha256 = { peer: digest(await readFile(join(isolatedApp, 'lib/peer.js'))), executor: digest(await readFile(join(isolatedApp, 'lib/executor.js'))) }

  // The child receives only these noncredential environment values and a fresh Harness home.
  const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL', 'SystemRoot'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]))
  env.DSH_HOME = testHome
  env.NO_COLOR = '1'
  child = spawn(runtimeNode, ['--expose-internals', cli, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.once('exit', (code, signal) => { exitState = { code, signal } })
  child.once('error', error => { exitState = { code: 'SPAWN_FAILED' }; log += error.message })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk.toString()).slice(-200_000) })
  const authUrl = await until(() => log.match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+\/\?token=[A-Za-z0-9_-]+/)?.[0], 'CLI_READY', 90_000)
  origin = new URL(authUrl).origin
  assert.notEqual(new URL(origin).port, '3080'); assert.notEqual(new URL(origin).port, '3081')
  receipt.loopbackOrigin = origin
  check('isolatedHomeAndEphemeralLoopbackPort')
  const unauthorized = await fetch(origin + '/api/qianshou/devices')
  assert.equal(unauthorized.status, 401)
  const deniedPair = await fetch(origin + '/api/qianshou/pairings', { method: 'POST' })
  assert.equal(deniedPair.status, 401)
  check('httpRequiresBrowserAuthentication')
  const auth = await fetch(authUrl, { redirect: 'manual' })
  assert.equal(auth.status, 303)
  const cookie = auth.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  check('launchTokenExchangedForBrowserCookie')
  const request = async (path, body) => {
    const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) })
    assert.equal(response.status, 200, `${path} returned ${response.status}`)
    return response.json()
  }
  const crossSite = await fetch(origin + '/api/qianshou/devices', { headers: { Cookie: cookie, Origin: 'https://untrusted.example' } })
  assert.equal(crossSite.status, 403)
  check('authenticatedCrossOriginRequestRejected')
  assert.deepEqual(await request('/api/qianshou/devices'), { devices: [], jobs: [] })
  const pairing = await request('/api/qianshou/pairings', {})
  assert.equal(pairing.wsPath, '/qianshou-device')
  let credential, executionCount = 0
  const states = []
  const workspaceId = 'packaged-approval-workspace'
  peer = new CompanionPeer({ endpoint: deviceEndpoint(origin), code: pairing.code, hello: { name: 'Temporary packaged acceptance peer', platform: process.platform, arch: process.arch, workspaces: [{ id: workspaceId, name: 'isolated test workspace', path: workspace }] }, saveCredential: async value => { credential = value }, saveJobs: async jobs => writeFile(join(sandbox, 'peer-jobs.json'), JSON.stringify(jobs), { mode: 0o600 }), changed: state => { states.push({ connected: state.connected, statuses: state.jobs.map(job => job.status) }) }, executor: (...args) => { executionCount++; return executeJob(...args) } })
  peer.connect()
  await until(() => peer.snapshot().connected, 'PEER_CONNECTED')
  assert.ok(credential)
  const live = await until(async () => (await request('/api/qianshou/devices')).devices.find(device => device.id === credential.deviceId && device.connected), 'DEVICE_VISIBLE')
  assert.equal(live.workspaces[0].path, workspace)
  check('httpPairingAndActualWebSocketUpgrade')

  const nonce = 'qianshou-packaged-' + randomUUID()
  const marker = join(workspace, 'approval-proof.txt')
  const program = `require('node:fs').writeFileSync('approval-proof.txt',${JSON.stringify(nonce)});process.stdout.write(${JSON.stringify(nonce)})`
  const command = shellQuote(runtimeNode) + ' -e ' + shellQuote(program)
  const job = await request('/api/qianshou/jobs', { deviceId: credential.deviceId, workspaceId, kind: 'command', payload: { command } })
  await until(() => peer.snapshot().jobs.find(item => item.id === job.id)?.status === 'awaiting-approval', 'LOCAL_APPROVAL_QUEUE')
  await delay(200)
  assert.equal(executionCount, 0); assert.ok(await absent(marker))
  assert.equal((await request('/api/qianshou/devices')).jobs.find(item => item.id === job.id).status, 'awaiting-approval')
  check('commandDoesNotExecuteBeforeExplicitLocalApproval')
  receipt.approval = { actor: 'isolated automated acceptance harness', method: 'CompanionPeer.approve', guiApprovalTested: false }
  await peer.approve(job.id)
  const completed = await until(async () => (await request('/api/qianshou/devices')).jobs.find(item => item.id === job.id && item.status === 'completed'), 'COMMAND_COMPLETED')
  assert.equal(executionCount, 1); assert.equal(await readFile(marker, 'utf8'), nonce)
  assert.equal(completed.output, nonce); assert.equal(completed.result.exitCode, 0)
  assert.equal(completed.result.output, nonce); assert.equal(completed.result.cwd, await realpath(workspace))
  check('packagedExecutorCommandAndHttpResultRoundTrip')
  receipt.command = { status: completed.status, exitCode: completed.result.exitCode, outputMatchedExpectedMarker: true, executedExactlyOnce: true }

  const readJob = await request('/api/qianshou/jobs', { deviceId: credential.deviceId, workspaceId, kind: 'read', payload: { path: 'approval-proof.txt' } })
  await until(() => peer.snapshot().jobs.some(item => item.id === readJob.id), 'READ_QUEUED')
  await peer.approve(readJob.id)
  const readResult = await until(async () => (await request('/api/qianshou/devices')).jobs.find(item => item.id === readJob.id && item.status === 'completed'), 'READ_COMPLETED')
  assert.equal(readResult.result.content, nonce)
  check('packagedFileReadAndHttpResultRoundTrip')
  const cancelled = await request('/api/qianshou/jobs', { deviceId: credential.deviceId, workspaceId, kind: 'write', payload: { path: 'must-not-exist.txt', content: 'not approved' } })
  await until(() => peer.snapshot().jobs.some(item => item.id === cancelled.id), 'CANCEL_QUEUED')
  await request('/api/qianshou/job-cancel', { jobId: cancelled.id })
  await until(async () => (await request('/api/qianshou/devices')).jobs.find(item => item.id === cancelled.id && item.status === 'cancelled'), 'CANCELLED')
  assert.ok(await absent(join(workspace, 'must-not-exist.txt'))); assert.equal(executionCount, 2)
  check('httpCancellationPreventsUnapprovedWrite')
  await request('/api/qianshou/device-revoke', { deviceId: credential.deviceId })
  await until(() => !peer.snapshot().connected, 'REVOKED')
  assert.equal((await request('/api/qianshou/devices')).devices.length, 0)
  check('httpRevokeDisconnectsPackagedPeer')
  receipt.observedStates = states
  receipt.status = 'PASSED'
} catch (error) {
  failure = error
  receipt.status = 'FAILED'
  receipt.error = redact(error instanceof Error ? error.message : error)
  receipt.sanitizedStartupTail = redact(log).slice(-6000)
} finally {
  peer?.stop()
  try {
    await stopOwnedProcess()
    check('temporaryBackendStopped', child === undefined || !!exitState)
    if (origin) {
      let refused = false
      try { await fetch(origin + '/api/qianshou/devices', { signal: AbortSignal.timeout(1000) }) } catch { refused = true }
      assert.ok(refused, 'Temporary HTTP listener must be closed')
      check('temporaryHttpListenerClosed')
    }
    if (sandbox) { await rm(sandbox, { recursive: true, force: true }); check('temporaryHomeWorkspaceAndTestCredentialsRemoved') }
  } catch (error) {
    failure ??= error; receipt.status = 'FAILED'; receipt.cleanupError = redact(error.message)
  }
  receipt.finishedAt = new Date().toISOString()
  await mkdir(dirname(receiptPath), { recursive: true })
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
}
console.log(JSON.stringify({ status: receipt.status, receipt: receiptPath, checks: receipt.checks, ...(receipt.error ? { error: receipt.error } : {}) }, null, 2))
if (failure) process.exitCode = 1
