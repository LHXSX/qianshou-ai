import { execFile } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '../src/index.ts'

const skillDirectory = fileURLToPath(new URL('../../../../qianshou/presets/qianshou-skill-creator/skills/', import.meta.url))
const verifier = fileURLToPath(new URL('../../../../qianshou/presets/qianshou-skill-creator/scripts/verify-plugin.mjs', import.meta.url))
const legalPlugin = fileURLToPath(new URL('../../../../qianshou/plugins/legal-preflight/', import.meta.url))
const execFileAsync = promisify(execFile)

describe('shipped Qianshou skill creator', () => {
  it('discovers and loads the bundled skill instructions', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, {
      includeDefaultRoots: false,
      customSkillDirs: [skillDirectory],
      watch: false,
    })
    const list = await ctx.skills.list()
    expect(list.map(skill => skill.name).sort()).toEqual(['plugin-author', 'skill-creator'])
    const loaded = await ctx.skills.get('skill-creator')
    expect(loaded?.content).toContain('展示可审阅的草稿')
    expect(loaded?.content).toContain('plugin-author')
    const author = await ctx.skills.get('plugin-author')
    expect(author?.content).toContain('至少试用一个成功输入和一个应拒绝的输入')
    expect(author?.content).toContain('不改期望值去迁就实现')
    await ctx.fiber.dispose()
  })

  it('runs a new multi-operation legal preflight bundle and rejects a false golden result', async () => {
    const verified = await execFileAsync(process.execPath, [verifier, legalPlugin], { timeout: 45_000 })
    expect(JSON.parse(verified.stdout)).toMatchObject({ status: 'passed', packageName: 'qianshou-legal-preflight',
      toolNames: ['qianshou_legal_redact', 'qianshou_legal_terms', 'qianshou_calendar_add'], samplesPassed: 9 })
    const temporary = await mkdtemp(join(tmpdir(), 'qianshou-plugin-verifier-'))
    try {
      await cp(legalPlugin, temporary, { recursive: true })
      const path = join(temporary, 'qianshou.contract.json')
      const contract = JSON.parse(await readFile(path, 'utf8')) as {
        operations: { samples: { expected: { redacted: string } }[] }[]
      }
      const sample = contract.operations[0]?.samples[0]
      if (!sample) throw new Error('The legal preflight fixture must contain its redaction golden sample')
      sample.expected.redacted = '错误期望值'
      await writeFile(path, JSON.stringify(contract))
      await expect(execFileAsync(process.execPath, [verifier, temporary], { timeout: 45_000 }))
        .rejects.toThrow(/golden sample/u)
    } finally { await rm(temporary, { recursive: true, force: true }) }
  })
})
