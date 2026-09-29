// @vitest-environment jsdom
/**
 * 历史对话的**可发现性**测试。
 *
 * 用户原话「历史对话呢？」——功能本身一直是好的，是入口被藏在了抽屉最底部
 * （14 项之后，手机上必须滚动才看得到）。所以这份测试断言的不是"历史页能渲染"，
 * 而是**入口在不需要滚动的地方**：
 * 1. 对话屏顶栏有历史按钮，点一下就到历史视图；
 * 2. 抽屉里的同一个入口排在前 6 项之内；
 * 3. 空态下不出现任何徽章——菜单上那个硬编码的 `12` 已经没有数据支撑，不能回来。
 */
import { act, createElement, type FC, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App, type AppProps } from '../src/App.tsx'
import { ChatController } from '../src/chat.ts'
import { zh } from '../src/copy.ts'
import { MENU } from '../src/data.ts'
import { installStorage } from './storage.ts'

const AppElement: FC<AppProps> = App

let container: HTMLDivElement | undefined
let root: { render: (node: ReactElement) => void; unmount: () => void } | null = null

beforeEach(() => { installStorage() })

afterEach(async () => {
  if (root !== null) await act(async () => { root!.unmount() })
  container?.remove()
  root = null
  container = undefined
})

async function flush(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

function byLabel(label: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  if (found === null) throw new Error(`找不到「${label}」`)
  return found
}

async function click(node: HTMLElement): Promise<void> {
  await act(async () => { node.click() })
  await flush()
}

async function mount(): Promise<void> {
  // 注入一个不联网的控制器：这里测的是导航，不是对话。
  const controller = new ChatController({
    settings: { providerId: 'deepseek', baseUrl: 'https://local.test/v1', model: 'deepseek-chat' },
    secret: 'sk-local-test',
    sessions: [],
  })
  container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const mounted = createRoot(container)
  root = mounted
  await act(async () => { mounted.render(createElement(AppElement, { controller })) })
  await flush()
}

async function openChatScreen(): Promise<void> {
  const suggest = document.querySelector<HTMLElement>('.suggest')
  if (suggest === null) throw new Error('首页没有建议卡片')
  await click(suggest)
}

function body(): string {
  return container?.textContent ?? ''
}

describe('历史对话的入口：不用滚动就能看到', () => {
  it('对话屏顶栏有历史按钮，点一下进入历史视图', async () => {
    await mount()
    await openChatScreen()

    // 顶栏按钮就在菜单图标与模型胶囊旁边，首屏可见。
    const entry = byLabel(zh.history)
    expect(entry.closest('.head')).not.toBeNull()

    await click(entry)

    // 历史页两段都在：这台手机的对话、以及发到电脑的指令（此处都是空态）。
    expect(body()).toContain(zh.sessionsLocalTitle)
    expect(body()).toContain(zh.sessionsPcTitle)
    expect(byLabel(zh.settingsBack)).toBeTruthy()
  })

  it('抽屉里的同一个入口排在前 6 项之内，不再埋在末尾', async () => {
    await mount()
    await openChatScreen()
    await click(byLabel(zh.menuTitle))

    const items = [...document.querySelectorAll<HTMLElement>('.drawer-list .d-item')]
    expect(items.length).toBeGreaterThan(6)
    const index = items.findIndex(item => item.textContent?.includes(zh.history) === true)
    expect(index).toBeGreaterThanOrEqual(0)
    // 手机上一屏能看到的量级：前 6 项之内 = 不需要滚动。
    expect(index).toBeLessThan(6)

    // 点它同样进历史页。
    const entry = items[index]
    if (entry === undefined) throw new Error('取不到历史入口')
    await click(entry)
    expect(body()).toContain(zh.sessionsLocalTitle)
  })

  it('空态下不出现任何徽章：菜单上没有真实数字就不许挂一个出来', async () => {
    await mount()
    await openChatScreen()
    await click(byLabel(zh.menuTitle))

    // 数据层先钉死：当前没有任何一条菜单项带数字。
    expect(MENU.filter(item => item.badge !== null)).toEqual([])
    // 界面层再钉一次：没有数据就不渲染徽章，连空壳都不留。
    expect([...document.querySelectorAll('.drawer-list .badge')]).toEqual([])
    const tasks = [...document.querySelectorAll<HTMLElement>('.drawer-list .d-item')]
      .find(item => item.textContent?.includes('任务中心') === true)
    expect(tasks?.textContent).toBe('任务中心')
  })
})
