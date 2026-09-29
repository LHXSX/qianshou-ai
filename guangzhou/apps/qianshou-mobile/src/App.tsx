import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { copyOf } from './copy.ts'
import {
  AGENTS,
  AGENT_CATEGORIES,
  CASES,
  DISCOVER_CATS,
  DISPATCH_SECTIONS,
  FACES,
  HOME_TILES,
  INDUSTRIES,
  LIVE_JOBS,
  ME_ROWS,
  ME_TAIL,
  MENU,
  MENU_TAIL,
  REGIONS,
  SUGGESTIONS,
  TASK_SECTIONS,
  TASKS,
  tabForMenu,
  taskMatches,
  type TabId,
} from './data.ts'
import { nextBatch } from './catalog.ts'
import { deriveFollowUps, type FollowUp } from './followups.ts'
import { MarkdownView } from './markdown-view.tsx'
import { openAccount, hostAccountReachable, type AccountService, type AccountSnapshot } from './account.ts'
import { AuthScreen } from './auth-screen.tsx'
import { WalletScreen } from './wallet-screen.tsx'
import { watchVersion } from './version-watch.ts'
import { WorkbenchClient, parseEntryUrl } from './workbench.ts'
import { SCAN_COPY, scanSupport, startScan, type ScanSession } from './pairing.ts'
import { ticketOf, redeemPairing } from './account.ts'
import {
  loadByokSettings,
  loadPcEntry,
  loadRouteChoice,
  savePcEntry,
  saveRouteChoice,
  subscriptionSettings,
} from './store.ts'
import type { Account } from '@deepseek-ai/dsh-client-account'
import { ScrollFollower, scrollToBottom } from './scroll.ts'
import { PhoneWindowRuntime, readDeviceId, type PhoneWindowSnapshot } from './window-runtime.ts'
import { ChatController, failureCopy, groupRuns, type ChatEntry, type ChatPhase, type ChatSnapshot } from './chat.ts'
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL_ID,
  PROVIDER_TEMPLATES,
  streamChat,
  type ChatFailure,
  type ChatStream,
  type ConnectionSettings,
  type SendOptions,
  type StreamHandlers,
} from './llm.ts'
import {
  formatSp,
  frontModelsForTier,
  isSubscriptionProvider,
  readSubscriptionStatus,
  resolveAiRoute,
  routeBlockReason,
  usable,
  type AiRoute,
  type RouteChoice,
  type RouteConditions,
  type SubscriptionStatusResult,
  type SubscriptionTierId,
} from './subscription-model.ts'
import { refuseSubscription, streamSubscription } from './subscription.ts'
import { supportsWebSearch, type SearchSource } from './search.ts'
import { runSearchLoop, type SearchLoopOptions, type SearchPhase } from './tool-loop.ts'
import type { StoredSession } from './store.ts'
import { useVoiceInput, voiceNoteOf } from './voice-input.ts'
import { VoiceNoteRow } from './voice-note-view.tsx'
import { appleSpeechSupport } from './voice-apple.ts'
import { voiceSupport, type VoiceSupport } from './voice.ts'
import type { DeliveryState, WindowCommandRecord } from '@deepseek-ai/dsh-client-pc-window-bridge'
import * as I from './icons.tsx'

const t = copyOf('zh')

/**
 * `App` 的入参。三条能力各自可注入，测试因此能单独驱动：
 * 只给 `controller` 验证独立对话，只给 `runtime` 验证遥控，只给 `search` 验证联网搜索。
 */
export interface AppProps {
  /** 注入的电脑窗口运行时；省略时界面自建一个同源 PcWindow 连接。 */
  readonly runtime?: PhoneWindowRuntime
  /** 注入的对话控制器；省略时界面自建一个连真实服务商的实例。 */
  readonly controller?: ChatController
  /** 注入的联网搜索执行器；省略时用真实的 `runSearchLoop`。 */
  readonly search?: WebSearchRunner
}

/**
 * 联网搜索的执行器签名。
 *
 * 与 `llm.ts` 的 `StreamChatFn` 同形，只多一个配置参数，因此可以**直接**当作
 * `ChatController` 的流实现注入：控制器与界面都不需要知道这一条走的是搜索循环
 * 还是普通对话。
 */
export type WebSearchRunner = (
  options: SendOptions,
  config: SearchLoopOptions,
  handlers: StreamHandlers,
) => ChatStream

/** App 自建的控制器用的真实搜索执行器。 */
const REAL_SEARCH: WebSearchRunner = (options, config, handlers) => runSearchLoop(options, config, handlers)

/** 一次发送的搜索接线：芯片是否真的开了搜索、以及往哪报中间状态。 */
interface SearchCall {
  readonly enabled: boolean
  readonly phase: (phase: SearchPhase | null) => void
  readonly sources: (sources: readonly SearchSource[]) => void
}

/**
 * 「联网搜索」打开后，这一条会怎么走。
 *
 * 四种去处，各有一条**明确**的界面说明；没有"静默降级"这一档：
 * - `pc`：电脑可达 → 由电脑联网搜索后回答；
 * - `phone-search`：电脑不在线，但这台手机能用自己的 DeepSeek 密钥联网搜索；
 * - `phone-plain`：电脑不在线、这台手机也搜不了（订阅通道不支持、服务商不支持或缺密钥）
 *   → 照常回答，但界面上说清楚，绝不假装搜过。
 * @param input - 芯片状态、服务商、电脑可达性与密钥可用性。
 * @returns 本次的去处与要显示的那句说明（芯片没开时为 `null`）。
 */
function webSearchPlan(input: {
  readonly enabled: boolean
  readonly providerId: string
  readonly pcReachable: boolean
  readonly hasKey: boolean
}): { readonly route: 'pc' | 'phone-search' | 'phone-plain'; readonly note: string | null } {
  if (!input.enabled) return { route: 'phone-plain', note: null }
  if (input.pcReachable) return { route: 'pc', note: t.searchBarRemote }
  /**
   * 订阅通道**不带联网搜索**：网关只做对话。这条不是"暂时没接上"的含糊话，
   * 而是当前版本的事实——所以芯片打开时当场说清，并且发送时真的不搜。
   */
  if (isSubscriptionProvider(input.providerId)) return { route: 'phone-plain', note: t.searchBarSubscription }
  if (supportsWebSearch(input.providerId) && input.hasKey) {
    return { route: 'phone-search', note: t.searchBarPhone }
  }
  if (supportsWebSearch(input.providerId)) return { route: 'phone-plain', note: t.searchBarOffline }
  return { route: 'phone-plain', note: t.searchBarUnsupported }
}

/**
 * 把结算帧里的剩余点数并进当前额度快照。
 *
 * 读不到档位时**原样返回**：宁可继续显示"额度未知"，也不拿一个只有数字、没有档位的
 * 半截快照去渲染。
 * @param current - 当前快照；还没读过时为 `null`。
 * @param remaining - 网关刚给出的剩余点数。
 * @returns 合并后的快照。
 */
function withRemaining(current: SubscriptionStatusResult | null, remaining: number): SubscriptionStatusResult | null {
  if (current === null || !current.ok) return current
  return { ok: true, credit: { ...current.credit, remainingSp: remaining } }
}

/**
 * 订阅档在模型选择器里的候选。
 *
 * 两层取舍：档位决定的可见性**由目录说了算**（`frontModelsForTier`）；而当前选中的那个
 * 即使这一档用不了也要列出来——界面不能把"正在用的模型"藏起来，否则用户看到的选中项
 * 与实际请求的模型不一致。
 * @param current - 当前选中的前台模型名。
 * @param tier - 当前档位；读不到传 `null`。
 * @returns 候选清单。
 */
function subscriptionModelOptions(
  current: string,
  tier: SubscriptionTierId | null,
): readonly { readonly id: string; readonly name: string }[] {
  const allowed = frontModelsForTier(tier).map(model => ({ id: model.name, name: model.name }))
  if (current.trim().length === 0 || allowed.some(option => option.id === current)) return allowed
  return [{ id: current, name: current }, ...allowed]
}

/**
 * 额度条上要显示的那一小段字。
 *
 * 读不到就说"额度未知"：**绝不**用上一次的数字顶上去，也不显示 0——
 * 那会让人以为"还能用"，而事实是不知道。
 * @param result - 最近一次读取结果；还没读过时为 `null`。
 * @returns 文本与"这个数字是否可信"。
 */
function creditChipOf(result: SubscriptionStatusResult | null): { readonly text: string; readonly known: boolean } {
  if (result === null) return { text: t.creditReading, known: false }
  if (!result.ok) return { text: t.creditUnknown, known: false }
  const remaining = result.credit.remainingSp
  if (remaining === null) return { text: t.creditUnknown, known: false }
  return { text: `${t.creditLabel} ${formatSp(remaining)} ${t.creditUnit}`, known: true }
}

/** 通道选择在设置页的显示名。 */
const ROUTE_LABEL: Readonly<Record<RouteChoice, string>> = {
  auto: '自动（推荐）',
  subscription: '订阅通道',
  byok: '自带密钥',
}

/** 通道选择在设置页的一句说明；说的是"选它会发生什么"。 */
const ROUTE_HINT: Readonly<Record<RouteChoice, string>> = {
  auto: '同源打开且已登录时走订阅通道，否则走你自己的密钥。',
  subscription: '用账号里的订阅额度，不需要填密钥。需要同源打开并登录。',
  byok: '一直用你自己填的服务商与密钥，不经过千手的服务器。',
}

/**
 * 模型选择器里的一句档位说明。
 *
 * 说的必须是**读到的**：档位读到就给名字，读不到就说读不到；「千手·强力」只在高级版 /
 * Max 出现这件事，也在这一句里讲清楚，免得用户以为列表短了是坏了。
 */
function subscriptionPickerNote(credit: SubscriptionStatusResult | null): string {
  if (credit === null || !credit.ok || credit.credit.tierLabel.length === 0) {
    return '档位还没读到：这里只列出所有档位都能用的模型。'
  }
  return `当前档位：${credit.credit.tierLabel}。「千手·强力」需要高级版或 Max。`
}

/**
 * 两份连接设置是不是同一份。
 *
 * 切换通道时用它决定"要不要真的落盘"：内容相同还写一次存储，等于每次渲染都动
 * localStorage，既是白干，也会让"这次写了哪些键"这类断言失去意义。
 * @param a - 当前生效的设置。
 * @param b - 目标设置。
 * @returns 三者都相同返回 `true`。
 */
function sameConnection(a: ConnectionSettings, b: ConnectionSettings): boolean {
  return a.providerId === b.providerId && a.baseUrl === b.baseUrl && a.model === b.model
}

/** 「测试连接」的超时；服务商不响应时不能让按钮一直转。 */
const TEST_TIMEOUT_MS = 15000

/** 界面上除五个底栏 tab 之外的整屏视图。 */
type View = 'screens' | 'settings' | 'history' | 'auth' | 'wallet'

/** 输入框上方的功能开关。 */
type ChipId = 'web' | 'think' | 'file' | 'image' | 'more'

/**
 * 电脑窗口的可用状态。`open` 之外的一切都不足以承载执行：
 * 未配对、电脑关闭、cookie 失效、网关不通都归入非 `open`。
 */
interface PcHandle {
  readonly runtime: PhoneWindowRuntime
  readonly snapshot: PhoneWindowSnapshot
  readonly open: boolean
}

