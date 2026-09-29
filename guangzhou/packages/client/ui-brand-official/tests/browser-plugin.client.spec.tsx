// @vitest-environment jsdom
import { createElement } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../src/client/index.ts'
import { OfficialBrandMark, OfficialBrandName } from '../src/client/Brand.tsx'
import { ForgeBrandMark } from '../src/client/ForgeBrand.tsx'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as hostApply } from '../src/index.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

const HOLES = [
  'sidebar.brand.mark',
  'sidebar.brand.name',
] as const

const HERO_HOLE = 'conversation.hero.brand.mark'

async function bench(declare = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const declareHoles = () => slots.register({
    name: 'root',
    children: Object.fromEntries([...HOLES, HERO_HOLE].map(name => [name, { kind: 'single', scope: 'root' }])),
  } as never, () => null)
  const disposeHoles = declare ? declareHoles() : undefined
  return { ctx, slots, declareHoles, disposeHoles }
}

describe('official browser-brand plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares only the slot service it uses', () => {
    expect(inject).toEqual(['slots'])
  })

  it('leaves every slot empty outside the official build profile', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'local')
    const subject = await bench()
    await subject.ctx.plugin({ inject: [...inject], apply }).await()
    for (const hole of HOLES) expect(subject.slots.entries(hole)).toHaveLength(0)
  })

  it('fills declarations before or after apply and removes every occupant on teardown', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'official')
    const before = await bench()
    const fiber = before.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(1)

    before.disposeHoles?.()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(0)
    before.declareHoles()
    await Promise.resolve()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(1)

    await fiber.dispose()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(0)

    const after = await bench(false)
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    for (const hole of HOLES) expect(after.slots.entries(hole)).toHaveLength(0)
    after.declareHoles()
    await Promise.resolve()
    for (const hole of HOLES) expect(after.slots.entries(hole)).toHaveLength(1)
  })

  it('leaves the conversation hero on its declaring fallback even in official builds', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'official')
    const subject = await bench()
    await subject.ctx.plugin({ inject: [...inject], apply }).await()
    expect(subject.slots.entries(HERO_HOLE)).toHaveLength(0)
  })

  it('installs the private localized brand only when its locale service is available', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'forge')
    const subject = await bench()
    subject.ctx.reflect.provide('locale', new LocaleRuntime(subject.ctx))
    const fiber = subject.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    for (const hole of HOLES) expect(subject.slots.entries(hole)).toHaveLength(1)
    expect(subject.slots.entries(HERO_HOLE)[0]?.component).toBe(ForgeBrandMark)
    expect(subject.slots.entries('sidebar.brand.mark')[0]?.component).toBe(ForgeBrandMark)
    expect(subject.ctx.locale.bind('forge.brand')('name')).toMatch(/千手|Qianshou/)
    await fiber.dispose()
    for (const hole of HOLES) expect(subject.slots.entries(hole)).toHaveLength(0)
    expect(subject.slots.entries(HERO_HOLE)).toHaveLength(0)
  })

  it('reinstalls the shared private mark when the hero and sidebar declarations return', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'forge')
    const subject = await bench(false)
    subject.ctx.reflect.provide('locale', new LocaleRuntime(subject.ctx))
    const fiber = subject.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(subject.slots.entries(HERO_HOLE)).toHaveLength(0)
    const dispose = subject.declareHoles()
    await Promise.resolve()
    for (const hole of [...HOLES, HERO_HOLE] as const) expect(subject.slots.entries(hole)).toHaveLength(1)
    dispose()
    for (const hole of [...HOLES, HERO_HOLE] as const) expect(subject.slots.entries(hole)).toHaveLength(0)
    subject.declareHoles()
    await Promise.resolve()
    for (const hole of [...HOLES, HERO_HOLE] as const) expect(subject.slots.entries(hole)).toHaveLength(1)
    await fiber.dispose()
  })

  it('renders the official name independently from both requested mark sizes', () => {
    const name = render(<OfficialBrandName />)
    expect(name.container.querySelector('svg')?.getAttribute('viewBox')).toBe('26 0 156 24')
    name.unmount()

    const mark = render(<OfficialBrandMark size={34} />)
    expect(mark.container.querySelector('svg')?.getAttribute('width')).toBe('34')
    mark.rerender(<OfficialBrandMark size={24} />)
    expect(mark.container.querySelector('svg')?.getAttribute('width')).toBe('24')
  })

  it('occupies honest product destinations and the right-rail guide in the forge build', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'forge')
    const { ctx, slots } = await bench(false)
    ctx.reflect.provide('locale', new LocaleRuntime(ctx))
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    slots.register({
      name: 'root',
      children: {
        main: { kind: 'keyed', scope: 'root' },
        // 四个产品页现在注册到设置里，所以测试外壳也要声明这个槽。
        'settings.section': { kind: 'list', scope: 'root' },
        // 仍然声明 panellist 并断言它为空：这是"左栏不再有内容导航"的守卫。
        'sidebar.panellist': { kind: 'list', scope: 'root' },
        'sidebar.right.tab.guide': { kind: 'chain', scope: 'session' },
      },
    } as never, () => null)
    await Promise.resolve()
    expect(slots.entries('main').map(entry => entry.options.key)).toEqual([
      'qianshou-agents', 'qianshou-workflows', 'qianshou-files', 'qianshou-models-api',
    ])
    // 四个产品页**不再占左栏内容导航**：左栏只承载"对话 + 历史会话"。
    // 它们改为设置里的小节，所以这里断言设置槽里有这四项，而 panellist 为空。
    expect(slots.entries('settings.section').map(entry => entry.options.id)).toEqual([
      'qianshou-agents', 'qianshou-workflows', 'qianshou-files', 'qianshou-models-api',
    ])
    expect(slots.entries('sidebar.panellist')).toHaveLength(0)
    expect(slots.entries('sidebar.right.tab.guide')).toHaveLength(1)
    // The registrations carry one face per destination: the slot injector must
    // hand back the same live observable the page binds, with real actions.
    const injectDestination = slots.entries('main')[0]!.inject as unknown as () => {
      hooks: { liveState: { subscribe: (listener: () => void) => () => void; getSnapshot: () => unknown } }
      openChat: () => void
      openPanel: (panel: string | null) => () => void
      openFiles: () => string | undefined
      openSession: (id: string) => void
    }
    const face = injectDestination()
    expect(face).toBe(injectDestination())
    expect(face.hooks.liveState.getSnapshot()).toEqual({
      list: undefined, directory: undefined, directoryMounted: false,
    })
    const off = face.hooks.liveState.subscribe(() => {})
    off()
    face.openChat()
    face.openPanel('qianshou-files')()
    face.openSession('session-1')
    expect(face.openFiles()).toBe('sidebarRight service is not available')
    const locale = ctx.get('locale') as LocaleRuntime
    const t = locale.bind('forge.brand')
    const destination = render(createElement(slots.entries('main')[0]!.component as never, { t } as never))
    // The page now carries grouped section headings beside its <h1>; the
    // identity assertion is that the destination heading itself renders.
    expect(destination.getAllByRole('heading').map(node => node.textContent))
      .toContainEqual(expect.stringMatching(/广场|plaza/i))
    destination.unmount()
    // 标签现在挂在**设置**那一节上；左栏不再有这一项，也就没有图标可断言。
    // 这不是"把断言删掉"：标签与左栏为空两件事都被断言了，只是搬了座位。
    expect(resolveSlotLabel(slots.entries('settings.section')[0]?.options.label)).toMatch(/广场|plaza/i)
    expect(slots.entries('sidebar.panellist')).toHaveLength(0)
    const guide = slots.entries('sidebar.right.tab.guide')[0]!
    expect(guide.select?.({} as never)).toBe(true)
    const injectRail = guide.inject as
      ((sessionId?: string) => {
        directory: unknown
        load: () => void
        openChat: () => void
        openModels: () => void
        openTasks: () => void
        selectModel: (provider: string, model: string) => void
      }) | undefined
    const empty = injectRail?.(undefined)
    expect(empty?.directory).toBeNull()
    empty?.load()
    empty?.openChat()
    empty?.openModels()
    empty?.openTasks()
    empty?.selectModel('local', 'qianshou-team')
    const load = vi.fn(() => Promise.reject(new Error('catalog failed')))
    const select = vi.fn(() => Promise.reject(new Error('select failed')))
    ctx.reflect.provide('modelDirectories', {
      directoryFor: () => ({
        store: { subscribe: () => () => {}, getSnapshot: () => ({ groups: [] }) },
        load,
        select,
      }),
    } as never)
    let address: unknown = {}
    ctx.reflect.provide('sessions', { subagentAddress: () => address } as never)
    const blocked = injectRail?.('session-1')
    blocked?.load()
    blocked?.selectModel('local', 'qianshou-team')
    expect(load).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
    address = undefined
    injectRail?.('session-1')?.load()
    expect(load).toHaveBeenCalledOnce()
    await expect(load.mock.results[0]!.value).rejects.toThrow('catalog failed')
    injectRail?.('session-1')?.selectModel('local', 'qianshou-team')
    expect(select).toHaveBeenCalledWith({ provider: 'local', model: 'qianshou-team' })
    await expect(select.mock.results[0]!.value).rejects.toThrow('select failed')
    injectRail?.('session-1')?.openModels()
    const selectPanel = vi.fn()
    ctx.reflect.provide('layout', { selectPanel } as never)
    injectRail?.('session-1')?.openChat()
    injectRail?.('session-1')?.openModels()
    injectRail?.('session-1')?.openTasks()
    expect(selectPanel).toHaveBeenCalledWith(null)
    expect(selectPanel).toHaveBeenCalledWith('qianshou-models-api')
    expect(selectPanel).toHaveBeenCalledWith('qianshou-compute')
    await fiber.dispose()
  })
})
