/** Fixed-purpose FRP configuration; no renderer-controlled forwarding target. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const RELAY_ENDPOINT = 'https://203.0.113.20:24443'
const sha = /^[a-f0-9]{64}$/u

/** Validate an independently provisioned registration without exposing its secret. */
export function parseEnrollment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'controllerId,endpoint,token,version'
    || value.version !== 1 || value.endpoint !== RELAY_ENDPOINT
    || typeof value.controllerId !== 'string' || !/^qs-[a-f0-9]{24}$/u.test(value.controllerId)
    || typeof value.token !== 'string' || !/^[a-f0-9]{64,128}$/u.test(value.token)) throw new Error('INVALID_ENROLLMENT')
  return { version: 1, endpoint: value.endpoint, controllerId: value.controllerId, token: value.token }
}

/** Read bounded JSON selected in the native file dialog. */
export async function readEnrollment(filename) {
  const file = await open(filename, 'r')
  try {
    if (!(await file.stat()).isFile()) throw new Error('INVALID_ENROLLMENT')
    const bytes = Buffer.alloc(8193)
    const result = await file.read(bytes, 0, bytes.length, 0)
    if (result.bytesRead > 8192) throw new Error('INVALID_ENROLLMENT')
    return parseEnrollment(JSON.parse(bytes.subarray(0, result.bytesRead).toString('utf8')))
  } finally { await file.close() }
}

async function digest(filename) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

/** Require exact-target immutable resources and verified bytes before launching FRPC. */
export async function verifyResources(directory, platform = process.platform, arch = process.arch) {
  try {
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    const filename = platform === 'win32' ? 'frpc.exe' : 'frpc'
    if (manifest.version !== 1 || manifest.frpcVersion !== '0.71.0'
      || manifest.platform !== platform || manifest.arch !== arch
      || manifest.binary?.file !== filename || !sha.test(manifest.binary?.sha256 ?? '')
      || manifest.ca?.file !== 'isrg-roots.pem' || !sha.test(manifest.ca?.sha256 ?? '')) throw new Error('INVALID_RELAY_RESOURCES')
    const binary = join(directory, filename), ca = join(directory, 'isrg-roots.pem')
    if (await digest(binary) !== manifest.binary.sha256 || await digest(ca) !== manifest.ca.sha256) throw new Error('INVALID_RELAY_RESOURCES')
    return { binary, ca }
  } catch { throw new Error('INVALID_RELAY_RESOURCES') }
}

/** One authenticated device WebSocket route, plus a private loopback status listener. */
export function frpcConfig(enrollment, { ca, gatewayPort, adminPort, adminPassword }) {
  const endpoint = new URL(enrollment.endpoint)
  return {
    user: enrollment.controllerId, serverAddr: endpoint.hostname, serverPort: Number(endpoint.port),
    loginFailExit: false,
    auth: { method: 'token', token: enrollment.token, additionalScopes: ['HeartBeats', 'NewWorkConns'] },
    transport: { protocol: 'wss', poolCount: 0, tls: { enable: true, serverName: endpoint.hostname, trustedCaFile: ca } },
    webServer: { addr: '127.0.0.1', port: adminPort, user: 'qianshou', password: adminPassword },
    log: { to: 'console', level: 'error', disablePrintColor: true },
    proxies: [{ name: 'devices', type: 'http', localIP: '127.0.0.1', localPort: gatewayPort,
      customDomains: [endpoint.hostname], locations: ['/qianshou-device'] }],
  }
}
