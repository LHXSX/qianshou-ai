import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import * as tar from 'tar'
import { stageUpdate, verifyStagedUpdate, updateLayout } from '../stage.mjs'
import { appEntries, signedDownload, tarBytes, testing, windows, workspace } from './stage-fixtures.mjs'

test('installs a complete Windows archive beside the original and verifies every file from signed archive bytes', async t => {
  const root = await workspace(t), updatesDirectory = path.join(root, 'updates')
  const download = await signedDownload(root)
  const receipt = await stageUpdate(download, { updatesDirectory, target: windows }, testing)
  assert.ok(receipt.entryPoint.startsWith(path.join(updatesDirectory, 'versions')))
  assert.match(await readFile(receipt.entryPoint, 'utf8'), /^MZ/)
  const verified = await verifyStagedUpdate({ ...receipt, entryPoint: '/tmp/attacker' }, { updatesDirectory, target: windows }, testing)
  assert.equal(verified.entryPoint, receipt.entryPoint)
  assert.equal((await stageUpdate(download, { updatesDirectory, target: windows }, testing)).entryPoint, receipt.entryPoint)
  assert.equal((await readdir(path.join(updatesDirectory, 'versions'))).length, 1)
})

test('large deflated files finish across stream chunks, preserve empty files, and remain verifiable before restart', { timeout: 10_000 }, async t => {
  const root = await workspace(t), updatesDirectory = path.join(root, 'updates')
  const base = updateLayout(windows, '0.2.2').root
  const bytes = Buffer.concat(Array.from({ length: 32_768 }, (_, index) => createHash('sha256').update(String(index)).digest()))
  const entries = [...appEntries(), { name: `${base}/resources/payload.bin`, data: bytes, deflate: true }, { name: `${base}/resources/empty`, data: '', deflate: true }]
  const receipt = await stageUpdate(await signedDownload(root, windows, entries), { updatesDirectory, target: windows }, testing)
  assert.deepEqual(await readFile(path.join(path.dirname(receipt.entryPoint), 'resources/payload.bin')), bytes)
  assert.equal((await readFile(path.join(path.dirname(receipt.entryPoint), 'resources/empty'))).length, 0)
  assert.equal((await verifyStagedUpdate(receipt, { updatesDirectory, target: windows }, testing)).entryPoint, receipt.entryPoint)
})

test('ZIP and tar install ASAR members as exact files and reject entries beneath those files', async t => {
  const root = await workspace(t)
  for (const target of [windows, { role: 'companion', platform: 'linux', arch: 'x64' }]) {
    const layout = updateLayout(target, '0.2.2')
    const name = `${layout.root}/resources/default_app.asar`
    const entries = [...appEntries(target), { name, data: 'opaque ASAR bytes, not a directory' }]
    const archive = layout.format === 'tar.gz' ? tarBytes(entries) : undefined
    const updatesDirectory = path.join(root, `asar-${target.platform}`)
    const receipt = await stageUpdate(await signedDownload(root, target, entries, '0.2.2', archive), { updatesDirectory, target }, testing)
    assert.equal(await readFile(path.join(path.dirname(receipt.entryPoint), 'resources/default_app.asar'), 'utf8'), entries.at(-1).data)
    await verifyStagedUpdate(receipt, { updatesDirectory, target }, testing)
    const invalid = [...entries, { name: `${name}/injected.js`, data: 'not an actual directory' }]
    await assert.rejects(stageUpdate(await signedDownload(root, target, invalid, '0.2.2', layout.format === 'tar.gz' ? tarBytes(invalid) : undefined), { updatesDirectory: path.join(root, `bad-asar-${target.platform}`), target }, testing), { code: 'UNSAFE_INSTALL' })
  }
})

test('an edited local receipt hash list cannot bless installed-file tampering', async t => {
  const root = await workspace(t), updatesDirectory = path.join(root, 'updates')
  const receipt = await stageUpdate(await signedDownload(root), { updatesDirectory, target: windows }, testing)
  await writeFile(receipt.entryPoint, 'MZ compromised full application fix')
  await assert.rejects(verifyStagedUpdate({ ...receipt, fileHashes: { [receipt.entryPoint]: 'attacker' } }, { updatesDirectory, target: windows }, testing), { code: 'UNSAFE_INSTALL' })
})

test('traversal, absolute, drive, backslash, duplicate, case-collision and special entries are refused before extraction', async t => {
  const root = await workspace(t)
  const base = updateLayout(windows, '0.2.2').root
  for (const [index, extras] of [
    [{ name: '../outside', data: 'bad' }], [{ name: '/tmp/outside', data: 'bad' }],
    [{ name: `${base}/C:stream`, data: 'bad' }], [{ name: `${base}\\outside`, data: 'bad' }],
    [appEntries()[0]], [{ name: `${base}/SAME`, data: 'a' }, { name: `${base}/same`, data: 'b' }],
    [{ name: `${base}/device`, mode: 0o020666 }], [{ name: `${base}/admin`, data: 'x', mode: 0o104755 }],
  ].entries()) {
    const updatesDirectory = path.join(root, `updates-${index}`)
    const download = await signedDownload(root, windows, [...appEntries(), ...extras])
    await assert.rejects(stageUpdate(download, { updatesDirectory, target: windows }, testing))
    assert.deepEqual(await readdir(path.join(updatesDirectory, 'versions')), [])
  }
})

