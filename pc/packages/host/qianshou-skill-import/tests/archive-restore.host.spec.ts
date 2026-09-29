import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import QianshouSkillImport from '../src/index.ts'
import type { LocalSkillArchiveRequest, LocalSkillRestoreRequest } from '../src/types.ts'

const homes: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})
const signal = (): AbortSignal => new AbortController().signal
const content = '---\nname: local-example\ndescription: 本机示例\nmetadata:\n  displayName: 中文示例\n---\n\n# 中文示例\nRun locally.\n'
const sha256 = createHash('sha256').update(content).digest('hex')

async function fixture(flat = false, source: LocalSkillArchiveRequest['source'] = 'user-dsh') {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'qianshou-restore-'))
  homes.push(home)
  const root = join(home, 'skills')
  const agentsRoot = join(home, 'agents-skills')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(QianshouSkillImport, { installRoot: root, agentsRoot })
  const path = flat ? join(root, 'local-example.md') : join(source === 'user-dsh' ? root : agentsRoot, 'local-example', 'SKILL.md')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  const request: LocalSkillArchiveRequest = { source, name: 'local-example', path, sha256 }
  return { home, root, ctx, request }
}

it.each([{ flat: false, source: 'user-dsh' as const }, { flat: true, source: 'user-dsh' as const },
  { flat: false, source: 'user-agents' as const }])('lists and restores exact local bytes without publishing: $source/$flat', async ({ flat, source }) => {
  const { ctx, request } = await fixture(flat, source)
  if (!flat) {
    await mkdir(join(dirname(request.path), 'scripts'))
    await writeFile(join(dirname(request.path), 'scripts/run.py'), '# author bytes\n', { mode: 0o700 })
  }
  const archive = await ctx.qianshouSkillImport.archiveLocal(request, signal())
  const items = (await ctx.qianshouSkillImport.archiveList()).items
  expect(items).toHaveLength(1)
  const entry = items[0]!
  expect(entry).toMatchObject({ source, name: request.name, sha256, displayName: '中文示例' })
  const receipt = await ctx.qianshouSkillImport.restoreLocal({ source, archiveId: entry.archiveId, sha256 }, signal())
  expect(receipt).toMatchObject({ state: 'restored', path: request.path, sha256 })
  expect(await readFile(request.path, 'utf8')).toBe(content)
  if (!flat) expect(await readFile(join(dirname(request.path), 'scripts/run.py'), 'utf8')).toBe('# author bytes\n')
  expect(await readFile(flat ? archive.archivePath : join(archive.archivePath, 'SKILL.md'), 'utf8')).toBe(content)
  expect((await ctx.qianshouSkillImport.archiveList()).items).toEqual([])
  expect((await ctx.qianshouSkillImport.listLocal()).skills).toHaveLength(1)
})

it.each(['directory', 'flat'])('refuses a conflicting %s name and preserves both original and backup', async (kind) => {
  const { ctx, root, request } = await fixture()
  const archive = await ctx.qianshouSkillImport.archiveLocal(request, signal())
  const entry = (await ctx.qianshouSkillImport.archiveList()).items[0]!
  const conflict = kind === 'flat' ? join(root, 'local-example.md') : join(root, 'local-example/keep.txt')
  await mkdir(dirname(conflict), { recursive: true }); await writeFile(conflict, 'keep my new files')
  await expect(ctx.qianshouSkillImport.restoreLocal({ source: request.source, archiveId: entry.archiveId, sha256 }, signal()))
    .rejects.toMatchObject({ code: 'skill-import/conflict' })
  expect(await readFile(conflict, 'utf8')).toBe('keep my new files')
  expect(await readFile(join(archive.archivePath, 'SKILL.md'), 'utf8')).toBe(content)
})

