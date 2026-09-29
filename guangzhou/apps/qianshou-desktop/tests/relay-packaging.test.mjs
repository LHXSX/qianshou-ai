import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { stageDesktopRelay } from '../scripts/relay-resources.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qianshou-relay-packaging-'))
  const source = join(root, 'relay')
  const cache = join(root, 'cache')
  mkdirSync(join(source, 'resources'), { recursive: true })
  mkdirSync(join(source, 'tests'))
  mkdirSync(cache)
  writeFileSync(join(source, 'controller.mjs'), 'export const marker = "public-module"\n')
  writeFileSync(join(source, 'README.md'), '# Public relay usage\n')
  writeFileSync(join(source, 'enrollment.json'), '{"token":"must-not-be-distributed"}')
  writeFileSync(join(source, 'tests/private.test.mjs'), 'must-not-be-distributed')
  writeFileSync(join(source, 'temporary.test.mjs'), 'must-not-be-distributed')
  writeFileSync(join(source, 'resources/frpc'), 'wrong-source-platform')
  const ca = Buffer.from('test-public-certificate')
  writeFileSync(join(source, 'resources/isrg-roots.pem'), ca)
  const executable = Buffer.from('verified-Windows-target-fixture')
  const license = Buffer.from('public upstream license')
  const archiveName = 'frp_0.71.0_windows_amd64.zip'
  const archive = join(cache, archiveName)
  const entries = { 'frp_0.71.0_windows_amd64/frpc.exe': executable.toString(), 'frp_0.71.0_windows_amd64/LICENSE': license.toString() }
  execFileSync('python3', ['-c', 'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); [z.writestr(k,v) for k,v in json.loads(sys.argv[2]).items()]; z.close()', archive, JSON.stringify(entries)])
  const bytes = readFileSync(archive)
  const lock = { version: 1, frpcVersion: '0.71.0', ca: { file: 'isrg-roots.pem', sha256: digest(ca) }, targets: [{ platform: 'win32', arch: 'x64',
    archive: { url: `https://github.com/fatedier/frp/releases/download/v0.71.0/${archiveName}`, sha256: digest(bytes), bytes: bytes.length },
    binary: { file: 'frpc.exe', entry: 'frp_0.71.0_windows_amd64/frpc.exe', sha256: digest(executable) },
    license: { entry: 'frp_0.71.0_windows_amd64/LICENSE', sha256: digest(license) } }] }
  const save = () => writeFileSync(join(source, 'frpc.lock.json'), JSON.stringify(lock))
  save()
  return { root, source, archive, lock, save, executable, ca,
    options: { appRoot: root, destination: join(root, 'output'), platform: 'win32', arch: 'x64', cacheRoot: cache } }
}

test('Windows staging selects the locked target and includes no enrollment, tests, or Mac executable', async () => {
  const f = fixture()
  try {
    const manifest = await stageDesktopRelay(f.options)
    assert.equal(manifest.platform, 'win32')
    assert.equal(manifest.binary.file, 'frpc.exe')
    assert.deepEqual(readFileSync(join(f.options.destination, 'resources/frpc.exe')), f.executable)
    assert.deepEqual(readFileSync(join(f.options.destination, 'resources/isrg-roots.pem')), f.ca)
    assert.deepEqual(readdirSync(f.options.destination).sort(), ['README.md', 'controller.mjs', 'frpc.lock.json', 'resources'])
    assert.deepEqual(readdirSync(join(f.options.destination, 'resources')).sort(), ['FRP_LICENSE', 'frpc.exe', 'isrg-roots.pem', 'manifest.json'])
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('staging fails on an altered CA, archive, executable or license hash', async () => {
  for (const item of ['ca', 'archive', 'binary', 'license']) {
    const f = fixture()
    try {
      if (item === 'ca') writeFileSync(join(f.source, 'resources/isrg-roots.pem'), 'changed')
      else if (item === 'archive') writeFileSync(f.archive, 'changed')
      else { f.lock.targets[0][item].sha256 = '0'.repeat(64); f.save() }
      await assert.rejects(stageDesktopRelay(f.options), /checksum mismatch/u)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  }
})

test('staging refuses an unsupported platform and cannot overwrite an existing target', async () => {
  const f = fixture()
  try {
    await assert.rejects(stageDesktopRelay({ ...f.options, platform: 'darwin' }), /No unique locked FRP target/u)
    await stageDesktopRelay(f.options)
    await assert.rejects(stageDesktopRelay(f.options), /already exists/u)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('the locked official download origin and archive member cannot escape the selected resource', async () => {
  const f = fixture()
  try {
    f.lock.targets[0].archive.url = 'https://untrusted.invalid/frpc.zip'; f.save()
    await assert.rejects(stageDesktopRelay(f.options), /official release/u)
    f.lock.targets[0].archive.url = 'https://github.com/fatedier/frp/releases/download/v0.71.0/frp_0.71.0_windows_amd64.zip'
    f.lock.targets[0].binary.entry = '../enrollment.json'; f.save()
    await assert.rejects(stageDesktopRelay(f.options), /Invalid locked archive member/u)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