/** 把时间戳格式化成气泡上的 `HH:MM`。 */
function formatTime(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function facesFor(count: number, extra: number) {
  return { shown: FACES.slice(0, Math.min(4, count)), extra }
}

function accessLabel(access: PhoneWindowSnapshot['access']): string {
  if (access === 'online') return t.pcOnline
  if (access === 'offline') return t.pcOffline
  if (access === 'unauthorized') return t.pcUnauthorized
  return t.pcUnavailable
}

/** 只有一个已绑定会话的在线电脑才允许执行；其余一律留在手机上。 */
function pcIsOpen(snapshot: PhoneWindowSnapshot): boolean {
  return snapshot.access === 'online' && snapshot.binding !== null
}

function deliveryLabel(state: DeliveryState): string {
  if (state === 'received') return t.deliveryReceived
  if (state === 'uncertain') return t.deliveryUncertain
  if (state === 'queued' || state === 'delivering') return t.queued
  return t.deliveryRejected
}

/**
 * 是否还有指令停在「可能没送到」的中间态。
 *
 * `PcWindowController` 只提供拉的 `snapshot()`，投递结果（已接收 / 未确认）是在
 * `enqueue` 之后异步落定的。不跟进这一步，界面会永远停在「已排队」——这正是
 * 合并前工作区里实际存在的缺陷。
 */
function hasPendingDelivery(records: readonly WindowCommandRecord[]): boolean {
  return records.some(record => record.state === 'queued' || record.state === 'delivering')
}

const EMPTY_WINDOW: PhoneWindowSnapshot = {
  binding: null,
  access: 'unavailable',
  records: [],
  cursor: null,
  error: null,
  connecting: false,
}

export function App({
  runtime: injectedRuntime, controller: injectedController, search: injectedSearch,
}: AppProps = {}) {
  /**
   * 本次发送的搜索接线。
   *
   * 控制器在**构造时**就固定了流实现，而"这一条要不要联网搜索"是发送那一刻才知道的，
   * 所以用一个 ref 把当前决定交给流闭包：`send()` 先写这里，再调 `controller.send()`。
   */
  const searchRef = useRef<SearchCall | null>(null)
  // 中间状态与来源都留在界面上，而不是塞进 `chat.ts` 的快照——那是锁定的契约，
  // 搜索的粒度也不该泄进对话控制器。
  const [searchState, setSearchState] = useState<{ readonly phase: SearchPhase | null; readonly sources: readonly SearchSource[] }>(
    { phase: null, sources: [] },
  )
  const searchRunner = injectedSearch ?? REAL_SEARCH
  /**
   * 订阅通道的界面状态。
   *
   * 三件事都留在这里而不是塞进 `chat.ts` 的快照（那是锁定的契约）：
   * `credit` 是网关给的档位与剩余点数、`downgradeNote` 是"这次不是你要的模型答的"、
   * `statusTick` 是"该重新读一次额度了"的信号（一条回复结束后扣费已经发生）。
   */
  const [credit, setCredit] = useState<SubscriptionStatusResult | null>(null)
  const [downgradeNote, setDowngradeNote] = useState<string | null>(null)
  const [statusTick, bumpStatus] = useReducer((count: number) => count + 1, 0)
  const [routeChoice, setRouteChoice] = useState<RouteChoice>(() => loadRouteChoice())
  /**
   * 发送那一刻的通道与条件。
   *
   * 流实现在控制器构造时就固定了，而"这一条走哪条路"要到发送时才定；用两个 ref
   * 把当时的判断交给流闭包，和上面 `searchRef` 是同一个理由。
   */
  const routeRef = useRef<AiRoute>('byok')
  const conditionsRef = useRef<RouteConditions>({ sameOrigin: false, signedIn: false })
  // 两个能力各自只建一次实例：控制器持有当前会话、流与密钥，运行时持有发件箱，
  // 重建都会丢状态。参数是给测试注入假实现用的；生产入口不传，走真实实现。
  const [controller] = useState(() => injectedController ?? new ChatController({
    stream: (options, handlers) => {
      if (routeRef.current === 'subscription') {
        // 兜底闸：条件在这一刻可能已经变了（会话过期、页面被换到非同源）。那时
        // **一个请求都不发**，也绝不改走 BYOK——用户选的是订阅通道，悄悄换一条会花钱的
        // 通路比报错更糟。见 `subscription.ts` 的 `refuseSubscription`。
        if (!usable(conditionsRef.current)) return refuseSubscription(conditionsRef.current, handlers)
        return streamSubscription(options, {
          onDelta: handlers.onDelta,
          onDone: (result) => {
            // 降级必须让用户看见：这一句挂在回复下方（见下面的 `downgrade`）。
            setDowngradeNote(result.note)
            // 结算帧里的剩余点数是这一轮之后的**权威值**；没有就重新读一次。
            if (result.remainingSp === null) bumpStatus()
            else {
              const remaining = result.remainingSp
              setCredit(current => withRemaining(current, remaining))
            }
            handlers.onDone()
          },
          onError: handlers.onError,
        })
      }
      const call = searchRef.current
      if (call === null || !call.enabled) return streamChat(options, handlers)
      // 收尾时把中间状态收回 idle：否则状态行会永远停在「正在搜索…」。
      return searchRunner(options, { onPhase: call.phase, onSources: call.sources }, {
        ...handlers,
        onDone: () => { call.phase(null); handlers.onDone() },
        onError: (failure) => { call.phase(null); handlers.onError(failure) },
      })
    },
  }))
  const [chat, setChat] = useState<ChatSnapshot>(() => controller.snapshot())
  const [runtime, setRuntime] = useState<PhoneWindowRuntime | null>(injectedRuntime ?? null)
  const [snapshot, setSnapshot] = useState<PhoneWindowSnapshot>(() => injectedRuntime?.snapshot() ?? EMPTY_WINDOW)
  // 手机自带模型是**永远可用**的那条路：电脑没配对、关机或换网络时，这一屏照常能用。
  // 电脑可达时默认把消息派给电脑（用户点模式条可以把它留在手机上）；`preferLocal`
  // 记的是用户这一次的意图，连接失败不会被写进偏好里——降级是显示层的，不是丢意图。
  const [preferLocal, setPreferLocal] = useState(false)
  const [view, setView] = useState<View>('screens')
  const [tab, setTab] = useState<TabId>('chat')
  const [drawer, setDrawer] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [chips, setChips] = useState<Record<ChipId, boolean>>({ web: false, think: false, file: false, image: false, more: false })
  /**
   * 某个开关被打开、但这次不会改变任何行为的说明。
   *
   * 存在的理由：`think`（深度思考）与 `more`（更多工具）目前**没有后端**——`send()` 里只有
   * `chips.web` 有分支。原先它们只是把按钮点亮，用户打开开关、发出去、结果毫无差别，
   * 这是「假交互」里最坏的一种（承诺了行为）。现在打开就当场说清，并且发送时一律放下。
   */
  const [inertNote, setInertNote] = useState<string | null>(null)
  /**
   * 账号服务：一个进程一份，放在 state 里而不是模块级单例——渲染期不该产生副作用，
   * 而且测试要能注入自己的实例。
   */
  /**
   * 有新版本可用。
   *
   * **只在提示里出现，不自动刷新**——用户可能正在等一条回复，自动刷新会把对话清掉。
   */
  const [updateReady, setUpdateReady] = useState(false)
  useEffect(() => {
    // 60 秒轮询：构建不会更快，太频繁只是白拉。测试可用 `?updateProbe=ms` 缩短间隔，
    // 否则这条路径没法在合理时间内被验证。
    const probe = new URLSearchParams(globalThis.location.search).get('updateProbe')
    const intervalMs = probe === null ? undefined : Number(probe)
    const watch = watchVersion(intervalMs === undefined || !Number.isFinite(intervalMs) ? {} : { intervalMs }, () => setUpdateReady(true))
    // 端到端验证用的可观测点：暴露检查函数，好在真实浏览器里手动触发一次而不必等轮询。
    ;(globalThis as unknown as { __qianshouVersionCheck?: () => Promise<boolean> }).__qianshouVersionCheck = watch.check
    return () => { watch.stop() }
  }, [])

  /**
   * 电脑入口。
   *
   * 手机直连上游账号接口会被**浏览器的跨域策略在请求发出前拦掉**（上游白名单只放行
   * localhost 与它自己的域），表现为「连不上账号服务器」。宿主进程不受同源策略约束，
   * 所以连上电脑之后账号请求一律经它转发——这是手机上唯一能通的路。
   *
   * `pcSlot` 是个可变槽：账号服务在启动时就建好了，而这里通常更晚才有客户端。
   */
  const pcSlot = useRef<{ client: WorkbenchClient | null }>({ client: null })
  const [pcEntry, setPcEntry] = useState(() => loadPcEntry())
  const [pcLink, setPcLink] = useState<'idle' | 'connecting' | 'connected' | 'failed'>(
    () => (loadPcEntry().length > 0 ? 'connecting' : 'idle'),
  )
  const [pcLinkMessage, setPcLinkMessage] = useState<string | null>(null)
  /**
   * 扫码有两个状态，**必须分开**：
   * - `scanWanted`：用户点了扫码 → 先渲染取景框（video 元素因此出现在 DOM 里）；
   * - `scanSession`：相机真的开了 → 用来在取消时释放。
   *
   * 合成一个状态是不行的：`startScan` 需要 `videoRef.current`，而取景框由状态控制渲染——
   * 一个状态会变成「要先有 ref 才能设状态、要先设状态才有 ref」的循环。第一版就是这么错的：
   * ref 是 null，于是直接走「相机没准备好」，连原因都没显示。
   */
  const [scanWanted, setScanWanted] = useState(false)
  const [scanSession, setScanSession] = useState<ScanSession | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    // 冷启动：上次连过就自动重连一次。入口令牌可能已经作废（工作台重启会换），
    // 那时如实显示失败并让用户重新粘贴，不假装还连着。
    const saved = loadPcEntry()
    if (saved.length > 0) void connectPc(saved)
    // 只在挂载时跑一次：connectPc 每次渲染都是新函数，放进依赖会变成无限重连。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 同源部署探测。
   *
   * 手机端与工作台同源时（挂在 `https://<工作台>/mobile/` 下），账号请求可以直接走
   * **相对路径**的宿主账号面——没有跨域、也没有额外一跳。这比"经电脑转发"更直接，
   * 所以在电脑连接之前先探一次；探不到才退回电脑转发或直连。
   */
  const [accountService] = useState(() => openAccount({ pc: pcSlot.current }))
  useEffect(() => {
    /**
     * 只在**同源部署的那份产物**上启用。
     *
     * 判据用构建时的资源前缀而不是运行时探测：`/mobile/` 前缀就是"挂在工作台下面"这个
     * 事实的确定信号（见 `vite.config.ts` 的 `base`）。用运行时探测的话，独立预览
     * （没有宿主账号面）也会白发一次请求——那会污染"这一条发了哪些请求"这类断言，
     * 实测被 `web-search-chip` 的用例抓出来过。
     */
    if (!import.meta.env.BASE_URL.startsWith('/mobile/')) return
    let cancelled = false
    void (async () => {
      const ok = await hostAccountReachable(globalThis.fetch.bind(globalThis))
      if (!cancelled && ok) accountService.useSameOrigin()
    })()
    return () => { cancelled = true }
  }, [accountService])
  const [account, setAccount] = useState<AccountSnapshot>(() => accountService.snapshot())
  useEffect(() => accountService.subscribe(setAccount), [accountService])

  /**
   * 这一次走哪条通道。
   *
   * 判定全在 `resolveAiRoute` 里（同源 + 有账号才可能走订阅，否则一律回落自带密钥），
   * 这里只把事实喂给它：
   * - **同源**：`account.route === 'same-origin'`，它只在上面那次宿主账号面探测通过后
   *   才成立。这是**硬边界**——手机连的是另一台电脑时 cookie 属于那台电脑的账号，
   *   用它会把这笔费用记到别人头上。
   * - **有账号**：本次会话已登录，或本机留着上次登录的账号（`account.account` 是本机
   *   缓存，且按域名隔离）。这里**不**额外发一次请求去"确认登录"：宿主账号面没有
   *   refresh 路由，手机的刷新请求会打到上游域并被浏览器拦掉（见 `account.ts` 的
   *   `HOST_PATHS`），所以冷启动时拿不到更权威的信号。凭据真的失效时网关回 401，
   *   界面会说"登录状态已过期"并给出出路——那次不会产生任何费用。
   */
  const routeConditions: RouteConditions = {
    sameOrigin: account.route === 'same-origin',
    signedIn: account.state === 'authenticated' || account.account !== null,
  }
  const route = resolveAiRoute(routeChoice, routeConditions)
  /** 订阅通道此刻用不了的原因；能用时为 `null`。界面必须如实说出来（见 Settings）。 */
  const routeBlocked = routeBlockReason(routeConditions)
  // 用 effect 而不是渲染期赋值：渲染必须是纯的（同一个理由见下面 `accountService` 的说明）。
  useEffect(() => {
    routeRef.current = route
    conditionsRef.current = routeConditions
  }, [route, routeConditions.sameOrigin, routeConditions.signedIn])

  /**
   * 把"走哪条通道"落到控制器的连接设置上。
   *
   * 这是两条通路的**切换点**，也是订阅档不覆盖用户自带密钥配置的地方：
   * `store.saveSettings` 按 `providerId` 分开落盘，订阅档写自己那份记录。
   * 只在真的有变化时写，避免每次渲染都写一遍存储。
   */
  useEffect(() => {
    const wanted = route === 'subscription' ? subscriptionSettings() : loadByokSettings()
    if (sameConnection(chat.settings, wanted)) return
    controller.saveConnection(wanted, controller.secretValue())
    setChat(controller.snapshot())
  }, [route, controller, chat.settings])

  /** 换通道就把上一条的降级说明收起来：那是上一条回复的事。 */
  useEffect(() => { setDowngradeNote(null) }, [route])

  /**
   * 读订阅额度。
   *
   * 只在订阅档下读：其他档位没有订阅额度这回事，读了反而会去打扰一个可能没登录的网关。
   * `statusTick` 由"这一轮扣费已经发生"驱动（见上面的流闭包）。
   */
  useEffect(() => {
    if (route !== 'subscription') { setCredit(null); return }
    let cancelled = false
    void readSubscriptionStatus().then((result) => {
      if (!cancelled) setCredit(result)
    })
    return () => { cancelled = true }
  }, [route, statusTick])
  const [batch, setBatch] = useState(0)
  const [spin, setSpin] = useState(false)
  const [agentCat, setAgentCat] = useState('hot')
  const [discoverCat, setDiscoverCat] = useState('hot')
  const [taskFilter, setTaskFilter] = useState('all')
  const [taskSection, setTaskSection] = useState(0)
  const [dispatchOpen, setDispatchOpen] = useState(false)
  const [dispatchSection, setDispatchSection] = useState(0)
  const [query, setQuery] = useState('')
  // 上次退出时若已有内容，直接回到对话：否则"刷新后记录还在"就只是数据还在，
  // 屏幕上看到的却仍然是首页，用户会以为记录丢了。两边的记录都算。
  const [chatOpen, setChatOpen] = useState(() => (injectedRuntime?.snapshot().records.length ?? 0) > 0 || controller.snapshot().messages.length > 0)
  const [liked, setLiked] = useState<'up' | 'down' | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  /** 投递跟进的节拍；见下面 `pendingDelivery` 的说明。 */
  const [deliveryTick, bumpDelivery] = useReducer((count: number) => count + 1, 0)
  /** 已经就「没送到」提示过的请求 id，避免同一张回执反复弹。 */
  const warnedRef = useRef(new Set<string>())
  const alive = useRef(true)

  useEffect(() => () => { alive.current = false }, [])

  useEffect(() => {
    if (injectedRuntime !== undefined) return
    let live = true
    void PhoneWindowRuntime.open().then((next) => {
      if (!live) return
      setRuntime(next)
      setSnapshot(next.snapshot())
      if (next.snapshot().records.length > 0) setChatOpen(true)
    }).catch(() => {
      if (!live) return
      // 电脑连不上不影响这台手机说话：保持空窗口快照即可。
      setSnapshot(EMPTY_WINDOW)
    })
    return () => { live = false }
  }, [injectedRuntime])

  useEffect(() => {
    if (runtime === null) return
    const sync = () => setSnapshot(runtime.snapshot())
    sync()
    return runtime.subscribe(sync)
  }, [runtime])

  /**
   * 投递结果跟进：电脑在 `enqueue` 之后才给出「已接收 / 未确认」，而
   * `PhoneWindowRuntime` 只在它自己的操作里推快照。没有这一步，气泡会永远停在
   * 「已排队」——合并前工作区里就实际存在这个缺陷。
   *
   * 只用运行时的公开接口：一次空 `enqueue` 不产生任何指令（空白输入被忽略），
   * 但它会经 `emit()` 清掉运行时的快照缓存，于是下一次 `snapshot()` 读到的就是
   * 控制器里刚落定的投递状态。失败一律按「不可达」处理：不改模式、不暂停重试、
   * 也绝不把机内错误码透给用户。
   */
  const pendingDelivery = hasPendingDelivery(snapshot.records)
  /**
   * 回执落定为「未确认」时：提示一次，并把模式让回手机。
   *
   * 这是「从可达变不可达」的优雅降级——不是报错，而是这条留在手机上、下一条也
   * 不再往一台联系不上的电脑上送。电脑恢复后用户点一下模式条即可切回遥控。
   */
  useEffect(() => {
    const uncertain = snapshot.records.find(record => record.state === 'uncertain'
      && !warnedRef.current.has(record.command.requestId))
    if (uncertain === undefined) return
    warnedRef.current.add(uncertain.command.requestId)
    setPreferLocal(true)
    show(t.modePcFellBack)
  }, [snapshot.records])
  useEffect(() => {
    if (runtime === null || !pendingDelivery || !pcIsOpen(snapshot)) return
    let alive = true
    const stop = runtime.subscribe(() => { if (alive) setSnapshot(runtime.snapshot()) })
    // 用定时器而不是递归微任务：微任务链会把宏任务（含测试超时）饿死，也读不到
    // 定时器驱动的回执。250ms 一轮，`pendingDelivery` 落定为假时 effect 自行清理。
    const timer = window.setTimeout(() => {
      if (!alive) return
      // 一次跟进：清掉运行时缓存并重读控制器的投递状态（纯本地，无网络、无写盘）。
      runtime.refresh()
      setSnapshot(runtime.snapshot())
      bumpDelivery()
    }, 250)
    return () => { alive = false; window.clearTimeout(timer); stop() }
  }, [runtime, pendingDelivery, snapshot.access, snapshot.binding, deliveryTick])

  // 手机侧对话的每次状态变化（含每个流式增量）都会推一个新快照过来。
  useEffect(() => {
    const sync = () => setChat(controller.snapshot())
    sync()
    return controller.subscribe(sync)
  }, [controller])
  // 页面卸载时收掉进行中的流，避免用户离开后请求还在跑。
  useEffect(() => () => { controller.abort() }, [controller])

  const pc: PcHandle | null = runtime === null ? null : { runtime, snapshot, open: pcIsOpen(snapshot) }
  /** 当前这一条消息会怎么走；模式条显示它，用户能自己改。 */
  const pcMode = pc !== null && pc.open && !preferLocal ? 'remote' : 'local'
  /**
   * 「联网搜索」打开后这一条的去处。
   *
   * 渲染期就算一次：用户按下开关的那一刻就该看到它会长什么样，而不是发出去之后才知道。
   * 发送时用同一个纯函数再算一次——两处结论必然一致。
   */
  const webPlan = webSearchPlan({
    enabled: chips.web,
    providerId: chat.settings.providerId,
    pcReachable: pc !== null && pc.open,
    hasKey: controller.hasKey(),
  })
  const groups = useMemo(() => groupRuns(chat.messages), [chat.messages])
  /**
   * 连带问题按**最后一句用户输入**现算，放在控制列最下面贴着回复。
   * 之前这里挂的是 `data.ts` 里写死的示例，用户问什么都显示特斯拉和 PPT 大纲。
   * 只依赖那一段文字，所以流式输出的每个增量都不会让这一行抖。
   */
  const followUps = useMemo(() => {
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const message = groups[index]
      if (message !== undefined && message.role === 'user') return deriveFollowUps(message.content)
    }
    return deriveFollowUps('')
  }, [groups])
  const modelName = controller.modelLabel()
  /**
   * 模型候选。
   *
   * 订阅档走**前台目录**（按档位过滤：普通版看不到「千手·强力」），其他档位仍走
   * 控制器里的 BYOK 目录。两处的显示名都是给人看的名字，没有任何上游标识。
   */
  const subscriptionTier = credit !== null && credit.ok ? credit.credit.tierId : null
  const modelOptions = route === 'subscription'
    ? subscriptionModelOptions(chat.settings.model, subscriptionTier)
    : controller.modelOptions()
  /** 对话页的额度条；只在订阅档显示，读不到时说"额度未知"。 */
  const creditChip = route === 'subscription' ? creditChipOf(credit) : null
  const suggestions = SUGGESTIONS[batch] ?? SUGGESTIONS[0]
  const agents = useMemo(() => AGENTS.filter(a => a.name.includes(query) || a.desc.includes(query) || query === ''), [query])
  const tasks = TASKS.filter(task => taskMatches(taskFilter, task.status))
  const darkHead = tab === 'discover'

  /**
   * 连上电脑：用入口地址换一个会话 cookie。
   * @param raw - 用户在电脑上看到的入口地址（`http://…/?token=…`）。
   */
  async function connectPc(raw: string) {
    const trimmed = raw.trim()
    if (trimmed.length === 0) {
      setPcLink('idle')
      setPcLinkMessage(null)
      return
    }
    const settings = parseEntryUrl(trimmed)
    if (settings === null) {
      setPcLink('failed')
      setPcLinkMessage('这串地址看不懂。请把电脑上显示的完整地址（以 http:// 或 https:// 开头）整段粘过来。')
      return
    }
    setPcLink('connecting')
    setPcLinkMessage(null)
    const client = new WorkbenchClient(settings)
    try {
      await client.connect(new AbortController().signal)
      pcSlot.current.client = client
      savePcEntry(trimmed)
      setPcEntry(trimmed)
      setPcLink('connected')
      setPcLinkMessage(null)
    } catch (error) {
      pcSlot.current.client = null
      setPcLink('failed')
      setPcLinkMessage(error instanceof Error ? error.message : '连不上这台电脑。')
    }
  }

  /**
   * 关掉相机并释放。
   *
   * 顺手清掉扫码留下的那句提示：不清的话，用户点了「取消」之后
   * 「把二维码放进取景框」还挂在「连接电脑」下面，像是没取消掉。
   */
  function stopScan() {
    scanSession?.stop()
    setScanSession(null)
    setScanWanted(false)
    setPcLinkMessage(null)
  }

  /**
   * 开始扫码：**只表达意图**，真正开相机在下面的 effect 里。
   *
   * 为什么要分两步：相机只能在取景框（video 元素）已经进 DOM 之后才能开，
   * 所以这里先设意图、让 React 先把取景框渲染出来。
   * 这一步换来的前提是**取景框和按钮必须在同一支渲染树里**（见下面 `scanWanted &&` 那段）。
   */
  function beginScan() {
    const support = scanSupport()
    if (!support.ok) {
      setPcLink('failed')
      setPcLinkMessage(SCAN_COPY[support.reason ?? 'unsupported'])
      return
    }
    setPcLinkMessage('把二维码放进取景框')
    setScanWanted(true)
  }

  /**
   * 取景框进 DOM 之后开相机。
   *
   * 依赖只看 `scanWanted`：相机只需开一次；把 `scanSession` 放进依赖会导致
   * 「开相机 → 设会话 → 再开一次」的循环。
   */
  useEffect(() => {
    if (!scanWanted) return
    const video = videoRef.current
    if (video === null) {
      // 取景框没进 DOM 只有一种解释：扫码弹层没挂在当前这一支渲染树里——正是这次报的 bug
      // （按钮在「我的」页，弹层却只挂在账号屏那一支）。旧文案写「重开一次页面再试」，
      // 那是句谎话：接线错了，重开多少次都一样。
      setPcLink('failed')
      setPcLinkMessage('取景框没能打开，扫码已取消。')
      setScanWanted(false)
      return
    }
    let cancelled = false
    void startScan({
      video,
      onCode: (value) => { void finishScan(value) },
      onFailure: (kind) => {
        if (cancelled) return
        setPcLink('failed')
        setPcLinkMessage(SCAN_COPY[kind])
        setScanWanted(false)
      },
    }).then((session) => {
      if (cancelled) { session.stop(); return }
      setScanSession(session)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanWanted])

  /** 扫到内容：兑换绑定。 */
  async function finishScan(value: string) {
    stopScan()
    const ticket = ticketOf(value)
    if (ticket === null) {
      setPcLink('failed')
      setPcLinkMessage('这个二维码不是配对码。请在电脑上重新生成。')
      return
    }
    const result = await redeemPairing({ ticket, deviceId: readDeviceId() })
    if (!result.ok) {
      setPcLink('failed')
      setPcLinkMessage(result.message)
      return
    }
    setPcLink('connected')
    setPcLinkMessage('配对成功，这台手机已经获得遥控权')
  }

  function show(message: string) {
    setToast(message)
    window.setTimeout(() => { if (alive.current) setToast(null) }, 1400)
  }

  /** 把一段文字放进输入框，并停在对话页；用户自己按发送。 */
  function openChat(text: string) {
    setView('screens')
    setChatOpen(true)
    setTab('chat')
    setDrawer(false)
    setDraft(text)
  }

  /**
   * 发送。路只有一条能走通：联网搜索打开且电脑可达时，**强制**派给电脑（只有电脑
   * 挂着工作台的联网搜索能力）；否则电脑可达且用户选了遥控就派给电脑；再否则这台
   * 手机自己回答——能用自己密钥联网搜索的就带上搜索，用不了的就照常回答并说明白。
   * 降级不是错误路径——用户看到的是「这条在手机上回答」，而不是一个技术报错。
   */
  /**
   * 切换输入框上方的开关。
   *
   * 只有真正会改变这一条去向的开关才接受打开；其余的（`think`/`more`）打开时给一句
   * 明确说明，避免用户以为它生效了。
   * @param id - 被切换的开关。
   */
  function onChipToggle(id: ChipId) {
    const next = !chips[id]
    if (next && (id === 'think' || id === 'more')) {
      setInertNote(id === 'think' ? t.deepThinkNoEffect : t.moreToolsNoEffect)
      // 不点亮：点了却不生效的开关，亮着比不亮更骗人。
      return
    }
    setInertNote(null)
    setChips(current => ({ ...current, [id]: next }))
  }

  function send() {
    sendText(draft)
  }

  /**
   * 真正发送一段文字。拆出来是因为「连带问题」也要走同一条路：芯片点下去必须和按发送键
   * 完全一样（清空输入框、按当时的联网/模式决定路径、进对话页），而不是只把字填进输入框
   * 让用户再按一次。`send()` 与 `onFollow` 都只是它的入口。
   * @param raw - 待发送的原文。
   */
  function sendText(raw: string) {
    const text = raw.trim()
    if (text.length === 0) return
    setDraft('')
    setInertNote(null)
    // 上一条的降级说明属于上一条，新的一条不继承。
    setDowngradeNote(null)
    setChatOpen(true)
    setView('screens')
    setTab('chat')
    setDrawer(false)
    const plan = webSearchPlan({
      enabled: chips.web,
      providerId: chat.settings.providerId,
      pcReachable: pc !== null && pc.open,
      hasKey: controller.hasKey(),
    })
    // 芯片打开 + 电脑可达 = 这一条走电脑，不管模式条停在哪儿：只有电脑有联网搜索。
    const remoteThisTurn = plan.route === 'pc' || (!chips.web && pcMode === 'remote' && pc !== null)
    // 接线要在 `controller.send()` **之前**写好：控制器会同步调用流实现。
    searchRef.current = {
      enabled: plan.route === 'phone-search',
      phase: phase => setSearchState(current => ({ ...current, phase })),
      sources: sources => setSearchState(current => ({ ...current, sources })),
    }
    setSearchState({ phase: null, sources: [] })
    if (remoteThisTurn && pc !== null) {
      // 投递失败只给一句中文说明；`snapshot.error` 里是 PC_WINDOW_* 这类机内代号，
      // 对用户没有意义，绝不透到界面上。
      void pc.runtime.enqueue(text).catch(() => { show(t.modePcFellBack) })
      return
    }
    // 用户在遥控模式下发的这条：电脑刚好不可达，如实说一声这条改由手机回答。
    if (pc !== null && !preferLocal && !chips.web) show(t.modePcFellBack)
    if (!chatOpen) {
      // 首页直接发：这句话开一条新会话，不再拿它当占位提示。
      controller.newSession()
      setLiked(null)
    }
    controller.send(text)
  }

  function newChat() {
    controller.newSession()
    setLiked(null)
    setChatOpen(false)
    setView('screens')
    setTab('chat')
    setDrawer(false)
  }

  function openSession(id: string) {
    controller.openSession(id)
    setLiked(null)
    setChatOpen(true)
    setView('screens')
    setTab('chat')
    setDrawer(false)
  }

  function goTab(next: TabId) {
    setView('screens')
    setTab(next)
    setDrawer(false)
    setDispatchOpen(false)
    setModelOpen(false)
    if (next !== 'chat') setChatOpen(false)
  }

  /** 模式条：只翻用户的意图。电脑真不可达时 `pcMode` 仍然是本地，界面照实说。 */
  function selectMode(next: 'local' | 'remote') {
    setPreferLocal(next === 'local')
    setModelOpen(false)
    if (next === 'remote') show(t.modeRemoteHint)
  }

  function reconnect() {
    if (runtime === null) {
      show(t.pcUnavailable)
      return
    }
    void runtime.connect().catch(() => { show(t.pcUnavailable) })
  }

  /** 设置页保存：写入本机存储，失败时明确告诉用户这次没存上。 */
  function saveConnection(settings: ConnectionSettings, secret: string): boolean {
    const ok = controller.saveConnection(settings, secret)
    setChat(controller.snapshot())
    show(ok ? t.settingsSaved : t.settingsStorageFailed)
    return ok
  }

  /**
   * 用户改通道选择。
   *
   * 选择**先落盘再渲染**：订阅档在条件不满足时（非同源 / 未登录）不会真的生效，但选择
   * 本身要记住——用户把手机换成同源地址打开后，这一档应当自动启用。
   * @param choice - 用户选的那一档。
   */
  function chooseRoute(choice: RouteChoice): void {
    try {
      saveRouteChoice(choice)
    } catch {
      // 存储写不进去时仍然让本次会话按用户的选择走；只是下次打开要重选。
      show(t.settingsStorageFailed)
    }
    setRouteChoice(choice)
  }

  const records = snapshot.records

  if (view === 'settings') {
    return (
      <div className="stage">
        <div className="phone">
          <Settings
            /**
             * BYOK 表单**永远显示用户自己那份配置**，与当前通道无关。
             *
             * 理由：这个表单编辑的是"自带密钥"那条通路。订阅生效时若把
             * `qianshou://subscription` 填进这里，用户会以为自己的端点被改掉了——
             * 而它其实只是没有被用到。
             */
            settings={loadByokSettings()}
            secret={controller.secretValue()}
            pc={pc}
            route={{ choice: routeChoice, effective: route, blocked: routeBlocked, credit, tier: subscriptionTier }}
            onRoute={chooseRoute}
            onBack={() => setView('screens')}
            onSave={saveConnection}
            onReconnect={reconnect}
          />
        {toast && <div className="toast">{toast}</div>}
        </div>
      </div>
    )
  }

  if (view === 'auth') {
    return (
      <>
        <AuthScreen service={accountService} onBack={() => setView('screens')} onDone={() => { setView('screens'); setTab('me') }} />
        {updateReady && <UpdateBar />}
      </>
    )
  }
  if (view === 'wallet') {
    return <><div className="stage"><div className="phone">
      <WalletScreen service={accountService} onBack={() => { setView('screens'); setTab('me') }} />
      {updateReady && <UpdateBar />}
    </div></div></>
  }
  if (view === 'history') {
    return (
      <div className="stage">
        <div className="phone">
          <History
            sessions={chat.sessions}
            current={chat.sessionId}
            records={records}
            onBack={() => setView('screens')}
            onOpen={openSession}
            onNew={newChat}
          />
          {updateReady && <UpdateBar />}
          {toast && <div className="toast">{toast}</div>}
        </div>
      </div>
    )
  }

  return (
    <div className="stage">
      <div className={`phone${darkHead ? ' dark-top' : ''}`}>
        {tab === 'chat' && !chatOpen && (
          <Home
            model={modelName}
            onMenu={() => setDrawer(true)}
            onModel={() => setModelOpen(v => !v)}
            onTile={(prompt) => openChat(prompt)}
            suggestions={suggestions}
            spin={spin}
            onShuffle={() => {
              setSpin(true)
              setBatch(i => nextBatch(i, SUGGESTIONS.length))
              window.setTimeout(() => { if (alive.current) setSpin(false) }, 480)
            }}
            onSuggest={openChat}
          />
        )}
        {tab === 'chat' && chatOpen && (
          <Chat
            model={modelName}
            groups={groups}
            records={records}
            phase={chat.phase}
            failure={chat.failure}
            searchPhase={searchState.phase}
            searchSources={searchState.sources}
            downgrade={downgradeNote}
            liked={liked}
            followUps={followUps}
            onMenu={() => setDrawer(true)}
            onModel={() => setModelOpen(v => !v)}
            onLike={v => setLiked(v)}
            onFollow={sendText}
            onHistory={() => setView('history')}
            onOpenSettings={() => setView('settings')}
          />
        )}
        {tab === 'agents' && (
          <Agents
            query={query}
            cat={agentCat}
            agents={agents}
            onMenu={() => setDrawer(true)}
            onQuery={setQuery}
            onCat={setAgentCat}
            onUse={(name) => { show(`已选用 ${name}`); openChat(`用「${name}」帮我开始工作`) }}
            onCreate={() => show('专属专家将在电脑端创建')}
          />
        )}
        {tab === 'discover' && (
          <Discover
            query={query}
            cat={discoverCat}
            onCat={setDiscoverCat}
            onQuery={setQuery}
            onTry={() => goTab('agents')}
            onCase={title => openChat(title)}
            onInvite={() => show('邀请功能还没做，先不放了')}
          />
        )}
        {tab === 'tasks' && !dispatchOpen && (
          <Tasks
            filter={taskFilter}
            section={taskSection}
            tasks={tasks}
            onMenu={() => setDrawer(true)}
            onFilter={setTaskFilter}
            onSection={setTaskSection}
            onNew={() => { setTab('chat'); setChatOpen(false); setDraft('用自然语言创建一个任务：') }}
            onOpen={() => setDispatchOpen(true)}
          />
        )}
        {tab === 'tasks' && dispatchOpen && (
          <Dispatch
            section={dispatchSection}
            onSection={setDispatchSection}
            onMenu={() => setDrawer(true)}
            onBack={() => setDispatchOpen(false)}
          />
        )}
        {tab === 'me' && (
          <Me
            model={modelName}
            pcMode={pcMode}
            account={account}
            pcEntry={pcEntry}
            pcLink={pcLink}
            pcLinkMessage={pcLinkMessage}
            onPcEntry={setPcEntry}
            onPcConnect={(value) => { void connectPc(value) }}
            onScan={() => { void beginScan() }}
            onMenu={() => setDrawer(true)}
            onAction={(id) => {
              if (id === 'models' || id === 'settings') setView('settings')
              else if (id === 'upgrade' || id === 'vip') show('会员升级在电脑端完成')
              else if (id === 'charge') setView('wallet')
              else if (id === 'profile') setView('auth')
              else show('已打开')
            }}
          />
        )}
        {(tab === 'chat') && (
          <>
            <ModeBar
              mode={pcMode}
              pc={pc}
              credit={creditChip}
              onSelect={selectMode}
            />
            <Composer
              draft={draft}
              chips={chips}
              showExtra={chatOpen}
              streaming={chat.streaming}
              searchNote={webPlan.note}
              inertNote={inertNote}
              searchActive={webPlan.route !== 'phone-plain'}
              voiceSupport={voiceSupport()}
              appleVoice={appleSpeechSupport()}
              onDraft={setDraft}
              onSend={send}
              onStop={() => controller.abort()}
              onChip={onChipToggle}
            />
          </>
        )}
        <TabBar
          tab={tab}
          dispatch={dispatchOpen}
          onTab={goTab}
        />
        {modelOpen && (
          <ModelPicker
            mode={pcMode}
            pc={pc}
            options={modelOptions}
            current={chat.settings.model}
            note={route === 'subscription' ? subscriptionPickerNote(credit) : null}
            onPick={(id) => {
              saveConnection({ ...chat.settings, model: id }, controller.secretValue())
              setModelOpen(false)
            }}
            onSelectMode={selectMode}
            onSettings={() => { setModelOpen(false); setView('settings') }}
          />
        )}
        {drawer && (
          <Drawer
            tab={tab}
            account={account}
            onClose={() => setDrawer(false)}
            onNew={newChat}
            onHistory={() => { setDrawer(false); setView('history') }}
            onItem={(id) => {
              if (id === 'tasks') { setTab('tasks'); setDispatchOpen(false) }
              else setTab(tabForMenu(id))
              setDrawer(false)
            }}
            onMe={() => { setTab('me'); setDrawer(false) }}
          />
        )}
        {/*
          扫码取景框。
          **它必须挂在「我的」页这一支里**：唯一能触发扫码的按钮 `.pc-link-scan` 在 `Me`，
          而 `Me` 只由这一支渲染。原先它写在上面 `view === 'auth'` 那一支里——那一支不渲染
          `Me`，`scanWanted` 永远不会在那里为真，所以是一段够不到的死代码；
          而真正的后果是：点扫码只把意图设成 true，当前这一支里却**没有 video 元素**，
          相机因此永远开不了，用户看到的就是「点了没反应」。
          回归测试钉住这条接线：`tests/scan-wiring.spec.ts`。
        */}
        {scanWanted && (
          <div className="scan-overlay" role="dialog" aria-label="扫码配对">
            <video ref={videoRef} playsInline muted />
            <p>把电脑上显示的二维码放进取景框</p>
            <button className="scan-cancel" onClick={stopScan}>取消</button>
          </div>
        )}
        {updateReady && <UpdateBar />}
        {toast && <div className="toast">{toast}</div>}
      </div>
    </div>
  )
}

/**
 * 模式条：告诉用户「这一条会怎么走」，并允许改。
 *
 * 它是两种能力共存的可见证据：电脑可达时出现遥控入口，不可达时如实说明
 * 「电脑不可用，这台手机自己回答」——不弹技术错误，也不假装已经派出去。
 */
/**
 * 模式条上还要显示订阅额度（只有订阅档才有这一段）。
 *
 * `known` 决定样式：读到的数字用蓝色（可信），"额度未知"用灰色——不把"不知道"
 * 混进"有数字"那一类里。
 */
function ModeBar({
  mode, pc, credit, onSelect,
}: {
  mode: 'local' | 'remote'
  pc: PcHandle | null
  credit: { readonly text: string; readonly known: boolean } | null
  onSelect: (mode: 'local' | 'remote') => void
}) {
  const chip = credit === null
    ? null
    : <b className={`credit${credit.known ? '' : ' unknown'}`}><I.IcoSpark />{credit.text}</b>
  if (mode === 'remote' && pc !== null) {
    return (
      <div className="modebar remote">
        <I.IcoServer />
        <span>{t.modeBarRemote}</span>
        {chip}
        <button className="mode-switch" aria-label={t.modeUseLocal} onClick={() => onSelect('local')}>{t.modeUseLocal}</button>
      </div>
    )
  }
  const pcUsable = pc !== null && pc.open
  return (
    <div className="modebar local">
      <I.IcoSpark />
      <span>{pcUsable ? t.modeBarLocalReady : t.modeBarLocalOnly}</span>
      {chip}
      {pcUsable && <button className="mode-switch" aria-label={t.modeUsePc} onClick={() => onSelect('remote')}>{t.modeUsePc}</button>}
    </div>
  )
}

function TabBar({ tab, dispatch, onTab }: { tab: TabId; dispatch: boolean; onTab: (tab: TabId) => void }) {
  const items: Array<{ id: TabId; label: string; icon: (on: boolean) => ReactNode }> = dispatch
    ? [
      { id: 'chat', label: t.tabChat, icon: on => <I.IcoChat filled={on} /> },
      { id: 'agents', label: t.tabAgents, icon: on => <I.IcoGrid filled={on} /> },
      { id: 'tasks', label: t.tabTasks, icon: on => <I.IcoBolt filled={on} /> },
      { id: 'discover', label: '数据', icon: on => <I.IcoTask filled={on} /> },
      { id: 'me', label: t.tabMe, icon: on => <I.IcoMe filled={on} /> },
    ]
    : [
      { id: 'chat', label: t.tabChat, icon: on => <I.IcoChat filled={on} /> },
      { id: 'agents', label: t.tabAgents, icon: on => <I.IcoGrid filled={on} /> },
      { id: 'discover', label: t.tabDiscover, icon: on => <I.IcoDiscover filled={on} /> },
      { id: 'tasks', label: t.tabTasks, icon: on => <I.IcoTask filled={on} /> },
      { id: 'me', label: t.tabMe, icon: on => <I.IcoMe filled={on} /> },
    ]
  return (
    <nav className="tabbar">
      {items.map(item => (
        <button key={item.id} className={`tab${tab === item.id ? ' on' : ''}`} onClick={() => onTab(item.id)}>
          {item.icon(tab === item.id)}
          {item.label}
        </button>
      ))}
    </nav>
  )
}

function Composer({
  draft, chips, showExtra, streaming, searchNote, searchActive, inertNote, voiceSupport, appleVoice, onDraft, onSend, onStop, onChip,
}: {
  draft: string
  chips: Record<ChipId, boolean>
  showExtra: boolean
  streaming: boolean
  /** 「联网搜索」打开后这一条会怎么走；关着的时候是 `null`，不占位。 */
  searchNote: string | null
  /** 这一条会不会**真的**联网搜索（电脑搜或手机搜）；纯粹照常回答时为 false。 */
  searchActive: boolean
  /** 某个开关这次不会生效时的说明；没有就是 `null`，不占位。 */
  inertNote: string | null
  /** **宿主那条路**（录音 → 上传给工作台）能不能用；见 `voice.ts`。 */
  voiceSupport: VoiceSupport
  /** **苹果自带那条路**（浏览器 Web Speech API）能不能用；见 `voice-apple.ts`。 */
  appleVoice: VoiceSupport
  onDraft: (v: string) => void
  onSend: () => void
  onStop: () => void
  onChip: (id: ChipId) => void
}) {
  // 语音识别出来的文字**只写进输入框**，不在这里发送：识别错一个字就发出去，
  // 代价比多按一下发送按钮大得多。
  const voice = useVoiceInput({ draft, onDraft, support: voiceSupport, apple: appleVoice })
  // 提示行上说什么，由 voice-input.ts 里那条产品判断决定（失败 → 能力说明 →
  // **自动收尾倒计时** → 常规状态）；界面只管把它画出来，见 voice-note-view.tsx。
  const voiceNote = voiceNoteOf(voice)
  return (
    <div className="composer-wrap">
      <div className="composer">
        {inertNote !== null && (
          <p className="search-note" role="status">
            <I.IcoWrench />
            <span>{inertNote}</span>
          </p>
        )}
        {searchNote !== null && (
          <p className={`search-note${searchActive ? ' on' : ''}`} role="status">
            <I.IcoGlobe />
            <span>{searchNote}</span>
          </p>
        )}
        {voiceNote !== null && (
          <VoiceNoteRow
            note={voiceNote}
            bars={voice.meter}
            recording={voice.phase === 'recording'}
            closing={voice.hint !== null}
            interim={voice.interim}
          />
        )}
        <div className="composer-row">
          {/* 这里原来有「附件」和「麦克风」两个按钮：手机上没有实现文件上传，也没有语音识别，
              画一个能点的图标就是承诺了做不到的事。麦克风现在**做完了**：苹果自带那条
              （见 voice-apple.ts）加宿主那条（见 voice.ts），两条任一条通就能点。附件仍然没有。 */}
          <button
            type="button"
            className={`composer-mic${voice.phase === 'recording' ? ' rec' : ''}`}
            // 不能用时按钮照样在，只是点不动：灰按钮加一句原因，比凭空少一个图标诚实。
            // 判据是**两条路合起来**能不能用（`voice.available`）——只看宿主那条的话，
            // 遥控形态下明明能用苹果那条路，按钮却是灰的。
            disabled={!voice.available || voice.phase === 'transcribing'}
            aria-label={voice.phase === 'recording' ? '停止录音并识别' : '语音输入'}
            aria-pressed={voice.phase === 'recording'}
            onClick={voice.toggle}
          >
            <I.IcoMic />
          </button>
          <input value={draft} placeholder={t.composerPlaceholder} onChange={e => onDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onSend() }} aria-label={t.composerPlaceholder} />
          {streaming
            ? <button className="stop" aria-label={t.stop} onClick={onStop}><StopIcon /></button>
            : <button className="send" aria-label={t.send} disabled={!draft.trim()} onClick={onSend}><I.IcoSend /></button>}
        </div>
        <div className="chips">
          <button className={`chip${chips.web ? ' on' : ''}`} onClick={() => onChip('web')}><I.IcoGlobe />{t.webSearch}</button>
          <button className={`chip${chips.think ? ' on' : ''}`} onClick={() => onChip('think')}><I.IcoThink />{t.deepThink}</button>
          {showExtra
            ? (
                <>
                  {/* 「文件上传」「图像生成」两个芯片已移除：手机上这两件事都做不了，
                     留着开关等于承诺了做不到的事。等真接上再放回来。 */}
                  <button className={`chip${chips.more ? ' on' : ''}`} onClick={() => onChip('more')}><I.IcoWrench />{t.moreTools}</button>
                </>
              )
            : (
                <button className={`chip${chips.more ? ' on' : ''}`} onClick={() => onChip('more')}><I.IcoWrench />{t.tools}</button>
              )}
        </div>
      </div>
    </div>
  )
}

/** 「停止」用的方块图标；放在这里而不是 icons.tsx，因为 icons.tsx 不在可改文件里。 */
function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2.5" />
    </svg>
  )
}

