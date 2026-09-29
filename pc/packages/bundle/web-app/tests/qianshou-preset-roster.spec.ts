import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { interpolate } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

const patchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const productRoot = fileURLToPath(new URL('../../../../qianshou/presets/', import.meta.url))

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllEnvs()
})

function rosterConfig() {
  const row = loadOverlayPatches('preset-roster-test', patchPath)
    .flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'agent-presets')
  expect(row).toBeDefined()
  return interpolate({}, row!.config) as {
    default: string
    includeShippedRoot: boolean
    includeUserRoot: boolean
    roots: Array<{ path: string; trust: 'system' | 'user' }>
  }
}

describe('Qianshou desktop preset roster', () => {
  it('keeps the general web profile on the original shipped roster', () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'official')
    const roster = rosterConfig()
    expect(roster).toEqual({ default: 'standard', includeShippedRoot: true,
      includeUserRoot: true, roots: [] })
  })

  it('offers the three public Qianshou modes while retaining historical compositions', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'qianshou')
    vi.stubEnv('QIANSHOU_PRESET_ROOT', productRoot)
    const roster = rosterConfig()
    expect(roster).toEqual({ default: 'qianshou-ceo', includeShippedRoot: false,
      includeUserRoot: false, roots: [{ path: productRoot, trust: 'system' }] })
    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(join(productRoot, '..', '..')).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentPresets, roster)
    expect((await ctx.agentPresets.list()).map(preset => preset.id).sort())
      .toEqual(['qianshou-call', 'qianshou-ceo', 'qianshou-plugin-creator', 'qianshou-skill-creator'])
    expect((await ctx.agentPresets.remoteExportList()).presets.map(preset => preset.id).sort())
      .toEqual(['qianshou-call', 'qianshou-ceo', 'qianshou-skill-creator'])
  })
})
