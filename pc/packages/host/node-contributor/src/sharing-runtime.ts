/** Hash-verified resumable packages and authenticated, supervised loopback runtimes. */
import { constants } from 'node:fs'
import { chmod, lstat, open, rename, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { totalmem } from 'node:os'
import type { SharingHardware, SharingInstallFile, SharingManifest } from './sharing-types.ts'
import { SHARING_UUID, sharingCanonical, sharingDigest, sharingFail, sharingObject, sharingRelative } from './sharing-protocol.ts'
import { sharingDirectory, sharingRead, sharingWrite } from './sharing-store.ts'

const exec = promisify(execFile)
/** Read actual GPU/RAM facts through fixed operating-system tools, without assuming qualification.
 * @returns Machine observations; missing GPU tools produce unknown GPU capacity.
 */
export async function sharingHardware(): Promise<SharingHardware> {
  const platform = process.platform
  if (!['darwin', 'win32', 'linux'].includes(platform)) sharingFail('HARDWARE_UNSUPPORTED')
  let gpuName = 'Unknown GPU'; let vramMb = 0; let freeVramMb = 0
  const paths = platform === 'win32' ? ['C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe',
    'C:\\Windows\\System32\\nvidia-smi.exe']
    : ['/usr/bin/nvidia-smi', '/usr/local/bin/nvidia-smi']
  for (const path of paths) {
    try {
      const { stdout } = await exec(path, ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'],
        { timeout: 5000, maxBuffer: 16384, env: minimalEnvironment() })
      const gpus = stdout.trim().split('\n').map(line => line.split(',').map(v => v.trim()))
      const best = gpus.filter(p => p.length === 3 && /^\d+$/u.test(p[1] ?? '') && /^\d+$/u.test(p[2] ?? ''))
        .sort((a, b) => Number(b[1]) - Number(a[1]))[0]
      if (best !== undefined) { gpuName = best[0] ?? 'Unknown GPU'; vramMb = Number(best[1]); freeVramMb = Number(best[2]); break }
    } catch { /* Absent or unusable GPU tools convey no paid device qualification. */ }
  }
  if (platform === 'darwin' && vramMb === 0) {
    try {
      const { stdout } = await exec('/usr/sbin/system_profiler', ['SPDisplaysDataType', '-json'],
        { timeout: 5000, maxBuffer: 65536, env: minimalEnvironment() })
      const info = sharingObject(JSON.parse(stdout) as unknown)
      const rows = info.SPDisplaysDataType
      if (Array.isArray(rows) && rows.length > 0) {
        const gpu = sharingObject(rows[0]); const name = gpu.sppci_model
        if (typeof name === 'string') gpuName = name.slice(0, 256)
        // Unified RAM is an observation, not an invented dedicated NVIDIA VRAM certificate.
      }
    } catch { /* Keep unknown capacity until an approved package supports these measured facts. */ }
  }
  return { platform: platform as SharingHardware['platform'], arch: process.arch, gpuName, vramMb, freeVramMb,
    memoryMb: Math.floor(totalmem() / 1024 ** 2) }
}
function minimalEnvironment(home?: string): NodeJS.ProcessEnv {
  return { PATH: process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin:/bin',
    ...(process.platform === 'win32' ? { SystemRoot: 'C:\\Windows' } : {}),
    ...(home === undefined ? {} : { HOME: home, USERPROFILE: home, TMPDIR: home, TEMP: home, TMP: home }), LANG: 'C.UTF-8' }
}
/** Bounded fixed-origin JSON exchange with redirect refusal and no ambient credentials.
 * @param url - Host-fixed HTTPS or loopback endpoint.
 * @param init - Explicit purpose-bound request and cancellation.
 * @param limit - Maximum complete response bytes.
 * @returns Parsed finite JSON object; upstream bodies never appear in diagnostics.
 */
export async function sharingJSON(url: string, init: RequestInit, limit = 1024 * 1024): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, redirect: 'error' })
  if (!response.ok) { await response.body?.cancel(); sharingFail(response.status === 404 ? 'NOT_FOUND' : 'UPSTREAM_UNAVAILABLE') }
  const bytes = await sharingResponseBytes(response, limit)
  try { return sharingObject(JSON.parse(bytes.toString('utf8')) as unknown) } catch { sharingFail('RESPONSE_INVALID') }
}
/** Read exact bounded bytes and close the response even on refusal.
 * @param response - Explicit media or control-plane response.
 * @param limit - Upper bound on all received bytes.
 * @returns Bytes only within the caller's fixed media boundary.
 */