function Brand({ center = false }: { center?: boolean }) {
  return (
    <div className={`brand${center ? ' center' : ''}`}>
      <div className="brand-row"><I.BrandMark /><span className="brand-name">{t.brand}</span></div>
      <span className="brand-tag">{t.tagline}</span>
    </div>
  )
}

/**
 * 模式选择器：手机自带模型与电脑窗口各占一段。
 *
 * 电脑连接那一行不是「模型」，但它是同样重要的执行路径；两者放在同一个面板里，
 * 用户点开就知道这台手机现在有哪两条路可选。
 */
function ModelPicker({
  mode, pc, options, current, note, onPick, onSelectMode, onSettings,
}: {
  mode: 'local' | 'remote'
  pc: PcHandle | null
  options: readonly { readonly id: string; readonly name: string }[]
  current: string
  /** 订阅档下的档位说明；其他档位为 `null`（说的是"这一档有什么"）。 */
  note: string | null
  onPick: (id: string) => void
  onSelectMode: (mode: 'local' | 'remote') => void
  onSettings: () => void
}) {
  const status = pc === null || !pc.open ? t.pcChipUnavailable : t.pcChipOnline
  return (
    <div className="picker">
      <div className="picker-head">{t.modePickerTitle}</div>
      <button className={mode === 'local' ? 'on' : ''} aria-label={`${t.modePickerTitle}: ${t.modeLocal}`} onClick={() => onSelectMode('local')}>
        <span>{t.modeLocal}</span>
        {mode === 'local' ? <I.IcoCheck /> : null}
      </button>
      <button
        className={mode === 'remote' ? 'on' : ''}
        aria-label={`${t.modePickerTitle}: ${t.modeRemote}`}
        disabled={pc === null || !pc.open}
        onClick={() => onSelectMode('remote')}
      >
        <span>{t.modeRemote}</span>
        {mode === 'remote' ? <I.IcoCheck /> : null}
      </button>
      <div className="picker-head">{t.modelPickerTitle}</div>
      {options.length === 0
        ? <p className="picker-empty">{t.modelPickerEmpty}</p>
        : options.map(option => (
          <button
            key={option.id}
            className={option.id === current ? 'on' : ''}
            aria-label={`${t.modelPickerTitle}: ${option.name}`}
            onClick={() => onPick(option.id)}
          >
            <span>{option.name}</span>
            {option.id === current ? <I.IcoCheck /> : null}
          </button>
        ))}
      <button className="picker-more" onClick={onSettings}><I.IcoGear />{t.settingsTitle}</button>
      {note !== null && <p className="picker-note">{note}</p>}
      {pc !== null && <p className="picker-note">{t.settingsPcTitle}：{status}</p>}
    </div>
  )
}

