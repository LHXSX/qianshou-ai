import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import QianshouSkillImport from '../src/index.ts'
import { archiveLocalSkill } from '../src/archive-local-skill.ts'
import type { LocalSkillArchiveRequest } from '../src/types.ts'

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })
const signal = (): AbortSignal => new AbortController().signal
const content = '---\nname: local-example\ndescription: Local example\n---\n\nRun locally.\n'
const sha256 = createHash('sha256').update(content).digest('hex')

async function fixture(flat = false): Promise<{ ctx: Context; home: string; root: string; request: LocalSkillArchiveRequest }> {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'qianshou-archive-'))
  homes.push(home)
  const root = join(home, 'skills')
  const ctx = new Context()
  await ctx.plugin(QianshouSkillImport, { installRoot: root, agentsRoot: join(home, 'agents-skills') })
  const path = flat ? join(root, 'local-example.md') : join(root, 'local-example', 'SKILL.md')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  return { ctx, home, root, request: { source: 'user-dsh', name: 'local-example', path, sha256 } }
}

it('archives complete author files outside discovery and restores without changing their bytes', async () => {
  const { ctx, request } = await fixture()
  try {
    await mkdir(join(dirname(request.path), 'scripts'))
    await writeFile(join(dirname(request.path), 'scripts', 'run.py'), 'print("local")\n')
    expect((await ctx.qianshouSkillImport.listLocal()).skills[0]).toMatchObject({ sha256, canArchive: true })
    const receipt = await ctx.qianshouSkillImport.archiveLocal(request, signal())
    expect(receipt).toMatchObject({ state: 'archived', name: request.name, originalPath: dirname(request.path), sha256 })
    expect(await readFile(join(receipt.archivePath, 'scripts/run.py'), 'utf8')).toBe('print("local")\n')
    expect(JSON.parse(await readFile(receipt.receiptPath, 'utf8'))).toMatchObject(receipt)
    expect((await ctx.qianshouSkillImport.listLocal()).skills).toEqual([])
    await rename(receipt.archivePath, receipt.originalPath)
    expect(await readFile(request.path, 'utf8')).toBe(content)
    expect((await ctx.qianshouSkillImport.listLocal()).skills).toHaveLength(1)
  } finally { await ctx.fiber.dispose() }
})

it('archives a flat skill file and supports the independent shared user root', async () => {
  const { ctx, home, request } = await fixture(true)
  try {
    const sharedPath = join(home, 'agents-skills/local-example/SKILL.md')
    await mkdir(dirname(sharedPath), { recursive: true }); await writeFile(sharedPath, content)
    const first = await ctx.qianshouSkillImport.archiveLocal(request, signal())
    expect(first.originalPath).toBe(request.path)
    expect(await readFile(first.archivePath, 'utf8')).toBe(content)
    const second = await ctx.qianshouSkillImport.archiveLocal({ ...request, source: 'user-agents', path: sharedPath }, signal())
    expect(await readFile(join(second.archivePath, 'SKILL.md'), 'utf8')).toBe(content)
    expect((await ctx.qianshouSkillImport.listLocal()).skills).toEqual([])
  } finally { await ctx.fiber.dispose() }
})

it('refuses changed instructions, another root and installed runtime paths without moving files', async () => {
  const { ctx, home, root, request } = await fixture()
  try {
    await writeFile(request.path, content + 'Changed.\n')
    await expect(ctx.qianshouSkillImport.archiveLocal(request, signal())).rejects.toMatchObject({ code: 'skill-import/changed' })
    await writeFile(request.path, content)
    for (const path of [join(root, '..', 'local-example/SKILL.md'), join(home, 'qianshou/order-adapter-runtime/local-example/SKILL.md')]) {
      await expect(archiveLocalSkill({ ...request, path }, [{ source: 'user-dsh', path: root }], signal()))
        .rejects.toMatchObject({ code: 'skill-import/unsafe-path' })
    }
    expect(await readFile(request.path, 'utf8')).toBe(content)
  } finally { await ctx.fiber.dispose() }
})

it('refuses managed installation markers and the selected node adapter', async () => {
  const { ctx, home, request } = await fixture()
  try {
    await writeFile(join(dirname(request.path), 'local-install.json'), '{"schema":"qianshou.order-adapter-local-install.v1"}')
    expect((await ctx.qianshouSkillImport.listLocal()).skills[0]?.canArchive).toBe(false)
    await expect(ctx.qianshouSkillImport.archiveLocal(request, signal())).rejects.toMatchObject({ code: 'skill-import/managed' })
    await rm(join(dirname(request.path), 'local-install.json'))
    ctx.provide('profileContext', { dir: home })
    await writeFile(join(home, 'qianshou-artifact-adapter.json'), JSON.stringify({ root: join(dirname(request.path), 'scripts/order_adapter') }))
    await expect(ctx.qianshouSkillImport.archiveLocal(request, signal())).rejects.toMatchObject({ code: 'skill-import/in-use' })
    expect(await readFile(request.path, 'utf8')).toBe(content)
  } finally { await ctx.fiber.dispose() }
})

it('rejects selected links and unsafe archive parents without following or changing their targets', async () => {
  const { ctx, home, root, request } = await fixture()
  try {
    const other = join(home, 'outside'); await mkdir(other)
    await symlink(other, join(home, '.qianshou-skill-archives'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(ctx.qianshouSkillImport.archiveLocal(request, signal())).rejects.toMatchObject({ code: 'skill-import/unsafe-path' })
    await rm(join(home, '.qianshou-skill-archives'))
    await rename(dirname(request.path), join(home, 'real-skill'))
    await symlink(join(home, 'real-skill'), dirname(request.path), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(archiveLocalSkill(request, [{ source: 'user-dsh', path: root }], signal()))
      .rejects.toMatchObject({ code: 'skill-import/unsafe-path' })
    expect(await readFile(join(home, 'real-skill/SKILL.md'), 'utf8')).toBe(content)
  } finally { await ctx.fiber.dispose() }
})

it('moves nested links as opaque directory entries and never reads their targets', async () => {
  const { ctx, home, request } = await fixture()
  try {
    const outside = join(home, 'outside'); await mkdir(outside)
    await writeFile(join(outside, 'keep.txt'), 'unchanged')
    await symlink(outside, join(dirname(request.path), 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await ctx.qianshouSkillImport.archiveLocal(request, signal())
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('unchanged')
  } finally { await ctx.fiber.dispose() }
})

it('does not move a skill when cancelled before the atomic archive', async () => {
  const { ctx, request } = await fixture()
  try {
    const cancelled = new AbortController(); cancelled.abort()
    await expect(ctx.qianshouSkillImport.archiveLocal(request, cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(await readFile(request.path, 'utf8')).toBe(content)
  } finally { await ctx.fiber.dispose() }
})
