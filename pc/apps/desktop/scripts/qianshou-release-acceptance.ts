/** Verify an independent target-device release acceptance before Qianshou production upload. */

import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { DesktopPackageTargetName } from './package-target.ts'

export interface QianshouReleaseAcceptanceFiles {
  readonly receipt: string
  readonly evidence: string
  readonly publicKey: string
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('desktop release acceptance: invalid receipt')
  }
  return value as Record<string, unknown>
}

/** Canonical fields signed by the target-device release reviewer. */
export function qianshouReleaseAcceptanceMessage(value: {
  readonly target: DesktopPackageTargetName
  readonly version: string
  readonly updaterSha512: string
  readonly installerSha512: string
  readonly evidenceSha256: string
  readonly verifiedAt: string
}): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: 2,
    product: 'qianshou-pc',
    target: value.target,
    version: value.version,
    updaterSha512: value.updaterSha512,
    installerSha512: value.installerSha512,
    evidenceSha256: value.evidenceSha256,
    verifiedAt: value.verifiedAt,
    checks: {
      trustedSignature: true,
      installedOnTarget: true,
      firstLaunch: true,
      updateEntry: true,
      coreConversation: true,
      trayIcon: true,
      freshHomeAgentStartup: true,
      retainedHomeAgentStartup: true,
      expiredLoginRecovery: true,
    },
  }))
}

/**
 * Bind reviewer-signed target-device evidence to the exact installer selected by the updater feed.
 * @param files Separate acceptance receipt, full target-device evidence, and trusted reviewer public key.
 * @param target Exact release target.
 * @param version Exact installed release version.
 * @param updaterSha512 SHA-512 of the updater payload (ZIP on macOS, EXE on Windows).
 * @param installerSha512 SHA-512 of the user-facing installer (DMG on macOS, EXE on Windows).
 */
export async function verifyQianshouReleaseAcceptance(
  files: QianshouReleaseAcceptanceFiles,
  target: DesktopPackageTargetName,
  version: string,
  updaterSha512: string,
  installerSha512: string,
): Promise<void> {
  const [receiptBytes, evidenceBytes, keyBytes] = await Promise.all([
    readFile(files.receipt), readFile(files.evidence), readFile(files.publicKey),
  ])
  if (receiptBytes.length > 16_384 || evidenceBytes.length === 0 || evidenceBytes.length > 50 * 1024 * 1024) {
    throw new Error('desktop release acceptance: invalid receipt or evidence size')
  }
  let parsed: unknown
  try { parsed = JSON.parse(receiptBytes.toString('utf8')) }
  catch { throw new Error('desktop release acceptance: invalid receipt JSON') }
  const row = object(parsed)
  const checks = object(row.checks)
  if (row.schemaVersion !== 2 || row.product !== 'qianshou-pc' || row.target !== target
    || row.version !== version || row.updaterSha512 !== updaterSha512
    || row.installerSha512 !== installerSha512
    || !/^[a-f0-9]{64}$/u.test(String(row.evidenceSha256))
    || row.evidenceSha256 !== createHash('sha256').update(evidenceBytes).digest('hex')
    || typeof row.verifiedAt !== 'string' || !Number.isFinite(Date.parse(row.verifiedAt))
    || Date.parse(row.verifiedAt) > Date.now() + 5 * 60_000
    || Object.keys(checks).length !== 9
    || Object.values(checks).some(value => value !== true)
    || !['trustedSignature', 'installedOnTarget', 'firstLaunch', 'updateEntry', 'coreConversation', 'trayIcon',
      'freshHomeAgentStartup', 'retainedHomeAgentStartup', 'expiredLoginRecovery']
      .every(name => checks[name] === true)
    || typeof row.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(row.signature)) {
    throw new Error('desktop release acceptance: target, installer, evidence, or checks do not match')
  }
  const message = qianshouReleaseAcceptanceMessage({
    target, version, updaterSha512, installerSha512,
    evidenceSha256: row.evidenceSha256 as string,
    verifiedAt: row.verifiedAt,
  })
  const key = createPublicKey(keyBytes)
  if (key.asymmetricKeyType !== 'ed25519'
    || !verify(null, message, key, Buffer.from(row.signature, 'base64'))) {
    throw new Error('desktop release acceptance: reviewer signature is invalid')
  }
}
