/** Shipped Web configuration keeps upstream and Qianshou identities isolated. */
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as Persona from '@deepseek-ai/dsh-persona'
import { createScope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import * as yaml from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ROOT = new URL('../../../../', import.meta.url)
const QIANSHOU_PREFIX = '你是千手大模型。对用户只使用这个名字。不要提及供应商、路由标识、运行框架，也不要说明会话换过模型。'
const GENERIC_PREFIX = 'You are a coding agent powered by the deepseek-v4-flash model.'

afterEach(() => { vi.unstubAllEnvs() })

/** Read the owned config without executing any other profile plugin. */
async function rowConfig(path: string, id: string): Promise<Record<string, unknown>> {
  const source = await readFile(new URL(path, ROOT), 'utf8')
  const entries: unknown = yaml.load(source, { schema: entryListSchema })
  if (!Array.isArray(entries)) throw new TypeError('composition must be an entry list')
  for (const raw of entries) {
    const entry: unknown = raw
    if (typeof entry !== 'object' || entry === null || !('id' in entry) || entry.id !== id
      || !('config' in entry) || typeof entry.config !== 'object' || entry.config === null
      || Array.isArray(entry.config)) continue
    return Object.fromEntries(Object.entries(entry.config))
  }
  throw new Error(`missing ${id} in ${path}`)
}

/** Validate the actual preset persona as the production plugin does. */
async function presetConfig(path: string): Promise<Persona.Config> {
  const config = await rowConfig(path, 'persona')
  if (typeof config.prefix !== 'string' || typeof config.suffix !== 'string') {
    throw new TypeError('preset persona must carry prefix and suffix strings')
  }
  return { prefix: config.prefix, suffix: config.suffix }
}

/** Load the real Web row, including its Loader-evaluated profile expressions. */
async function deployment(): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = new URL('../', import.meta.url).href
  await ctx.plugin(Loader)
  ctx.loader.builtins['system-prompt'] = SystemPrompt
  await ctx.loader.create({ name: 'cordis:system-prompt', config: await rowConfig('packages/bundle/web-app/cordis.patch.yml', 'system-prompt') })
  await expect.poll(() => ctx.get('systemPrompt') !== undefined).toBe(true)
  ctx.systemPrompt.variable('model', () => 'deepseek-v4-flash')
  ctx.systemPrompt.variable('cwd', () => '/test/workspace')
  return ctx
}

describe('Web persona profile isolation', () => {
  it.each(['official', ''])('retains upstream identity for profile %j and all generic presets', async (profile) => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', profile)
    const ctx = await deployment()
    try {
      const global = renderPrompt(await ctx.systemPrompt.assemble())
      expect(global).toContain('You are an AI agent powered by DeepSeek Harness.')
      expect(global).not.toContain('千手')
      for (const id of ['standard', 'cordis', 'ptc']) {
        const key: ScopeKey = { agent: id }
        const scope = createScope(ctx, key)
        await scope.ctx.plugin(Persona, await presetConfig(`packages/preset/agent-presets/presets/${id}/agent.cordis.yml`))
        const prompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))
        expect(prompt.split('\n\n').slice(0, 2)).toEqual([
          'You are an AI agent powered by DeepSeek Harness.', GENERIC_PREFIX,
        ])
        expect(prompt).not.toContain('千手')
        expect(prompt).toContain('Your working directory is /test/workspace.')
        await scope.dispose()
      }
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps Qianshou identity and each dedicated mode persona', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'qianshou')
    const ctx = await deployment()
    try {
      expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain(QIANSHOU_PREFIX)
      expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('DeepSeek Harness')
      for (const [id, prefix] of [
        ['qianshou-ceo', '你是千手 CEO'],
        ['qianshou-skill-creator', '你是千手技能创作助手'],
        ['qianshou-call', '你是千手调用助手'],
      ] as const) {
        const key: ScopeKey = { agent: id }
        const scope = createScope(ctx, key)
        await scope.ctx.plugin(Persona, await presetConfig(`qianshou/presets/${id}/agent.cordis.yml`))
        const prompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))
        expect(prompt).toContain(prefix)
        expect(prompt).not.toContain('DeepSeek Harness')
        expect(prompt).not.toContain(GENERIC_PREFIX)
        await scope.dispose()
      }
    } finally { await ctx.fiber.dispose() }
  })
})
