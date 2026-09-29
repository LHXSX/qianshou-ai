/** Enter the existing signed Desktop packager with an explicit Qianshou profile. */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scripts = {
  'mac-arm64': 'package:mac:arm64',
  'mac-x64': 'package:mac:x64',
  'win-x64': 'package:win:x64',
}

export function qianshouPackageInvocation(target, options = []) {
  if (!Object.hasOwn(scripts, target)) throw new Error(`Unsupported Qianshou package target: ${String(target)}`)
  if (options.some(option => !['--check', '--dir', '--prepare-only', '--unsigned'].includes(option))) {
    throw new Error('Unsupported Qianshou package option')
  }
  if (options.includes('--unsigned') && !['win-x64', 'mac-arm64'].includes(target)) {
    throw new Error('Unsigned diagnostic packaging supports Windows x64 and macOS arm64 only')
  }
  const unsigned = options.includes('--unsigned')
  return {
    script: unsigned ? target === 'win-x64' ? 'package:win:x64:unsigned' : 'package:mac:arm64:unsigned' : scripts[target],
    options: options.filter(option => option !== '--unsigned'),
  }
}

if (import.meta.main) {
  const target = process.argv[2]
  const { script, options } = qianshouPackageInvocation(target, process.argv.slice(3))
  const env = { ...process.env, DSH_CLIENT_BUILD_PROFILE: 'qianshou', DSH_CLIENT_TITLE: '千手 PC' }
  delete env.DSH_BUILD_CLIENT_PROFILE
  const manager = process.env.npm_execpath ?? resolve(root, 'node_modules/pnpm/bin/pnpm.cjs')
  const child = spawn(process.execPath, [manager, '--filter', '@deepseek-ai/dsh-desktop', 'run', script, ...options], {
    cwd: root, env, stdio: 'inherit',
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal) })
  child.on('error', error => { console.error(error.message); process.exitCode = 1 })
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1) })
}
