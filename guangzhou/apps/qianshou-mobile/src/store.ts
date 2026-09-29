/**
 * 手机端的本地存储：连接设置、密钥与会话记录。
 *
 * 存储边界（刻意如此）：
 * - 密钥与其他数据**都只存在这台设备的浏览器里**，不上传任何服务器；
 * - 账号只用来**取订阅额度**（那条通路的身份是同源 cookie，不落在这里），
 *   自带密钥那条通路的身份就是密钥本身；
 * - 会话记录做上限裁剪，避免手机浏览器配额被写满后整个应用写不动。
 *
 * 注意 `localStorage` 不是加密存储：能拿到这台设备浏览器的人就能读到密钥。
 * 这是 BYOK 在纯浏览器形态下的固有代价，设置页里对用户明说，不含糊过去。
 */
import type { ChatMessage, ConnectionSettings, ProviderProfile } from './llm.ts'
import { PROVIDER_TEMPLATES } from './llm.ts'
import {
  DEFAULT_FRONT_MODEL,
  SUBSCRIPTION_BASE_URL,
  SUBSCRIPTION_PROVIDER_ID,
  isFrontModel,
  type RouteChoice,
} from './subscription-model.ts'

const KEY_SETTINGS = 'qianshou.mobile.connection.v1'
const KEY_SECRET = 'qianshou.mobile.secret.v1'
const KEY_SESSIONS = 'qianshou.mobile.sessions.v1'
/** 电脑入口地址（含一次性令牌）；空串表示还没连过电脑。 */
const KEY_PC_ENTRY = 'qianshou.mobile.pc-entry.v1'
/**
 * 订阅档的选择（只记前台模型名）。
 *
 * **单独一份记录**：订阅档不是用户的服务商配置，写它的时候绝不能覆盖
 * `KEY_SETTINGS` 里那份自带密钥配置——否则用户切回 BYOK 时端点和模型就没了。
 */
const KEY_SUBSCRIPTION = 'qianshou.mobile.subscription.v1'
/** 用户对「走哪条通道」的选择；没选过时是 `auto`（跟随同源与登录条件）。 */
const KEY_ROUTE = 'qianshou.mobile.route.v1'

/** 会话记录上限；超过后丢弃最旧的一条。 */
export const MAX_SESSIONS = 30

/** 一个会话。 */
export interface StoredSession {
  readonly id: string
  readonly title: string
  readonly updatedAt: number
  readonly messages: readonly ChatMessage[]
}

/** 存储不可用（隐私模式、配额写满）时抛出，由界面给出明确说明。 */
export class StorageUnavailable extends Error {
  /** @param cause - 底层异常，仅供日志。 */
  constructor(readonly cause: unknown) {
    super('本机存储不可用')
    this.name = 'StorageUnavailable'
  }
}

/** 安全读取：存储不可用或内容损坏时回退到默认值，绝不让整个应用崩溃。 */
function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    if (raw === null || raw === undefined) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** 写入；配额写满时抛出可识别的错误，而不是静默丢数据。 */
function writeJson(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value))
  } catch (error) {
    throw new StorageUnavailable(error)
  }
}

/**
 * 默认服务商模板。
 *
 * 用显式判定而不是非空断言：模板表是运行时可改的数据，缺失应当**响亮地失败**，
 * 而不是靠 `!` 让类型检查闭嘴——那会把配置错误推迟到用户点开设置页才暴露。
 */
function defaultTemplate(): ProviderProfile {
  const template = PROVIDER_TEMPLATES.deepseek
  if (template === undefined) throw new Error('内置服务商模板缺失：deepseek')
  return template
}

/** 默认连接设置：DeepSeek 模板，但**不含密钥**。 */
export function defaultSettings(): ConnectionSettings {
  const template = defaultTemplate()
  return { providerId: 'deepseek', baseUrl: template.baseUrl, model: template.defaultModel }
}

/** 自带密钥那一份连接设置；从未配置过时返回默认值。 */
export function loadByokSettings(): ConnectionSettings {
  const stored = readJson<Partial<ConnectionSettings> | null>(KEY_SETTINGS, null)
  if (stored === null || typeof stored !== 'object') return defaultSettings()
  const base = defaultSettings()
  return {
    providerId: typeof stored.providerId === 'string' ? stored.providerId : base.providerId,
    baseUrl: typeof stored.baseUrl === 'string' ? stored.baseUrl : base.baseUrl,
    model: typeof stored.model === 'string' ? stored.model : base.model,
  }
}

