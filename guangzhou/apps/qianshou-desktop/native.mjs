/** Launch the already installed RustDesk application using a validated peer ID. */
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { validRustDeskId } from './security.mjs'

/** Resolve the actual native executable, with one explicit installation override. */
export async function findRustDesk(configured, platform = process.platform, env = process.env) {
  const candidates = configured ? [configured] : platform === 'darwin'
    ? ['/Applications/RustDesk.app/Contents/MacOS/RustDesk', join(homedir(), 'Applications/RustDesk.app/Contents/MacOS/RustDesk')]
    : platform === 'win32'
      ? [join(env.ProgramFiles ?? 'C:\\Program Files', 'RustDesk', 'rustdesk.exe'), join(env.LOCALAPPDATA ?? homedir(), 'Programs', 'RustDesk', 'rustdesk.exe')]
      : ['/usr/bin/rustdesk', '/usr/local/bin/rustdesk', '/opt/rustdesk/rustdesk']
  for (const path of candidates) {
    try { await access(path, platform === 'win32' ? constants.F_OK : constants.X_OK); return path }
    catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error }
  }
  return null
}

/** Return a truthful native-launch receipt, never a claim that a remote session connected. */
export async function openRustDesk(id, configured = '') {
  if (!validRustDeskId(id)) return { ok: false, error: 'INVALID_ID' }
  let binary
  try { binary = await findRustDesk(configured) }
  catch { return { ok: false, error: 'LAUNCH_FAILED' } }
  if (binary === null) return { ok: false, error: 'NOT_INSTALLED' }
  return new Promise(resolve => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key) && key !== 'ELECTRON_RUN_AS_NODE' && key !== 'NODE_OPTIONS'))
    const child = spawn(binary, ['--connect', id], { detached: true, stdio: 'ignore', windowsHide: false, env })
    child.once('error', () => resolve({ ok: false, error: 'LAUNCH_FAILED' }))
    child.once('spawn', () => { child.unref(); resolve({ ok: true }) })
  })
}
