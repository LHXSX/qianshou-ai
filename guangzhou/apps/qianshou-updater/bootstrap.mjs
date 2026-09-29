/** Side-by-side activation. Only a not-yet-ready attempt can return to its previous executable. */
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { lstat, open, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions, UpdateError } from './manifest.mjs'
import { readUpdateJson, updateDirectory, verifyStagedUpdate, writeUpdateJson } from './stage.mjs'

const STATE_FILE = 'activation.json'
const READY_TIMEOUT_MS = 120_000
const PARENT_EXIT_TIMEOUT_MS = 120_000
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const failure = (code, message) => { throw new UpdateError(code, message) }
const targetFields = target => ({ role: target.role, platform: target.platform, arch: target.arch })
const targetEqual = (left, right) => left?.role === right?.role && left?.platform === right?.platform && left?.arch === right?.arch

function alive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code !== 'ESRCH' }
}

/** Child apps receive only OS session variables, never inherited provider keys, Node options or helper switches. */
export function updateChildEnvironment(source = process.env) {
  const names = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'HOMEDRIVE', 'HOMEPATH'])
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => names.has(key.toUpperCase()) && typeof value === 'string'))
}

async function stateAt(root) {
  try { return await readUpdateJson(path.join(root, STATE_FILE)) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

async function locked(root, operation) {
  const lockPath = path.join(root, 'activation.lock')
  let lock
  const deadline = Date.now() + 5000
  while (!lock) {
    try {
      lock = await open(lockPath, 'wx', 0o600)
      await lock.writeFile(JSON.stringify({ pid: process.pid }))
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const owner = await readUpdateJson(lockPath)
        if (Number.isSafeInteger(owner.pid) && owner.pid > 0 && !alive(owner.pid)) { await rm(lockPath); continue }
      } catch (readError) { if (readError.code !== 'ENOENT' && !(readError instanceof SyntaxError)) throw readError }
      if (Date.now() >= deadline) failure('UPDATE_BUSY', 'Another update activation is being committed')
      await pause(25)
    }
  }
  try { return await operation() }
  finally { await lock.close(); await rm(lockPath, { force: true }) }
}

function secretMatches(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

async function validateCurrentExecutable(executable, target, version) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable)) failure('INVALID_CURRENT_APP', 'Current application executable must be absolute')
  const actual = await realpath(executable)
  if (!(await lstat(actual)).isFile()) failure('INVALID_CURRENT_APP', 'Current application executable is unavailable')
  let metadata
  if (target.platform === 'darwin' && path.basename(actual) === 'Electron' && path.basename(path.dirname(actual)) === 'MacOS') {
    metadata = path.join(path.dirname(actual), '../Resources/app/package.json')
  } else if (target.platform === 'win32' && path.basename(actual) === (target.role === 'controller' ? 'QianshouAgent.exe' : 'QianshouCompanion.exe')) {
    metadata = path.join(path.dirname(actual), 'resources/app/package.json')
  } else if (target.platform === 'linux' && target.role === 'companion' && path.basename(actual) === 'qianshou-companion') {
    metadata = path.join(path.dirname(actual), 'resources/app/package.json')
  } else failure('INVALID_CURRENT_APP', 'Current executable does not match this application')
  const identity = await readUpdateJson(metadata)
  if (identity.name !== (target.role === 'controller' ? 'qianshou-agent' : 'qianshou-companion') || identity.version !== version) failure('INVALID_CURRENT_APP', 'Current application identity is inconsistent')
  return actual
}

function receiptOnly(receipt) { return { schemaVersion: 1, envelope: receipt.envelope, version: receipt.version } }

