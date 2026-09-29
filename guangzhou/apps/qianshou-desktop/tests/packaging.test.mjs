import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotRuntimeClosure, matchesPlatform, copyRuntimeTree } from '../scripts/runtime-closure.mjs'
import { resolvePackagedConfig } from '../config.mjs'
import { optionalVoiceEnvironment } from '../voice-config.mjs'
import { auditWindowsFiles, requireWindowsX64 } from '../scripts/windows-binary.mjs'

test('packaged entry relocates and ignores stale source and Node overrides while preserving the user home', () => {
  const config = resolvePackagedConfig('/Applications/Moved.app/Contents/Resources', { sourcePath: '/old/source', nodePath: '/old/node', home: '/kept/data', path: '/old/path' }, { QIANSHOU_SOURCE: '/env/source', QIANSHOU_NODE: '/env/node', PATH: '/usr/bin' }, '/new/user')
  assert.equal(config.cliPath, '/Applications/Moved.app/Contents/Resources/dsh/lib/bin.js')
  assert.equal(config.nodePath, '/Applications/Moved.app/Contents/Resources/runtime/node/node')
  assert.equal(config.home, '/kept/data')
  assert.equal(config.workingDirectory, '/new/user')
  assert.ok(!config.path.includes('/old'))
})

test('runtime graph remains executable after relocation and never copies undeclared workspace files or env', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'qianshou-closure-test-'))
  try {
    const source = join(temporary, 'source')
    const dependency = join(source, 'node_modules', 'fixture')
    mkdirSync(dependency, { recursive: true })
    mkdirSync(join(source, 'lib'))
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', type: 'module', files: ['lib'], dependencies: { fixture: '1.0.0' } }))
    writeFileSync(join(source, 'lib', 'entry.js'), "export {value} from 'fixture'\n")
    writeFileSync(join(source, '.env'), 'LOCAL_ONLY=not-for-release')
    writeFileSync(join(source, 'private.txt'), 'not runtime')
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', main: 'index.js' }))
    writeFileSync(join(dependency, 'index.js'), 'export const value=42\n')
    writeFileSync(join(dependency, 'LICENSE'), 'dependency notice')
    const destination = join(temporary, 'runtime')
    const graph = snapshotRuntimeClosure({ entry: source, destination, repoRoot: source })
    assert.equal(graph.length, 2)
    assert.equal(existsSync(join(destination, '.env')), false)
    assert.equal(existsSync(join(destination, 'private.txt')), false)
    const moved = join(temporary, 'moved-runtime')
    renameSync(destination, moved)
    rmSync(source, { recursive: true })
    assert.ok(realpathSync(join(moved, 'node_modules/fixture')).startsWith(realpathSync(moved)))
    assert.equal(readFileSync(join(moved, 'node_modules/fixture/LICENSE'), 'utf8'), 'dependency notice')
    assert.equal((await import(join(moved, 'lib/entry.js'))).value, 42)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})

test('optional package selectors handle npm negative and positive platform lists', () => {
  assert.equal(matchesPlatform(['!win32'], 'darwin'), true)
  assert.equal(matchesPlatform(['!darwin'], 'darwin'), false)
  assert.equal(matchesPlatform(['linux', '!win32'], 'darwin'), false)
  assert.equal(matchesPlatform(['darwin', '!win32'], 'darwin'), true)
})

test('universal tool runtime copies only packages matching the target while preserving its target native bytes', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'qianshou-runtime-target-'))
  try {
    const source = join(temporary, 'tool')
    for (const [name, os, cpu] of [['windows', 'win32', 'x64'], ['mac', 'darwin', 'arm64'], ['arm', 'win32', 'arm64']]) {
      const folder = join(source, 'node_modules', name)
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'package.json'), JSON.stringify({ name, os: [os], cpu: [cpu] }))
      writeFileSync(join(folder, 'native.node'), name)
    }
    const output = join(temporary, 'out')
    copyRuntimeTree(source, output, { target: { platform: 'win32', arch: 'x64' } })
    assert.equal(readFileSync(join(output, 'node_modules/windows/native.node'), 'utf8'), 'windows')
    assert.equal(existsSync(join(output, 'node_modules/mac')), false)
    assert.equal(existsSync(join(output, 'node_modules/arm')), false)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})

