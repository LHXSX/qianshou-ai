/** Invoke the validated Desktop uploader with the Qianshou product identity. */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scripts = {
  'mac-arm64': 'upload:mac:arm64',
  'mac-x64': 'upload:mac:x64',
  'win-x64': 'upload:win:x64',
}

export function qianshouUploadInvocation(target, options = [], environment = process.env) {
  if (!Object.hasOwn(scripts, target)) throw new Error(`Unsupported Qianshou upload target: ${String(target)}`)
  if (options.length !== 0) throw new Error('Qianshou upload does not accept extra options')
  const env = { ...environment, DSH_CLIENT_BUILD_PROFILE: 'qianshou' }
  delete env.DSH_BUILD_CLIENT_PROFILE
  return { script: scripts[target], env }
}

if (import.meta.main) {
  const { script, env } = qianshouUploadInvocation(process.argv[2], process.argv.slice(3))
  const manager = process.env.npm_execpath ?? resolve(root, 'node_modules/pnpm/bin/pnpm.cjs')
  const child = spawn(process.execPath, [manager, '--dir', root, 'run', script], {
    cwd: root, env, stdio: 'inherit',
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal) })
  child.on('error', error => { console.error(error.message); process.exitCode = 1 })
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1) })
}