/** Verify and record a user-authorized pending attempt before the caller acquires its short maintenance lease. */
export async function prepareActivation(receipt, { updatesDirectory, target, currentVersion, currentExecutable, currentPid = process.pid }, dependencies = {}) {
  const root = await updateDirectory(updatesDirectory)
  if (compareVersions(receipt.version, currentVersion) <= 0) failure('UPDATE_DOWNGRADE', 'Activation requires a newer application version')
  if (!Number.isSafeInteger(currentPid) || currentPid < 1) failure('INVALID_CURRENT_APP', 'Invalid current process')
  const previousExecutable = await validateCurrentExecutable(currentExecutable, target, currentVersion)
  const stage = await verifyStagedUpdate(receipt, { updatesDirectory: root, target: { ...target, currentVersion } }, dependencies)
  return locked(root, async () => {
    const state = await stateAt(root)
    if (state?.phase === 'pending' || state?.phase === 'committed') failure('UPDATE_BUSY', 'An update restart is already pending')
    if (state?.phase === 'active' && compareVersions(state.receipt.version, stage.version) >= 0) failure('UPDATE_DOWNGRADE', 'A newer or equal application is already active')
    const activation = {
      schemaVersion: 1, phase: 'pending', target: targetFields(target), receipt: receiptOnly(stage),
      attemptId: randomUUID(), token: randomBytes(32).toString('hex'), createdAt: Date.now(),
      previous: { version: currentVersion, executable: previousExecutable, pid: currentPid },
      previousActive: state?.phase === 'active' ? { receipt: state.receipt, target: state.target } : state?.previousActive ?? null,
    }
    await writeUpdateJson(path.join(root, STATE_FILE), activation)
    return Object.freeze({ ...activation, updatesDirectory: root })
  })
}

/** Cancel only this unlaunched pending attempt, leaving the running application and all data untouched. */
export async function cancelActivation(activation) {
  const root = await updateDirectory(activation.updatesDirectory, false)
  return locked(root, async () => {
    const state = await stateAt(root)
    if (state?.phase === 'active') return { cancelled: false, reason: 'already-active' }
    if (state?.phase === 'committed') return { cancelled: false, reason: 'data-access-committed' }
    if (state?.phase !== 'pending' || state.attemptId !== activation.attemptId || !secretMatches(state.token, activation.token)) failure('INVALID_ACTIVATION', 'Cancellation does not match the pending attempt')
    if (state.launchStartedAt) return { cancelled: false, reason: 'already-launching' }
    await writeUpdateJson(path.join(root, STATE_FILE), { schemaVersion: 1, phase: 'failed', target: state.target, receipt: state.receipt, attemptId: state.attemptId, previousActive: state.previousActive, failedAt: Date.now(), reason: 'cancelled-before-restart' })
    return { cancelled: true }
  })
}

/** Spawn the helper before normal app.quit(); it cannot start the new app until this process exits. */
export async function launchActivation(activation, { helperExecutable = process.execPath, helperScript = fileURLToPath(new URL('./runner.mjs', import.meta.url)), electronRunAsNode = true } = {}, { spawnImpl = spawn, environment = process.env } = {}) {
  if (!activation || !['pending', 'forward'].includes(activation.phase)) failure('INVALID_ACTIVATION', 'A prepared activation is required')
  const env = updateChildEnvironment(environment)
  if (electronRunAsNode) env.ELECTRON_RUN_AS_NODE = '1'
  // The signed envelope lives in the bounded state file, not the OS-limited environment block.
  env.QIANSHOU_UPDATE_HELPER = JSON.stringify({ schemaVersion: 1, phase: activation.phase, updatesDirectory: activation.updatesDirectory, attemptId: activation.attemptId, token: activation.token, previous: activation.previous, target: activation.target })
  let child
  try {
    child = spawnImpl(helperExecutable, [helperScript], { detached: true, stdio: 'ignore', windowsHide: true, env })
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  }
  catch (error) {
    if (activation.phase === 'pending') await commitFailure(activation.updatesDirectory, activation, 'helper-could-not-start')
    throw error
  }
  child.unref?.()
  return { pid: child.pid }
}

/** Load the signed receipt from local state after checking the short helper capability. */
export async function activationFromHelperInput(input) {
  if (input?.schemaVersion !== 1 || !['pending', 'forward'].includes(input.phase)) failure('INVALID_ACTIVATION', 'Invalid helper input')
  const root = await updateDirectory(input.updatesDirectory, false)
  const state = await stateAt(root)
  if (input.phase === 'pending') {
    if (state?.phase !== 'pending' || state.attemptId !== input.attemptId || !secretMatches(state.token, input.token)) failure('INVALID_ACTIVATION', 'Helper capability is no longer pending')
    return { ...input, receipt: state.receipt }
  }
  const active = ['active', 'committed'].includes(state?.phase) ? state : state?.phase === 'failed' ? state.previousActive : null
  if (!active || !targetEqual(input.target, active.target)) failure('INVALID_ACTIVATION', 'No matching active release')
  return { ...input, receipt: active.receipt }
}

