/** Owned FRPC process, transient secret file and loopback status channel. */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { join } from 'node:path'
import { frpcConfig } from './config.mjs'
import { startDeviceGateway } from './gateway.mjs'

async function reserveAdminPort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

function waitFor(promise, milliseconds) {
  let timer
  return Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds) })])
    .finally(() => clearTimeout(timer))
}

/** Read only bounded authenticated status, never configuration or mutation endpoints. */
export function readFrpcStatus(port, password) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/status', method: 'GET', timeout: 1500,
      headers: { Authorization: 'Basic ' + Buffer.from('qianshou:' + password).toString('base64') } }, response => {
      if (response.statusCode !== 200) { response.destroy(); reject(new Error('STATUS_UNAVAILABLE')); return }
      const chunks = []; let bytes = 0
      response.on('data', chunk => {
        bytes += chunk.length
        if (bytes > 16384) { response.destroy(new Error('STATUS_TOO_LARGE')); return }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch { reject(new Error('INVALID_STATUS')) }
      })
    })
    const deadline = setTimeout(() => req.destroy(new Error('STATUS_TIMEOUT')), 1500)
    req.once('close', () => clearTimeout(deadline))
    req.on('timeout', () => req.destroy(new Error('STATUS_TIMEOUT')))
    req.on('error', reject)
    req.end()
  })
}

/** Translate FRPC's observed route to a credential-free public state. */
export function connectionStatus(value, enrollment, gatewayPort) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.http)) return 'connecting'
  const route = value.http.find(item => item?.name === 'devices')
  if (!route) return 'connecting'
  if (route.type !== 'http' || route.local_addr !== `127.0.0.1:${gatewayPort}` || route.err) return 'error'
  if (route.status !== 'running') return route.status === 'start error' ? 'error' : 'connecting'
  // The public TLS entry owns the HTTP vhost; FRPC reports its internal route address.
  if (route.remote_addr !== new URL(enrollment.endpoint).hostname + ':17441') return 'error'
  return 'online'
}

/** Start only the fixed FRPC executable and release all owned resources on stop. */
export async function startRelayProcess({ enrollment, resources, backendPort, directory }) {
  const temporary = await mkdtemp(join(directory, 'run-'))
  let gateway, child, cleanupPromise, done
  const cleanup = () => cleanupPromise ??= (async () => {
    try { await gateway?.close() }
    finally { await rm(temporary, { recursive: true, force: true }) }
  })()
  try {
    gateway = await startDeviceGateway(backendPort)
    const adminPort = await reserveAdminPort(), password = randomBytes(32).toString('hex')
    const config = join(temporary, 'frpc.json')
    await writeFile(config, JSON.stringify(frpcConfig(enrollment, {
      ca: resources.ca, gatewayPort: gateway.port, adminPort, adminPassword: password,
    })), { flag: 'wx', mode: 0o600 })
    const env = { HOME: temporary, PATH: process.platform === 'win32' ? '' : '/usr/bin:/bin' }
    if (process.platform === 'win32') env.SystemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    child = spawn(resources.binary, ['-c', config], { cwd: temporary, env, windowsHide: true, stdio: 'ignore' })
    done = new Promise(resolve => { child.once('close', resolve) })
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    void done.then(() => cleanup()).catch(() => { /* Explicit stop reports cleanup failures. */ })
    let stopping
    return {
      async status() {
        if (child.exitCode !== null || child.signalCode !== null) return 'error'
        try { return connectionStatus(await readFrpcStatus(adminPort, password), enrollment, gateway.port) }
        catch { return 'connecting' }
      },
      stop() {
        return stopping ??= (async () => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM')
            if (!await waitFor(done, 1500)) child.kill('SIGKILL')
            if (!await waitFor(done, 2000)) throw new Error('RELAY_STOP_FAILED')
          }
          await cleanup()
        })()
      },
    }
  } catch (error) {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (done) await done
    await cleanup()
    throw error
  }
}
