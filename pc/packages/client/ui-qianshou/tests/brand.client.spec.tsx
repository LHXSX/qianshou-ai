// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { ThemeRuntime, type ThemeSettings } from '@deepseek-ai/dsh-client-ui-theme/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { QianshouMark, QianshouName } from '../src/client/Brand.tsx'

afterEach(() => { cleanup(); vi.unstubAllEnvs() })

const holes = ['sidebar.brand.mark', 'sidebar.brand.name', 'conversation.hero.brand.mark'] as const

async function bench() {
  const ctx = new Context()
  const registryFiber = ctx.plugin(SlotRegistry)
  await registryFiber.await()
  const slots = ctx.get('slots') as SlotRegistry
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const theme = new ThemeRuntime(ctx, stubSettingsScope<ThemeSettings>().scope)
  ctx.provide('theme', theme)
  const declare = () => slots.register({ name: 'root', children: {
    'sidebar.brand.mark': { kind: 'single', scope: 'root' },
    'sidebar.brand.name': { kind: 'single', scope: 'root' },
    'conversation.hero.brand.mark': { kind: 'single', scope: 'root' },
  } }, (_props: PropsRenderSlots<typeof holes[number]>) => null)
  return { ctx, slots, locale, theme, declare, registryFiber }
}

describe('Qianshou product composition', () => {
  it('uses the supplied emblem in the sidebar and conversation hero without redrawing it', () => {
    const view = render(<QianshouMark size={32} />)
    const mark = view.container.querySelector('[data-qianshou-brand="mark"]')
    expect(mark?.tagName).toBe('IMG')
    expect(mark?.getAttribute('src')).toBe('/brand/qianshou-mark.png')
    expect(mark?.getAttribute('width')).toBe('32')
    expect(mark?.getAttribute('alt')).toBe('')
  })
  it('leaves upstream builds and their themes unchanged', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'official')
    const b = await bench()
    const dispose = b.declare()
    const fiber = b.ctx.plugin({ inject, apply })
    await fiber.await()
    expect(holes.map(h => b.slots.entries(h).length)).toEqual([0, 0, 0])
    await fiber.dispose(); dispose(); await b.registryFiber.dispose()
  })

  it('restores branding after parent remount and removes all contributions on unload', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'qianshou')
    const b = await bench()
    const initialTheme = b.theme.getTheme().active.tokens
    const fiber = b.ctx.plugin({ inject, apply })
    await fiber.await()
    let undeclare = b.declare()
    await Promise.resolve()
    expect(holes.map(h => b.slots.entries(h).length)).toEqual([1, 1, 1])
    undeclare()
    expect(holes.map(h => b.slots.entries(h).length)).toEqual([0, 0, 0])
    undeclare = b.declare()
    await Promise.resolve()
    expect(holes.map(h => b.slots.entries(h).length)).toEqual([1, 1, 1])
    const view = render(<QianshouName t={b.locale.bind('qianshou.brand')} />)
    expect(view.getByText('千手')).toBeTruthy()
    expect(view.getByText('你的智能工作伙伴')).toBeTruthy()
    expect(view.container.textContent).not.toContain('DeepSeek')
    expect(view.container).toMatchSnapshot()
    view.unmount()
    await fiber.dispose()
    expect(holes.map(h => b.slots.entries(h).length)).toEqual([0, 0, 0])
    expect(b.theme.getTheme().active.tokens).toEqual(initialTheme)
    undeclare(); await b.registryFiber.dispose()
  })
})