/** Inspect startup state. Forwarding is returned to main so its normal shutdown remains the lifecycle owner. */
export async function bootstrapUpdate({ updatesDirectory, target, currentVersion, currentExecutable, currentPid = process.pid, attemptId = process.env.QIANSHOU_UPDATE_ATTEMPT, token = process.env.QIANSHOU_UPDATE_TOKEN }, dependencies = {}) {
  const root = await updateDirectory(updatesDirectory)
  const state = await stateAt(root)
  if (!state) return { action: 'continue' }
  if (state.schemaVersion !== 1 || !targetEqual(state.target, target)) failure('INVALID_ACTIVATION', 'Update state belongs to another application')
  if (state.phase === 'committed' && state.receipt.version === currentVersion) {
    const stage = await verifyStagedUpdate(state.receipt, { updatesDirectory: root, target: { ...target, currentVersion } }, dependencies)
    if (await realpath(currentExecutable) !== stage.entryPoint) failure('INVALID_ACTIVATION', 'Only the committed application may reopen its data')
    return { action: 'continue', pending: true, dataAccessCommitted: true, attemptId: state.attemptId, token: state.token, updatesDirectory: root }
  }
  if (state.phase === 'pending') {
    if (state.attemptId !== attemptId || !secretMatches(state.token, token)) {
      // An interrupted helper cannot cause an unbounded restart loop. Main may show the pending failure to the user.
      return { action: 'wait', reason: 'An update attempt has not acknowledged readiness', version: state.receipt.version }
    }
    const stage = await verifyStagedUpdate(state.receipt, { updatesDirectory: root, target: { ...target, currentVersion } }, dependencies)
    if (currentVersion !== stage.version || await realpath(currentExecutable) !== stage.entryPoint) failure('INVALID_ACTIVATION', 'Readiness belongs to the exact staged application')
    return { action: 'continue', pending: true, attemptId, token, updatesDirectory: root }
  }
  const active = ['active', 'committed'].includes(state.phase) ? state : state.phase === 'failed' ? state.previousActive : null
  if (!active || compareVersions(active.receipt.version, currentVersion) <= 0) return { action: 'continue', failed: state.phase === 'failed' }
  const executable = await validateCurrentExecutable(currentExecutable, target, currentVersion)
  await verifyStagedUpdate(active.receipt, { updatesDirectory: root, target: { ...target, currentVersion } }, dependencies)
  return { action: 'forward', activation: { schemaVersion: 1, phase: 'forward', target: targetFields(target), receipt: active.receipt, updatesDirectory: root, previous: { executable, version: currentVersion, pid: currentPid } } }
}

/** Commit the irreversible data boundary before opening stores or starting a backend which may write newer formats. */
export async function acknowledgeDataAccess({ updatesDirectory, target, currentVersion, currentExecutable = process.execPath, attemptId, token }, dependencies = {}) {
  const root = await updateDirectory(updatesDirectory, false)
  const initial = await stateAt(root)
  if (!['pending', 'committed'].includes(initial?.phase) || initial.attemptId !== attemptId || !secretMatches(initial.token, token) || !targetEqual(initial.target, target)) failure('INVALID_ACTIVATION', 'Data access does not match this activation')
  const stage = await verifyStagedUpdate(initial.receipt, { updatesDirectory: root, target }, dependencies)
  if (stage.version !== currentVersion || await realpath(currentExecutable) !== stage.entryPoint) failure('INVALID_ACTIVATION', 'Only the staged application can commit data access')
  return locked(root, async () => {
    const state = await stateAt(root)
    if (!['pending', 'committed'].includes(state?.phase) || state.attemptId !== attemptId || !secretMatches(state.token, token)) failure('ACTIVATION_ENDED', 'The update attempt ended before data access')
    if (state.phase === 'pending') await writeUpdateJson(path.join(root, STATE_FILE), { ...state, phase: 'committed', dataOpenedAt: Date.now() })
    return { committed: true, ready: false, version: currentVersion }
  })
}

