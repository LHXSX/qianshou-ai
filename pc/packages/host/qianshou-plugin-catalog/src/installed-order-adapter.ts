/** Installed adapter inventory for a task-specific publication handler. */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { CatalogFailure } from './registry.ts'

const FILES = ['package.json', 'pnpm-lock.yaml', 'local-adapter.json',
  'src/adapter.mjs', 'src/assemble_gif.py', 'src/encode_frames.swift'] as const
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/u
const HASH = /^[0-9a-f]{64}$/u
const execFileAsync = promisify(execFile)
const PYTHON_CANDIDATES = ['/usr/local/bin/python3', '/opt/homebrew/bin/python3', '/usr/bin/python3'] as const
const PILLOW_VERSION = '12.3.0'
const RUNTIME_DIRECTORY = '.venv'

export interface InstalledOrderAdapter {
  readonly root: string
  readonly digest: string
  readonly version: string
  readonly taskType: 'bar_chart_svg_v1'
  readonly capabilityId: 'video.render'
  readonly pythonPath: string
  readonly swiftPath: string
}

/** Source identity can be read for an owner's publication list without installing a runtime. */
export type InstalledOrderAdapterSource = Omit<InstalledOrderAdapter, 'pythonPath' | 'swiftPath'>

function inside(parent: string, child: string): boolean {
  const offset = relative(parent, child)
  return offset !== '' && offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset)
}

async function executable(paths: readonly string[]): Promise<string> {
  for (const path of paths) {
    try {
      const target = await realpath(path)
      const stat = await lstat(target)
      if (!stat.isFile()) continue
      await access(target, constants.X_OK)
      return target
    } catch { /* Try the next installed runtime. */ }
  }
  throw new CatalogFailure('order-runtime-unavailable')
}

function isolatedEnvironment(): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: tmpdir(), TMPDIR: tmpdir(),
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }
}

async function verifyPillow(path: string, pinnedVersion: boolean): Promise<string> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Python runtime is not a regular file')
  await access(path, constants.X_OK)
  const result = await execFileAsync(path, ['-I', '-c',
    'import PIL; from PIL import Image; assert callable(Image.open) and Image.Dither.NONE is not None; print(PIL.__version__)'],
  { timeout: 5000, maxBuffer: 1024, windowsHide: true, env: isolatedEnvironment() })
  if (pinnedVersion && result.stdout.trim() !== PILLOW_VERSION) throw new Error('Pillow version changed')
  return path
}

