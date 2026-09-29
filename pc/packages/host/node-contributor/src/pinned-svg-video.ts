/** Fixed, digest-pinned launcher for the installed bar-chart adapter; never runs SKILL.md text. */
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { constants, createReadStream } from 'node:fs'
import { access, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { ComputeError } from '@deepseek-ai/dsh-compute-core'
import type { ArtifactOrderAdapter } from './artifact-order.ts'

const FILES = ['package.json', 'pnpm-lock.yaml', 'local-adapter.json',
  'src/adapter.mjs', 'src/assemble_gif.py', 'src/encode_frames.swift'] as const
const HASH = /^[0-9a-f]{64}$/u
export const SVG_VIDEO_PACKAGE_ALGORITHM = 'qianshou.bar-chart-package.v4' as const
const execFileAsync = promisify(execFile)
const PNPM_SHIMS = new Set([
  'node_modules/.pnpm/node_modules/.bin/semver',
  'node_modules/.pnpm/sharp@0.35.3/node_modules/sharp/node_modules/.bin/semver',
])

export interface PinnedSvgVideoOptions {
  /** Installed `scripts/order_adapter` directory. */
  readonly root: string
  /** Owner-selected digest of the complete declared adapter source set. */
  readonly expectedDigest: string
  /** Digest of source files plus the entire installed Node dependency tree. */
  readonly expectedPackageDigest: string
  readonly nodePath: string
  readonly pythonPath: string
  readonly swiftPath: string
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel.length > 0 && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`
  }
  throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_INVALID')
}

function normalizedPnpmMetadata(bytes: Buffer, key: string, root: string): Buffer {
  let raw: string
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_INVALID') }
  if (PNPM_SHIMS.has(key)) {
    if (!raw.startsWith('#!/bin/sh\n') || !raw.includes(root)) {
      throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_INVALID')
    }
    return Buffer.from(raw.replaceAll(root, '@PACKAGE_ROOT@'), 'utf8')
  }
  let value: unknown
  try { value = JSON.parse(raw) }
  catch { throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_INVALID') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_INVALID')
  }
  const metadata = value as Record<string, unknown>
  if (key === 'node_modules/.modules.yaml') {
    if (typeof metadata.prunedAt !== 'string' || typeof metadata.storeDir !== 'string'
      || !isAbsolute(metadata.storeDir)) {
      throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_INVALID')
    }
    delete metadata.prunedAt
    delete metadata.storeDir
  } else if (key === 'node_modules/.pnpm-workspace-state-v1.json') {
    if (!Number.isSafeInteger(metadata.lastValidatedTimestamp)) {
      throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_INVALID')
    }
    delete metadata.lastValidatedTimestamp
  } else throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_INVALID')
  return Buffer.from(canonicalJson(metadata), 'utf8')
}

/** Hash the only code files this launcher can execute, with their relative names and byte lengths. */
export async function installedSvgVideoDigest(root: string): Promise<string> {
  const resolved = await realpath(root)
  const hash = createHash('sha256')
  for (const name of FILES) {
    const path = join(resolved, name)
    const st = await lstat(path)
    if (!st.isFile() || st.isSymbolicLink() || st.size > 2_000_000) {
      throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_FILE_INVALID')
    }
    const bytes = await readFile(path)
    hash.update(name).update('\0').update(String(bytes.length)).update('\0').update(bytes)
  }
  return hash.digest('hex')
}

/** Hash source, installed Sharp/libvips, and the selected Pillow runtime. */
export async function installedSvgVideoPackageDigest(root: string, pythonPath: string,
  swiftPath: string): Promise<string> {
  const resolved = await realpath(root)
  const dependencies = join(resolved, 'node_modules')
  if (!(await lstat(dependencies)).isDirectory()) throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_INVALID')
  const hash = createHash('sha256').update(`${SVG_VIDEO_PACKAGE_ALGORITHM}\0`)
    .update(await installedSvgVideoDigest(resolved)).update('\0')
  let entries = 0
  let totalBytes = 0
  const hashFile = async (path: string, key: string, limit: number): Promise<void> => {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit
      || (totalBytes += stat.size) > 384 * 1024 * 1024) {
      throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_INVALID')
    }
    const sourceBytes = key === 'node_modules/.modules.yaml'
      || key === 'node_modules/.pnpm-workspace-state-v1.json' || PNPM_SHIMS.has(key)
      ? await readFile(path) : null
    if (sourceBytes !== null && sourceBytes.length !== stat.size) {
      throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_CHANGED')
    }
    const normalized = sourceBytes === null ? null : normalizedPnpmMetadata(sourceBytes, key, resolved)
    hash.update(`f\0${key}\0${normalized?.length ?? stat.size}\0`)
    let actual = 0
    const observed = sourceBytes === null ? null : createHash('sha256')
    for await (const chunk of createReadStream(path)) {
      const bytes = chunk as Buffer
      actual += bytes.length
      if (normalized === null) hash.update(bytes)
      else observed!.update(bytes)
    }
    if (actual !== stat.size) throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_CHANGED')
    if (sourceBytes !== null && observed!.digest('hex')
      !== createHash('sha256').update(sourceBytes).digest('hex')) {
      throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_CHANGED')
    }
    if (normalized !== null) hash.update(normalized)
  }
  const visit = async (base: string, directory: string, prefix: string,
    ignorePythonCache = false): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      // Pillow's generated bytecode embeds machine-specific source paths. The
      // launcher gives Python a fresh cache prefix, so these files cannot run.
      if (ignorePythonCache && name === '__pycache__') continue
      if (ignorePythonCache && name.endsWith('.pyc')) {
        throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_INVALID')
      }
      const path = join(directory, name)
      const relativeName = `${prefix}/${relative(base, path).split(sep).join('/')}`
      const stat = await lstat(path)
      entries++
      if (entries > 5_000) throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_INVALID')
      if (stat.isDirectory()) {
        hash.update(`d\0${relativeName}\0`)
        await visit(base, path, prefix, ignorePythonCache)
      } else if (stat.isSymbolicLink()) {
        const target = await realpath(path)
        const offset = relative(base, target)
        if (offset === '..' || offset.startsWith('..' + sep) || isAbsolute(offset)) {
          throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_INVALID')
        }
        // Hash the in-tree target identity, not the machine-specific spelling
        // of an absolute/relative link to the same installed dependency.
        hash.update(`l\0${relativeName}\0${relative(base, target).split(sep).join('/')}\0`)
      } else if (stat.isFile()) {
        await hashFile(path, relativeName, 32 * 1024 * 1024)
      } else throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_INVALID')
    }
  }
  await visit(dependencies, dependencies, 'node_modules')
  if (entries < 2 || totalBytes < 1_000_000) throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_INVALID')
  const python = await realpath(pythonPath)
  const swift = await realpath(swiftPath)
  const pythonPrefix = await realpath(dirname(dirname(pythonPath)))
  // Path and symlink text locate the interpreter but do not identify its bytes.
  await hashFile(python, 'runtime/python', 64 * 1024 * 1024)
  await hashFile(swift, 'runtime/swift-entry', 64 * 1024 * 1024)
  let venvConfig: Buffer | undefined
  try {
    const path = join(pythonPrefix, 'pyvenv.cfg')
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) {
      throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_INVALID')
    }
    venvConfig = await readFile(path)
    if (venvConfig.length !== stat.size) throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_CHANGED')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (venvConfig !== undefined) {
    const fields = new Map<string, string>()
    const allowed = new Set(['home', 'include-system-site-packages', 'version', 'executable', 'command', 'prompt'])
    const raw = venvConfig.toString('utf8')
    if (Buffer.from(raw, 'utf8').compare(venvConfig) !== 0) {
      throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_INVALID')
    }
    for (const line of raw.split(/\r?\n/u)) {
      if (line.trim() === '') continue
      const separator = line.indexOf('=')
      const key = line.slice(0, separator).trim().toLowerCase()
      if (separator < 0 || !allowed.has(key) || fields.has(key)) {
        throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_INVALID')
      }
      const value = line.slice(separator + 1).trim()
      if (value === '' || value.includes('\0') || value.length > 4096) {
        throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_INVALID')
      }
      fields.set(key, value)
    }
    const version = fields.get('version') ?? ''
    if (fields.get('include-system-site-packages') !== 'false'
      || !/^[0-9]+(?:\.[0-9]+){1,3}$/u.test(version)
      || (fields.get('home') !== undefined && !isAbsolute(fields.get('home')!))) {
      throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_INVALID')
    }
    const executable = fields.get('executable')
    if (executable !== undefined) {
      if (!isAbsolute(executable)) throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_INVALID')
      if (fields.get('home') !== undefined
        && await realpath(dirname(executable)) !== await realpath(fields.get('home')!)) {
        throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_INVALID')
      }
      const stat = await lstat(executable)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024
        || createHash('sha256').update(await readFile(executable)).digest('hex')
          !== createHash('sha256').update(await readFile(python)).digest('hex')) {
        throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DEPENDENCIES_INVALID')
      }
    }
    hash.update(`python-venv\0${version}\0false\0${fields.get('prompt') ?? ''}\0`)
  }
  let pillowFile: string
  const probeCache = await mkdtemp(join(tmpdir(), 'qianshou-pillow-probe-'))
  try {
    const result = await execFileAsync(pythonPath, ['-I', '-B', '-X', `pycache_prefix=${probeCache}`, '-c',
      'import json, PIL; print(json.dumps({"file": PIL.__file__, "version": PIL.__version__}))'], {
      timeout: 5_000, maxBuffer: 4096,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: tmpdir(), LANG: 'C',
        PYTHONDONTWRITEBYTECODE: '1' },
    })
    const parsed: unknown = JSON.parse(result.stdout.trim())
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
      || typeof (parsed as Record<string, unknown>).file !== 'string'
      || typeof (parsed as Record<string, unknown>).version !== 'string') {
      throw new Error('Pillow identity invalid')
    }
    pillowFile = (parsed as { file: string }).file
    hash.update(`pillow-version\0${(parsed as { version: string }).version}\0`)
  } catch { throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_PILLOW_UNAVAILABLE') }
  finally { await rm(probeCache, { recursive: true, force: true }) }
  const pillowDir = await realpath(dirname(pillowFile))
  if (!contained(pythonPrefix, pillowDir) || !isAbsolute(pillowDir)) {
    throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_PILLOW_UNTRUSTED')
  }
  const sitePackages = dirname(pillowDir)
  await visit(pillowDir, pillowDir, 'PIL', true)
  for (const name of (await readdir(sitePackages)).filter(item => /^pillow(?:\.libs|-[^/]+\.dist-info)$/iu.test(item)).sort()) {
    const path = join(sitePackages, name)
    if (!(await lstat(path)).isDirectory()) throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_PILLOW_UNTRUSTED')
    hash.update(`d\0${name}\0`)
    await visit(path, path, name)
  }
  return hash.digest('hex')
}

/** Read a platform-independent adapter object only after every executable path is pinned. */
export async function createPinnedSvgVideoAdapter(options: PinnedSvgVideoOptions): Promise<ArtifactOrderAdapter> {
  if (!isAbsolute(options.root) || !HASH.test(options.expectedDigest)
    || !HASH.test(options.expectedPackageDigest)
    || ![options.nodePath, options.pythonPath, options.swiftPath].every(isAbsolute)) {
    throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_CONFIG_INVALID')
  }
  const root = await realpath(options.root)
  const current = await installedSvgVideoDigest(root)
  if (current !== options.expectedDigest) throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DIGEST_MISMATCH')
  if (await installedSvgVideoPackageDigest(root, options.pythonPath, options.swiftPath)
    !== options.expectedPackageDigest) {
    throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_PACKAGE_DIGEST_MISMATCH')
  }
  const descriptor: unknown = JSON.parse(await readFile(join(root, 'local-adapter.json'), 'utf8'))
  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)
    || (descriptor as Record<string, unknown>).schema !== 'qianshou.local-adapter-candidate.v1'
    || (descriptor as Record<string, unknown>).taskType !== 'bar_chart_svg_v1'
    || (descriptor as Record<string, unknown>).inputKind !== 'inline_json'
    || (descriptor as Record<string, unknown>).outputKind !== 'local_artifact_manifest') {
    throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_CONFIG_INVALID')
  }
  for (const executable of [options.nodePath, options.pythonPath, options.swiftPath]) {
    await access(executable, constants.X_OK)
  }
  return {
    taskType: 'bar_chart_svg_v1', inputKind: 'inline', outputKind: 'artifact_ref',
    contractVersion: 'v1', artifactDigest: `sha256:${options.expectedDigest}`,
    packageDigest: `sha256:${options.expectedPackageDigest}`, outputFormats: ['gif', 'mp4'],
    async run({ recipeJson, outputFormat, workspacePath, signal }) {
      signal.throwIfAborted()
      if (await installedSvgVideoDigest(root) !== options.expectedDigest) {
        throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_DIGEST_MISMATCH')
      }
      if (await installedSvgVideoPackageDigest(root, options.pythonPath, options.swiftPath)
        !== options.expectedPackageDigest) {
        throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_PACKAGE_DIGEST_MISMATCH')
      }
      const workspace = await realpath(workspacePath)
      const input = join(workspace, 'scene.json')
      await writeFile(input, recipeJson, { mode: 0o600, flag: 'wx' })
      const script = join(root, 'src', 'adapter.mjs')
      const child = spawn(options.nodePath, [script, '--input', input, '--work-root', workspace,
        '--python', options.pythonPath, '--swift', options.swiftPath], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: workspace, TMPDIR: workspace,
          LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONPYCACHEPREFIX: join(workspace, '.qianshou-isolated-pycache'),
          // In the packaged desktop process execPath points at Electron. Keep
          // its Node mode local to this pinned child; never relaunch the UI.
          ELECTRON_RUN_AS_NODE: '1' },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8').slice(0, Math.max(0, 16_384 - stdout.length)) })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8').slice(0, Math.max(0, 16_384 - stderr.length)) })
      const kill = () => {
        if (child.pid && process.platform !== 'win32') {
          try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
        } else child.kill('SIGKILL')
      }
      const deadline = setTimeout(kill, 180_000)
      signal.addEventListener('abort', kill, { once: true })
      let code: number | null
      try {
        code = await new Promise<number | null>((resolve, reject) => {
          child.once('error', reject)
          child.once('close', resolve)
        })
      } finally {
        clearTimeout(deadline)
        signal.removeEventListener('abort', kill)
      }
      signal.throwIfAborted()
      if (code !== 0) throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_EXECUTION_FAILED', 503)
      let response: unknown
      try { response = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') }
      catch { throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_RECEIPT_INVALID', 422) }
      if (response === null || typeof response !== 'object' || Array.isArray(response)
        || typeof (response as Record<string, unknown>).workDir !== 'string') {
        throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_RECEIPT_INVALID', 422)
      }
      const reportedWorkDir = (response as Record<string, unknown>).workDir
      if (typeof reportedWorkDir !== 'string') throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_RECEIPT_INVALID', 422)
      const workDir = await realpath(reportedWorkDir)
      if (!contained(workspace, workDir)) throw new ComputeError('COMPUTE_ARTIFACT_ADAPTER_RECEIPT_INVALID', 422)
      const filename = `result.${outputFormat}`
      const path = join(workDir, filename)
      // The consumer reopens this path, checks magic/size/hash and enforces workspace containment.
      void stderr
      return { path, filename, contentType: outputFormat === 'gif' ? 'image/gif' : 'video/mp4' }
    },
  }
}

/** Run the pinned program on a fixed tiny recipe and inspect both real media outputs. */
export async function selfTestPinnedSvgVideoAdapter(adapter: ArtifactOrderAdapter): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'qianshou-media-proof-'))
  try {
    const canonicalWorkspace = await realpath(workspace)
    const recipeJson = JSON.stringify({
      kind: 'bar_chart_svg_v1', title: '接单自检', unit: '单', durationSeconds: 1,
      fps: 20, width: 640, height: 360,
      bars: [{ label: '甲', value: 10, color: '#4f8cff' }, { label: '乙', value: 20, color: '#44c7b2' }],
    })
    const output = await adapter.run({ recipeJson, outputFormat: 'mp4', workspacePath: workspace,
      signal: new AbortController().signal })
    const workDir = await realpath(dirname(output.path))
    if (!contained(canonicalWorkspace, workDir)) throw new ComputeError('COMPUTE_ARTIFACT_SELF_TEST_FAILED')
    for (const [name, mime] of [['result.gif', 'image/gif'], ['result.mp4', 'video/mp4']] as const) {
      const path = join(workDir, name)
      const st = await lstat(path)
      if (!st.isFile() || st.isSymbolicLink() || st.size < 100 || st.size > 16 * 1024 * 1024) {
        throw new ComputeError('COMPUTE_ARTIFACT_SELF_TEST_FAILED')
      }
      const bytes = await readFile(path)
      if (mime === 'image/gif' && bytes.subarray(0, 6).toString('ascii') !== 'GIF89a'
        || mime === 'video/mp4' && bytes.subarray(4, 8).toString('ascii') !== 'ftyp') {
        throw new ComputeError('COMPUTE_ARTIFACT_SELF_TEST_FAILED')
      }
    }
  } finally { await rm(workspace, { recursive: true, force: true }) }
}
