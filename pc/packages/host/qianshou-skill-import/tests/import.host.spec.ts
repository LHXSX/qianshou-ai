import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import QianshouSkillImport, { MAX_SKILL_IMPORT_BYTES } from '../src/index.ts'

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })

async function service(): Promise<{ ctx: Context; root: string }> {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'qianshou-skill-import-'))
  homes.push(home)
  const root = join(home, 'skills')
  const ctx = new Context()
  await ctx.plugin(QianshouSkillImport, { installRoot: root })
  return { ctx, root }
}

const skill = (name = 'sample-skill'): string => `---\nname: ${name}\ndescription: Sample task\n---\n\nUse the sample skill.\n`
const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex')

it('returns the live configured authoring root and exact destination without creating it', async () => {
  const { ctx, root } = await service()
  try {
    expect(await ctx.qianshouSkillImport.authoringContext('new-skill')).toEqual({
      roots: [{ path: root, source: 'user-dsh', exists: false, hostWritable: true }],
      destination: { source: 'user-dsh', directory: join(root, 'new-skill'),
        skillFile: join(root, 'new-skill', 'SKILL.md'), conflict: false },
    })
    await expect(readFile(join(root, 'new-skill', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    await mkdir(root)
    await writeFile(join(root, 'new-skill.md'), skill('new-skill'))
    expect((await ctx.qianshouSkillImport.authoringContext('new-skill')).destination?.conflict).toBe(true)
    await expect(ctx.qianshouSkillImport.authoringContext('../other')).rejects.toMatchObject({ code: 'skill-import/invalid' })
  } finally { await ctx.fiber.dispose() }
})

it('reports unsafe authoring roots and selects only an independently configured ready root', async () => {
  const { ctx, root } = await service()
  const other = new Context()
  try {
    await mkdir(root)
    const target = join(root, 'target')
    await mkdir(target)
    const link = join(root, 'linked')
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    const shared = join(root, 'shared')
    await other.plugin(QianshouSkillImport, { installRoot: link, agentsRoot: shared })
    const result = await other.qianshouSkillImport.authoringContext('new-skill')
    expect(result.roots).toEqual([
      { path: link, source: 'user-dsh', exists: false, hostWritable: false, problem: 'unsafe-path' },
      { path: shared, source: 'user-agents', exists: false, hostWritable: true },
    ])
    expect(result.destination).toMatchObject({ source: 'user-agents', directory: join(shared, 'new-skill') })
  } finally { await other.fiber.dispose(); await ctx.fiber.dispose() }
})

it('inspects exact bytes before publishing a verified disk-only receipt', async () => {
  const { ctx, root } = await service()
  try {
    const content = skill()
    const inspection = await ctx.qianshouSkillImport.inspect(content)
    expect(inspection).toMatchObject({ name: 'sample-skill', bytes: Buffer.byteLength(content), targetPath: join(root, 'sample-skill', 'SKILL.md') })
    const receipt = await ctx.qianshouSkillImport.install(inspection.inspectionId, new AbortController().signal)
    expect(receipt).toEqual({ state: 'written', name: 'sample-skill', sha256: inspection.sha256, path: inspection.targetPath, bytes: inspection.bytes })
    expect(await readFile(receipt.path, 'utf8')).toBe(content)
    await expect(ctx.qianshouSkillImport.install(inspection.inspectionId, new AbortController().signal)).rejects.toMatchObject({ code: 'skill-import/expired' })
  } finally { await ctx.fiber.dispose() }
})

it('rejects malformed, non-UTF-8 and oversized instruction text before writing', async () => {
  const { ctx, root } = await service()
  try {
    const exact = skill() + 'x'.repeat(MAX_SKILL_IMPORT_BYTES - Buffer.byteLength(skill()))
    expect((await ctx.qianshouSkillImport.inspect(exact)).bytes).toBe(MAX_SKILL_IMPORT_BYTES)
    for (const content of ['hello', '---\nname: Bad/Name\ndescription: test\n---\nbody', skill().replace('Sample task', ''), `${skill()}\ud800`, `${skill()}\0`, `${skill()}\uFFFD`, `${skill()}${'中'.repeat(Math.floor(MAX_SKILL_IMPORT_BYTES / 3))}`]) {
      await expect(ctx.qianshouSkillImport.inspect(content)).rejects.toMatchObject({ code: 'skill-import/invalid' })
    }
    await expect(readFile(join(root, 'sample-skill', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await ctx.fiber.dispose() }
})

it('refuses existing bundles, flat skills and symlinked roots or names', async () => {
  const { ctx, root } = await service()
  try {
    await mkdir(root)
    await writeFile(join(root, 'sample-skill.md'), skill())
    await expect(ctx.qianshouSkillImport.inspect(skill())).rejects.toMatchObject({ code: 'skill-import/conflict' })
    await rm(join(root, 'sample-skill.md'))
    const elsewhere = join(root, 'elsewhere')
    await mkdir(elsewhere)
    await symlink(elsewhere, join(root, 'sample-skill'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(ctx.qianshouSkillImport.inspect(skill())).rejects.toMatchObject({ code: 'skill-import/conflict' })
    await unlink(join(root, 'sample-skill'))
    const inspection = await ctx.qianshouSkillImport.inspect(skill())
    await symlink(elsewhere, join(root, 'sample-skill'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(ctx.qianshouSkillImport.install(inspection.inspectionId, new AbortController().signal)).rejects.toMatchObject({ code: 'skill-import/conflict' })
  } finally { await ctx.fiber.dispose() }
})

it('refuses a symlink in the controlled root path', async () => {
  const { ctx, root } = await service()
  try {
    const actual = join(root, 'actual')
    await mkdir(root)
    await mkdir(actual)
    const link = join(root, 'linked')
    await symlink(actual, link, process.platform === 'win32' ? 'junction' : 'dir')
    const ctx2 = new Context()
    try {
      await ctx2.plugin(QianshouSkillImport, { installRoot: join(link, 'skills') })
      await expect(ctx2.qianshouSkillImport.inspect(skill())).rejects.toMatchObject({ code: 'skill-import/unsafe-path' })
    } finally { await ctx2.fiber.dispose() }
  } finally { await ctx.fiber.dispose() }
})

it('verifies exact bytes after an uncertain install response without claiming Session discovery', async () => {
  const { ctx, root } = await service()
  try {
    const content = skill()
    const hash = sha256(content)
    expect(await ctx.qianshouSkillImport.verify('sample-skill', hash)).toEqual({ state: 'missing' })
    const inspection = await ctx.qianshouSkillImport.inspect(content)
    await ctx.qianshouSkillImport.install(inspection.inspectionId, new AbortController().signal)
    expect(await ctx.qianshouSkillImport.verify('sample-skill', hash)).toEqual({ state: 'matched' })
    expect(await ctx.qianshouSkillImport.verify('sample-skill', '0'.repeat(64))).toEqual({ state: 'different' })
    const path = join(root, 'sample-skill', 'SKILL.md')
    await writeFile(path, `${content}changed`)
    expect(await ctx.qianshouSkillImport.verify('sample-skill', hash)).toEqual({ state: 'different' })
    await writeFile(path, 'x'.repeat(MAX_SKILL_IMPORT_BYTES + 1))
    expect(await ctx.qianshouSkillImport.verify('sample-skill', hash)).toEqual({ state: 'different' })
    await unlink(path)
    expect(await ctx.qianshouSkillImport.verify('sample-skill', hash)).toEqual({ state: 'missing' })
    await expect(ctx.qianshouSkillImport.verify('../escape', hash)).rejects.toMatchObject({ code: 'skill-import/invalid' })
    await expect(ctx.qianshouSkillImport.verify('sample-skill', hash.toUpperCase())).rejects.toMatchObject({ code: 'skill-import/invalid' })
  } finally { await ctx.fiber.dispose() }
})

it('reports symlinked directories and files as different without reading their target', async () => {
  const { ctx, root } = await service()
  try {
    await mkdir(root)
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'SKILL.md'), skill('linked-skill'))
    await symlink(outside, join(root, 'linked-skill'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await ctx.qianshouSkillImport.verify('linked-skill', sha256(skill('linked-skill')))).toEqual({ state: 'different' })
    if (process.platform !== 'win32') {
      await mkdir(join(root, 'file-link'))
      await symlink(join(outside, 'SKILL.md'), join(root, 'file-link', 'SKILL.md'), 'file')
      expect(await ctx.qianshouSkillImport.verify('file-link', sha256(skill('linked-skill')))).toEqual({ state: 'different' })
    }
  } finally { await ctx.fiber.dispose() }
})

it('lists valid local user skills, including the shared agents root, without following links', async () => {
  const { ctx, root } = await service()
  const agentsRoot = join(root, '..', 'agents-skills')
  const shared = new Context()
  try {
    await mkdir(root)
    await mkdir(join(root, 'local-video'))
    await writeFile(join(root, 'local-video', 'SKILL.md'), [
      '---', 'name: local-video', 'description: 制作视频',
      'metadata:', '  displayName: 视频制作', '  category: video', '---', '', '# 视频工作流', '', '生成视频。', '',
    ].join('\n'))
    await mkdir(agentsRoot)
    await writeFile(join(agentsRoot, 'shared-text.md'), skill('shared-text'))
    await mkdir(join(agentsRoot, 'invalid-name'))
    await writeFile(join(agentsRoot, 'invalid-name', 'SKILL.md'), skill('different-name'))
    await symlink(join(root, 'local-video'), join(agentsRoot, 'linked-video'), process.platform === 'win32' ? 'junction' : 'dir')
    await shared.plugin(QianshouSkillImport, { installRoot: root, agentsRoot })
    expect(await shared.qianshouSkillImport.listLocal()).toEqual({ skills: [
      {
        name: 'local-video', displayName: '视频制作', description: '制作视频', category: 'video',
        source: 'user-dsh', path: join(root, 'local-video', 'SKILL.md'), updatedAt: expect.any(Number),
        modelInvocable: true, userInvocable: true, canArchive: true,
        sha256: sha256(await readFile(join(root, 'local-video', 'SKILL.md'), 'utf8')),
      },
      {
        name: 'shared-text', displayName: 'shared-text', description: 'Sample task',
        source: 'user-agents', path: join(agentsRoot, 'shared-text.md'), updatedAt: expect.any(Number),
        modelInvocable: true, userInvocable: true, canArchive: true, sha256: sha256(skill('shared-text')),
      },
    ] })
  } finally {
    await shared.fiber.dispose()
    await ctx.fiber.dispose()
  }
})

it('sweeps expired preflight text and clears pending text when the plugin stops', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  const { ctx } = await service()
  const owner = ctx.qianshouSkillImport as unknown as { pending: Map<string, unknown> }
  try {
    await ctx.qianshouSkillImport.inspect(skill())
    expect(owner.pending.size).toBe(1)
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(owner.pending.size).toBe(0)
    await ctx.qianshouSkillImport.inspect(skill())
    expect(owner.pending.size).toBe(1)
  } finally {
    await ctx.fiber.dispose()
    expect(owner.pending.size).toBe(0)
    vi.useRealTimers()
  }
})
