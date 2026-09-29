/** Ephemeral signing material and artifacts used only by offline updater tests. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { UPDATE_ORIGIN } from '../manifest.mjs'

const keys = generateKeyPairSync('ed25519')
export const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' })
export const now = () => Date.parse('2026-09-14T00:00:00Z')
export const target = { role: 'controller', platform: 'darwin', arch: 'arm64', currentVersion: '0.2.1' }
export const body = Buffer.from('verified update archive fixture\n'.repeat(4096))

export function artifact(overrides = {}) {
  return { role: 'controller', platform: 'darwin', arch: 'arm64', fileName: 'qianshou-agent-0.2.2-darwin-arm64.zip',
    url: `${UPDATE_ORIGIN}/downloads/qianshou-agent/0.2.2/qianshou-agent-0.2.2-darwin-arm64.zip`,
    size: body.length, sha256: createHash('sha256').update(body).digest('hex'), notes: ['Voice and collaboration fixes'], ...overrides }
}

export function release(overrides = {}) {
  return { schemaVersion: 1, product: 'qianshou-agent', version: '0.2.2', channel: 'preview',
    releasedAt: '2026-09-13T23:00:00Z', bootstrapVersion: 1, artifacts: [artifact()], ...overrides }
}

export function envelope(value = release()) {
  const payload = Buffer.from(JSON.stringify(value))
  return Buffer.from(JSON.stringify({ schemaVersion: 1, payload: payload.toString('base64'),
    signature: sign(null, payload, keys.privateKey).toString('base64') }))
}

export const dependencies = { publicKeyPem, now }