/** Called once backend plus UI (controller), or the window (companion), is ready and before work is admitted. */
export async function acknowledgeReady({ updatesDirectory, target, currentVersion, currentExecutable = process.execPath, attemptId, token }, dependencies = {}) {
  const root = await updateDirectory(updatesDirectory, false)
  const initial = await stateAt(root)
  if (initial?.phase === 'active' && initial.attemptId === attemptId && initial.receipt.version === currentVersion) return { active: true, version: currentVersion }
  if (!['pending', 'committed'].includes(initial?.phase) || initial.attemptId !== attemptId || !secretMatches(initial.token, token) || !targetEqual(initial.target, target)) failure('INVALID_ACTIVATION', 'Readiness token does not match an activation')
  const stage = await verifyStagedUpdate(initial.receipt, { updatesDirectory: root, target }, dependencies)
  if (stage.version !== currentVersion || await realpath(currentExecutable) !== stage.entryPoint) failure('INVALID_ACTIVATION', 'Only the staged application can acknowledge readiness')
  return locked(root, async () => {
    const state = await stateAt(root)
    if (!['pending', 'committed'].includes(state?.phase) || state.attemptId !== attemptId || !secretMatches(state.token, token)) failure('ACTIVATION_ENDED', 'The update attempt ended before readiness')
    await writeUpdateJson(path.join(root, STATE_FILE), { schemaVersion: 1, phase: 'active', target: state.target, receipt: state.receipt, attemptId, activatedAt: Date.now() })
    return { active: true, version: currentVersion }
  })
}

async function commitFailure(root, activation, reason) {
  return locked(root, async () => {
    const state = await stateAt(root)
    if (state?.phase !== 'pending' || state.attemptId !== activation.attemptId || !secretMatches(state.token, activation.token)) return false
    await writeUpdateJson(path.join(root, STATE_FILE), { schemaVersion: 1, phase: 'failed', target: state.target, receipt: state.receipt, attemptId: state.attemptId, previousActive: state.previousActive, failedAt: Date.now(), reason })
    return true
  })
}

async function spawnObserved(executable, env, spawnImpl) {
  const child = spawnImpl(executable, [], { detached: true, stdio: 'ignore', windowsHide: true, env })
  let exited = false
  const exit = new Promise(resolve => {
    child.once('exit', () => { exited = true; resolve() })
    child.once('error', () => { exited = true; resolve() })
  })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  return { child, exit, get exited() { return exited } }
}

