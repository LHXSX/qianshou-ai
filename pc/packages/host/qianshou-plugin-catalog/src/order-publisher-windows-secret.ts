/** Windows CurrentUser DPAPI boundary for account-scoped publisher private keys. */
import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { extendWin32ProcessBindings } from '@deepseek-ai/dsh-win32-process'
import { CatalogFailure } from './registry.ts'

const SCHEMA = 'qianshou.order-publisher.dpapi.v1'
const MAX_BYTES = 8192
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

// Fixed code only: neither paths nor secrets are inserted in this command.
// The payload travels over private stdin; failures never print PowerShell details.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.schema -ne '${SCHEMA}') { throw 'invalid' }
  $owner = [long]$request.ownerId
  if ($owner -lt 1 -or $owner -gt 9007199254740991) { throw 'invalid' }
  $data = [Convert]::FromBase64String($request.payload)
  if ($data.Length -lt 1 -or $data.Length -gt ${MAX_BYTES}) { throw 'invalid' }
  $entropy = [Text.Encoding]::UTF8.GetBytes('${SCHEMA}:' + $owner.ToString([Globalization.CultureInfo]::InvariantCulture))
  $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
  if ($request.operation -eq 'protect') {
    $result = [Security.Cryptography.ProtectedData]::Protect($data, $entropy, $scope)
  } elseif ($request.operation -eq 'unprotect') {
    $result = [Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, $scope)
  } else { throw 'invalid' }
  if ($result.Length -lt 1 -or $result.Length -gt ${MAX_BYTES}) { throw 'invalid' }
  [Console]::Out.Write([Convert]::ToBase64String($result))
  [Array]::Clear($data, 0, $data.Length)
  [Array]::Clear($result, 0, $result.Length)
  exit 0
} catch { exit 1 }
`

function unavailable(): CatalogFailure { return new CatalogFailure('order-author-key-unavailable') }

interface DirectoryBindings {
  getSystemDirectory(this: void, buffer: Buffer, size: number): number
  getWindowsDirectory(this: void, buffer: Buffer, size: number): number
}

let directories: DirectoryBindings | undefined

function systemPaths(): { executable: string; root: string } {
  if (directories === undefined) {
    // Kernel32 is the operating system's already-loaded KnownDLL, not an env-selected executable.
    directories = extendWin32ProcessBindings(({ kernel32, bind }) => ({
      getSystemDirectory: bind(kernel32, 'GetSystemDirectoryW', 'uint32', ['void *', 'uint32']),
      getWindowsDirectory: bind(kernel32, 'GetWindowsDirectoryW', 'uint32', ['void *', 'uint32']),
    })) as unknown as DirectoryBindings
  }
  const read = (get: (buffer: Buffer, size: number) => number): string => {
    const buffer = Buffer.alloc(32_768 * 2)
    const length = get(buffer, 32_768)
    if (!Number.isInteger(length) || length < 1 || length >= 32_768
      || buffer.readUInt16LE(length * 2) !== 0) throw unavailable()
    const value = buffer.subarray(0, length * 2).toString('utf16le')
    if (!/^[A-Za-z]:\\[^\0\r\n]+$/u.test(value)
      || win32.normalize(value) !== value) throw unavailable()
    return value
  }
  return { root: read(directories.getWindowsDirectory),
    executable: win32.join(read(directories.getSystemDirectory), 'WindowsPowerShell', 'v1.0', 'powershell.exe') }
}

function binary(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length < 4 || value.length > MAX_BYTES * 2
    || !BASE64.test(value)) throw unavailable()
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length < 1 || bytes.length > MAX_BYTES || bytes.toString('base64') !== value) throw unavailable()
  return bytes
}

/**
 * Decode a bounded encrypted record for its exact account, never a plaintext fallback.
 * @param bytes - Captured private-file bytes, already checked for replacement and links.
 * @param ownerId - Signed-in platform account owning this key.
 * @returns DPAPI ciphertext which still needs successful CurrentUser decryption.
 */
export function decodeWindowsPublisherSecret(bytes: Buffer, ownerId: number): Buffer {
  if (!Number.isSafeInteger(ownerId) || ownerId < 1 || bytes.length > MAX_BYTES * 2) throw unavailable()
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw unavailable() }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw unavailable()
  const row = value as Record<string, unknown>
  if (row.schema !== SCHEMA || row.ownerId !== ownerId
    || Object.keys(row).sort().join(',') !== 'ownerId,payload,schema') throw unavailable()
  return binary(row.payload)
}

/**
 * Store only encrypted bytes with the account-bound private-key format.
 * @param bytes - Ciphertext returned by successful CurrentUser protection.
 * @param ownerId - Signed-in platform account owning this key.
 * @returns A bounded JSON file containing no plaintext private key.
 */
export function encodeWindowsPublisherSecret(bytes: Buffer, ownerId: number): Buffer {
  if (!Number.isSafeInteger(ownerId) || ownerId < 1 || bytes.length < 1 || bytes.length > MAX_BYTES) throw unavailable()
  return Buffer.from(JSON.stringify({ schema: SCHEMA, ownerId, payload: bytes.toString('base64') }), 'utf8')
}

/**
 * Protect or unprotect using the Windows account, with no secret in argv or environment.
 * @param operation - One fixed DPAPI operation; no executable or script is caller-selected.
 * @param bytes - Bounded private key or ciphertext, sent only over stdin.
 * @param ownerId - Platform account also bound through DPAPI additional entropy.
 * @returns Protected bytes or the decrypted key after a successful bounded child exit.
 */
export async function windowsPublisherSecret(operation: 'protect' | 'unprotect',
  bytes: Buffer, ownerId: number): Promise<Buffer> {
  if (process.platform !== 'win32' || !Number.isSafeInteger(ownerId) || ownerId < 1
    || bytes.length < 1 || bytes.length > MAX_BYTES) throw unavailable()
  let paths: { executable: string; root: string }
  try { paths = systemPaths() } catch { throw unavailable() }
  const request = Buffer.from(JSON.stringify({ schema: SCHEMA, operation, ownerId,
    payload: bytes.toString('base64') }), 'utf8')
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const child = execFile(paths.executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(SCRIPT, 'utf16le').toString('base64')], {
        shell: false, windowsHide: true, timeout: 15_000, maxBuffer: MAX_BYTES * 2,
        env: { SystemRoot: paths.root, ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}) },
      }, (error, stdout, stderr) => {
        request.fill(0)
        if (error !== null || stderr.length > 0) { reject(unavailable()); return }
        try { resolve(binary(stdout)) } catch { reject(unavailable()) }
      })
      child.stdin?.on('error', () => { child.kill(); reject(unavailable()) })
      if (child.stdin === null) { child.kill(); reject(unavailable()); return }
      child.stdin.end(request)
    })
  } catch { throw unavailable() }
  finally { request.fill(0) }
}