/**
 * 读取**当前生效**的连接设置。
 *
 * 生效的是哪一份，由用户的选择（`KEY_ROUTE`）决定：选了订阅档就返回订阅档那份
 * （端点由代码固定、只记前台模型名），否则返回自带密钥那份。`auto` 归入后者——
 * 自动档下真正走哪条路要等同源与登录探测的结果，那是界面的事，存储层不猜。
 */
export function loadSettings(): ConnectionSettings {
  return loadRouteChoice() === 'subscription' ? subscriptionSettings() : loadByokSettings()
}

/** 订阅档的连接设置：端点固定，模型只认前台名（存量数据坏了就回到默认模型）。 */
export function subscriptionSettings(): ConnectionSettings {
  const stored = readJson<{ model?: unknown } | null>(KEY_SUBSCRIPTION, null)
  const model = typeof stored?.model === 'string' && isFrontModel(stored.model) ? stored.model : DEFAULT_FRONT_MODEL
  return { providerId: SUBSCRIPTION_PROVIDER_ID, baseUrl: SUBSCRIPTION_BASE_URL, model }
}

/**
 * 保存连接设置。
 *
 * 订阅档写进它自己那份记录：**绝不覆盖**用户的自带密钥配置。这是"两条通路都必须
 * 永远可用"落地的地方——切到订阅档再切回来，端点、模型、密钥一个都不会少。
 */
export function saveSettings(settings: ConnectionSettings): void {
  if (settings.providerId === SUBSCRIPTION_PROVIDER_ID) {
    writeJson(KEY_SUBSCRIPTION, { model: settings.model })
    return
  }
  writeJson(KEY_SETTINGS, settings)
}

/** 读用户对通道的选择；没选过时是 `auto`。 */
export function loadRouteChoice(): RouteChoice {
  const stored = readJson<string>(KEY_ROUTE, 'auto')
  return stored === 'subscription' || stored === 'byok' ? stored : 'auto'
}

/** 记下用户对通道的选择。 */
export function saveRouteChoice(choice: RouteChoice): void {
  writeJson(KEY_ROUTE, choice)
}

/** 读取密钥；未设置时返回空串。 */
export function loadSecret(): string {
  const stored = readJson<{ key?: unknown } | null>(KEY_SECRET, null)
  return typeof stored?.key === 'string' ? stored.key : ''
}

/** 保存密钥；传空串表示清除。 */
export function saveSecret(key: string): void {
  writeJson(KEY_SECRET, { key })
}

/** 读取全部会话，按最近更新排序。 */
export function loadSessions(): readonly StoredSession[] {
  const stored = readJson<StoredSession[]>(KEY_SESSIONS, [])
  if (!Array.isArray(stored)) return []
  return stored
    .filter((s): s is StoredSession => typeof s?.id === 'string' && Array.isArray(s.messages))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 写入全部会话，并裁剪到上限。 */
export function saveSessions(sessions: readonly StoredSession[]): void {
  const trimmed = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS)
  writeJson(KEY_SESSIONS, trimmed)
}

/** 用首条用户消息生成标题；不调用模型，避免为命名付费。 */
export function titleFrom(messages: readonly ChatMessage[]): string {
  const first = messages.find(m => m.role === 'user')?.content ?? ''
  const line = first.split('\n').find(l => l.trim().length > 0)?.trim() ?? ''
  return line.length > 0 ? line.slice(0, 24) : '新对话'
}

/** 生成一个会话 id；不用 `crypto.randomUUID` 之外的东西，少一层依赖。 */
export function newSessionId(): string {
  try {
    return globalThis.crypto.randomUUID()
  } catch {
    return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
}

/**
 * 读电脑入口地址。
 *
 * 存的是用户在电脑上看到的那一串（`http://…/?token=…`）。它是**一次性令牌的载体**：
 * 作用只是让手机换到会话 cookie，换到之后 cookie 才是真正在用的凭据。
 * @returns 入口地址原文；没连过时是空串。
 */
export function loadPcEntry(): string {
  return readJson<string>(KEY_PC_ENTRY, '')
}

/**
 * 保存电脑入口地址。
 * @param entry - 入口地址原文；传空串表示清除。
 */
export function savePcEntry(entry: string): void {
  writeJson(KEY_PC_ENTRY, entry)
}