/**
 * 首页四张卡片的本地化文案。
 *
 * 以前是 `t[tile.title]`——拿 `data.ts` 里的**中文字符串当本地化键**。本地化表里
 * 一个中文键都没有，那四张卡片的标题与副标题实际上渲染成了空。这里按 `tile.id`
 * 显式映射：文案归本地化表，数据归 `data.ts`，两边不再互相假冒。
 */
const TILE_COPY: Readonly<Record<
  (typeof HOME_TILES)[number]['id'],
  { readonly title: string; readonly desc: string }
>> = {
  create: { title: t.tileCreateTitle, desc: t.tileCreateDesc },
  run: { title: t.tileRunTitle, desc: t.tileRunDesc },
  flow: { title: t.tileFlowTitle, desc: t.tileFlowDesc },
  data: { title: t.tileDataTitle, desc: t.tileDataDesc },
}

/**
 * 卡片图标。
 *
 * 只处理 `HOME_TILES` 真实存在的三种 glyph。原先这里还比较 `'doc'`/`'image'`/`'code'`，
 * 但那三种只出现在 `TASKS` 里、从不出现在首页卡片上：既是三条永远走不到的死分支，
 * 又是三个类型错误（比较的两边没有交集）。删掉比留着更诚实。
 */
function tileGlyph(glyph: (typeof HOME_TILES)[number]['glyph']): ReactNode {
  if (glyph === 'nodes') return <I.IcoNodes />
  if (glyph === 'flow') return <I.IcoFlow />
  return <I.IcoBars />
}

