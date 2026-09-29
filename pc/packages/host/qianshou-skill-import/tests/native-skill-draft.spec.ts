import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NATIVE_H3_RUNTIME_ABI_V2, NATIVE_H3_RUNTIME_V2 } from '../../compute-core/src/native-h3-binding.ts'
import { nativeH3AuthoringTemplate, readNativeH3OrderSource } from '../../qianshou-plugin-catalog/src/native-h3-order-source.ts'
import { installNativeSkillDraft, type NativeSkillDraftRequest } from '../src/native-skill-draft.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const signal = (): AbortSignal => new AbortController().signal
const binding = { schema: 'qianshou.native-h3-execution-binding.v2' as const,
  runtimeAbi: NATIVE_H3_RUNTIME_ABI_V2, runtime: NATIVE_H3_RUNTIME_V2,
  executionRecipeSha256: 'a'.repeat(64), modelSha256: 'b'.repeat(64), firstFrameSha256: 'c'.repeat(64) }
async function fixture() {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'native-skill-draft-')); roots.push(home)
  const root = join(home, 'skills'); await mkdir(root)
  const name = 'h3-chinese-draft'
  const files = nativeH3AuthoringTemplate(binding, name, 'qianshou_h3_fixture_v2').files
  files['SKILL.md'] = `---\nname: ${name}\ndescription: 五秒中文视频草稿\nmetadata:\n  displayName: 我的 H3 视频\n---\n\n# 我的 H3 视频\n描述视频内容后生成五秒视频。保存草稿不会投稿、审核或接单。\n`
  const request: NativeSkillDraftRequest = { name, files, assertCurrent: vi.fn(async () => {}),
    verifyWritten: vi.fn<NativeSkillDraftRequest['verifyWritten']>(async (path) => {
      const source = await readNativeH3OrderSource(path)
      expect(source.taskDefinition.nativeBinding).toEqual(binding)
      expect(source.declaration.contractVersion).toBe('v2')
    }) }
  return { home, root, request, target: join(root, name, 'SKILL.md') }
}