export async function sharingResponseBytes(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader(); if (reader === undefined) sharingFail('RESPONSE_INVALID')
  const chunks: Uint8Array[] = []; let size = 0
  try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length
    if (size > limit) sharingFail('RESPONSE_TOO_LARGE'); chunks.push(next.value) } }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  return Buffer.concat(chunks)
}
/** Stream-check a local regular file without following symlinks or reading model bytes wholesale.
 * @param path - Private fixed package/output path.
 * @param size - Exact approved size, or a bounded result size.
 * @returns Lowercase file SHA-256 after ordinary-file checks.
 */
export async function sharingFileHash(path: string, size: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== size || process.getuid && stat.uid !== process.getuid(
    )) sharingFail('FILE_INVALID')
    const hash = createHash('sha256'); const buffer = Buffer.alloc(1024 * 1024); let position = 0
    while (position < size) { const next = await file.read(buffer, 0, Math.min(buffer.length, size - position), position)
      if (next.bytesRead === 0) sharingFail('FILE_INVALID'); hash.update(buffer.subarray(0, next.bytesRead)); position += next.bytesRead }
    return hash.digest('hex')
  } finally { await file.close() }
}
/** Download one flat approved file using immutable ETag/Range and a final full SHA-256.
 * @param root - Private bundle directory.
 * @param file - Independently signed file declaration.
 * @param signal - Owner/lifecycle cancellation preserves the original partial file.
 * @param progress - Actual persisted bytes, never simulated percentage.
 * @returns Nothing until the exact bytes are durably installed.
 */
