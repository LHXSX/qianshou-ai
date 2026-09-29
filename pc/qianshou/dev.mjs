/** Build and start an isolated Qianshou profile through the upstream launcher. */
import { spawn } from 'node:child_process'
import { mkdir, copyFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const mode = process.argv[2] ?? 'web'
const home = resolve(process.env.QIANSHOU_DSH_HOME ?? resolve(root, '..',
  mode === 'desktop' ? 'qianshou-pc-desktop-home' : 'qianshou-pc-home'))
const env = { ...process.env, DSH_HOME: home, DSH_CLIENT_BUILD_PROFILE: 'qianshou',
  DSH_CLIENT_TITLE: '千手 PC · 开发版', QIANSHOU_PRESET_ROOT: resolve(root, 'qianshou', 'presets') }
delete env.DSH_BUILD_CLIENT_PROFILE

if (!['build', 'web', 'desktop'].includes(mode)) throw new Error('Expected build, web, or desktop')
if (mode !== 'build') {
  await mkdir(home, { recursive: true, mode: 0o700 })
  for (const name of ['settings.yaml', 'cordis.patch.yml']) {
    // Desktop reads its user overlay from profiles/desktop. Keep the web
    // profile's existing home-level overlay, and never replace either user's file.
    const destination = name === 'cordis.patch.yml' && mode === 'desktop'
      ? resolve(home, 'profiles', 'desktop', name) : resolve(home, name)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    try { await copyFile(resolve(root, 'qianshou', name), destination, constants.COPYFILE_EXCL) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
  }
}

const options = mode === 'build'
  ? ['--import', 'tsx/esm', 'scripts/build.ts']
  : mode === 'web'
    ? ['apps/cli/lib/bin.js', 'web', ...process.argv.slice(3),
      '--port', process.env.QIANSHOU_PC_PORT ?? '3180', '--no-open']
    : [process.env.npm_execpath ?? 'node_modules/pnpm/bin/pnpm.cjs', 'run', 'start:desktop']
const child = spawn(process.execPath, options, { cwd: root, env, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal) })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1) })
