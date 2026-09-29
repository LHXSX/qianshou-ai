/**
 * 插件装配的规格测试。
 *
 * 这里用**真实的 cordis 上下文与真实的槽位注册表**，只有宿主是空壳——
 * 注册路径本身是真的，不是被 mock 掉的。
 *
 * 最重要的一条是「注入面身份稳定」。它是踩过的坑，而且**从现象几乎反推不出来**：
 * 组件把「挂载即读一次」写成 `useEffect(() => refresh(), [refresh])`；
 * 如果 `inject` 工厂每次返回新对象，`refresh` 每次都是新函数身份，
 * 效应就**空转且永不生效**——侧栏卡片永远停在 `idle`、界面上什么都不显示、
 * 控制台一行错也没有。所以这里直接断言"调用两次必须拿到同一对函数"。
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../src/client/index.ts'
import { NS, zh } from '../src/client/locales.ts'
import type { AccountCardInjected } from '../src/client/AccountCard.tsx'
import type { AccountCenterInjected } from '../src/client/AccountCenter.tsx'

/** 装一份能被这些插槽依赖的最小外壳。 */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const slots = ctx.get('slots') as SlotRegistry
  const owner = slots.register({
    name: 'root',
    children: {
      'sidebar.footer.action': { kind: 'list', scope: 'root' },
      main: { kind: 'keyed', scope: 'root' },
      /* `sidebar.panellist` 仍然声明：断言"这一行不再存在"需要一个**存在的座位**才成立。
         如果连座位都不声明，`entries()` 永远返回空，那条守卫就等于没写。 */
      'sidebar.panellist': { kind: 'list', scope: 'root' },
      /* 设置小节：`settings.section` 是 `{kind:'list', scope:'root', owner}`——
         这里的 `owner` 由真宿主的设置面板提供（它的 `close` 就是面板关闭动作），
         空壳里给一个最小的 `close` 即可，注册路径本身仍然是真的。 */
      'settings.section': { kind: 'list', scope: 'root', owner: { close: () => {} } },
    },
  } as never, () => null)
  return { ctx, slots, owner }
}

describe('账户区的装配', () => {
  it('账户卡进 footer.action，内容进 main 与 settings.section，**左栏不再有导航行**', async () => {
    // 用户的要求是"个人中心应该在下面的设置里面，设置里面包含所有功能性的东西"。
    // 所以左栏那行 `sidebar.panellist` 被**刻意删除**（左栏只留对话与历史会话），
    // 同一份内容改为挂在设置小节里。这条测试因此同时是两类守卫：
    //   ① 新的落点必须在位；
    //   ② 旧落点必须**不在**——否则有人"顺手加回来"，左栏又会多一行。
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const [card] = slots.entries('sidebar.footer.action')
    expect(card?.options.id).toBe('qianshou-account')

    const page = slots.entries('main').find(entry => entry.options.key === 'qianshou-account')
    expect(page).toBeDefined()

    const [section] = slots.entries('settings.section')
    expect(section?.options.id).toBe('qianshou-account')
    // 设置里这一节的导航名，真正的约束是**不与上游那个「账号」小节同名**：
    // 「账号」管登录 / 注册 / 2FA / 退出（我是谁），这一节管档位 / 额度 / 用量
    // （我买到什么、还剩多少）。两个同名入口会让用户来回点、也说不清哪个是充值入口。
    const navLabel = resolveSlotLabel(section?.options.label) ?? ''
    expect(navLabel).toBe(zh['settings.title'])
    expect(navLabel.length).toBeGreaterThan(0)
    expect(navLabel).not.toBe('账号')
    expect(navLabel).not.toBe('个人中心')

    expect(slots.entries('sidebar.panellist')).toEqual([])
  })

  it('字典按插件生命周期注册，中文键就是本包字典', async () => {
    const { ctx } = await bench()
    const locale = ctx.get('locale')
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(locale?.bind(NS)('page.title')).toBe(zh['page.title'])
  })

  it('注入面的函数身份在多次调用间保持稳定', async () => {
    // 这条不是风格检查：身份一变，组件的挂载效应就永不生效（见文件头）。
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const [card] = slots.entries('sidebar.footer.action')
    const cardFace = card?.inject as unknown as () => AccountCardInjected
    const first = cardFace()
    const second = cardFace()
    expect(second.refresh).toBe(first.refresh)
    expect(second.open).toBe(first.open)
    expect(second.view).toBe(first.view)
    // 卡片与页面必须共用同一个 store：两处显示的额度得是同一个数字。
    const page = slots.entries('main').find(entry => entry.options.key === 'qianshou-account')
    const pageFace = (page?.inject as unknown as () => AccountCenterInjected)()
    expect(pageFace.view).toBe(first.view)
    expect(pageFace.refresh).toBe(first.refresh)
  })

  it('卡片只暴露一个读动作（刷新按钮已移出卡片）', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const [card] = slots.entries('sidebar.footer.action')
    const face = (card?.inject as unknown as () => AccountCardInjected)()
    // 卡片上不再有手动刷新：刷新属于"我想核对一下"的动作，放在个人中心里。
    // 底部这一块保持最简——头像、名字、档位、额度，加一个打开它的点击。
    expect(Object.keys(face).sort()).toEqual(['open', 'refresh', 'view'])
    // 调用不应抛出（真去读会失败，但读层把一切异常都折叠成 unavailable）。
    expect(() => { face.refresh() }).not.toThrow()
  })

  it('卸载后插槽与字典一起消失，不留孤儿', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('sidebar.footer.action')).toHaveLength(1)
    fiber.dispose()
    await Promise.resolve()
    expect(slots.entries('sidebar.footer.action')).toHaveLength(0)
    expect(slots.entries('main').filter(e => e.options.key === 'qianshou-account')).toHaveLength(0)
  })
})
