import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../src/client/index.ts'
import type { ComputeFace } from '../src/client/ComputePage.tsx'

describe('compute plugin lifetime', () => {
  it.each([
    [undefined, '共享算力', 11],
    ['forge', '任务中心', 3],
  ] as const)('在设置里注册为 %s', async (profile, title, order) => {
    if (profile !== undefined) vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', profile)
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const locale = new LocaleRuntime(ctx)
    locale.setLocale('zh')
    ctx.provide('locale', locale)
    const slots = ctx.get('slots') as SlotRegistry
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const owner = slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' }, 'settings.section': { kind: 'list', scope: 'root' }, 'tool.call.toolview': { kind: 'keyed', scope: 'session' } } } as never, () => null)
    expect(slots.entries('main').map(row => row.options.key)).toEqual(['qianshou-compute'])
    expect(slots.entries('tool.call.toolview').map(row => row.options.key)).toEqual(['compute_plan_draft'])
    expect(resolveSlotLabel(slots.entries('settings.section')[0]?.options.label)).toBe(title)
    expect(slots.entries('settings.section')[0]?.options.order).toBe(order)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'no' }, { status: 500 })))
    const face = (slots.entries('main')[0]?.inject as unknown as () => ComputeFace)()
    const settings = (slots.entries('settings.section')[0]?.inject as unknown as () => { face: ComputeFace })()
    const row = (slots.entries('tool.call.toolview')[0]?.inject as unknown as () => ComputeFace)()
    expect(settings.face).toBe(face)
    expect(row).toBe(face)
    await face.refresh()
    await face.ensureLoaded()
    expect(await face.saveDraft({
      capabilityId: 'missing', goal: 'x', budgetYuan: 1, maxNodes: 1,
    } as never)).toBe(false)
    expect(await face.confirmDraft('draft-1' as never, 'approved')).toBe(false)
    expect(await face.publishDraft('draft-1' as never)).toBe(false)
    vi.unstubAllGlobals()
    owner()
    const nextOwner = slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' }, 'settings.section': { kind: 'list', scope: 'root' }, 'tool.call.toolview': { kind: 'keyed', scope: 'session' } } } as never, () => null)
    expect(slots.entries('main')).toHaveLength(1)
    await fiber.dispose()
    expect(slots.entries('main')).toHaveLength(0)
    expect(slots.entries('settings.section')).toHaveLength(0)
    expect(slots.entries('tool.call.toolview')).toHaveLength(0)
    nextOwner()
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
  })
})