/** Helper runtime with injectable process boundaries. It never kills the old app or rolls back an active version. */
export async function runActivationHelper(activation, { spawnImpl = spawn, isAlive = alive, sleep = pause, now = Date.now, environment = process.env, parentExitTimeoutMs = PARENT_EXIT_TIMEOUT_MS, readyTimeoutMs = READY_TIMEOUT_MS, ...verification } = {}) {
  if (!activation || activation.schemaVersion !== 1 || !['pending', 'forward'].includes(activation.phase)) failure('INVALID_ACTIVATION', 'Invalid helper activation')
  const root = await updateDirectory(activation.updatesDirectory, false)
  const target = activation.target
  const previous = activation.previous
  if (!Number.isSafeInteger(previous?.pid) || previous.pid < 1) failure('INVALID_ACTIVATION', 'Invalid parent process')
  await validateCurrentExecutable(previous.executable, target, previous.version)
  if (activation.phase === 'pending') {
    const state = await stateAt(root)
    if (state?.phase !== 'pending' || state.attemptId !== activation.attemptId || !secretMatches(state.token, activation.token)) failure('INVALID_ACTIVATION', 'Helper attempt does not match pending state')
    if (JSON.stringify(state.previous) !== JSON.stringify(previous) || !targetEqual(state.target, target) || state.receipt.envelope !== activation.receipt.envelope) failure('INVALID_ACTIVATION', 'Helper context differs from the prepared activation')
  } else {
    const state = await stateAt(root)
    const active = ['active', 'committed'].includes(state?.phase) ? state : state?.phase === 'failed' ? state.previousActive : null
    if (!active || !targetEqual(active.target, target) || active.receipt.envelope !== activation.receipt.envelope) failure('INVALID_ACTIVATION', 'Forwarding requires the committed active release')
  }
  let stage
  try { stage = await verifyStagedUpdate(activation.receipt, { updatesDirectory: root, target: { ...target, currentVersion: previous.version } }, { ...verification, now }) }
  catch (error) {
    if (activation.phase === 'forward') throw error
    if (!await commitFailure(root, activation, 'stage-verification-failed')) return { status: 'cancelled' }
    const exitDeadline = now() + parentExitTimeoutMs
    while (isAlive(previous.pid)) {
      if (now() >= exitDeadline) return { status: 'failed', reason: 'stage-verification-failed', rolledBack: false }
      await sleep(100)
    }
    await validateCurrentExecutable(previous.executable, target, previous.version)
    const old = await spawnObserved(previous.executable, updateChildEnvironment(environment), spawnImpl)
    old.child.unref?.()
    return { status: 'failed', reason: 'stage-verification-failed', rolledBack: true }
  }
  const parentDeadline = now() + parentExitTimeoutMs
  while (isAlive(previous.pid)) {
    if (activation.phase === 'pending') {
      const state = await stateAt(root)
      if (state?.phase !== 'pending' || state.attemptId !== activation.attemptId) return { status: 'cancelled' }
    }
    if (now() >= parentDeadline) {
      if (activation.phase === 'pending') await commitFailure(root, activation, 'previous-app-did-not-exit')
      return { status: 'failed', reason: 'previous-app-did-not-exit' }
    }
    await sleep(100)
  }
  if (activation.phase === 'pending') {
    const authorized = await locked(root, async () => {
      const state = await stateAt(root)
      if (state?.phase !== 'pending' || state.attemptId !== activation.attemptId || !secretMatches(state.token, activation.token)) return false
      await writeUpdateJson(path.join(root, STATE_FILE), { ...state, launchStartedAt: now() })
      return true
    })
    if (!authorized) return { status: 'cancelled' }
  }
  const env = updateChildEnvironment(environment)
  if (activation.phase === 'pending') {
    env.QIANSHOU_UPDATE_DIRECTORY = root
    env.QIANSHOU_UPDATE_ATTEMPT = activation.attemptId
    env.QIANSHOU_UPDATE_TOKEN = activation.token
  }
  let spawned
  let reason = 'new-app-exited-before-ready'
  try { spawned = await spawnObserved(stage.entryPoint, env, spawnImpl) }
  catch { reason = 'new-app-could-not-start' }
  if (activation.phase === 'forward') {
    // An active release may have written new data. Failure here cannot justify launching an older app.
    if (!spawned) failure('ACTIVE_APP_UNAVAILABLE', 'The active application could not start; automatic downgrade is disabled')
    spawned.child.unref?.()
    return { status: 'forwarded', version: stage.version }
  }
  const deadline = now() + readyTimeoutMs
  while (spawned && !spawned.exited) {
    const state = await stateAt(root)
    if (state?.phase === 'active' && state.attemptId === activation.attemptId) {
      spawned.child.unref?.()
      return { status: 'active', version: stage.version }
    }
    if (now() >= deadline) { reason = 'new-app-readiness-timeout'; break }
    await sleep(100)
  }
  // Commit under the same lock as acknowledgeReady. If readiness won, no process is stopped and no downgrade occurs.
  if (!await commitFailure(root, activation, reason)) {
    const state = await stateAt(root)
    if (state?.phase === 'active' && state.attemptId === activation.attemptId) return { status: 'active', version: stage.version }
    spawned?.child.unref?.()
    return { status: 'committed-not-ready', version: stage.version, reason, rolledBack: false }
  }
  if (spawned && !spawned.exited) {
    spawned.child.kill('SIGTERM')
    let stopped = false
    await Promise.race([spawned.exit.then(() => { stopped = true }), sleep(10_000)])
    if (!stopped) return { status: 'failed', reason: 'new-app-did-not-stop', rolledBack: false }
  }
  // The prior path came from the running app at prepare time and is identity-checked again; no state-supplied arbitrary entry is accepted.
  await validateCurrentExecutable(previous.executable, target, previous.version)
  const old = await spawnObserved(previous.executable, updateChildEnvironment(environment), spawnImpl)
  old.child.unref?.()
  return { status: 'failed', reason, rolledBack: true }
}