test('Cordis-style dynamic imports find transitive first-party plugins from the packaged root', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'qianshou-dynamic-closure-'))
  try {
    const source = join(temporary, 'source')
    mkdirSync(join(source, 'lib'), { recursive: true })
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'app', version: '1', type: 'module', files: ['lib'], dependencies: { '@deepseek-ai/loader': '1', '@deepseek-ai/bundle': '1' } }))
    writeFileSync(join(source, 'lib/entry.js'), "import {load} from '@deepseek-ai/loader';export const value=await load('@deepseek-ai/task')\n")
    for (const [name, program, dependencies] of [
      ['loader', 'export const load=async name=>(await import(name)).value', {}],
      ['bundle', 'export const bundled=true', { '@deepseek-ai/task': '1' }],
      ['task', 'export const value=73', {}],
    ]) {
      const folder = join(source, 'node_modules/@deepseek-ai', name)
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version: '1', type: 'module', main: 'index.js', dependencies }))
      writeFileSync(join(folder, 'index.js'), program)
    }
    const destination = join(temporary, 'runtime')
    snapshotRuntimeClosure({ entry: source, destination, repoRoot: source })
    rmSync(source, { recursive: true })
    assert.equal((await import(join(destination, 'lib/entry.js'))).value, 73)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})

test('voice installer paths are optional, validated and do not select a speaker', () => {
  const home = mkdtempSync(join(tmpdir(), 'qianshou-voice-config-'))
  try {
    assert.deepEqual(optionalVoiceEnvironment(home), {})
    const folder = join(home, '.local/share/qianshou-agent/voice')
    mkdirSync(folder, { recursive: true })
    const file = join(folder, 'voice-settings.json')
    writeFileSync(file, JSON.stringify({ version: 1, tts: { python: '/resources/python', worker: '/resources/worker.py', model: '/resources/model' }, speaker: 'ignored' }))
    assert.deepEqual(optionalVoiceEnvironment(home), { FORGE_TTS_PYTHON: '/resources/python', FORGE_TTS_WORKER: '/resources/worker.py', FORGE_TTS_MODEL: '/resources/model' })
    writeFileSync(file, JSON.stringify({ version: 1, asr: { binary: 'relative', model: '/model' } }))
    assert.throws(() => optionalVoiceEnvironment(home), /INVALID_CONFIG/u)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('Windows hoisting preserves conflicting versions without links and selects target native overrides', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'qianshou-windows-closure-'))
  try {
    const source = join(temporary, 'source')
    const pkg = (folder, manifest, code) => {
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'package.json'), JSON.stringify({ version: '1.0.0', type: 'module', main: 'index.js', ...manifest }))
      writeFileSync(join(folder, 'index.js'), code)
    }
    pkg(source, { name: 'application', files: ['index.js'], dependencies: { first: '1', second: '1' }, optionalDependencies: { 'native-win32-x64': '1', 'native-darwin-arm64': '1' } }, "export { value as first } from 'first';export { value as second } from 'second'")
    pkg(join(source, 'node_modules/first'), { name: 'first', peerDependencies: { shared: '1' } }, "export { value } from 'shared'")
    pkg(join(source, 'node_modules/second'), { name: 'second', dependencies: { shared: '2' } }, "export { value } from 'shared'")
    pkg(join(source, 'node_modules/shared'), { name: 'shared', version: '1.0.0' }, 'export const value=1')
    pkg(join(source, 'node_modules/second/node_modules/shared'), { name: 'shared', version: '2.0.0' }, 'export const value=2')
    pkg(join(source, 'node_modules/native-darwin-arm64'), { name: 'native-darwin-arm64', os: ['darwin'], cpu: ['arm64'] }, 'export const value="mac"')
    const native = join(temporary, 'native')
    pkg(native, { name: 'native-win32-x64', os: ['win32'], cpu: ['x64'] }, 'export const value="windows"')
    const destination = join(temporary, 'runtime')
    const graph = snapshotRuntimeClosure({ entry: source, destination, repoRoot: source, layout: 'hoisted', target: { platform: 'win32', arch: 'x64' }, dependencyOverrides: { 'native-win32-x64': native } })
    assert.equal(graph.some(p => p.name === 'native-darwin-arm64'), false)
    assert.equal(graph.some(p => p.name === 'native-win32-x64'), true)
    const walk = path => { for (const entry of readdirSync(path, { withFileTypes: true })) { assert.equal(entry.isSymbolicLink(), false); if (entry.isDirectory()) walk(join(path, entry.name)) } }
    walk(destination)
    rmSync(source, { recursive: true }); rmSync(native, { recursive: true })
    const result = await import(join(destination, 'index.js'))
    assert.equal(result.first, 1); assert.equal(result.second, 2)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})

