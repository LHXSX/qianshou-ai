import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { apply, NODE_CONTRIBUTOR_SERVICE, verifyInstalledArtifactRoot,
  type NodeContributorService } from '../src/plugin.ts'
import { installedSvgVideoDigest, installedSvgVideoPackageDigest } from '../src/pinned-svg-video.ts'

const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function mounted(): Promise<{ service: NodeContributorService; profile: string }> {
  const profile = await mkdtemp(join(tmpdir(), 'qianshou-profile-media-'))
  directories.push(profile)
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('profileContext', { dir: profile })
  ctx.provide('connection', { fetch: { register: () => () => undefined } })
  apply(ctx, { autoStart: false, storePath: join(profile, 'tasks.json'), workspaceRoot: profile })
  const service = ctx.get(NODE_CONTRIBUTOR_SERVICE) as NodeContributorService
  expect(service).toBeDefined()
  return { service, profile }
}

it('rejects a media selection outside the installed skill and writes no profile choice', async () => {
  const { service, profile } = await mounted()
  await expect(service.selectArtifactAdapter({ root: '/tmp/random/order_adapter', digest: 'a'.repeat(64),
    pythonPath: '/usr/bin/python3', swiftPath: '/usr/bin/swift' })).rejects.toThrow()
  await expect(readFile(join(profile, 'qianshou-artifact-adapter.json'))).rejects.toThrow()
})

it('accepts a different skill name at the path guard but refuses an unrelated directory', async () => {
  const { profile } = await mounted()
  const skill = join(profile, 'chart-maker')
  const rootPath = join(skill, 'scripts', 'order_adapter')
  await mkdir(rootPath, { recursive: true })
  await writeFile(join(skill, 'SKILL.md'), '# Chart maker\n')
  const root = await realpath(rootPath)
  await expect(verifyInstalledArtifactRoot(root)).resolves.toBeUndefined()
  await expect(verifyInstalledArtifactRoot(join(profile, 'random', 'order_adapter')))
    .rejects.toThrow('COMPUTE_ARTIFACT_ADAPTER_SELECTION_INVALID')
  await expect(readFile(join(profile, 'qianshou-artifact-adapter.json'))).rejects.toThrow()
})

it('changes the package snapshot if Pillow or installed Node dependency bytes change', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qianshou-package-digest-'))
  directories.push(dir)
  const root = join(dir, 'adapter')
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'node_modules'), { recursive: true })
  for (const name of ['package.json', 'pnpm-lock.yaml', 'local-adapter.json',
    'src/adapter.mjs', 'src/assemble_gif.py', 'src/encode_frames.swift']) {
    await writeFile(join(root, name), name)
  }
  const dependency = join(root, 'node_modules', 'sharp-native.bin')
  await writeFile(dependency, Buffer.alloc(1_000_001, 65))
  await writeFile(join(root, 'node_modules', 'package.json'), '{}')
  const runtime = join(dir, 'runtime')
  const pillowDir = join(runtime, 'lib', 'site-packages', 'PIL')
  await mkdir(join(runtime, 'bin'), { recursive: true })
  await mkdir(pillowDir, { recursive: true })
  const pillow = join(pillowDir, '__init__.py')
  await writeFile(pillow, 'Pillow A')
  const python = join(runtime, 'bin', 'python3')
  await writeFile(python, `#!/bin/sh\nprintf '%s\\n' '{"file":"${pillow}","version":"12.3.0"}'\n`)
  await chmod(python, 0o700)
  const swift = join(dir, 'swift')
  await writeFile(swift, '#!/bin/sh\nexit 0\n')
  await chmod(swift, 0o700)
  const first = await installedSvgVideoPackageDigest(root, python, swift)
  await writeFile(pillow, 'Pillow B')
  const pillowChanged = await installedSvgVideoPackageDigest(root, python, swift)
  expect(pillowChanged).not.toBe(first)
  await writeFile(dependency, Buffer.alloc(1_000_001, 66))
  expect(await installedSvgVideoPackageDigest(root, python, swift)).not.toBe(pillowChanged)
})

