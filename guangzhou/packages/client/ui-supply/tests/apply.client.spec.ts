/**
 * Plugin lifetime and wiring: the workspace seat and its navigation entry exist
 * exactly while the owning plugin and slots do, and the injected face drives the
 * real routes through the controller's ambient fetch.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../src/client/index.ts'
import type { SupplyFace } from '../src/client/SupplyPage.tsx'
import { blockedJson, readyJson } from './fixtures.client.ts'

async function mounted() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const slots = ctx.get('slots') as SlotRegistry
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const children = { main: { kind: 'keyed', scope: 'root' }, 'settings.section': { kind: 'list', scope: 'root' } } as never
  const owner = slots.register({ name: 'root', children } as never, () => null)
  return { ctx, slots, fiber, owner, children }
}

function requestPath(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

describe('supply plugin lifetime', () => {
  it.each([
    [undefined, '供给管理', 12],
    ['forge', '应用市场', 5],
  ] as const)('在设置里注册其页面为 %s', async (profile, title, order) => {
    if (profile !== undefined) vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', profile)
    const { ctx, slots, fiber, owner, children } = await mounted()
    expect(slots.entries('main').map(row => row.options.key)).toEqual(['qianshou-supply'])
    expect(resolveSlotLabel(slots.entries('settings.section')[0]?.options.label)).toBe(title)
    expect(slots.entries('settings.section')[0]?.options.order).toBe(order)
    owner()
    const nextOwner = slots.register({ name: 'root', children } as never, () => null)
    expect(slots.entries('main')).toHaveLength(1)
    await fiber.dispose()
    expect(slots.entries('main')).toHaveLength(0)
    expect(slots.entries('settings.section')).toHaveLength(0)
    nextOwner()
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
  })

  it('drives both real routes through the face the renderer injects into the page', async () => {
    const transport = vi.fn<typeof globalThis.fetch>(async (input, init) => Response.json(
      requestPath(input).endsWith('/supply/policy') && init?.method === 'POST' ? readyJson : blockedJson,
    ))
    vi.stubGlobal('fetch', transport)
    try {
      const { ctx, slots, fiber, owner } = await mounted()
      const face = (slots.entries('main')[0]?.inject as unknown as () => SupplyFace)()
      await face.refresh()
      expect(transport.mock.calls[0]?.[0]).toBe('/api/qianshou/compute/supply')
      expect(face.hooks.supply.getSnapshot().snapshot?.eligibility.state).toBe('blocked')
      const policy = face.hooks.supply.getSnapshot().snapshot!.ownerPolicy
      expect(await face.savePolicy({ ...policy, mode: 'allowed' })).toBe(true)
      expect(face.hooks.supply.getSnapshot().snapshot?.eligibility.state).toBe('ready')
      await fiber.dispose()
      expect(transport.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true)
      expect(await face.savePolicy(policy)).toBe(false)
      owner(); await ctx.fiber.dispose()
    } finally { vi.unstubAllGlobals() }
  })

  it('disposes the request lifetime with the plugin', async () => {
    const { ctx, slots, fiber, owner } = await mounted()
    await fiber.dispose()
    expect(slots.entries('main')).toHaveLength(0)
    owner(); await ctx.fiber.dispose()
  })
})
