/** Locally approved work executes only after resolving the selected workspace. Commands are not an OS sandbox. */
import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, open, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { MAX_FILE_BYTES, MAX_OUTPUT_CHARS, type RemoteJob, type RemoteWorkspace } from '@deepseek-ai/dsh-host-remote-devices/protocol'

const executeFile = promisify(execFile)
export type JobExecutor = (job: RemoteJob, workspace: RemoteWorkspace, signal: AbortSignal, output: (text: string) => void) => Promise<unknown>

/** Resolve a relative file request and reject traversal or symlinks before filesystem access. */
export async function workspacePath(root: string, requested: string, write = false): Promise<string> {
  if (isAbsolute(requested) || requested.includes('\0')) throw new Error('PATH_OUTSIDE_WORKSPACE')
  const canonicalRoot = await realpath(root)
  const target = resolve(canonicalRoot, requested)
  const child = relative(canonicalRoot, target)
  if (child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) throw new Error('PATH_OUTSIDE_WORKSPACE')
  let cursor = canonicalRoot
  const parts = child.split(sep).filter(Boolean)
  for (let index = 0; index < parts.length; index++) {
    cursor = join(cursor, parts[index]!)
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('SYMLINK_NOT_ALLOWED') }
    catch (error) {
      if (write && index === parts.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
  if (write && target === canonicalRoot) throw new Error('CANNOT_REPLACE_WORKSPACE')
  return target
}

/** Execute a confirmed request. File payloads are capped and command output is bounded. */
export const executeJob: JobExecutor = async (job, workspace, signal, output) => {
  signal.throwIfAborted()
  if (job.kind === 'desktop') return openRustDesk()
  if (job.kind === 'command') return command(job.payload.command!, await realpath(workspace.path), signal, output)
  const path = await workspacePath(workspace.path, job.payload.path!, job.kind === 'write')
  signal.throwIfAborted()
  if (job.kind === 'list') {
    const entries = await readdir(path, { withFileTypes: true })
    return { path: job.payload.path, entries: entries.slice(0, 1000).map(entry => ({ name: entry.name, directory: entry.isDirectory(), symlink: entry.isSymbolicLink() })), truncated: entries.length > 1000 }
  }
  if (job.kind === 'read') {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('FILE_TOO_LARGE_OR_NOT_FILE')
      return { path: job.payload.path, content: await handle.readFile('utf8'), bytes: stat.size }
    } finally { await handle.close() }
  }
  if (job.kind === 'write') {
    const content = job.payload.content!
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('FILE_TOO_LARGE')
    const temporary = join(dirname(path), `.${basename(path)}.qianshou-${randomUUID()}`)
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
      signal.throwIfAborted()
      await rename(temporary, path)
    } catch (error) {
      await unlink(temporary).catch(() => { /* Failed or cancelled writes may not have created the temporary file. */ })
      throw error
    }
    return { path: job.payload.path, bytes: Buffer.byteLength(content), written: true }
  }
  throw new Error('UNSUPPORTED_JOB')
}

function command(text: string, cwd: string, signal: AbortSignal, output: (text: string) => void): Promise<unknown> {
  return new Promise((resolveResult, reject) => {
    const windows = process.platform === 'win32'
    const shell = windows ? 'powershell.exe' : '/bin/sh'
    const args = windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', text] : ['-c', text]
    const child = spawn(shell, args, { cwd, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let combined = ''
    let timedOut = false
    let killed = false
    let force: NodeJS.Timeout | undefined
    const stop = (): void => {
      if (killed || child.pid === undefined) return
      killed = true
      if (windows) { void executeFile('taskkill', ['/PID', String(child.pid), '/T', '/F']).catch(() => { /* The owned process may already have exited; its close event remains authoritative. */ }); return }
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* The owned group may already have exited. */ }
      force = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* Group already exited. */ } }, 1500)
      force.unref()
    }
    const timer = setTimeout(() => { timedOut = true; stop() }, 5 * 60_000)
    signal.addEventListener('abort', stop, { once: true })
    const collect = (chunk: Buffer): void => { combined = (combined + chunk.toString()).slice(-MAX_OUTPUT_CHARS); output(combined) }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    const cleanup = (): void => { clearTimeout(timer); if (!killed) clearTimeout(force); signal.removeEventListener('abort', stop) }
    child.on('error', error => { cleanup(); reject(error) })
    child.on('close', (code, endedSignal) => {
      cleanup()
      if (signal.aborted) reject(new Error('CANCELLED'))
      else if (timedOut) reject(new Error('COMMAND_TIMEOUT'))
      else if (code !== 0) reject(new Error(`COMMAND_EXIT_${String(code)}${endedSignal ? '_' + endedSignal : ''}`))
      else resolveResult({ exitCode: code, output: combined, cwd })
    })
    if (signal.aborted) stop()
  })
}

/** Launch an installed RustDesk; authentication and OS screen permissions remain in that app. */
export async function openRustDesk(): Promise<{ app: 'RustDesk'; id: string | null; started: true }> {
  const candidates = process.platform === 'darwin' ? ['/Applications/RustDesk.app/Contents/MacOS/RustDesk', join(homedir(), 'Applications/RustDesk.app/Contents/MacOS/RustDesk')]
    : process.platform === 'win32' ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'RustDesk', 'RustDesk.exe'), join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'RustDesk', 'RustDesk.exe')]
      : ['/usr/bin/rustdesk', '/usr/local/bin/rustdesk']
  let binary: string | undefined
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); binary = candidate; break }
    catch { /* This known installation candidate is absent. */ }
  }
  if (!binary) throw new Error('RUSTDESK_NOT_INSTALLED')
  let id: string | null = null
  try {
    const result = await executeFile(binary, ['--get-id'], { timeout: 6000, maxBuffer: 4096 })
    const candidate = result.stdout.trim()
    if (/^[a-zA-Z0-9_-]{1,64}$/.test(candidate)) id = candidate
  } catch { /* App launch is still available when this build does not expose an ID through stdout. */ }
  const child = spawn(binary, [], { detached: true, stdio: 'ignore' })
  await new Promise<void>((resolveStarted, reject) => { child.once('spawn', resolveStarted); child.once('error', reject) })
  child.unref()
  return { app: 'RustDesk', id, started: true }
}