it('reproduces v4 across independent pnpm metadata and shim paths while rejecting runtime changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qianshou-package-portable-'))
  directories.push(dir)
  const build = async (location: string) => {
    const root = join(location, 'adapter')
    const modules = join(root, 'node_modules')
    const runtime = join(location, 'runtime')
    const pillow = join(runtime, 'lib', 'site-packages', 'PIL', '__init__.py')
    const python = join(runtime, 'bin', 'python3')
    const swift = join(location, 'swift')
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(modules, { recursive: true })
    await mkdir(join(runtime, 'bin'), { recursive: true })
    await mkdir(join(runtime, 'lib', 'site-packages', 'PIL'), { recursive: true })
    for (const name of ['package.json', 'pnpm-lock.yaml', 'local-adapter.json',
      'src/adapter.mjs', 'src/assemble_gif.py', 'src/encode_frames.swift']) {
      await writeFile(join(root, name), name)
    }
    await writeFile(join(modules, 'a.bin'), Buffer.alloc(1_000_000, 65))
    await writeFile(join(modules, 'b.bin'), 'b')
    await writeFile(join(modules, '.modules.yaml'), JSON.stringify({
      layoutVersion: 5, packageManager: 'pnpm@11.7.0', prunedAt: location,
      storeDir: join(location, 'pnpm-store'),
    }, null, 2))
    await writeFile(join(modules, '.pnpm-workspace-state-v1.json'), JSON.stringify({
      projects: {}, lastValidatedTimestamp: location.endsWith('machine-a') ? 1 : 2,
    }, null, 2))
    for (const name of ['.pnpm/node_modules/.bin/semver',
      '.pnpm/sharp@0.35.3/node_modules/sharp/node_modules/.bin/semver']) {
      const path = join(modules, name)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, `#!/bin/sh\nexport NODE_PATH="${await realpath(root)}/node_modules"\n`)
    }
    await symlink(join(modules, 'a.bin'), join(modules, 'linked.bin'))
    await writeFile(pillow, 'Pillow A')
    await mkdir(join(dirname(pillow), '__pycache__'))
    await writeFile(join(dirname(pillow), '__pycache__', '__init__.cpython-314.pyc'),
      location.endsWith('machine-a') ? 'machine-a-path-bytecode' : 'machine-b-path-bytecode')
    await writeFile(python, '#!/bin/sh\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nprintf \'{"file":"%s/lib/site-packages/PIL/__init__.py","version":"12.3.0"}\\n\' "$HERE"\n')
    await chmod(python, 0o700)
    await writeFile(swift, '#!/bin/sh\nexit 0\n')
    await chmod(swift, 0o700)
    await writeFile(join(runtime, 'pyvenv.cfg'),
      `home = ${join(runtime, 'bin')}\ninclude-system-site-packages = false\nversion = 3.14.7\nexecutable = ${python}\ncommand = python -m venv ${runtime}\n`)
    return { root, modules, runtime, python, swift }
  }
  const first = await build(join(dir, 'machine-a'))
  const second = await build(join(dir, 'machine-b'))
  const original = await installedSvgVideoPackageDigest(first.root, first.python, first.swift)
  expect(await installedSvgVideoPackageDigest(second.root, second.python, second.swift)).toBe(original)
  await writeFile(join(second.modules, 'b.bin'), 'c')
  expect(await installedSvgVideoPackageDigest(second.root, second.python, second.swift)).not.toBe(original)
  await writeFile(join(second.runtime, 'pyvenv.cfg'),
    'include-system-site-packages = true\nversion = 3.14.7\n')
  await expect(installedSvgVideoPackageDigest(second.root, second.python, second.swift)).rejects.toThrow()
}, 30_000)

// Set this to an installed skill directory for an on-device integration proof. The
// normal CI suite does not depend on a user's personal skill installation.
const realSkillRoot = process.env.QIANSHOU_REAL_SVG_VIDEO_SKILL_ROOT
it.skipIf(realSkillRoot === undefined)('selects an installed adapter after real GIF and MP4 self-test',
  { timeout: 240_000 }, async () => {
    const { service, profile } = await mounted()
    const root = realSkillRoot!
    const digest = await installedSvgVideoDigest(root)
    const pythonPath = process.env.QIANSHOU_REAL_PILLOW_PYTHON!
    const packageDigest = await installedSvgVideoPackageDigest(root, pythonPath, '/usr/bin/swift')
    const receipt = await service.selectArtifactAdapter({ root, digest,
      pythonPath, swiftPath: '/usr/bin/swift' })
    expect(receipt).toEqual({ taskType: 'bar_chart_svg_v1', artifactDigest: `sha256:${digest}`,
      packageDigest: `sha256:${packageDigest}`,
      inventoryAlgorithm: 'qianshou.bar-chart-package.v4',
      localVerified: true, platformReady: false })
    expect(JSON.parse(await readFile(join(profile, 'qianshou-artifact-adapter.json'), 'utf8')))
      .toMatchObject({ version: 4, root, digest, packageDigest,
        inventoryAlgorithm: 'qianshou.bar-chart-package.v4' })
  })