it('writes and verifies exactly five real files, with Chinese metadata and no private config', async () => {
  const f = await fixture(); let phases = 0
  const assertCurrent = vi.fn(async () => {
    phases++
    if (phases === 2) {
      expect(await readdir(join(f.root, f.request.name, 'scripts/order_adapter'))).toHaveLength(4)
      await expect(readFile(f.target)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })
  const receipt = await installNativeSkillDraft(f.root, { ...f.request, assertCurrent }, signal())
  expect(receipt).toMatchObject({ state: 'written', name: f.request.name, path: f.target })
  expect(receipt.files).toHaveLength(5)
  expect(await readFile(f.target, 'utf8')).toContain('displayName: 我的 H3 视频')
  for (const file of receipt.files) {
    const bytes = await readFile(join(dirname(f.target), file.path))
    expect(bytes.length).toBe(file.bytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256)
    expect(bytes.toString()).not.toContain('ownerConfigDigest')
  }
  expect(f.request.verifyWritten).toHaveBeenCalledWith(f.target)
  expect(await readdir(dirname(f.target))).toEqual(['SKILL.md', 'scripts'])
})

it.each(['directory', 'flat', 'case'])('does not overwrite an existing %s skill', async (shape) => {
  const f = await fixture()
  const path = join(f.root, shape === 'flat' ? f.request.name + '.md' : shape === 'case' ? f.request.name.toUpperCase() : f.request.name)
  if (shape === 'flat') await writeFile(path, 'existing flat skill')
  else { await mkdir(path); await writeFile(join(path, 'keep.txt'), 'existing folder') }
  await expect(installNativeSkillDraft(f.root, f.request, signal())).rejects.toThrow('NATIVE_SKILL_DRAFT_CONFLICT')
  expect(await readFile(shape === 'flat' ? path : join(path, 'keep.txt'), 'utf8')).toContain('existing')
})

it.each(['con', 'lpt1', '../outside', 'UPPER'])('rejects unsafe or Windows-reserved name %s', async (name) => {
  const f = await fixture()
  await expect(installNativeSkillDraft(f.root, { ...f.request, name }, signal())).rejects.toThrow('NATIVE_SKILL_DRAFT_INVALID')
  expect(await readdir(f.root)).toEqual([])
})

it('rolls back its unchanged files when the author changes before SKILL becomes visible', async () => {
  const f = await fixture(); let phases = 0
  const assertCurrent = async () => { if (++phases === 2) throw new Error('current author changed') }
  await expect(installNativeSkillDraft(f.root, { ...f.request, assertCurrent }, signal())).rejects.toThrow('current author changed')
  expect(await readdir(f.root)).toEqual([])
  expect(f.request.verifyWritten).not.toHaveBeenCalled()
})

it('preserves externally changed bytes during rollback rather than recursively deleting the folder', async () => {
  const f = await fixture(); let phases = 0
  const modified = join(dirname(f.target), 'scripts/order_adapter/package.json')
  const assertCurrent = async () => {
    if (++phases === 2) { await writeFile(modified, 'new user bytes'); throw new Error('source changed') }
  }
  await expect(installNativeSkillDraft(f.root, { ...f.request, assertCurrent }, signal())).rejects.toThrow('source changed')
  expect(await readFile(modified, 'utf8')).toBe('new user bytes')
  await expect(readFile(f.target)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects invalid written native metadata through the actual source reader and removes its own draft', async () => {
  const f = await fixture()
  const files = { ...f.request.files, 'scripts/order_adapter/package.json': '{"scripts":{"postinstall":"unsafe"}}' }
  await expect(installNativeSkillDraft(f.root, { ...f.request, files }, signal())).rejects.toThrow()
  expect(await readdir(f.root)).toEqual([])
  expect(f.request.verifyWritten).toHaveBeenCalled()
})

it('never follows a symlinked root or a swapped transaction directory', async () => {
  const f = await fixture(); const linkedRoot = join(f.home, 'linked'); await symlink(f.root, linkedRoot)
  await expect(installNativeSkillDraft(linkedRoot, f.request, signal())).rejects.toThrow('NATIVE_SKILL_DRAFT_INVALID')
  let phases = 0
  const original = dirname(f.target); const moved = join(f.root, 'kept-original')
  const assertCurrent = async () => {
    if (++phases === 2) { await rename(original, moved); await symlink(moved, original) }
  }
  await expect(installNativeSkillDraft(f.root, { ...f.request, assertCurrent }, signal())).rejects.toThrow()
  expect(await readFile(join(moved, 'scripts/order_adapter/package.json'), 'utf8')).toBe(f.request.files['scripts/order_adapter/package.json'])
  await expect(readFile(join(moved, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('honors cancellation before publication and never exposes a partial SKILL', async () => {
  const f = await fixture(); const controller = new AbortController(); let phases = 0
  const assertCurrent = async () => { if (++phases === 2) controller.abort(new Error('cancelled by author')) }
  await expect(installNativeSkillDraft(f.root, { ...f.request, assertCurrent }, controller.signal)).rejects.toThrow('cancelled by author')
  expect(await readdir(f.root)).toEqual([])
})

it('rechecks a late flat-name conflict and preserves the foreign skill while removing only its own draft', async () => {
  const f = await fixture(); let phases = 0
  const foreign = join(f.root, f.request.name + '.md')
  const assertCurrent = async () => { if (++phases === 2) await writeFile(foreign, 'foreign flat skill') }
  await expect(installNativeSkillDraft(f.root, { ...f.request, assertCurrent }, signal())).rejects.toThrow('NATIVE_SKILL_DRAFT_INVALID')
  expect(await readdir(f.root)).toEqual([f.request.name + '.md'])
  expect(await readFile(foreign, 'utf8')).toBe('foreign flat skill')
})