it('rejects forged destination, wrong source, changed digest and a receipt link', async () => {
  const { ctx, home, request } = await fixture()
  const archive = await ctx.qianshouSkillImport.archiveLocal(request, signal())
  const entry = (await ctx.qianshouSkillImport.archiveList()).items[0]!
  const restore: LocalSkillRestoreRequest = { source: request.source, archiveId: entry.archiveId, sha256 }
  const saved = await readFile(archive.receiptPath, 'utf8')
  await writeFile(archive.receiptPath, JSON.stringify({ ...JSON.parse(saved), originalPath: join(home, 'outside') }))
  expect((await ctx.qianshouSkillImport.archiveList()).items).toEqual([])
  await expect(ctx.qianshouSkillImport.restoreLocal(restore, signal())).rejects.toMatchObject({ code: 'skill-import/unsafe-path' })
  await writeFile(archive.receiptPath, saved)
  await expect(ctx.qianshouSkillImport.restoreLocal({ ...restore, source: 'user-agents' }, signal()))
    .rejects.toMatchObject({ code: 'skill-import/unsafe-path' })
  await writeFile(join(archive.archivePath, 'SKILL.md'), content + 'changed')
  await expect(ctx.qianshouSkillImport.restoreLocal(restore, signal())).rejects.toMatchObject({ code: 'skill-import/changed' })
  await writeFile(join(archive.archivePath, 'SKILL.md'), content)
  const outside = join(home, 'outside.json'); await writeFile(outside, saved)
  await rm(archive.receiptPath); await symlink(outside, archive.receiptPath)
  expect((await ctx.qianshouSkillImport.archiveList()).items).toEqual([])
  await expect(ctx.qianshouSkillImport.restoreLocal(restore, signal())).rejects.toThrow()
  expect(await readFile(outside, 'utf8')).toBe(saved)
})

it('refuses frontmatter name mismatch even when a local manifest digest was changed to match', async () => {
  const { ctx, request } = await fixture()
  const archive = await ctx.qianshouSkillImport.archiveLocal(request, signal())
  const entry = (await ctx.qianshouSkillImport.archiveList()).items[0]!
  const changed = content.replace('name: local-example', 'name: different-name')
  const digest = createHash('sha256').update(changed).digest('hex')
  await writeFile(join(archive.archivePath, 'SKILL.md'), changed)
  await writeFile(archive.receiptPath, JSON.stringify({ ...JSON.parse(await readFile(archive.receiptPath, 'utf8')), sha256: digest }))
  expect((await ctx.qianshouSkillImport.archiveList()).items).toEqual([])
  await expect(ctx.qianshouSkillImport.restoreLocal({ source: request.source, archiveId: entry.archiveId, sha256: digest }, signal()))
    .rejects.toMatchObject({ code: 'skill-import/changed' })
})

it('does not restore on cancellation and never follows nested links into their target', async () => {
  const { ctx, home, request } = await fixture()
  const outside = join(home, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep'), 'untouched')
  await symlink(outside, join(dirname(request.path), 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await ctx.qianshouSkillImport.archiveLocal(request, signal())
  const entry = (await ctx.qianshouSkillImport.archiveList()).items[0]!
  const restore = { source: request.source, archiveId: entry.archiveId, sha256 }
  const cancelled = new AbortController(); cancelled.abort()
  await expect(ctx.qianshouSkillImport.restoreLocal(restore, cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect((await ctx.qianshouSkillImport.listLocal()).skills).toEqual([])
  await ctx.qianshouSkillImport.restoreLocal(restore, signal())
  expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('untouched')
})

it('permits only one concurrent restoration and rejects arbitrary archive ids', async () => {
  const { ctx, request } = await fixture()
  await ctx.qianshouSkillImport.archiveLocal(request, signal())
  const entry = (await ctx.qianshouSkillImport.archiveList()).items[0]!
  const restore = { source: request.source, archiveId: entry.archiveId, sha256 }
  const results = await Promise.allSettled([ctx.qianshouSkillImport.restoreLocal(restore, signal()),
    ctx.qianshouSkillImport.restoreLocal(restore, signal())])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  await expect(ctx.qianshouSkillImport.restoreLocal({ ...restore, archiveId: '../../outside' }, signal()))
    .rejects.toMatchObject({ code: 'skill-import/invalid' })
})

it('refuses recovery into a currently saved node binding without changing files or grants', async () => {
  const { ctx, home, request } = await fixture()
  const archive = await ctx.qianshouSkillImport.archiveLocal(request, signal())
  const entry = (await ctx.qianshouSkillImport.archiveList()).items[0]!
  ctx.provide('profileContext', { dir: home })
  const binding = JSON.stringify({ root: join(dirname(request.path), 'scripts/order_adapter') })
  await writeFile(join(home, 'qianshou-artifact-adapter.json'), binding)
  await expect(ctx.qianshouSkillImport.restoreLocal({ source: request.source, archiveId: entry.archiveId, sha256 }, signal()))
    .rejects.toMatchObject({ code: 'skill-import/in-use' })
  expect((await ctx.qianshouSkillImport.listLocal()).skills).toEqual([])
  expect(await readFile(join(archive.archivePath, 'SKILL.md'), 'utf8')).toBe(content)
  expect(await readFile(join(home, 'qianshou-artifact-adapter.json'), 'utf8')).toBe(binding)
})