test('missing selected Windows optional native fails instead of silently producing a partial runtime', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'qianshou-windows-missing-'))
  try {
    writeFileSync(join(temporary, 'package.json'), JSON.stringify({ name: 'app', files: [], optionalDependencies: { 'absent-win32-x64': '1.0.0' } }))
    assert.throws(() => snapshotRuntimeClosure({ entry: temporary, repoRoot: temporary, destination: join(temporary, 'runtime'), target: { platform: 'win32', arch: 'x64' }, layout: 'hoisted' }), /Missing target runtime dependency/u)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})

test('Windows archive audit rejects reserved names and foreign native formats', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'qianshou-windows-audit-'))
  try {
    writeFileSync(join(temporary, 'CON.txt'), 'not usable on Windows')
    assert.throws(() => auditWindowsFiles(temporary), /reserved path/u)
    rmSync(join(temporary, 'CON.txt'))
    writeFileSync(join(temporary, 'bad.node'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))
    assert.throws(() => auditWindowsFiles(temporary), /Not a Windows PE/u)
    const arm64 = Buffer.alloc(128)
    arm64.writeUInt16LE(0x5a4d, 0); arm64.writeUInt32LE(64, 0x3c); arm64.writeUInt32LE(0x4550, 64); arm64.writeUInt16LE(0xaa64, 68)
    assert.throws(() => requireWindowsX64(arm64, 'arm64.dll'), /Not an AMD64/u)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})

test('only an exact upstream executable path and digest allow an I386 WOW64 helper', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'qianshou-upstream-helper-'))
  try {
    const bytes = Buffer.alloc(128)
    bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(64, 0x3c)
    bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(0x14c, 68)
    writeFileSync(join(temporary, 'upstream.exe'), bytes)
    const sha = createHash('sha256').update(bytes).digest('hex')
    assert.throws(() => auditWindowsFiles(temporary), /Not an AMD64/u)
    assert.throws(() => auditWindowsFiles(temporary, { allowedI386Executables: { 'another.exe': sha } }), /Not an AMD64/u)
    assert.throws(() => auditWindowsFiles(temporary, { allowedI386Executables: { 'upstream.exe': 'wrong' } }), /Not an AMD64/u)
    assert.equal(auditWindowsFiles(temporary, { allowedI386Executables: { 'upstream.exe': sha } }).nativeFiles[0].machine, 'I386')
    renameSync(join(temporary, 'upstream.exe'), join(temporary, 'native.node'))
    assert.throws(() => auditWindowsFiles(temporary, { allowedI386Executables: { 'native.node': sha } }), /Not an AMD64/u)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})
