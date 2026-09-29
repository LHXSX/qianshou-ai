import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { acknowledgeDataAccess, acknowledgeReady, activationFromHelperInput, bootstrapUpdate, cancelActivation, launchActivation, prepareActivation, runActivationHelper, updateChildEnvironment } from '../bootstrap.mjs'
import { stageUpdate } from '../stage.mjs'
import { currentApp, signedDownload, testing, windows, workspace } from './stage-fixtures.mjs'

async function prepared(t) {
  const root = await workspace(t), updatesDirectory = path.join(root, 'updates')
  const currentExecutable = await currentApp(root)
  const receipt = await stageUpdate(await signedDownload(root), { updatesDirectory, target: windows }, testing)
  const options = { updatesDirectory, target: windows, currentVersion: '0.2.1', currentExecutable, currentPid: 43210 }
  return { root, options, receipt, activation: await prepareActivation(receipt, options, testing) }
}

function fakeSpawn(onSpawn) {
  const calls = []
  function spawnImpl(executable, args, options) {
    const child = new EventEmitter()
    child.pid = 50000 + calls.length
    child.unref = () => {}
    child.kills = []
    child.kill = signal => { child.kills.push(signal); queueMicrotask(() => child.emit('exit', null, signal)); return true }
    calls.push({ executable, args, options, child })
    queueMicrotask(() => { child.emit('spawn'); onSpawn?.(child, calls.length) })
    return child
  }
  return { calls, spawnImpl }
}

function readyOptions(fixture) {
  return { updatesDirectory: fixture.options.updatesDirectory, target: windows, currentVersion: '0.2.2', currentExecutable: fixture.receipt.entryPoint, attemptId: fixture.activation.attemptId, token: fixture.activation.token }
}

test('prepare commits only pending; new app must acknowledge exact staged executable before state becomes active', async t => {
  const f = await prepared(t)
  const state = () => readFile(path.join(f.options.updatesDirectory, 'activation.json'), 'utf8').then(JSON.parse)
  assert.equal((await state()).phase, 'pending')
  assert.equal((await bootstrapUpdate(f.options, testing)).action, 'wait')
  await assert.rejects(acknowledgeReady({ ...readyOptions(f), token: 'a'.repeat(64) }, testing), { code: 'INVALID_ACTIVATION' })
  await assert.rejects(acknowledgeReady({ ...readyOptions(f), currentExecutable: f.options.currentExecutable }, testing), { code: 'INVALID_ACTIVATION' })
  const boot = await bootstrapUpdate({ ...f.options, ...readyOptions(f) }, testing)
  assert.equal(boot.pending, true)
  assert.deepEqual(await acknowledgeReady(readyOptions(f), testing), { active: true, version: '0.2.2' })
  assert.equal((await state()).phase, 'active')
  assert.equal('token' in await state(), false)
  assert.equal((await bootstrapUpdate(f.options, testing)).action, 'forward')
  assert.equal((await bootstrapUpdate({ ...f.options, currentVersion: '0.2.2', currentExecutable: f.receipt.entryPoint }, testing)).action, 'continue')
})

