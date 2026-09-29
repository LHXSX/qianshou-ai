/**
 * 插件装配的规格测试：这一节确实注册进了设置页，且随插件卸载一起消失。
 *
 * 这里用真实的 cordis 上下文与真实的槽位注册表，只有「宿主」是空壳——
 * 也就是说，注册路径本身是真的，不是被 mock 掉的。
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../src/client/index.ts'
import type { RoutingConsoleInjected } from '../src/client/RoutingConsoleSection.tsx'
import { NS, zh } from '../src/client/locales.ts'

/** 装一份能被 slots.inject 依赖的最小设置外壳。 */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const slots = ctx.get('slots') as SlotRegistry
  const owner = slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
  return { ctx, slots, owner, locale }
}

describe('模型路由控制台的装配', () => {
  it('把「模型路由」注册进设置页的一节，并带上注入面', async () => {
    const { ctx, slots, owner } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const [entry, review] = slots.entries('settings.section')
    expect(entry?.options.id).toBe('routing')
    expect(entry?.options.order).toBe(20)
    expect(resolveSlotLabel(entry?.options.label)).toBe(zh.nav)
    expect(review?.options.id).toBe('plugin-review')
    expect(review?.options.order).toBe(21)
    expect(resolveSlotLabel(review?.options.label)).toBe(zh.pluginReviewNav)

    const face = (entry?.inject as unknown as () => RoutingConsoleInjected)()
    expect(face.hooks.catalog.getSnapshot()).toMatchObject({ catalog: null, loading: true, readError: null, bindError: null })
    expect(face.t('nav')).toBe(zh.nav)
    expect(typeof face.bind).toBe('function')
    expect(typeof face.refresh).toBe('function')

    await fiber.dispose()
    expect(slots.entries('settings.section')).toHaveLength(0)
    owner()
    await ctx.fiber.dispose()
  })

  it('注册了中文与英文两份字典（缺一份会让英文界面露出键名）', async () => {
    const { ctx, locale, owner } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const t = locale.bind(NS)
    expect(t('nav')).toBe(zh.nav)
    locale.setLocale('en')
    expect(t('nav')).toBe('Model routing')
    await fiber.dispose()
    owner()
    await ctx.fiber.dispose()
  })
})
