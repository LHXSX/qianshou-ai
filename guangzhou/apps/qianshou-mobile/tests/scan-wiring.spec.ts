// @vitest-environment jsdom
/**
 * 「扫二维码配对」的接线测试：点下去必须**真的去要摄像头**。
 *
 * 这一条钉的是一个真实报障：按钮点了没反应、取景框不出现、控制台零报错。
 * 根因不在扫码模块（`pairing.ts` 那 5 条用例一直是绿的），而在**渲染树接线**：
 * 取景框（`.scan-overlay` + `<video ref={videoRef}>`）只挂在 `view === 'auth'` 那一支，
 * 而触发按钮在「我的」页（`view === 'screens'`）。于是 `beginScan()` 设下的
 * `scanWanted = true` 在那一帧里找不到 video 元素，开相机的 effect 拿到 `null` 直接放弃——
 * 相机一次都没被请求过，所以「没有权限」这类**应该在失败后才出现**的文案也不可能出现。
 *
 * 所以断言的是那条链，不是某句话：
 * 1. 点击后 `getUserMedia` 被调用（没调 = 相机永远不会开，文案写得再对也没用）；
 * 2. 调用的那一刻 `.scan-overlay video` 已经在 DOM 里（`startScan` 拿到的是真元素）；
 * 3. 失败原因如实上屏（`SCAN_COPY` 五选一），**不是**那句「重开一次页面再试」。
 *
 * 用 `.spec.ts` 而不是 `.spec.tsx`：仓库根 vitest 配置里手机端这一条 include 只收
 * `*.spec.ts`，所以这里用 `createElement` 写元素。
 */