test('helper waits for original PID exit then launches exactly one verified app with no inherited secrets or Electron Node mode', async t => {
  const f = await prepared(t), spawned = fakeSpawn()
  let waits = 0, clock = testing.now()
  const result = await runActivationHelper(f.activation, { ...testing, ...spawned,
    isAlive: () => waits < 2, now: () => clock,
    environment: { HOME: f.root, PATH: '/usr/bin', DEEPSEEK_API_KEY: 'private-test', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require bad.js' },
    sleep: async ms => { waits++; clock += ms; if (spawned.calls.length) await acknowledgeReady(readyOptions(f), testing) },
  })
  assert.deepEqual(result, { status: 'active', version: '0.2.2' })
  assert.ok(waits >= 3)
  assert.equal(spawned.calls.length, 1)
  const call = spawned.calls[0]
  assert.equal(call.executable, f.receipt.entryPoint)
  assert.deepEqual(call.args, [])
  assert.equal(call.options.env.QIANSHOU_UPDATE_TOKEN, f.activation.token)
  for (const key of ['DEEPSEEK_API_KEY', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) assert.equal(call.options.env[key], undefined)
  assert.deepEqual(call.child.kills, [])
})

test('early exit rolls back once; failed receipt cannot restart the same update on old startup', async t => {
  const f = await prepared(t), spawned = fakeSpawn((child, number) => { if (number === 1) queueMicrotask(() => child.emit('exit', 1)) })
  const result = await runActivationHelper(f.activation, { ...testing, ...spawned, isAlive: () => false })
  assert.equal(result.rolledBack, true)
  assert.deepEqual(spawned.calls.map(call => call.executable), [f.receipt.entryPoint, f.options.currentExecutable])
  assert.equal(spawned.calls[1].options.env.QIANSHOU_UPDATE_ATTEMPT, undefined)
  assert.deepEqual(await bootstrapUpdate(f.options, testing), { action: 'continue', failed: true })
  await assert.rejects(acknowledgeReady(readyOptions(f), testing), { code: 'INVALID_ACTIVATION' })
})

test('readiness timeout stops only its spawned child, awaits exit, then starts the original', async t => {
  const f = await prepared(t), spawned = fakeSpawn()
  let clock = testing.now()
  const result = await runActivationHelper(f.activation, { ...testing, ...spawned, isAlive: () => false, now: () => clock, readyTimeoutMs: 100,
    sleep: async ms => { clock += ms; await new Promise(resolve => setImmediate(resolve)) },
  })
  assert.equal(result.reason, 'new-app-readiness-timeout')
  assert.equal(result.rolledBack, true)
  assert.deepEqual(spawned.calls[0].child.kills, ['SIGTERM'])
  assert.deepEqual(spawned.calls[1].child.kills, [])
})

test('readiness commit wins a deadline race and permanently prevents rollback', async t => {
  const f = await prepared(t), spawned = fakeSpawn()
  let clock = testing.now()
  const result = await runActivationHelper(f.activation, { ...testing, ...spawned, isAlive: () => false, now: () => clock, readyTimeoutMs: 100,
    sleep: async ms => { clock += ms; await acknowledgeReady(readyOptions(f), testing) },
  })
  assert.equal(result.status, 'active')
  assert.equal(spawned.calls.length, 1)
  assert.deepEqual(spawned.calls[0].child.kills, [])
  // A later failed active process is never replaced by an older app.
  const forward = await bootstrapUpdate(f.options, testing)
  const errors = fakeSpawn(child => queueMicrotask(() => child.emit('exit', 1)))
  assert.equal((await runActivationHelper(forward.activation, { ...testing, ...errors, isAlive: () => false })).status, 'forwarded')
  assert.equal(errors.calls.length, 1)
})

test('opening data commits the new version without claiming UI readiness; a blank app timeout cannot downgrade', async t => {
  const f = await prepared(t), spawned = fakeSpawn()
  let clock = testing.now(), committed = false
  const result = await runActivationHelper(f.activation, { ...testing, ...spawned, isAlive: () => false, now: () => clock, readyTimeoutMs: 100,
    sleep: async ms => {
      clock += ms
      if (!committed) { committed = true; assert.deepEqual(await acknowledgeDataAccess(readyOptions(f), testing), { committed: true, ready: false, version: '0.2.2' }) }
    },
  })
  assert.equal(result.status, 'committed-not-ready')
  assert.equal(result.rolledBack, false)
  assert.equal(spawned.calls.length, 1)
  assert.deepEqual(spawned.calls[0].child.kills, [])
  const state = JSON.parse(await readFile(path.join(f.options.updatesDirectory, 'activation.json'), 'utf8'))
  assert.equal(state.phase, 'committed')
  assert.equal(state.activatedAt, undefined)
  assert.equal((await bootstrapUpdate(f.options, testing)).action, 'forward')
  const boot = await bootstrapUpdate({ ...f.options, currentExecutable: f.receipt.entryPoint, currentVersion: '0.2.2' }, testing)
  assert.equal(boot.dataAccessCommitted, true)
  assert.equal(boot.pending, true)
  assert.deepEqual(await cancelActivation(f.activation), { cancelled: false, reason: 'data-access-committed' })
  await acknowledgeReady({ ...readyOptions(f), token: boot.token, attemptId: boot.attemptId }, testing)
  assert.equal(JSON.parse(await readFile(path.join(f.options.updatesDirectory, 'activation.json'), 'utf8')).phase, 'active')
})

test('a child that exits after data access leaves the committed target for retries and never starts the old version', async t => {
  const f = await prepared(t), spawned = fakeSpawn()
  let didExit = false
  const result = await runActivationHelper(f.activation, { ...testing, ...spawned, isAlive: () => false,
    sleep: async () => {
      if (!didExit) {
        didExit = true
        await acknowledgeDataAccess(readyOptions(f), testing)
        spawned.calls[0].child.emit('exit', 1)
      }
    },
  })
  assert.equal(result.status, 'committed-not-ready')
  assert.equal(spawned.calls.length, 1)
  const forwarding = await bootstrapUpdate(f.options, testing)
  const retry = fakeSpawn()
  assert.equal((await runActivationHelper(forwarding.activation, { ...testing, ...retry, isAlive: () => false })).status, 'forwarded')
  assert.equal(retry.calls[0].executable, f.receipt.entryPoint)
  assert.equal(retry.calls.length, 1)
})

test('original app that refuses to quit is neither killed nor duplicated', async t => {
  const f = await prepared(t), spawned = fakeSpawn()
  let clock = testing.now()
  const result = await runActivationHelper(f.activation, { ...testing, ...spawned, isAlive: () => true, now: () => clock, parentExitTimeoutMs: 100,
    sleep: async ms => { clock += ms },
  })
  assert.equal(result.reason, 'previous-app-did-not-exit')
  assert.equal(spawned.calls.length, 0)
})

test('active forwarding rejects a tampered installed executable before any process starts', async t => {
  const f = await prepared(t)
  await acknowledgeReady(readyOptions(f), testing)
  await writeFile(f.receipt.entryPoint, 'MZ replaced executable')
  await assert.rejects(bootstrapUpdate(f.options, testing), { code: 'UNSAFE_INSTALL' })
})

test('a stage changed after preparation is never executed; a quitting original is recovered without leaving pending', async t => {
  const f = await prepared(t), spawned = fakeSpawn()
  await writeFile(f.receipt.entryPoint, 'modified after prepare')
  const result = await runActivationHelper(f.activation, { ...testing, ...spawned, isAlive: () => false })
  assert.deepEqual(result, { status: 'failed', reason: 'stage-verification-failed', rolledBack: true })
  assert.deepEqual(spawned.calls.map(call => call.executable), [f.options.currentExecutable])
  assert.equal((await bootstrapUpdate(f.options, testing)).failed, true)
})

test('helper launch uses bounded control context and an ephemeral token, and cleans pending when spawn fails', async t => {
  const f = await prepared(t), spawned = fakeSpawn()
  const result = await launchActivation(f.activation, { helperExecutable: '/fixed/Electron', helperScript: '/fixed/runner.mjs', electronRunAsNode: true }, { ...spawned, environment: { HOME: f.root, PRIVATE_KEY: 'test-secret' } })
  assert.equal(result.pid, 50000)
  const env = spawned.calls[0].options.env
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(env.PRIVATE_KEY, undefined)
  const short = JSON.parse(env.QIANSHOU_UPDATE_HELPER)
  assert.equal(short.receipt, undefined)
  assert.equal((await activationFromHelperInput(short)).receipt.envelope, f.receipt.envelope)
  const spawnImpl = () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('cannot spawn'))); return child }
  await assert.rejects(launchActivation(f.activation, {}, { spawnImpl }), /cannot spawn/)
  assert.equal((await bootstrapUpdate(f.options, testing)).failed, true)
})