/** Install only the fixed registered adapter's binary Pillow release into an isolated venv. */
async function installPillowRuntime(root: string): Promise<string> {
  const runtime = join(root, RUNTIME_DIRECTORY)
  const python = join(runtime, 'bin', 'python3')
  try { await lstat(runtime); throw new CatalogFailure('order-runtime-unavailable') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const staging = await mkdtemp(join(root, '.venv.prepare-'))
    .catch(() => { throw new CatalogFailure('order-runtime-unavailable') })
  let installed = false
  try {
    let created = false
    for (const candidate of PYTHON_CANDIDATES) {
      try {
        const interpreter = await realpath(candidate)
        await access(interpreter, constants.X_OK)
        await execFileAsync(interpreter, ['-I', '-m', 'venv', '--copies', staging],
          { timeout: 30_000, maxBuffer: 4096, windowsHide: true, env: isolatedEnvironment() })
        created = true
        break
      } catch { /* Try the next fixed system Python. */ }
    }
    if (!created) throw new CatalogFailure('order-runtime-unavailable')
    const stagedPython = join(staging, 'bin', 'python3')
    await execFileAsync(stagedPython, ['-I', '-m', 'pip', 'install', '--isolated', '--no-input',
      '--disable-pip-version-check', '--no-cache-dir', '--no-deps', '--only-binary=:all:',
      '--index-url', 'https://pypi.org/simple', '--timeout', '15', '--retries', '1',
      `Pillow==${PILLOW_VERSION}`],
    { timeout: 180_000, maxBuffer: 16_384, windowsHide: true, env: isolatedEnvironment() })
    await verifyPillow(stagedPython, true)
    await rename(staging, runtime)
    installed = true
    return await verifyPillow(python, true)
  } catch {
    // A staged install is never a usable runtime until the final isolated probe passes.
    if (installed) await rm(runtime, { recursive: true, force: true }).catch(() => undefined)
    throw new CatalogFailure('order-runtime-unavailable')
  }
  finally { await rm(staging, { recursive: true, force: true }).catch(() => undefined) }
}

/** The GIF child runs without the user's HOME or PYTHONPATH, so probe that exact isolation. */
async function pillowPython(root: string, prepareRuntime: boolean): Promise<string> {
  const configured = process.env.QIANSHOU_PILLOW_PYTHON
  if (configured !== undefined && (configured === '' || !isAbsolute(configured))) {
    throw new CatalogFailure('order-runtime-unavailable')
  }
  if (configured !== undefined) {
    try { return await verifyPillow(configured, false) }
    catch { throw new CatalogFailure('order-runtime-unavailable') }
  }
  const runtime = join(root, RUNTIME_DIRECTORY)
  try {
    const stat = await lstat(runtime)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CatalogFailure('order-runtime-unavailable')
    return await verifyPillow(join(runtime, 'bin', 'python3'), true)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new CatalogFailure('order-runtime-unavailable')
  }
  if (prepareRuntime) return installPillowRuntime(root)
  const candidates = PYTHON_CANDIDATES
  for (const path of candidates) {
    try {
      const target = await realpath(path)
      return await verifyPillow(target, false)
    } catch { /* Continue only to another fixed, locally installed interpreter. */ }
  }
  throw new CatalogFailure('order-runtime-unavailable')
}

/** A bounded registry: new task contracts add a handler, not a filename guess from SKILL.md. */
export async function installedOrderAdapterSource(skillPath: string): Promise<InstalledOrderAdapterSource> {
  const skillDir = await realpath(dirname(skillPath))
  const root = await realpath(join(skillDir, 'scripts', 'order_adapter'))
  if (!inside(skillDir, root)) throw new CatalogFailure('order-adapter-invalid')
  const hash = createHash('sha256')
  for (const name of FILES) {
    const path = join(root, name)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000) {
      throw new CatalogFailure('order-adapter-invalid')
    }
    const bytes = await readFile(path)
    if (bytes.length !== stat.size) throw new CatalogFailure('order-adapter-invalid')
    hash.update(name).update('\0').update(String(bytes.length)).update('\0').update(bytes)
  }
  const digest = hash.digest('hex')
  if (!HASH.test(digest)) throw new CatalogFailure('order-adapter-invalid')
  const descriptor: unknown = JSON.parse(await readFile(join(root, 'local-adapter.json'), 'utf8'))
  const packageJson: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)
    || packageJson === null || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
    throw new CatalogFailure('order-adapter-invalid')
  }
  const declaration = descriptor as Record<string, unknown>
  const manifest = packageJson as Record<string, unknown>
  if (declaration.schema !== 'qianshou.local-adapter-candidate.v1'
    || declaration.taskType !== 'bar_chart_svg_v1' || declaration.inputKind !== 'inline_json'
    || declaration.outputKind !== 'local_artifact_manifest'
    || typeof manifest.version !== 'string' || !VERSION.test(manifest.version)) {
    throw new CatalogFailure('order-adapter-invalid')
  }
  return { root, digest, version: manifest.version, taskType: 'bar_chart_svg_v1',
    capabilityId: 'video.render' }
}

export async function installedOrderAdapter(skillPath: string,
  options: { prepareRuntime?: boolean } = {}): Promise<InstalledOrderAdapter> {
  const source = await installedOrderAdapterSource(skillPath)
  const pythonPath = await pillowPython(source.root, options.prepareRuntime === true)
  const swiftPath = await executable(['/usr/bin/swift', '/opt/homebrew/bin/swift'])
  return { ...source, pythonPath, swiftPath }
}
