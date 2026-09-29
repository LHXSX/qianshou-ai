/** Own one web-profile child. Readiness and shutdown never attach to or kill another server. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, writeSync, closeSync, chmodSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { backendEnvironment, localOrigin } from './config.mjs'
import { authenticatedUrl, redactLog } from './security.mjs'
import { optionalVoiceEnvironment } from './voice-config.mjs'

/** Probe without connecting to an existing listener; an occupied port is never taken over. */
export function ensurePortFree(host, port) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', () => reject(new Error('PORT_IN_USE')))
    server.listen({ host, port, exclusive: true }, () => { server.close(error => error ? reject(error) : resolve()) })
  })
}

/** Start the compiled CLI. Returned stop resolves only after its child has exited. */
export async function startBackend(config, onUnexpectedExit = () => {}, internals = {}) {
  const platform = internals.platform ?? process.platform
  const spawnProcess = internals.spawn ?? spawn
  const cli = config.cliPath ?? join(config.sourcePath, 'apps', 'cli', 'lib', 'bin.js')
  if (!existsSync(cli)) throw new Error('RUNTIME_MISSING')
  const environment = { ...(config.packaged ? optionalVoiceEnvironment(config.workingDirectory) : {}), ...backendEnvironment(config, process.env, platform) }
  await ensurePortFree(config.host, config.port)
  const logDir = join(config.home, 'desktop-logs')
  mkdirSync(logDir, { recursive: true, mode: 0o700 }); chmodSync(logDir, 0o700)
  const logPath = join(logDir, `desktop-${Date.now()}-${randomUUID()}.log`)
  const fd = openSync(logPath, 'wx', 0o600)
  let closedLog = false
  const log = line => { if (!closedLog) writeSync(fd, `${redactLog(line)}\n`) }
  const closeLog = () => { if (!closedLog) { closedLog = true; closeSync(fd) } }
  // Node 24 requires this flag for the live profile's Cordis HMR module loader.
  const child = spawnProcess(config.nodePath, [...(config.packaged ? ['--expose-internals'] : []), cli, 'web', '--host', config.host, '--port', String(config.port), '--no-open'], {
    cwd: config.workingDirectory ?? config.sourcePath,
    env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    detached: platform !== 'win32', windowsHide: true,
  })
  let stopped = false
  let exited = false
  let ready = false
  let stopPromise
  let timer
  let resolveReady
  let rejectReady
  const url = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  // The caller awaits readiness immediately, while stop may reject it first.
  void url.catch(() => {})
  const done = new Promise(resolve => {
    child.once('error', error => {
      log(`spawn error: ${error.code ?? 'UNKNOWN'}`)
      rejectReady(new Error('START_FAILED'))
    })
    child.once('close', (code, signal) => {
      exited = true; clearTimeout(timer)
      log(`backend exit: ${code ?? signal ?? 'unknown'}`)
      if (!(stopped && platform === 'win32')) closeLog()
      resolve()
      if (!ready) rejectReady(new Error(stopped ? 'START_CANCELLED' : 'START_FAILED'))
      else if (!stopped) onUnexpectedExit()
    })
  })
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = ''
    stream.setEncoding('utf8')
    stream.on('data', chunk => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/u, ''); buffer = buffer.slice(newline + 1)
        log(line)
        const value = authenticatedUrl(line, localOrigin(config))
        if (value !== null && !stopped && !ready) { ready = true; clearTimeout(timer); resolveReady(value) }
      }
      if (buffer.length > 1024 * 1024) { log(buffer.slice(0, 4096)); buffer = '' }
    })
    stream.on('end', () => { if (buffer) log(buffer) })
  }
  const signal = force => {
    if (child.pid === undefined) return
    try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM') }
    catch (error) { if (error.code !== 'ESRCH') log(`shutdown signal: ${error.code ?? 'UNKNOWN'}`) }
  }
  const stopWindowsTree = async () => {
    if (child.pid === undefined || exited) { await done; return }
    // Await taskkill itself: the backend leader can close before /T has finished
    // terminating its descendants. /F avoids console applications ignoring WM_CLOSE.
    const confirmed = await new Promise(resolve => {
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
      let killer
      let expiry
      const finish = value => { clearTimeout(expiry); resolve(value) }
      try {
        killer = spawnProcess(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } catch { finish(false); return }
      expiry = setTimeout(() => { killer.kill(); finish(false) }, 10000)
      killer.once('error', () => finish(false))
      killer.once('close', code => finish(code === 0))
    })
    if (!confirmed && !exited) child.kill('SIGKILL')
    let expiry
    try {
      await Promise.race([done, new Promise((_, reject) => {
        expiry = setTimeout(() => reject(new Error('WINDOWS_TREE_STOP_TIMEOUT')), 10000)
      })])
      if (!confirmed) throw new Error('WINDOWS_TREE_STOP_UNCONFIRMED')
    } finally { clearTimeout(expiry) }
  }
  const stop = () => {
    if (stopPromise) return stopPromise
    stopped = true; clearTimeout(timer); rejectReady(new Error('START_CANCELLED'))
    stopPromise = (async () => {
      if (platform === 'win32') {
        try { await stopWindowsTree() }
        catch (error) { log(`shutdown failed: ${error.message}`); throw error }
        finally { closeLog() }
        return
      }
      signal(false)
      const force = setTimeout(() => signal(true), 5000)
      await done
      if (child.pid !== undefined) {
        // The leader may finish before an owned tool subprocess. Wait on its
        // process group before returning, then remove remaining owned children.
        const groupAlive = () => {
          try { process.kill(-child.pid, 0); return true }
          catch (error) { if (error.code === 'ESRCH') return false; throw error }
        }
        const until = Date.now() + 5200
        while (groupAlive() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50))
        if (groupAlive()) signal(true)
      }
      clearTimeout(force); closeLog()
    })()
    return stopPromise
  }
  timer = setTimeout(() => {
    rejectReady(new Error('START_TIMEOUT'))
    void stop().catch(error => { log(`shutdown failed: ${error.message}`) })
  }, config.startupTimeoutMs)
  return { url, stop, done, logPath, pid: child.pid }
}