test('escaping links and archive entries written below a symlink are rejected', async t => {
  const root = await workspace(t), base = updateLayout(windows, '0.2.2').root
  for (const [index, extras] of [
    [{ name: `${base}/escape`, mode: 0o120777, data: '../../outside' }],
    [{ name: `${base}/alias`, mode: 0o120777, data: 'resources' }, { name: `${base}/alias/injected`, data: 'bad' }],
  ].entries()) await assert.rejects(stageUpdate(await signedDownload(root, windows, [...appEntries(), ...extras]), { updatesDirectory: path.join(root, `updates-${index}`), target: windows }, testing), { code: 'UNSAFE_INSTALL' })
})

test('macOS ditto UTF-8 names without a UTF-8 flag and internal framework links remain intact', async t => {
  const root = await workspace(t), target = { role: 'companion', platform: 'darwin', arch: 'arm64' }
  const base = updateLayout(target, '0.2.2').root
  const entries = [...appEntries(target), { name: `${base}/Contents/alias`, mode: 0o120777, data: 'Resources' }, { name: `__MACOSX/._${base}`, data: 'resource fork' }].map(entry => ({ ...entry, flags: 0 }))
  let checked = 0
  const receipt = await stageUpdate(await signedDownload(root, target, entries), { updatesDirectory: path.join(root, 'updates'), target }, { ...testing, verifyMacSignature: async app => { checked++; assert.ok(app.endsWith(base)) } })
  assert.equal(checked, 1)
  await verifyStagedUpdate(receipt, { updatesDirectory: path.join(root, 'updates'), target }, testing)
})

test('Linux companion tar.gz preserves executable mode and is verified with the same full-tree authority', async t => {
  const root = await workspace(t), target = { role: 'companion', platform: 'linux', arch: 'x64' }
  const folder = path.join(root, 'tar-input'), entries = appEntries(target)
  for (const item of entries) {
    const file = path.join(folder, item.name)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, item.data); await chmod(file, item.mode & 0o777 || 0o644)
  }
  const archive = path.join(root, 'fixture.tar.gz')
  await tar.c({ file: archive, cwd: folder, gzip: true }, [updateLayout(target, '0.2.2').root])
  const receipt = await stageUpdate(await signedDownload(root, target, entries, '0.2.2', await readFile(archive)), { updatesDirectory: path.join(root, 'updates'), target }, testing)
  await verifyStagedUpdate(receipt, { updatesDirectory: path.join(root, 'updates'), target }, testing)
})

test('malicious tar traversal, external links and hard links reject as promises without extraction or uncaught callbacks', async t => {
  const root = await workspace(t), target = { role: 'companion', platform: 'linux', arch: 'x64' }
  const base = updateLayout(target, '0.2.2').root
  for (const [index, bad] of [{ name: '../outside', data: 'bad' }, { name: `${base}/escape`, type: '2', link: '../../outside' }, { name: `${base}/hard`, type: '1', link: `${base}/qianshou-companion` }].entries()) {
    const updatesDirectory = path.join(root, `updates-${index}`)
    const download = await signedDownload(root, target, [], '0.2.2', tarBytes([bad]))
    await assert.rejects(stageUpdate(download, { updatesDirectory, target }, testing), { code: 'UNSAFE_INSTALL' })
    assert.deepEqual(await readdir(path.join(updatesDirectory, 'versions')), [])
  }
})

test('untrusted stage symlink, wrong application version, missing entry, corruption and abort cannot publish a stage', async t => {
  const root = await workspace(t)
  const updatesDirectory = path.join(root, 'updates')
  await mkdir(updatesDirectory, { mode: 0o700 }); await mkdir(path.join(root, 'outside'))
  await symlink(path.join(root, 'outside'), path.join(updatesDirectory, 'versions'))
  await assert.rejects(stageUpdate(await signedDownload(root), { updatesDirectory, target: windows }, testing), { code: 'UNSAFE_INSTALL' })
  const wrong = appEntries(); wrong[1] = { ...wrong[1], data: JSON.stringify({ name: 'qianshou-agent', version: '9.9.9' }) }
  await assert.rejects(stageUpdate(await signedDownload(root, windows, wrong), { updatesDirectory: path.join(root, 'wrong'), target: windows }, testing), { code: 'UNSAFE_INSTALL' })
  await assert.rejects(stageUpdate(await signedDownload(root, windows, appEntries().slice(1)), { updatesDirectory: path.join(root, 'missing'), target: windows }, testing), { code: 'UNSAFE_INSTALL' })
  const download = await signedDownload(root); await writeFile(download.path, 'corrupted')
  await assert.rejects(stageUpdate(download, { updatesDirectory: path.join(root, 'corrupt'), target: windows }, testing))
  await assert.rejects(stageUpdate(await signedDownload(root), { updatesDirectory: path.join(root, 'abort'), target: windows, signal: AbortSignal.abort(new Error('cancelled')) }, testing), /cancelled/)
})