test('invalid target, downgraded release and concurrent activation never replace pending state', async t => {
  const f = await prepared(t)
  await assert.rejects(prepareActivation(f.receipt, f.options, testing), { code: 'UPDATE_BUSY' })
  await assert.rejects(prepareActivation(f.receipt, { ...f.options, currentVersion: '0.2.2' }, testing), { code: 'UPDATE_DOWNGRADE' })
  await assert.rejects(bootstrapUpdate({ ...f.options, target: { ...windows, role: 'companion' } }, testing), { code: 'INVALID_ACTIVATION' })
})

test('cancelling a prepared lease failure clears pending, stops a waiting helper and cannot cancel an active release', async t => {
  const f = await prepared(t), spawned = fakeSpawn()
  await assert.rejects(cancelActivation({ ...f.activation, token: '0'.repeat(64) }), { code: 'INVALID_ACTIVATION' })
  const result = await runActivationHelper(f.activation, { ...testing, ...spawned, isAlive: () => true,
    sleep: async () => { assert.deepEqual(await cancelActivation(f.activation), { cancelled: true }) },
  })
  assert.equal(result.status, 'cancelled')
  assert.equal(spawned.calls.length, 0)
  assert.equal((await bootstrapUpdate(f.options, testing)).action, 'continue')
  const activation = await prepareActivation(f.receipt, f.options, testing)
  await acknowledgeReady({ ...readyOptions(f), attemptId: activation.attemptId, token: activation.token }, testing)
  assert.deepEqual(await cancelActivation(activation), { cancelled: false, reason: 'already-active' })
})

test('environment cleanup preserves the OS session without arbitrary auth, preload or shell options', () => {
  assert.deepEqual(updateChildEnvironment({ HOME: '/home/test', Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=x', SHELLOPTS: 'xtrace', NODE_OPTIONS: 'bad', AWS_SECRET_ACCESS_KEY: 'private', QIANSHOU_UPDATE_TOKEN: 'old' }), {
    HOME: '/home/test', Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=x',
  })
})