export async function sharingDownload(root: string, file: SharingInstallFile, signal: AbortSignal,
  progress: (bytes: number) => void): Promise<void> {
  sharingRelative(file.path)
  const path = join(root, file.path); await sharingDirectory(dirname(path))
  const existing = await lstat(path).catch((e: unknown) => { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e })
  if (existing !== null) {
    if (await sharingFileHash(path, file.size_bytes) !== file.sha256) sharingFail('HASH_INVALID')
    progress(file.size_bytes); return
  }
  const part = path + '.part'; let handle
  try { handle = await open(part, constants.O_RDWR | constants.O_NOFOLLOW) }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; handle = await open(part, 'wx+', 0o600) }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > file.size_bytes || process.getuid && (stat.uid !== process.getuid(
    ) || (stat.mode & 0o077) !== 0)) sharingFail('FILE_INVALID')
    let position = stat.size; progress(position)
    if (position < file.size_bytes) {
      const response = await fetch(file.url, { redirect: 'error', signal,
        headers: position === 0 ? { 'Accept-Encoding': 'identity' } : { 'Accept-Encoding': 'identity',
          Range: 'bytes=' + String(position) + '-', 'If-Range': file.etag } })
      if (response.status !== (position === 0 ? 200 : 206) || response.headers.get('etag') !== file.etag
        || response.headers.get('content-encoding') !== null && response.headers.get('content-encoding') !== 'identity'
        || Number(response.headers.get('content-length')) !== file.size_bytes - position
        || position > 0 && response.headers.get('content-range') !== `bytes ${position}-${file.size_bytes - 1}/${file.size_bytes}`) {
        await response.body?.cancel(); sharingFail('DOWNLOAD_FAILED')
      }
      const reader = response.body?.getReader(); if (reader === undefined) sharingFail('DOWNLOAD_FAILED')
      try { while (true) { const next = await reader.read(); if (next.done) break
        if (position + next.value.length > file.size_bytes) sharingFail('DOWNLOAD_FAILED')
        let written = 0
        while (written < next.value.length) { const r = await handle.write(next.value, written, next.value.length - written,
          position + written)
        if (r.bytesWritten === 0) sharingFail('DOWNLOAD_FAILED'); written += r.bytesWritten }
        position += written; await handle.sync(); progress(position)
      } } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
      if (position !== file.size_bytes) sharingFail('DOWNLOAD_FAILED')
    }
    await handle.sync()
  } finally { await handle.close() }
  if (await sharingFileHash(part, file.size_bytes) !== file.sha256) sharingFail('HASH_INVALID')
  await chmod(part, file.executable ? 0o700 : 0o600); await rename(part, path)
  if (process.platform !== 'win32') { const dir = await open(dirname(path), constants.O_RDONLY); try { await dir.sync(
  ) } finally { await dir.close() } }
}
interface RuntimeRecord { schema: 'qianshou.media-runtime-process.v1'; bundleId: string; instanceId: string; origin: string; pid: number }
/** Actual loopback process supervisor; restored jobs are queried by their immutable attempt ID. */
export class SharingRuntime {
  private child: ChildProcess | undefined
  private exited: Promise<void> | undefined
  private record: RuntimeRecord | undefined
  private token: string | undefined
  private closed = false
  private readOnly = false
  constructor(readonly root: string, readonly manifest: SharingManifest) {}
  /** Verify an existing approved bundle without redownloading or adopting an unrelated service.
   * @param signal - Owner/lifecycle cancellation.
   * @returns True only when every immutable file has its exact approved size and hash.
   */
  async installed(signal: AbortSignal): Promise<boolean> {
    for (const file of this.manifest.files) {
      if (signal.aborted) sharingFail('RUNTIME_UNAVAILABLE')
      const path = join(this.root, file.path)
      const exists = await lstat(path).catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw e
      })
      if (exists === null) return false
      if (await sharingFileHash(path, file.size_bytes) !== file.sha256) sharingFail('HASH_INVALID')
    }
    return true
  }
  /** Download and verify approved files before launching any executable.
   * @param signal - Owner/lifecycle cancellation.
   * @param progress - Observed total package bytes.
   * @returns Completion when every file is installed and verified.
   */
  async install(signal: AbortSignal, progress: (bytes: number, total: number) => void): Promise<void> {
    await sharingDirectory(this.root)
    if (await this.installed(signal)) { progress(0, 0); return }
    const disk = await statfs(this.root); if (disk.bavail * disk.bsize < this.manifest.storage_bytes) sharingFail('DISK_SPACE')
    const total = this.manifest.files.reduce((sum, f) => sum + f.size_bytes, 0); let complete = 0
    for (const file of this.manifest.files) {
      await sharingDownload(this.root, file, signal, (bytes) =>{  progress(complete + bytes, total) }); complete += file.size_bytes
    }
  }
  private async health(record: RuntimeRecord, signal: AbortSignal): Promise<boolean> {
    try {
      if (this.token === undefined) return false
      const value = await sharingJSON(record.origin + '/health', { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
        headers: { Authorization: 'Bearer ' + this.token } }, 16384)
      return value.schema === this.manifest.abi && value.instance_id === record.instanceId && value.bundle_id === this.manifest.bundle_id
        && value.executor_sha256 === this.manifest.executor_sha256 && sharingDigest(value.profiles) === sharingDigest(
        this.manifest.profiles)
    } catch { return false }
  }
  /** Original recovery adoption never downloads, spawns, shuts down or obtains a POST right.
   * @param signal - Current original-owner lifecycle cancellation.
   * @returns True only for unchanged installed files and the exact authenticated existing process.
   */
  async adoptOriginal(signal: AbortSignal): Promise<boolean> {
    if (this.closed) return false
    try {
      if (!await this.installed(signal)) return false
      const saved = sharingObject(JSON.parse((await sharingRead(join(this.root, 'process.json'), 4096)).toString()) as unknown)
      if (Object.keys(saved).sort().join(',') !== 'bundleId,instanceId,origin,pid,schema'
        || saved.schema !== 'qianshou.media-runtime-process.v1' || saved.bundleId !== this.manifest.bundle_id
        || typeof saved.origin !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(saved.origin)
        || typeof saved.instanceId !== 'string' || !SHARING_UUID.test(saved.instanceId)
        || typeof saved.pid !== 'number' || !Number.isSafeInteger(saved.pid) || saved.pid < 1) return false
      this.token = (await sharingRead(join(this.root, 'runtime-token'), 256)).toString()
      if (!/^[0-9a-f]{64}$/u.test(this.token)) { this.token = undefined; return false }
      const record = saved as unknown as RuntimeRecord
      if (!await this.health(record, signal)) { this.token = undefined; return false }
      this.record = record; this.readOnly = true; return true
    } catch { this.token = undefined; return false }
  }
  /** A recovery-only instance can never supply new intake or execute a runtime POST. */
  get recoveryOnly(): boolean { return this.readOnly }
  /** Adopt only the private authenticated original instance, or spawn the approved executable.
   * @param signal - Owner/lifecycle cancellation.
   * @returns Completion after random instance and approved executable health match.
   */
  async start(signal: AbortSignal): Promise<void> {
    if (this.closed || this.readOnly) sharingFail('RUNTIME_UNAVAILABLE')
    for (const file of this.manifest.files) if (await sharingFileHash(join(this.root, file.path),
      file.size_bytes) !== file.sha256) sharingFail('HASH_INVALID')
    const recordPath = join(this.root, 'process.json'); const tokenPath = join(this.root, 'runtime-token')
    const prior = await lstat(recordPath).catch((e: unknown) => { if ((
      e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e })
    if (prior !== null) {
      const saved = sharingObject(JSON.parse((await sharingRead(recordPath, 4096)).toString()) as unknown)
      if (saved.schema !== 'qianshou.media-runtime-process.v1' || saved.bundleId !== this.manifest.bundle_id
        || typeof saved.origin !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(saved.origin)
        || typeof saved.instanceId !== 'string' || typeof saved.pid !== 'number' || !Number.isSafeInteger(
        saved.pid)) sharingFail('RUNTIME_UNAVAILABLE')
      this.token = (await sharingRead(tokenPath, 256)).toString(); const record = saved as unknown as RuntimeRecord
      if (await this.health(record, signal)) { this.record = record; return }
      try { process.kill(record.pid, 0); sharingFail('RUNTIME_UNAVAILABLE') }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') sharingFail('RUNTIME_UNAVAILABLE') }
      // Only proven process absence permits starting the same package, never submitting old jobs again.
    }
    this.token = randomBytes(32).toString('hex'); await sharingWrite(tokenPath, Buffer.from(this.token))
    const server = createServer(); await new Promise<void>((resolve, reject) => { server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve) })
    const address = server.address(); if (address === null || typeof address === 'string') sharingFail('RUNTIME_UNAVAILABLE')
    const port = address.port; await new Promise<void>((resolve, reject) => server.close((e) =>{  if (e) reject(e); else resolve() }))
    const instanceId = randomUUID()
    const args = this.manifest.args.map(a => a.replaceAll('{PORT}', String(port)).replaceAll('{ROOT}', this.root)
      .replaceAll('{INSTANCE_ID}', instanceId).replaceAll('{AUTH_TOKEN_FILE}', tokenPath))
    const child = spawn(join(this.root, this.manifest.entrypoint), args, { cwd: this.root, shell: false, windowsHide: true,
      env: { ...minimalEnvironment(this.root), QIANSHOU_MEDIA_BUNDLE_ID: this.manifest.bundle_id,
        QIANSHOU_MEDIA_EXECUTOR_SHA256: this.manifest.executor_sha256, QIANSHOU_MEDIA_PROFILES: sharingCanonical(
          this.manifest.profiles).toString() }, stdio: ['ignore', 'ignore', 'ignore'] })
    this.child = child; this.exited = new Promise((resolve) => { child.once('error', () =>{  resolve() }); child.once(
      'exit', () =>{  resolve() }) })
    if (child.pid === undefined) { await this.exited; sharingFail('RUNTIME_UNAVAILABLE') }
    this.record = { schema: 'qianshou.media-runtime-process.v1', bundleId: this.manifest.bundle_id, instanceId,
      origin: 'http://127.0.0.1:' + String(port), pid: child.pid }
    await sharingWrite(recordPath, sharingCanonical(this.record))
    for (let i = 0; i < 100; i++) {
      if (signal.aborted || child.exitCode !== null || child.signalCode !== null) { await this.close(); sharingFail('RUNTIME_UNAVAILABLE') }
      if (await this.health(this.record, signal)) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    await this.close(); sharingFail('RUNTIME_UNAVAILABLE')
  }
  /** Query/submit only the fixed approved runtime ABI with its private bearer.
   * @param method - First submit or original-job recovery.
   * @param path - Only media jobs namespace is allowed.
   * @param body - Signed lease projection and fixed local asset/output paths.
   * @param signal - Lifecycle cancellation.
   * @returns Bounded job state, never a fabricated external job.
   */
  async request(method: 'GET' | 'POST', path: string, body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (this.readOnly && method !== 'GET') sharingFail('RECOVERY_READ_ONLY')
    if (this.record === undefined || this.token === undefined || !/^\/v1\/media\/jobs(?:\/[0-9a-f-]{36})?$/u.test(path)
      || !await this.health(this.record, signal)) sharingFail('RUNTIME_UNAVAILABLE')
    return sharingJSON(this.record.origin + path, { method, signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: sharingCanonical(body).toString() } : {}) }, 65536)
  }
  /** Check the authenticated original process for heartbeat and reconnect supervision.
   * @param signal - Owner/lifecycle cancellation.
   * @returns True only for the exact private instance.
   */
  async healthy(signal: AbortSignal): Promise<boolean> { return this.record !== undefined && await this.health(this.record, signal) }
  /** Drain a child or authenticated restored instance; never kill a PID taken from disk.
   * @returns Completion after actual exit, or a finite refusal for an unconfirmed adopted shutdown.
   */
  async close(): Promise<void> {
    this.closed = true
    if (this.readOnly) { this.record = undefined; this.token = undefined; return }
    if (this.child !== undefined) {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill('SIGTERM'); const timer = setTimeout(() => this.child?.kill('SIGKILL'), 5000)
        try { await this.exited } finally { clearTimeout(timer) }
      } else await this.exited
    } else if (this.record !== undefined && this.token !== undefined) {
      try { await sharingJSON(this.record.origin + '/shutdown', { method: 'POST', signal: AbortSignal.timeout(2000),
        headers: { Authorization: 'Bearer ' + this.token } }, 1024) } catch { /* Verify absence independently. */ }
      for (let i = 0; i < 50; i++) { try { process.kill(this.record.pid, 0) } catch (e) { if ((
        e as NodeJS.ErrnoException).code === 'ESRCH') return }
      await new Promise(resolve => setTimeout(resolve, 100)) }
      sharingFail('RUNTIME_UNAVAILABLE')
    }
  }
}
