import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { afterEach, expect, it, vi } from 'vitest'
import { verifyDesktopAgentStartup } from '../src/agent-startup.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.unstubAllEnvs()
})

async function roster(skillComposition = '[]\n', callComposition = '[]\n'): Promise<Context> {
  const home = await mkdtemp(join(tmpdir(), 'qianshou-agent-startup-'))
  roots.push(home)
  const presetRoot = join(home, 'immutable-presets')
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'qianshou')
  vi.stubEnv('QIANSHOU_PRESET_ROOT', presetRoot)
  for (const [id, source] of [['qianshou-ceo', '[]\n'], ['qianshou-skill-creator', skillComposition],
    ['qianshou-call', callComposition]] as const) {
    await mkdir(join(presetRoot, id), { recursive: true })
    await writeFile(join(presetRoot, id, 'agent.cordis.yml'), source)
  }
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(home).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(SessionProjectionRegistry)
  // A retained old roster cannot replace the packaged product's immutable root.
  await ctx.plugin(AgentPresets, { default: 'standard', roots: [], includeShippedRoot: true, includeUserRoot: true })
  return ctx
}

it('mounts all three real standing modes without creating agents, sessions, or calling a model', async () => {
  const ctx = await roster()
  await expect(verifyDesktopAgentStartup(ctx, 'qianshou')).resolves.toBeUndefined()
  const ceo = await ctx.agentPresets.standingKeyFor('qianshou-ceo')
  const creator = await ctx.agentPresets.standingKeyFor('qianshou-skill-creator')
  expect(ceo).toEqual({ agentPreset: 'qianshou-ceo' })
  expect(creator).toEqual({ agentPreset: 'qianshou-skill-creator' })
  expect(await ctx.agentPresets.standingKeyFor('qianshou-call')).toEqual({ agentPreset: 'qianshou-call' })
  expect(ctx.get('agents')).toBeUndefined()
  expect(ctx.get('sessions')).toBeUndefined()
  expect(ctx.get('llm')).toBeUndefined()
})

it('rejects readiness when the third calling mode cannot initialize', async () => {
  const plugin = new URL('../../../packages/preset/agent-presets/tests/fixtures/plugins/throws.js', import.meta.url)
  const ctx = await roster('[]\n', `- name: ${plugin.href}\n  config:\n    message: missing calling export\n`)
  await expect(verifyDesktopAgentStartup(ctx, 'qianshou'))
    .rejects.toThrow('desktop agent startup: qianshou-call could not mount')
})

it('rejects a composition that resolves on disk but fails during actual module initialization', async () => {
  const plugin = new URL('../../../packages/preset/agent-presets/tests/fixtures/plugins/throws.js', import.meta.url)
  const ctx = await roster(`- name: ${plugin.href}\n  config:\n    message: missing module export\n`)
  const failure = await verifyDesktopAgentStartup(ctx, 'qianshou').catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  expect(failure).toMatchObject({ message: 'desktop agent startup: qianshou-skill-creator could not mount',
    cause: expect.objectContaining({ message: expect.stringContaining('failed to mount') }) })
})

it('refuses Qianshou readiness without its owner while leaving the official profile unchanged', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await expect(verifyDesktopAgentStartup(ctx, 'qianshou')).rejects.toThrow('preset service is unavailable')
  await expect(verifyDesktopAgentStartup(ctx, 'official')).resolves.toBeUndefined()
})
