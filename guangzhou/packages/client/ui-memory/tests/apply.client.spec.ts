import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../src/client/index.ts'
import type { MemoryFace } from '../src/client/MemoryPage.tsx'

describe('memory workspace contribution', () => {
  it.each([
    [undefined, '记忆与知识', 12],
    ['forge', '知识库', 6],
  ] as const)('在设置里注册为 %s', async (profile, title, order) => {
    if (profile !== undefined) vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', profile)
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const locale = new LocaleRuntime(ctx)
    locale.setLocale('zh')
    ctx.provide('locale', locale)
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({ name: 'root', children: {
      main: { kind: 'keyed', scope: 'root' }, 'settings.section': { kind: 'list', scope: 'root' },
    } } as never, () => null)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('main').map(row => row.options.key)).toEqual(['qianshou-memory'])
    expect(resolveSlotLabel(slots.entries('settings.section')[0]?.options.label)).toBe(title)
    expect(slots.entries('settings.section')[0]?.options.order).toBe(order)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'no' }, { status: 500 })))
    const face = (slots.entries('main')[0]?.inject as unknown as () => MemoryFace)()
    face.filter({ query: 'q' })
    await face.refresh()
    await face.select('id-1')
    expect(await face.mutate('delete', { id: 'id-1', expectedRevision: 1 })).toBe(false)
    expect(await face.exportData()).toBeNull()
    vi.unstubAllGlobals()
    await fiber.dispose()
    expect(slots.entries('main')).toHaveLength(0)
    expect(slots.entries('settings.section')).toHaveLength(0)
    vi.unstubAllEnvs()
  })
})