import { act, createElement, type FC, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { PcWindowHttpPort } from '@deepseek-ai/dsh-client-pc-window-bridge'
import { App, type AppProps } from '../src/App.tsx'
import { zh } from '../src/copy.ts'
import { SCAN_COPY } from '../src/pairing.ts'
import { MemoryWindowJournalStore, PhoneWindowRuntime } from '../src/window-runtime.ts'
import { installStorage } from './storage.ts'

const AppElement: FC<AppProps> = App

const BINDING = {
  accountId: 'local-owner',
  pcId: 'this-pc',
  sessionId: 'session-primary',
  sourceDeviceId: 'phone-test',
}

/** 电脑认领成功但判定离线：遥控不可用这条用例不管，只要网关形状合法。 */
const OFFLINE = { state: 'offline', allowedActions: [] }

/** 「我的」页连接卡在没连过电脑时显示的那句提示。 */
const IDLE_HINT = '把电脑上显示的地址整段粘到这里'

/** 扫码开始后 `beginScan` 写下的那句提示。 */
const SCAN_PLACE_HINT = '把二维码放进取景框'

let container: HTMLDivElement | undefined
let root: { render: (node: ReactElement) => void; unmount: () => void } | null = null

beforeEach(() => {
  installStorage()
})

afterEach(async () => {
  if (root !== null) await act(async () => { root!.unmount() })
  container?.remove()
  root = null
  container = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function flush(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

async function click(node: HTMLElement): Promise<void> {
  await act(async () => { node.click() })
  await flush()
}

/** 电脑侧的假网关：这一条只关心扫码，遥控那半边给个「认领成功但离线」的回答就够。 */
function gateway(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.includes('/bootstrap')
      ? { binding: BINDING, access: OFFLINE }
      : url.includes('/access')
        ? OFFLINE
        : {
            binding: BINDING, fromCursor: null,
            nextCursor: 'qianshou.pc-window.cursor.v1:1', receipts: [], notReceivedIds: [],
          }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

async function mount(): Promise<void> {
  const runtime = await PhoneWindowRuntime.open({
    port: new PcWindowHttpPort({ baseUrl: 'http://pc.test', fetch: gateway() }),
    store: new MemoryWindowJournalStore(),
    deviceId: 'phone-test',
    sessionId: 'session-primary',
    now: () => 1_700_000_000_000,
    requestId: () => 'req-scan-1' as SessionRequestId,
  })
  container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const mounted = createRoot(container)
  root = mounted
  await act(async () => { mounted.render(createElement(AppElement, { runtime })) })
  await flush()
  // 切到「我的」页：扫码按钮只在这里。
  const me = [...document.querySelectorAll<HTMLElement>('.tab')]
    .find(node => node.textContent?.trim() === zh.tabMe)
  if (me === undefined) throw new Error(`找不到「${zh.tabMe}」这个标签页`)
  await click(me)
}

function scanButton(): HTMLElement {
  const button = document.querySelector<HTMLElement>('.pc-link-scan')
  if (button === null) throw new Error('「我的」页里没有 .pc-link-scan 按钮')
  return button
}

/**
 * 「连接电脑」那张卡的说明文字。
 *
 * 用 `.pc-link-head div > span`：**不要**用 `.pc-link-head span`——那个选择器命中的是
 * **第一个** span，也就是放地球图标的 `<span class="glyph blue">`，它的 textContent 恒为空。
 * 复现脚本正是被这一点骗过：它在坏产物和好产物上都报 "(空)"。
 *
 * 这里也**不**用本次修复新增的 `.pc-link-status`：这个选择器在修之前、修之后两份 markup
 * 上都有效，于是把这份用例拿去跑修之前的源码，失败原因只能是行为差异（相机没被请求、
 * 文案是那句「重开一次页面」），而不是"找不到新加的类"。
 */
function statusText(): string {
  const node = document.querySelector('.pc-link-head div > span')
  if (node === null) throw new Error('找不到「连接电脑」的状态文案节点')
  return (node.textContent ?? '').trim()
}

/** 一次扫码环境的取证结果。 */
interface ScanEnvironment {
  readonly getUserMedia: ReturnType<typeof vi.fn>
  /** `getUserMedia` 被调用那一刻 DOM 里的取景框 video；`null` 就是这次要钉的 bug。 */
  readonly viewfinderAtRequest: () => HTMLVideoElement | null
}

/**
 * 装一个可扫码的浏览器环境：安全上下文 + 摄像头接口 + 原生识别器。
 *
 * 三个条件缺一不可——`scanSupport()` 先看 `isSecureContext`，再看 `mediaDevices`，
 * 最后看 `BarcodeDetector`，少任何一个都会走「环境不支持」那条分支，就测不到接线了。
 * @param options - `outcome` 决定 `getUserMedia` 成功还是被拒；`detector: false` 用来测「不支持」那支。
 * @returns 可断言的假摄像头。
 */
function installScanEnvironment(options: {
  readonly outcome: 'denied' | 'granted'
  readonly detector?: boolean
}): ScanEnvironment {
  const stream = {
    getTracks: () => [{ stop: vi.fn() }],
  } as unknown as MediaStream
  let viewfinder: HTMLVideoElement | null = null
  const getUserMedia = vi.fn(async () => {
    // 关键取证：要摄像头的那一刻，取景框必须**已经**在 DOM 里。
    viewfinder = document.querySelector<HTMLVideoElement>('.scan-overlay video')
    if (options.outcome === 'denied') {
      throw Object.assign(new Error('在测试里被拒'), { name: 'NotAllowedError' })
    }
    return stream
  })
  vi.stubGlobal('isSecureContext', true)
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    value: { getUserMedia }, configurable: true,
  })
  if (options.detector !== false) {
    vi.stubGlobal('BarcodeDetector', class {
      detect(): Promise<readonly { readonly rawValue: string }[]> { return Promise.resolve([]) }
    })
    // jsdom 的 `HTMLMediaElement.play()` 是「未实现」桩（返回 undefined），
    // 而 `pairing.ts` 会 `video.play().catch(...)`——不替掉它，成功路径会因
    // TypeError 变成没人处理的拒绝，测出来的失败和产品行为无关。
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => { /* 假装在播 */ })
  }
  return { getUserMedia, viewfinderAtRequest: () => viewfinder }
}

describe('扫码按钮的接线', () => {
  it('点「扫二维码配对」会真的去要摄像头，取景框在要之前就已进 DOM', async () => {
    await mount()
    const camera = installScanEnvironment({ outcome: 'denied' })

    await click(scanButton())

    // 1) 相机被请求过。修之前这里是 0 次：`scanWanted` 设了，却没有 video 元素可挂。
    expect(camera.getUserMedia).toHaveBeenCalledTimes(1)
    // 2) `startScan` 拿到的是真元素，不是 null。
    expect(camera.viewfinderAtRequest()?.tagName).toBe('VIDEO')
  })

  it('没有摄像头权限时，如实显示「去设置里允许」，不说「重开一次页面」', async () => {
    await mount()
    installScanEnvironment({ outcome: 'denied' })
    expect(statusText()).toBe(IDLE_HINT)

    await click(scanButton())

    expect(statusText()).toBe(SCAN_COPY.denied)
    expect(statusText()).not.toContain('重开一次页面')
    // 失败之后取景框收起，不留一个黑屏弹层在那儿。
    expect(document.querySelector('.scan-overlay')).toBeNull()
  })

  it('相机开成时取景框留在屏幕上：video 挂着流；点取消才收起', async () => {
    await mount()
    const camera = installScanEnvironment({ outcome: 'granted' })

    await click(scanButton())

    expect(camera.getUserMedia).toHaveBeenCalledTimes(1)
    expect(document.querySelectorAll('.scan-overlay')).toHaveLength(1)
    const video = document.querySelector<HTMLVideoElement>('.scan-overlay video')
    expect(video).not.toBeNull()
    // 流真的挂上了 video（不是「开了个黑框假装在扫」）。
    expect(video?.srcObject).not.toBeNull()
    // 文案跟着状态走：这条提示在修之前被「只有失败态才渲染」的写法吞掉了。
    expect(statusText()).toBe(SCAN_PLACE_HINT)

    const cancel = document.querySelector<HTMLElement>('.scan-cancel')
    if (cancel === null) throw new Error('取景框里没有取消按钮')
    await click(cancel)

    expect(document.querySelector('.scan-overlay')).toBeNull()
    // 取消之后不留扫码提示，回到「粘地址」那句。
    expect(statusText()).toBe(IDLE_HINT)
  })

  it('环境不支持时不碰摄像头，并给出可执行的替代路径', async () => {
    await mount()
    const camera = installScanEnvironment({ outcome: 'denied', detector: false })

    await click(scanButton())

    expect(camera.getUserMedia).not.toHaveBeenCalled()
    expect(statusText()).toBe(SCAN_COPY.unsupported)
    expect(statusText()).toContain('手动输入')
    expect(document.querySelector('.scan-overlay')).toBeNull()
  })
})