/**
 * 建议卡片的装饰图标。
 *
 * `SUGGESTIONS` 里只有文本，图标纯属装饰，因此按序号轮流取，而不是去读一个数据里
 * 并不存在的 `icon` 字段——那正是之前建议卡片整块渲染成空白的原因。
 */
const SUGGEST_GLYPHS = ['play', 'cap'] as const

function suggestGlyph(index: number): ReactNode {
  return SUGGEST_GLYPHS[index % SUGGEST_GLYPHS.length] === 'play' ? <I.IcoPlay /> : <I.IcoCap />
}

function Home({
  model, onMenu, onModel, onTile, suggestions, spin, onShuffle, onSuggest,
}: {
  model: string
  onMenu: () => void
  onModel: () => void
  onTile: (prompt: string) => void
  suggestions: (typeof SUGGESTIONS)[number]
  spin: boolean
  onShuffle: () => void
  onSuggest: (text: string) => void
}) {
  return (
    <div className="app">
      <div className="head">
        <button className="icon-btn" aria-label={t.menuTitle} onClick={onMenu}><I.IcoMenu /></button>
        <Brand center />
        <button className="model" aria-label={t.modelPickerTitle} onClick={onModel}>
          <I.IcoSpark />
          <span className="model-label">{model}</span>
          <I.IcoCaret />
        </button>
      </div>
      <div className="scroll">
        <div className="hero">
          <p className="hello">{t.hello}<br />{t.askLead}<span className="accent">{t.askAccent}</span></p>
          <p className="sub">{t.subtitle}</p>
        </div>
        <div className="grid">
          {HOME_TILES.map(tile => {
            const copy = TILE_COPY[tile.id]
            return (
              <button key={tile.id} className="tile" onClick={() => onTile(copy.title)}>
                <span className={`glyph ${tile.tint}`}>{tileGlyph(tile.glyph)}</span>
                <span className="tile-copy"><b>{copy.title}</b><small>{copy.desc}</small></span>
                <I.IcoChevron className="chev" />
              </button>
            )
          })}
        </div>
        <div className="section"><h2>{t.tryAlso}</h2><button className={`refresh${spin ? ' spin' : ''}`} onClick={onShuffle}><I.IcoRefresh />{t.shuffle}</button></div>
        {suggestions.map((text, index) => (
          <button key={text} className="suggest" onClick={() => onSuggest(text)}>
            <span className="suggest-ico">{suggestGlyph(index)}</span>
            <span>{text}</span>
            <I.IcoChevron className="chev" />
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * 对话屏。它同时渲染两条来源：这台手机自己的对话（本地模型流式回复），
 * 以及发到电脑的指令与投递状态。两者都不为空时都显示——合并的是能力，不是数据。
 */
/**
 * 状态文字。
 *
 * 一句话概括当前的收流阶段：等待首字是「思考中」，已经在吐字是「正在回复…」，
 * 用户按了停止是「已停止」，空闲是「就绪」。失败不走这里——它由下面的
 * `.failure` 块显示可读原因，避免同一件事说两遍。
 */
function statusText(phase: ChatPhase): string {
  if (phase === 'thinking') return t.thinking
  if (phase === 'replying') return t.streaming
  if (phase === 'aborted') return t.aborted
  if (phase === 'failed') return ''
  return t.idle
}

/** 「思考中」的动态指示：三个呼吸的小圆点。动效只在 CSS 里，随系统偏好自动停。 */
function ThinkingDots() {
  return (
    <span className="thinking-dots" aria-hidden="true">
      <i /><i /><i />
    </span>
  )
}

/**
 * 状态行。
 *
 * 换文案时只做透明度渐变（`.status-swap`），文字本身**立刻**在 DOM 里更新：
 * 动画只影响观感，任何读屏、测试或复制文本都不该等这 160ms。
 *
 * `search` 是手机端搜索循环自己的更细状态：`searching`（正在等搜索结果）与
 * `reading`（结果已到、模型在整理）。它**盖过** `ChatPhase`：`thinking` 说不清
 * "在搜索"和"在想"的差别，而这两件事对用户的等待时长完全不是一回事。
 */
function StatusLine({ phase, search }: { phase: ChatPhase; search: SearchPhase | null }) {
  const text = search === 'searching'
    ? t.searchSearching
    : search === 'reading'
      ? t.searchReading
      : statusText(phase)
  const [faded, setFaded] = useState(false)
  useEffect(() => {
    // 换一行文案就重放一次淡入：先把透明度压到 0，下一个宏任务再抬回来。
    setFaded(true)
    const timer = window.setTimeout(() => { setFaded(false) }, 0)
    return () => { window.clearTimeout(timer) }
  }, [text])
  if (text.length === 0) return null
  return (
    <p className={`status-line ${phase}${search === null ? '' : ` search-${search}`}`} role="status">
      <span className="status-swap" style={{ opacity: faded ? 0 : 1 }}>{text}</span>
      {phase === 'thinking' && search === null && <ThinkingDots />}
    </p>
  )
}

/**
 * 本次回答引用的联网来源。
 *
 * 只在服务端**真的**返回了来源时才出现，数字与域名都来自响应本身——没有来源就是
 * 一行都不显示，绝不拿一个编出来的条数充场面。
 */
function SearchSources({ sources }: { sources: readonly SearchSource[] }) {
  if (sources.length === 0) return null
  const hosts: string[] = []
  for (const source of sources) {
    let host = source.url
    try { host = new URL(source.url).host } catch { /* 非标准地址就原样显示 */ }
    if (!hosts.includes(host)) hosts.push(host)
  }
  return (
    <p className="search-sources">
      <I.IcoGlobe />
      <span>{t.searchSources.replace('{n}', String(sources.length))}</span>
      {hosts.length > 0 && <span className="search-source-hosts">{hosts.slice(0, 3).join(' · ')}</span>}
    </p>
  )
}

/**
 * 对话滚动跟随。
 *
 * 用户反馈的 bug：回复变长后新内容跑到屏幕外，得自己滑轮。修法不是"永远滚到底"——
 * 那样用户往上读历史时会被反复拽回来，比不动更烦人。判据是**用户意图**：
 * 他本来就在底部就跟，他主动往上滑就停，他刚发出消息就无条件给到底。
 *
 * 只在**内容高度真的变了**时滚，而不是每次渲染都滚：后者会在键盘弹出、
 * 图片加载等无关重排时也触发跳动。
 * @param messageCount - 本地对话的消息数。
 * @param recordCount - 发往电脑的指令数。
 * @returns 绑定到滚动容器的 ref 与 onScroll 处理器。
 */
function useAutoScroll(messageCount: number, recordCount: number) {
  const ref = useRef<HTMLDivElement | null>(null)
  const follower = useRef(new ScrollFollower())
  const lastHeight = useRef(0)
  const lastCount = useRef(-1)

  // 消息数增加 = 用户刚发出或收到了新的一条：无条件恢复跟随。
  useLayoutEffect(() => {
    const total = messageCount + recordCount
    if (total > lastCount.current) follower.current.jumpToBottom()
    lastCount.current = total
  }, [messageCount, recordCount])

  // 内容高度变化（流式吐字会让它一直在变）：正在跟随时滚到底。
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    if (element.scrollHeight === lastHeight.current) return
    lastHeight.current = element.scrollHeight
    if (!follower.current.shouldFollow()) return
    scrollToBottom(element)
  })

  const onScroll = useCallback(() => {
    const element = ref.current
    if (element === null) return
    follower.current.onScroll({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    })
  }, [])

  return { ref, onScroll }
}

function Chat({
  model, groups, records, phase, failure, searchPhase, searchSources, downgrade, liked, onMenu, onModel, onHistory, onLike, followUps, onFollow, onOpenSettings,
}: {
  model: string
  groups: readonly ChatEntry[]
  records: readonly WindowCommandRecord[]
  phase: ChatPhase
  failure: ChatFailure | null
  /** 手机端搜索的中间状态；没在搜索时为 `null`。 */
  searchPhase: SearchPhase | null
  /** 本次回答引用到的联网来源；没搜到就是空数组。 */
  searchSources: readonly SearchSource[]
  /**
   * 订阅网关的降级说明：这次请求的模型与实际作答的模型不同。
   *
   * 单独一个字段而不是塞进 `ChatFailure`：降级**不是失败**（回答是好的），
   * 但它必须被看见——用户买的是「千手·强力」，静默换成轻量模型是不能接受的。
   */
  downgrade: string | null
  liked: 'up' | 'down' | null
  onMenu: () => void
  onModel: () => void
  /** 打开历史对话。顶栏与抽屉两个入口都走这里。 */
  onHistory: () => void
  onLike: (v: 'up' | 'down') => void
  followUps: readonly FollowUp[]
  onFollow: (text: string) => void
  onOpenSettings: () => void
}) {
  const empty = groups.length === 0 && records.length === 0
  const lastGroup = groups.length - 1
  const follow = useAutoScroll(groups.length, records.length)
  return (
    <div className="app">
      <div className="head">
        <button className="icon-btn" aria-label={t.menuTitle} onClick={onMenu}><I.IcoMenu /></button>
        <Brand center />
        <button className="model" aria-label={t.modelPickerTitle} title={model} onClick={onModel}><I.IcoSpark /><span className="model-label">{model}</span><I.IcoCaret /></button>
        {/*
          历史入口放在对话屏顶栏，而不是只留在抽屉第 14 项之后：用户明确反馈
          "历史对话呢？"——功能一直是好的，是入口藏起来了。两个入口并行不冲突。
        */}
        <button className="icon-btn" aria-label={t.history} onClick={onHistory}><I.IcoClock /></button>
      </div>
      <div className="scroll" ref={follow.ref} onScroll={follow.onScroll}>
        {empty ? <Welcome /> : null}
        {groups.map((message, index) => {
          const last = index === lastGroup
          if (message.role !== 'user') {
            return (
              <AnswerBubble
                key={index}
                content={message.content}
                at={message.at}
                caret={phase === 'replying' && last}
                react={last}
                streaming={phase === 'replying' && last}
                liked={liked}
                onLike={onLike}
              />
            )
          }
          // 连着发的几条并成一个视觉块：块内收紧，时间戳只落在最后一条上。
          const next = groups[index + 1]
          return (
            <div className="msg-block" key={index}>
              <UserBubble
                content={message.content}
                at={message.at}
                time={next === undefined || next.role !== 'user'}
              />
            </div>
          )
        })}
        {records.length > 0 && (
          <>
            <p className="hint">{t.remoteRecordHint}</p>
            {records.map((record) => {
              const action = record.command.action
              const text = action.type === 'cancel' ? t.close : action.text
              return (
                <div key={record.command.requestId}>
                  <UserBubble content={text} at={record.command.createdAt} />
                  <AnswerBubble
                    content={deliveryLabel(record.state)}
                    at={record.command.createdAt}
                    caret={record.state === 'queued' || record.state === 'delivering'}
                    react={record.state === 'received'}
                    liked={liked}
                    onLike={onLike}
                  />
                </div>
              )
            })}
          </>
        )}
        {/* 失败只在相位确实是 failed 时显示：新一轮发送开始后，上一条失败不该继续占着屏。 */}
        {failure !== null && phase === 'failed' && (
          <div className="failure">
            <I.IcoFail />
            <span>{failureCopy(failure)}</span>
            <button className="failure-cta" onClick={onOpenSettings}>{t.settingsTitle}</button>
          </div>
        )}
        {/*
          降级说明挂在回复**下方**：这条回答是好的，但"不是你要的那个模型答的"必须
          和回答一起被看到，而不是等用户自己去猜字体的差别。样式与失败提示同族但用中性色
          ——它不是错误。
        */}
        {downgrade !== null && (
          <p className="downgrade"><I.IcoInfo />{downgrade}</p>
        )}
        <StatusLine phase={phase} search={searchPhase} />
        <SearchSources sources={searchSources} />
        {/*
          连带问题：内容按最后一句输入现算，点了就和按发送键完全一样。
          `type="button"` + `onSend` 直接接线，避免以后有人误接回「填进输入框」。
        */}
        <div className="follows">
          <span className="follows-label">{t.followLabel}</span>
          <div className="follows-row">
            {followUps.map(item => (
              <button
                key={item.text}
                type="button"
                className="follow"
                title={item.text}
                onClick={() => onFollow(item.text)}
              >
                <I.IcoSend className="follow-go" />
                <span className="follow-text">{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 空对话的第一屏：说明这台手机自己就能回答，而不是假装已经读过什么东西。 */
function Welcome() {
  return (
    <div className="welcome">
      <span className="bot"><I.BrandMark /></span>
      <div className="answer">
        <h3><I.IcoSpark style={{ color: '#3b82f6' }} />{t.welcomeTitle}</h3>
        <ul>
          <li>{t.welcomeLine1}</li>
          <li>{t.welcomeLine2}</li>
        </ul>
        <p className="welcome-hint">{t.welcomeHint}</p>
      </div>
    </div>
  )
}

function UserBubble({ content, at, time }: { content: string; at?: number; time?: boolean }) {
  return (
    <>
      <div className="bubble-user">{content}</div>
      <span className={time ? 'bubble-time' : 'bubble-time hidden'}>{formatTime(at ?? Date.now())}</span>
    </>
  )
}

/**
 * 已定稿行的渲染次数。
 *
 * 流式渲染的成本在于"每个字都重建整棵行树"：`content.split('\n')` 之后逐行建
 * 元素，一次增量一次全量 diff。把已经换过行的内容交给 `memo` 之后，只有跨过
 * 换行符的那一刻才重建这一块，中间每个字只改动尾行的一个文本节点。
 *
 * 这个计数器是**测试接缝**：它只在组件真的执行时自增，`memo` 命中时不会。
 * 生产代码不读它，界面也不依赖它。
 */
export const settledRenderCount = { value: 0 }

/**
 * 已定稿的行（除最后一行以外的全部内容）。
 *
 * 单独抽出来是为了 `memo`：文本按值比较，尾行每追加一个字都不会让这一块重渲染。
 *
 * 这里**必须**走 Markdown 解析。早先它把每一行当纯文本画出来（`{line}<br/>`），
 * 于是模型回复里的 `##`、`**`、`- `、表格竖线全部原样显示——用户看到的就是"没有排版"，
 * 而样式表里那一堆 `.md` 规则一条都用不上，因为 DOM 里根本没有 `.md`。
 */
export const SettledLines = memo(function SettledLines({ text }: { text: string }) {
  settledRenderCount.value += 1
  if (text.length === 0) return null
  return <MarkdownView text={text} />
})

export function AnswerBubble({
  content, at, caret, react, liked, onLike, streaming = false,
}: {
  content: string
  at?: number
  caret: boolean
  react: boolean
  liked: 'up' | 'down' | null
  onLike: (v: 'up' | 'down') => void
  /** 这一条此刻还在流式追加；决定尾行要不要播淡入。 */
  streaming?: boolean
}) {
  // 只有最后一行在流式追加期间会变，所以它单独渲染；前面的行交给 memo 块。
  const lines = content.split('\n')
  const tail = lines[lines.length - 1] ?? ''
  const settled = lines.length > 1 ? lines.slice(0, -1).join('\n') : ''
  return (
    <div className="msg">
      <span className="bot"><I.BrandMark /></span>
      <div className="answer">
        <SettledLines text={settled} />
        {/*
          尾行还在增长，不能整块解析：一行中途套 `<p>` 会让段落反复拆合。
          但**行内**标记（粗体、行内代码）照解，否则 `**` 会一直露在屏幕上，
          直到换行为止——那正是"看着很乱"的一部分。
          淡入只在收流那一刻播一次；流式期间每个增量都重播会变成抖动。
        */}
        <span className={streaming ? 'stream-tail' : undefined}><MarkdownView text={tail} inline /></span>
        {caret && <i className="caret" />}
        {react && (
          <div className="reacts">
            <span className="react-time">{formatTime(at ?? Date.now())}</span>
            <span style={{ flex: 1 }} />
            <button className={liked === 'up' ? 'on' : ''} onClick={() => onLike('up')}><I.IcoLike /></button>
            <button className={liked === 'down' ? 'on' : ''} onClick={() => onLike('down')}><I.IcoDislike /></button>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 新版本提示条。
 *
 * 多处屏幕都要显示它（对话、账号、历史、设置各自提前 return），所以做成组件而不是复制三份。
 * **只提示、不自动刷新**：用户可能正在等一条回复，自动刷新会把对话清掉。
 */
function UpdateBar() {
  return (
    <button className="update-bar" onClick={() => globalThis.location.reload()}>
      有新版本可用 · 点此刷新
    </button>
  )
}

/** 余额显示：上游给的是字符串或数字，空值就显示 0，不编金额。 */
function balanceText(account: Account): string {
  if (account.balance === null) return '0'
  return String(account.balance)
}

function mark(id: string) {
  if (id === 'pen' || id === 'knot') return <I.MarkKnot />
  if (id === 'bars') return <I.MarkBars />
  if (id === 'scale') return <I.MarkScale />
  if (id === 'play') return <I.MarkPlay />
  if (id === 'trend') return <I.MarkTrend />
  return <I.MarkCap />
}

function Agents({
  query, cat, agents, onMenu, onQuery, onCat, onUse, onCreate,
}: {
  query: string
  cat: string
  agents: typeof AGENTS[number][] | readonly typeof AGENTS[number][]
  onMenu: () => void
  onQuery: (v: string) => void
  onCat: (id: string) => void
  onUse: (name: string) => void
  onCreate: () => void
}) {
  return (
    <div className="app">
      <div className="head">
        <Brand />
        <label className="search"><I.IcoSearch /><input value={query} placeholder="搜索专家、行业或功能..." onChange={e => onQuery(e.target.value)} /></label>
        <button className="icon-btn" onClick={onMenu}><I.IcoGrid /></button>
      </div>
      <div className="scroll tight">
        <div className="hero-banner">
          <img src="media/hero-globe.png" alt="" />
          <div className="veil" />
          <div className="hero-copy">
            <h2>选一个方向<br />让 AI 接着往下做</h2>
            <p>挑一个专家，直接在手机上对话；电脑连着时也能派给它</p>
          </div>
          <div className="orbs">
            <span className="orb" style={{ left: '18%', top: '8%' }}>协作</span>
            <span className="orb" style={{ left: '48%', top: '2%' }}>分析</span>
            <span className="orb" style={{ right: '4%', top: '18%' }}>创作</span>
            <span className="orb" style={{ left: '8%', top: '42%' }}>协作</span>
            <span className="orb" style={{ right: '10%', top: '46%' }}>执行</span>
            <span className="orb" style={{ left: '28%', top: '68%' }}>研究</span>
            <span className="orb" style={{ right: '22%', top: '72%' }}>生成</span>
          </div>
        </div>
        <div className="cats">
          {AGENT_CATEGORIES.map(item => (
            <button key={item.id} className={`cat${cat === item.id ? ' on' : ''}`} onClick={() => onCat(item.id)}>
              <i>{catIcon(item.icon)}</i>{item.label}
            </button>
          ))}
        </div>
        <div className="section"><h2>热门专家</h2></div>
        {agents.map(agent => (
          <div key={agent.id} className="agent">
            <span className={`agent-mark ${agent.mark}`}>{mark(agent.mark)}</span>
            <div>
              <b>{agent.name}</b>
              <p>{agent.desc}</p>
              <div className="tags">{agent.tags.map(tag => <span key={tag} className="tag">{tag}</span>)}</div>
            </div>
            <div className="agent-side">
              <button className="use" onClick={() => onUse(agent.name)}>使用</button>
            </div>
          </div>
        ))}
        <button className="create" onClick={onCreate}>
          <span className="create-plus"><I.IcoPlus /></span>
          <div><b>创建你的专属专家</b><span>用自然语言，快速搭建一个属于你的AI专家</span></div>
          <span className="create-cta">立即创建 →</span>
        </button>
      </div>
    </div>
  )
}

function catIcon(id: string) {
  if (id === 'star') return <I.IcoStar />
  if (id === 'brief') return <I.IcoBrief />
  if (id === 'bars') return <I.IcoBars />
  if (id === 'scale') return <I.IcoScale />
  if (id === 'mega') return <I.IcoMegaphone />
  if (id === 'pen') return <I.IcoPen />
  if (id === 'code') return <I.IcoCode />
  if (id === 'cap') return <I.IcoCap />
  if (id === 'flame') return <I.IcoFlame />
  return <I.IcoGrid />
}

function Discover({
  query, cat, onCat, onQuery, onTry, onCase, onInvite,
}: {
  query: string
  cat: string
  onCat: (id: string) => void
  onQuery: (v: string) => void
  onTry: () => void
  onCase: (title: string) => void
  onInvite: () => void
}) {
  /**
   * 搜索命中判定。空查询一律通过，大小写不敏感。
   *
   * 这个搜索框以前是 `readOnly` 的——看起来能搜、其实打不了字，而同一应用里 Agents 页的
   * 搜索是真的。现在它接同一个 `query` 状态，并且真的过滤下面三个列表。
   */
  const hits = (...fields: readonly string[]): boolean => {
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) return true
    return fields.some(field => field.toLowerCase().includes(needle))
  }
  return (
    <div className="app dark-band" style={{ background: 'linear-gradient(#0b1a33 0 118px, var(--bg) 118px)' }}>
      <div className="head dark">
        <Brand />
        {/* 这里原来是个 readOnly 的搜索框和一枚通知铃：搜索打不了字、铃铛点了没反应。
            同一个应用里 Agents 页的搜索是真的，所以这里也接真状态；铃铛要先有账号才有通知可收，先去掉。 */}
        <label className="search"><I.IcoSearch /><input value={query} placeholder="搜索行业或案例..." onChange={e => onQuery(e.target.value)} /></label>
      </div>
      <div className="scroll tight">
        <div className="hero-banner tall">
          <img src="media/hero-globe.png" alt="" />
          <div className="veil" />
          <div className="hero-copy">
            <h2>发现能直接用的能力<br />不用先配一堆东西</h2>
            <p>这里的每一项都能直接用<br />点一下就开始</p>
            <button className="cta" onClick={onTry}>立即体验 →</button>
          </div>
          <div className="orbs">
            <span className="orb" style={{ left: '30%', top: '8%' }}>分析</span>
            <span className="orb" style={{ right: '8%', top: '18%' }}>创作</span>
            <span className="orb" style={{ right: '12%', top: '42%' }}>执行</span>
            <span className="orb" style={{ left: '22%', top: '52%' }}>研究</span>
            <span className="orb" style={{ right: '18%', top: '70%' }}>协作</span>
          </div>
        </div>
        <div className="cats">
          {DISCOVER_CATS.map(item => (
            <button key={item.id} className={`cat${cat === item.id ? ' on' : ''}`} onClick={() => onCat(item.id)}>
              <i>{catIcon(item.icon)}</i>{item.label}
            </button>
          ))}
        </div>
        <div className="section"><h2>精选专家</h2></div>
        <div className="featured">
          {AGENTS.filter(agent => hits(agent.name, agent.desc)).slice(0, 4).map(agent => (
            <button key={agent.id} className="feat" onClick={onTry}>
              <span className={`agent-mark ${agent.mark}`}>{mark(agent.mark)}</span>
              <b>{agent.name.replace(' 专家', '')}</b>
              <p>{agent.short}</p>
            </button>
          ))}
        </div>
        <div className="section"><h2>行业解决方案</h2></div>
        <div className="industries">
          {INDUSTRIES.filter(item => hits(item.title, item.desc)).map(item => (
            <button key={item.id} className="shot" onClick={onTry}>
              <img src={item.image} alt="" />
              <div className="cap"><b>{item.title}</b><span>{item.desc}</span></div>
            </button>
          ))}
        </div>
        <div className="section"><h2>案例推荐</h2></div>
        {CASES.filter(item => hits(item.title, item.desc)).map(item => (
          <button key={item.id} className="case" onClick={() => onCase(item.title)}>
            <img src={item.image} alt="" />
            <div>
              <b>{item.title}</b>
              <p style={{ margin: '4px 0 6px', fontSize: 11, color: '#6b7285' }}>{item.desc}</p>
              <div className="tags">{item.tags.map(tag => <span key={tag} className="tag">{tag}</span>)}</div>
            </div>
          </button>
        ))}
        <button className="invite" onClick={onInvite}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span className="glyph blue"><I.IcoGift /></span>
            <div><b>邀请好友，领取高级权益</b><span style={{ display: 'block', fontSize: 11, color: '#8b93a7' }}>一起体验千手AI，解锁更多专家和功能</span></div>
          </div>
          <span className="create-cta">立即邀请 →</span>
        </button>
      </div>
    </div>
  )
}

function Tasks({
  filter, section, tasks, onMenu, onFilter, onSection, onNew, onOpen,
}: {
  filter: string
  section: number
  tasks: typeof TASKS[number][] | readonly typeof TASKS[number][]
  onMenu: () => void
  onFilter: (id: string) => void
  onSection: (i: number) => void
  onNew: () => void
  onOpen: () => void
}) {
  return (
    <div className="app">
      <div className="head">
        <Brand />
        <button className="icon-btn" aria-label={t.menuTitle} onClick={onMenu}><I.IcoSearch /></button>
        <button className="cta-new" onClick={onNew}><I.IcoPlus />新建任务</button>
      </div>
      <div className="scroll tight">
        <div className="subnav">
          {TASK_SECTIONS.map((item, i) => (
            <button key={item} className={section === i ? 'on' : ''} onClick={() => onSection(i)}>{item}</button>
          ))}
        </div>
        <div className="filters">
          <button className={`filter${filter === 'all' ? ' on' : ''}`} onClick={() => onFilter('all')}>全部</button>
          <button className={`filter${filter === 'running' ? ' on' : ''}`} onClick={() => onFilter('running')}>进行中</button>
          <button className={`filter${filter === 'done' ? ' on' : ''}`} onClick={() => onFilter('done')}>已完成</button>
          <button className={`filter${filter === 'failed' ? ' on' : ''}`} onClick={() => onFilter('failed')}>已失败</button>
        </div>
        <div className="hero-banner">
          <img src="media/hero-tasks.png" alt="" />
          <div className="veil" />
          <div className="hero-copy">
            <h2>手机上接任务<br />电脑替你执行</h2>
            <p>复杂任务，自动拆解 · 并行执行 · 实时汇总</p>
          </div>
          <div className="checks">
            <div>✓ 任务拆解</div>
            <div>✓ 多专家协同</div>
            <div>✓ 实时监控</div>
            <div>✓ 自动生成结果</div>
          </div>
        </div>
        {tasks.map((task) => {
          const pack = facesFor(task.agents, task.extra)
          return (
            <button key={task.id} className="task" onClick={onOpen}>
              <div className="task-top">
                <div className="task-id">
                  <span className={`glyph ${task.tint}`}>{taskGlyph(task.glyph)}</span>
                  <div>
                    <b>{task.title}</b>
                    <small style={{ display: 'block', marginTop: 4, color: '#8b93a7', fontSize: 11 }}>{task.desc}</small>
                  </div>
                </div>
                <span className={`st ${task.status === 'running' ? 'run' : task.status === 'done' ? 'done' : 'fail'}`}>
                  {task.status === 'running' ? <><I.IcoSparkle />进行中</> : task.status === 'done' ? <><I.IcoCheck />已完成</> : <><I.IcoFail />已失败</>}
                </span>
              </div>
              <div className={`bar ${task.status === 'done' ? 'done' : task.status === 'failed' ? 'fail' : ''}`}><i style={{ width: `${task.progress}%` }} /></div>
              <div className="meta">
                <span className="faces">
                  {pack.shown.map(src => <img key={src} src={src} alt="" />)}
                  <em>+{task.extra}</em>
                  {' '}{task.status === 'failed' ? `${task.agents} 个专家执行失败` : task.status === 'done' ? `${task.agents} 个专家协同完成` : `${task.agents} 个专家正在工作...`}
                </span>
                <span>{task.progress}%　{task.eta}</span>
              </div>
            </button>
          )
        })}
        {/*
          调度视图（节点地图 + 全局调度）原先只能靠点一张任务卡进入，等于「没有任务就看不到调度」。
          那是被假数据决定的设计缺陷：这里给它一个**自己的入口**。
        */}
        <button className="model-card" onClick={onOpen}>
          <span className="glyph blue"><I.IcoGrid /></span>
          <div style={{ flex: 1, textAlign: 'left' }}>
            <b>算力调度</b>
            <span>节点分布 · 任务运行 · 实时调度</span>
          </div>
          <span className="more">打开 <I.IcoChevron /></span>
        </button>
        {tasks.length === 0 && (
          <p className="hint">
            还没有任务。真实的任务列表来自你的算力账号（`/api/v8/my/tasks`），
            登录后会自动出现在这里；现在显示为空是因为**还没有数据**，不是加载失败。
          </p>
        )}
        <button className="create" onClick={onNew}>
          <span className="create-plus"><I.IcoPlus /></span>
          <div><b>用自然语言创建新任务</b><span>告诉我你的目标，我将自动拆解并分配给合适的AI专家</span></div>
          <span className="create-cta">立即创建 →</span>
        </button>
      </div>
    </div>
  )
}

function taskGlyph(id: string) {
  if (id === 'doc') return <I.IcoDoc />
  if (id === 'image') return <I.IcoImage />
  if (id === 'code') return <I.IcoCode />
  if (id === 'db') return <I.IcoDb />
  return <I.IcoBars />
}

/**
 * 任务运行页。
 *
 * 供给数据尚未接入：`LIVE_JOBS` 是空数组、`REGIONS` 没有节点数字段，所以这里
 * 一律不显示任何数量——宁可显示空态，也不拿占位数字充数。
 */
function Dispatch({
  section, onSection, onMenu, onBack,
}: {
  section: number
  onSection: (i: number) => void
  onMenu: () => void
  onBack: () => void
}) {
  return (
    <div className="app">
      <div className="head">
        <button className="icon-btn" onClick={onBack}><I.IcoMenu /></button>
        <Brand />
        <button className="icon-btn" onClick={onMenu}><I.IcoSearch /></button>
        <img src="media/avatar-profile.png" alt="" className="avatar" style={{ width: 28, height: 28 }} />
      </div>
      <div className="scroll tight">
        <div className="subnav">
          {DISPATCH_SECTIONS.map((item, i) => (
            <button key={item} className={section === i ? 'on' : ''} onClick={() => onSection(i)}>{item}</button>
          ))}
        </div>
        <p className="hello" style={{ fontSize: 26, textAlign: 'left', margin: '8px 0 0' }}>任务运行</p>
        <p style={{ margin: '6px 0 4px', fontSize: 18, fontWeight: 700 }}>真实调度数据接入前，这里不显示任何数量</p>
        <p className="sub" style={{ textAlign: 'left', marginTop: 0 }}>下方区域保留结构：接上真实供给后，子任务与节点数会出现在原处。</p>
        <div className="stats">
          <div className="stat"><span className="ico" style={{ background: '#e7eeff', color: 'var(--blue)' }}><I.IcoServer /></span><b>—</b><span>子任务</span></div>
          <div className="stat"><span className="ico" style={{ background: '#e8f8ef', color: 'var(--green)' }}><I.IcoNodes /></span><b>—</b><span>参与节点</span></div>
          <div className="stat"><span className="ico" style={{ background: '#efe8ff', color: 'var(--violet)' }}><I.IcoBolt /></span><b>—</b><span>整体进度</span></div>
          <div className="stat"><span className="ico" style={{ background: '#ffeedd', color: 'var(--orange)' }}><I.IcoClock /></span><b>—</b><span>已运行</span></div>
        </div>
        <div className="map-card">
          <div className="map-head">
            <div><b>全球节点实时调度</b><div style={{ fontSize: 11, color: '#8b93a7' }}>智能分配 · 就近计算 · 并行执行</div></div>
          </div>
          <div className="map-wrap">
            <img src="media/world-map.png" alt="" />
            {REGIONS.map(region => (
              <div key={region.id} className="region" style={{ left: region.x, top: region.y }}>
                <span className="glyph blue" style={{ width: 28, height: 28 }}><I.IcoServer /></span>
                {/* 这里原本显示编造的节点数；真实供给数据接入前，不显示任何数字。 */}
                <div><b>{region.name}</b></div>
              </div>
            ))}
          </div>
          <div className="legend">
            <span><i className="dot" style={{ background: '#22c55e' }} />节点在线</span>
            <span><i className="dot" style={{ background: '#3b82f6' }} />任务传输</span>
            <span><i className="dot" style={{ background: '#8b5cf6' }} />计算中</span>
            <span><i className="dot" style={{ background: '#94a3b8' }} />已完成</span>
            <span className="pulse">实时调度中...</span>
          </div>
        </div>
        <div className="section"><h2>任务执行流程</h2></div>
        <div className="flow">
          {['任务提交', '智能拆分', '节点分配', '并行执行', '结果合并'].map((label, i) => (
            <div key={label} className={`flow-step${i < 3 ? ' done' : ''}`}>
              <i>{i < 3 ? <I.IcoCheck /> : <I.IcoNodes />}</i>
              <b>{label}</b>
              <span>{i >= 3 ? '等待中' : '已完成'}</span>
            </div>
          ))}
        </div>
        <div className="live">
          <span>{t.liveJobsEmpty}</span>
        </div>
        {LIVE_JOBS.length === 0
          ? <p className="hint">{t.liveJobsNone}</p>
          : LIVE_JOBS.map(job => (
            <div key={job.id} className="job">
              <div className="job-top">
                <div className="task-id">
                  <span className={`glyph ${job.tint}`}>{taskGlyph(job.glyph)}</span>
                  <div>
                    <b>{job.title}</b>
                    <small style={{ display: 'block', color: '#8b93a7', fontSize: 11 }}>{job.meta}</small>
                  </div>
                </div>
                <span className={`job-state ${job.state === '已完成' ? 'done' : 'run'}`}>{job.state}</span>
              </div>
              <div className={`bar ${job.progress === 100 ? 'done' : ''}`}><i style={{ width: `${job.progress}%` }} /></div>
              <div className="meta"><span>{job.nodes}</span><span>{job.speed}　{job.progress}%</span></div>
            </div>
          ))}
      </div>
    </div>
  )
}

function Me({
  model, pcMode, account, pcEntry, pcLink, pcLinkMessage, onMenu, onAction, onPcEntry, onPcConnect, onScan,
}: {
  model: string
  pcMode: 'local' | 'remote'
  account: AccountSnapshot
  /** 当前保存的电脑入口地址。 */
  pcEntry: string
  pcLink: 'idle' | 'connecting' | 'connected' | 'failed'
  pcLinkMessage: string | null
  onPcEntry: (value: string) => void
  onPcConnect: (value: string) => void
  onScan: () => void
  onMenu: () => void
  onAction: (id: string) => void
}) {
  return (
    <div className="app">
      <div className="head">
        <button className="icon-btn" onClick={onMenu}><I.IcoMenu /></button>
        <Brand center />
        <span style={{ flex: 1 }} />
        <button className="icon-btn" aria-label={t.settingsTitle} onClick={() => onAction('settings')}><I.IcoGear /></button>
      </div>
      <div className="scroll tight">
        {/*
          「我的」页的身份卡。
          原先写死「小神仙 / Pro 会员 / ID: 100086 / 用AI，让世界更高效」——昵称、会员、
          ID、签名全是编的。现在两种状态都是真的：登录了就显示上游给的账号与余额，
          没登录就明确说未登录并给出登录入口。
        */}
        <button className="me-head" onClick={() => onAction('profile')}>
          {account.account === null
            ? <span className="avatar avatar-empty big"><I.IcoMe /></span>
            : <span className="avatar avatar-initial big">{(account.account.username || '·').slice(0, 1).toUpperCase()}</span>}
          <div style={{ flex: 1, textAlign: 'left' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <b>{account.account === null ? t.meSignedOut : account.account.username}</b>
              {account.account !== null && <span className="pro">{account.account.role}</span>}
            </div>
            <div style={{ fontSize: 12, color: '#8b93a7', marginTop: 4 }}>
              {account.account === null ? t.meSignedOutHint : account.account.email}
            </div>
            <div style={{ fontSize: 11, color: '#8b93a7', marginTop: 2 }}>
              {account.account === null ? '' : `ID: ${String(account.account.id)}`}
            </div>
          </div>
          <span className="more">{account.account === null ? t.meSignIn : '账号设置'} <I.IcoChevron /></span>
        </button>
        {/*
          这一块原来是一条「千手AI · Pro 会员 / 立即升级」，并列着四项权益
          （更高模型额度、更多专家、高速通道、专属客服）。**全是编的**：
          我们既没有会员体系，也没有这四项权益，点「立即升级」只会弹一句提示。
          现在换成**真实账号卡**：余额与角色都来自上游账号，没有就不显示数字。
        */}
        <button className="vip" onClick={() => onAction(account.account === null ? 'profile' : 'charge')}>
          <div className="vip-top">
            <div>
              <b>{account.account === null ? t.meSignedOut : `${account.account.username}`}</b>
              <div style={{ fontSize: 11, opacity: .75, marginTop: 4 }}>
                {account.account === null
                  ? t.meSignedOutHint
                  : `${t.meBalancePrefix}${balanceText(account.account)}`}
              </div>
            </div>
            <span className="gold-btn">{account.account === null ? t.meSignIn : '查看钱包'}</span>
          </div>
        </button>
        {/*
          连接电脑。
          手机直连上游账号接口会被浏览器跨域策略拦掉，所以「连上电脑」是手机上能用账号、
          能用遥控的前提。入口地址就是电脑上显示的那一串（含一次性令牌）。
        */}
        <div className="pc-link">
          <div className="pc-link-head">
            <span className="glyph blue"><I.IcoGlobe /></span>
            <div style={{ flex: 1, textAlign: 'left' }}>
              <b>连接电脑</b>
              {/* 状态文案带自己的类：`.pc-link-head span` 会连左边的图标 span 一起命中（见 styles.css）。 */}
              <span className="pc-link-status">
                {/*
                  有话说时**优先说那句话**，不再要求 `pcLink === 'failed'` 才渲染 `pcLinkMessage`。
                  旧写法只在失败态显示消息，于是「状态设了、屏幕上却不变」这种情况肉眼看不出来——
                  扫码那次就是这么被掩盖的：消息早就设进去了，用户一个字也没看见。
                */}
                {pcLink === 'connected' ? '已连接，账号与遥控都可用'
                  : pcLink === 'connecting' ? '正在连接…'
                  : pcLinkMessage ?? (pcLink === 'failed' ? '连接失败' : '把电脑上显示的地址整段粘到这里')}
              </span>
            </div>
          </div>
          <input
            value={pcEntry}
            placeholder="http://127.0.0.1:3091/?token=…"
            autoComplete="off"
            spellCheck={false}
            onChange={e => onPcEntry(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onPcConnect(pcEntry) }}
          />
          <button className="pc-link-btn" disabled={pcLink === 'connecting'} onClick={() => onPcConnect(pcEntry)}>
            {pcLink === 'connecting' ? '连接中…' : '连接'}
          </button>
          {/*
            扫码配对。相机只在安全上下文（https）下可用，环境不支持时
            `beginScan` 会给出具体原因（协议不对/不支持/没权限…），不假装能用。
          */}
          <button className="pc-link-scan" onClick={onScan}>扫二维码配对</button>
        </div>

        <button className="model-card" onClick={() => onAction('models')}>
          <span className="glyph blue"><I.IcoSpark /></span>
          <div style={{ flex: 1, textAlign: 'left' }}>
            <b>{t.meModeLabel}</b>
            <span>{t.modePickerTitle}</span>
          </div>
          <span className="more">{pcMode === 'remote' ? t.modeRemote : t.modeLocal} <I.IcoChevron /></span>
        </button>
        <button className="model-card" onClick={() => onAction('models')}>
          <span className="glyph green"><I.IcoBulb /></span>
          <div style={{ flex: 1, textAlign: 'left' }}>
            <b>当前模型</b>
            <span>{model}</span>
          </div>
          <span className="more">{t.settingsTitle} <I.IcoChevron /></span>
        </button>
        <div className="card-block">
          {ME_ROWS.map(row => (
            <button key={row.id} className="row" onClick={() => onAction(row.id)}>
              <span className="row-left">{rowIcon(row.icon)}{row.label}</span>
              <small>{row.extra} &gt;</small>
            </button>
          ))}
        </div>
        <div className="card-block">
          {ME_TAIL.map(row => (
            <button key={row.id} className="row" onClick={() => onAction(row.id)}>
              <span className="row-left">{rowIcon(row.icon)}{row.label}</span>
              <small>{row.extra} &gt;</small>
            </button>
          ))}
        </div>
        <p className="hint">{t.meHint}</p>
      </div>
    </div>
  )
}

function rowIcon(id: string) {
  if (id === 'receipt') return <I.IcoReceipt />
  if (id === 'clock') return <I.IcoClock />
  if (id === 'list') return <I.IcoList />
  if (id === 'grid') return <I.IcoGrid />
  if (id === 'people') return <I.IcoPeople />
  if (id === 'gift') return <I.IcoGift />
  if (id === 'question') return <I.IcoQuestion />
  return <I.IcoInfo />
}

function menuIcon(id: string) {
  if (id === 'chat') return <I.IcoChat />
  if (id === 'grid') return <I.IcoGrid />
  if (id === 'list') return <I.IcoList />
  if (id === 'flow') return <I.IcoFlow />
  if (id === 'folder') return <I.IcoFolder />
  if (id === 'book') return <I.IcoBook />
  if (id === 'diamond') return <I.IcoDiamond />
  if (id === 'people') return <I.IcoPeople />
  if (id === 'star') return <I.IcoStar />
  if (id === 'receipt') return <I.IcoReceipt />
  if (id === 'gear') return <I.IcoGear />
  if (id === 'question') return <I.IcoQuestion />
  return <I.IcoBox />
}

function Drawer({
  tab, account, onClose, onNew, onHistory, onItem, onMe,
}: {
  tab: TabId
  account: AccountSnapshot
  onClose: () => void
  onNew: () => void
  onHistory: () => void
  onItem: (id: string) => void
  onMe: () => void
}) {
  return (
    <>
      <button className="drawer-bg" aria-label={t.close} onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-head">
          <Brand />
          <button className="icon-btn" onClick={onClose}><I.IcoClose /></button>
        </div>
        <button className="drawer-new" onClick={onNew}><span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><I.IcoPlus />新建对话</span><span className="kbd">N</span></button>
        <div className="drawer-list">
          {/*
            历史入口放在列表**第二项**，不再埋在抽屉最底部（原来在 14 项之后，
            手机上必须滚动才看得到，用户因此以为没有历史功能）。列表本身就是
            滚动容器，位置前移后无需滚动即可看到。
          */}
          {MENU.map((item, index) => (
            <Fragment key={item.id}>
              {index === 1 && (
                <button className="d-item" onClick={onHistory}><I.IcoClock />{t.history}<I.IcoChevron className="chev" /></button>
              )}
              <button className={`d-item${(item.id === 'chat' && tab === 'chat') || (item.id === 'square' && tab === 'agents') || (item.id === 'tasks' && tab === 'tasks') ? ' on' : ''}`} onClick={() => onItem(item.id)}>
                {menuIcon(item.icon)}{item.label}
                {item.badge ? <span className="badge">{item.badge}</span> : null}
              </button>
            </Fragment>
          ))}
          <div style={{ height: 10 }} />
          {MENU_TAIL.map(item => (
            <button key={item.id} className="d-item" onClick={() => onItem(item.id)}>
              {menuIcon(item.icon)}{item.label}
              {item.extra ? <span className="pill-gold">{item.extra}</span> : item.id === 'about' ? <I.IcoChevron className="chev" /> : null}
            </button>
          ))}
        </div>
        {/*
          身份块：**有账号显示账号，没有账号显示登录入口**。
          原先这里是写死的「小神仙 / Pro 会员」——一个不存在的身份，编造了昵称、会员等级和 ID。
        */}
        <button className="drawer-user" onClick={onMe}>
          {account.account === null
            ? <span className="avatar avatar-empty"><I.IcoMe /></span>
            : <span className="avatar avatar-initial">{(account.account.username || '·').slice(0, 1).toUpperCase()}</span>}
          <div style={{ flex: 1, textAlign: 'left' }}>
            <b>{account.account === null ? t.meSignedOut : account.account.username}</b>
            <div><span className="pro">{account.account === null ? t.meSignIn : t.meBalancePrefix + balanceText(account.account)}</span></div>
          </div>
          <I.IcoChevron className="chev" />
        </button>
      </aside>
    </>
  )
}

/** 历史：手机自己的会话（可点开继续）与发到电脑的指令（只读投递状态）都列在这里。 */
function History({
  sessions, current, records, onBack, onOpen, onNew,
}: {
  sessions: readonly StoredSession[]
  current: string
  records: readonly WindowCommandRecord[]
  onBack: () => void
  onOpen: (id: string) => void
  onNew: () => void
}) {
  return (
    <div className="app">
      <div className="head">
        <button className="icon-btn" aria-label={t.settingsBack} onClick={onBack}><I.IcoBack /></button>
        <Brand center />
        <button className="icon-btn" aria-label={t.newChat} onClick={onNew}><I.IcoPlus /></button>
      </div>
      <div className="scroll tight">
        <div className="section"><h2>{t.sessionsLocalTitle}</h2></div>
        {sessions.length === 0
          ? <p className="hint">{t.sessionsEmpty}</p>
          : sessions.map(session => (
            <button key={session.id} className={`session${session.id === current ? ' on' : ''}`} onClick={() => onOpen(session.id)}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{session.title}</b>
                <p>{session.messages.length} 条消息 · {formatTime(session.updatedAt)}</p>
              </div>
              <I.IcoChevron className="chev" />
            </button>
          ))}
        <div className="section"><h2>{t.sessionsPcTitle}</h2></div>
        {records.length === 0
          ? <p className="hint">{t.sessionsRecordsEmpty}</p>
          : records.map(record => {
            const action = record.command.action
            const text = action.type === 'cancel' ? t.close : action.text
            return (
              <div key={record.command.requestId} className="session">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{text}</b>
                  <p>{deliveryLabel(record.state)} · {formatTime(record.command.createdAt)}</p>
                </div>
              </div>
            )
          })}
        <p className="hint">{t.sessionsHint}</p>
      </div>
    </div>
  )
}

/** 设置页状态机的界面状态。 */
type TestState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'ok'; readonly message: string }
  | { readonly kind: 'bad'; readonly message: string }

/**
 * 设置页。三段都在：
 * 最上面是**走哪条通道**（订阅 / 自带密钥 / 自动），中间是这台手机自己的模型（BYOK，
 * 电脑不在也能填能测），下面是电脑窗口的连接状态。
 *
 * 通道与 BYOK 表单分开而不是合成一个下拉框：两者管的不是一回事。通道决定"这一条
 * 发给谁"，BYOK 表单描述"你自己的那个服务商长什么样"，它们各有各的存储记录
 * （见 `store.ts`），谁也不覆盖谁。
 */
function Settings({
  settings, secret, pc, route, onRoute, onBack, onSave, onReconnect,
}: {
  settings: ConnectionSettings
  secret: string
  pc: PcHandle | null
  /** 通道选择与当前生效的事实。 */
  route: {
    readonly choice: RouteChoice
    readonly effective: AiRoute
    /** 用户选了订阅但条件不满足时，这里是原因；否则 `null`。 */
    readonly blocked: string | null
    readonly credit: SubscriptionStatusResult | null
    readonly tier: SubscriptionTierId | null
  }
  onRoute: (choice: RouteChoice) => void
  onBack: () => void
  onSave: (settings: ConnectionSettings, secret: string) => boolean
  onReconnect: () => void
}) {
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
  const [apiKey, setApiKey] = useState(secret)
  const [model, setModel] = useState(settings.model)
  const [providerId, setProviderId] = useState(settings.providerId)
  const [reveal, setReveal] = useState(false)
  const [test, setTest] = useState<TestState>({ kind: 'idle' })
  const live = useRef(true)
  useEffect(() => () => { live.current = false }, [])

  /** 切服务商模板：端点与模型跟着模板走，密钥不动。 */
  function pickProvider(id: string) {
    setProviderId(id)
    const template = PROVIDER_TEMPLATES[id]
    if (template === undefined) return
    if (template.baseUrl) setBaseUrl(template.baseUrl)
    if (template.defaultModel) setModel(template.defaultModel)
  }

  function save(): boolean {
    return onSave({ providerId, baseUrl: baseUrl.trim(), model: model.trim() }, apiKey)
  }

  /** 发一条最短请求验证配置：2 个 token 的回复，只关心能不能通。 */
  function testConnection() {
    if (!baseUrl.trim()) { setTest({ kind: 'bad', message: t.testNeedEndpoint }); return }
    if (!model.trim()) { setTest({ kind: 'bad', message: t.testNeedEndpoint }); return }
    onSave({ providerId, baseUrl: baseUrl.trim(), model: model.trim() }, apiKey)
    setTest({ kind: 'running' })
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
    const done = () => { window.clearTimeout(timer) }
    streamChat(
      {
        baseUrl: baseUrl.trim(),
        apiKey,
        model: model.trim(),
        messages: [{ role: 'user', content: '你好' }],
        extraBody: { max_tokens: 2 },
        signal: controller.signal,
      },
      {
        onDelta: () => {},
        onDone: () => { done(); if (live.current) setTest({ kind: 'ok', message: t.settingsTestOk }) },
        onError: (failure) => {
          done()
          if (!live.current) return
          // 超时是我们自己中止的，文案要说清是超时，而不是"已取消"。
          if (failure.kind === 'aborted' && controller.signal.aborted) {
            setTest({ kind: 'bad', message: t.testTimeout })
            return
          }
          setTest({ kind: 'bad', message: failureCopy(failure) })
        },
      },
    )
  }

  const pcStatus = pc === null
    ? t.pcChipUnavailable
    : pc.snapshot.connecting ? t.pcConnecting : accessLabel(pc.snapshot.access)

  /**
   * 「现在走哪条通道」这一句。
   *
   * 只说事实：生效的是哪条、档位读到没有、还剩多少。读不到的点数写"未知"，
   * 不写 0，也不沿用上一次的数字。
   */
  const routeSummary = route.effective === 'subscription'
    ? `${t.routeNowSubscription}${route.credit !== null && route.credit.ok && route.credit.credit.tierLabel.length > 0 ? ` · ${route.credit.credit.tierLabel}` : ''}`
    : t.routeNowByok

  return (
    <div className="app">
      <div className="head">
        <button className="icon-btn" aria-label={t.settingsBack} onClick={onBack}><I.IcoBack /></button>
        <Brand center />
        <span style={{ width: 36 }} />
      </div>
      <div className="scroll tight">
        <div className="set-intro">
          <span className="glyph blue"><I.IcoSwap /></span>
          <div><b>{t.routeTitle}</b><span>{routeSummary}</span></div>
        </div>
        <div className="route-block">
          {(['auto', 'subscription', 'byok'] as const).map(choice => (
            <button
              key={choice}
              type="button"
              className={`route-option${choice === route.choice ? ' on' : ''}`}
              aria-label={`${t.routeTitle}: ${ROUTE_LABEL[choice]}`}
              onClick={() => onRoute(choice)}
            >
              <b>{ROUTE_LABEL[choice]}</b>
              <span>{ROUTE_HINT[choice]}</span>
              {choice === route.choice ? <I.IcoCheck /> : null}
            </button>
          ))}
        </div>
        {/*
          订阅通道用不了时说清是哪一条不满足，并说出现在走的是 BYOK。
          显式选了订阅的人看到的是红色块（他要的那档没生效，必须知道）；自动档下看到的是
          灰色说明（他说的是"自动"，事实是当前回落到了自带密钥，也要知道，但不是在报错）。
          绝不显示成"订阅已启用"——那正是把费用记到别人账上的前一步。
        */}
        {route.blocked !== null && route.effective !== 'subscription' && (
          <p className={`route-blocked${route.choice === 'subscription' ? ' alert' : ''}`}>
            {route.choice === 'subscription' ? <I.IcoFail /> : <I.IcoInfo />}
            {route.blocked}
          </p>
        )}
        {route.effective === 'subscription' && (
          <p className={`route-credit${route.credit !== null && route.credit.ok ? '' : ' unknown'}`}>
            <I.IcoCoins />
            {route.credit !== null && route.credit.ok && route.credit.credit.remainingSp !== null
              ? `${t.creditLabel} ${formatSp(route.credit.credit.remainingSp)} ${t.creditUnit}`
              : t.creditUnknown}
          </p>
        )}

        <div className="set-intro">
          <span className="glyph blue"><I.IcoSpark /></span>
          <div><b>{t.settingsLocalTitle}</b><span>{t.settingsLocalHint}</span></div>
        </div>

        <div className="field-block">
          <label className="field">
            <span className="field-label">{t.settingsProvider}</span>
            {/*
              下拉里**不列订阅档**：通道由上面那一段选。把"通道"塞进"服务商"里，
              会让用户在两个地方改同一件事，而它们的落盘位置并不一样。
            */}
            <select value={providerId} onChange={e => pickProvider(e.target.value)}>
              {Object.entries(PROVIDER_TEMPLATES)
                .filter(([id]) => !isSubscriptionProvider(id))
                .map(([id, template]) => (
                  <option key={id} value={id}>{template.label}</option>
                ))}
            </select>
          </label>

          <label className="field">
            <span className="field-label">{t.settingsBaseUrl}</span>
            <input
              value={baseUrl}
              placeholder={DEFAULT_BASE_URL}
              autoComplete="off"
              spellCheck={false}
              onChange={e => setBaseUrl(e.target.value)}
            />
            <span className="field-hint">{t.settingsBaseUrlHint}</span>
          </label>

          <label className="field">
            <span className="field-label">{t.settingsApiKey}</span>
            <span className="field-key">
              <input
                type={reveal ? 'text' : 'password'}
                value={apiKey}
                placeholder={t.settingsApiKeyPlaceholder}
                autoComplete="off"
                spellCheck={false}
                onChange={e => setApiKey(e.target.value)}
              />
              <button className="reveal" onClick={() => setReveal(v => !v)}>{reveal ? t.settingsHide : t.settingsShow}</button>
            </span>
          </label>

          <label className="field">
            <span className="field-label">{t.settingsModel}</span>
            <input
              value={model}
              placeholder={DEFAULT_MODEL_ID}
              autoComplete="off"
              spellCheck={false}
              onChange={e => setModel(e.target.value)}
            />
            <span className="field-hint">{t.settingsModelHint}</span>
          </label>
        </div>

        <p className="privacy"><I.IcoInfo />{t.settingsPrivacy}</p>

        <div className="set-actions">
          <button className="ghost" onClick={testConnection} disabled={test.kind === 'running'}>
            {test.kind === 'running' ? t.settingsTesting : t.settingsTest}
          </button>
          <button className="primary" onClick={() => { save() }}>{t.settingsSave}</button>
        </div>
        {test.kind === 'ok' && <p className="test-result ok"><I.IcoCheck />{test.message}</p>}
        {test.kind === 'bad' && <p className="test-result bad"><I.IcoFail />{test.message}</p>}

        <div className="set-intro">
          <span className="glyph green"><I.IcoServer /></span>
          <div><b>{t.settingsPcTitle}</b><span>{t.settingsPcHint}</span></div>
        </div>
        <p className="hint">{pcStatus}{pc?.snapshot.binding === null || pc === null ? '' : ` · ${pc.snapshot.binding.sessionId}`}</p>
        {/* 连接层只给机内错误码（PC_WINDOW_*），对用户没有意义：这里只说"暂时不可用"。 */}
        {pc !== null && pc.snapshot.error !== null && <p className="test-result bad"><I.IcoFail />{t.pcUnavailable}</p>}
        <div className="set-actions">
          <button className="primary" onClick={onReconnect} disabled={pc === null || pc.snapshot.connecting}>{t.settingsReconnect}</button>
        </div>
        <p className="hint">{t.settingsPcOptional}</p>
      </div>
    </div>
  )
}
