/**
 * 审计：谁、何时、从哪来、做了什么、改前值 → 改后值、结果如何。
 *
 * 这个文件要回答的是"事后凭什么说得清"。三条纪律：
 *
 * 1. **只追加**。审计写在 JSONL 里，代码里没有"改一条审计"或"删一条审计"的路径——
 *    能被改写的历史不是历史。
 * 2. **拒绝也要记**。越权尝试、白名单拒绝、登录失败都会被写下来。
 *    只记成功的操作，等于把最有价值的那部分（有人在敲门）丢掉。
 * 3. **敏感值入库前遮盖**。口令、令牌、cookie 一旦写进审计，就等于把密钥抄了一份
 *    存在审计文件里——而审计文件是要被很多人读的。
 */
import { readJsonl, appendJsonl, type JsonlReadResult } from './store.ts'
import type { DataScope } from './rbac.ts'

/** 一条审计记录。 */
export interface AuditEntry {
  /** 记录 id（不可变；详情页按它查）。 */
  readonly id: string
  /** 发生时刻（毫秒）。 */
  readonly at: number
  /** 主体类型：管理员 / 匿名 / 系统 / 命令行。 */
  readonly actorType: 'admin' | 'anonymous' | 'system' | 'cli'
  /** 主体 accountId；匿名写 `-`。 */
  readonly actorId: string
  /** 主体当时的角色 id；没有角色写 `-`。 */
  readonly actorRole: string
  /** 来源 IP（白名单判定的那个值）。 */
  readonly ip: string
  /** 来源地址是怎么判出来的（socket / x-real-ip / x-forwarded-for）。 */
  readonly addressSource: string
  /** 动作标识，例如 `session.login`、`rbac.roles.apply`、`ip.rejected`。 */
  readonly action: string
  /** 作用目标，例如 `role:ops`、`admin:167`、`account:167`。 */
  readonly target: string
  /** 结果：通过 / 拒绝 / 出错（出错也要留痕）。 */
  readonly result: 'allow' | 'deny' | 'error'
  /** 原因：操作者填的，或系统给的原因。 */
  readonly reason: string
  /** 一句话摘要（列表页直接展示）。 */
  readonly summary: string
  /** 改前值 / 改后值（写操作才有）。 */
  readonly before?: unknown
  readonly after?: unknown
  /** before → after 的逐字段差异。 */
  readonly diff?: readonly DiffRow[]
}

/** 一处差异。 */
export interface DiffRow {
  readonly path: string
  readonly before: unknown
  readonly after: unknown
}

/** 审计查询条件。 */
export interface AuditQuery {
  readonly from?: number
  readonly to?: number
  readonly actorId?: string
  readonly actionPrefix?: string
  /** 只看某个目标。 */
  readonly target?: string
  readonly result?: 'allow' | 'deny' | 'error'
  readonly limit?: number
  readonly offset?: number
  /** 数据范围：`self` 只看自己经办的操作。 */
  readonly scope?: DataScope
  /** 配合 `self` 使用的主体 id。 */
  readonly selfId?: string
}

/** 查询结果。 */
export interface AuditQueryResult {
  /** 过滤后的总条数（分页前）。 */
  readonly total: number
  readonly entries: readonly AuditEntry[]
  /** 坏行数（文件里读不出来的行）。 */
  readonly brokenLines: number
  /** 是否因为文件过大而只读了尾部。 */
  readonly truncated: boolean
}

/**
 * 需要遮盖的键名。
 *
 * 用**子串**匹配而不是全等：上游可能写 `password`、`old_password`、`newPassword`、
 * `access_token`、`refreshToken`、`client_secret`——漏掉一个就等于抄了一份密钥。
 */
const SECRET_KEY_PARTS = ['password', 'passwd', 'secret', 'token', 'cookie', 'credential', 'authorization', 'apikey', 'api_key']

/** 遮盖占位符。 */
const REDACTED = '***'

/** 这个键名是不是敏感键。 */
export function isSecretKey(key: string): boolean {
  // 先把分隔符去掉再比：`x-api-key`、`api_key`、`apiKey` 必须都算敏感键，
  // 漏掉一种写法就等于抄了一份密钥进审计文件。
  const normalized = key.toLowerCase().replaceAll(/[-_.\s]/g, '')
  return SECRET_KEY_PARTS.some(part => normalized.includes(part.replaceAll(/[-_.\s]/g, '')))
}

/**
 * 深度遮盖敏感字段。
 * @param value - 任意值。
 * @param depth - 递归深度上限（防御自引用/超深结构）。
 * @returns 遮盖后的副本。
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[深度截断]'
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? REDACTED : redact(item, depth + 1)
    }
    return out
  }
  return value
}

/**
 * 计算 before → after 的差异。
 *
 * 逐字段递归（对象）与整体比较（数组/标量）：数组元素的下标在业务上没有意义，
 * 报成"第 2 项从 A 变成 B"会让人以为顺序重要。数组整体替换反而更好读。
 * @param before - 改前值。
 * @param after - 改后值。
 * @returns 差异行（无差异时为空数组）。
 */
export function computeDiff(before: unknown, after: unknown): readonly DiffRow[] {
  const rows: DiffRow[] = []
  const walk = (left: unknown, right: unknown, path: string): void => {
    // 一侧是对象、另一侧是 null/undefined：按"这些字段被删掉/新增"逐字段展开，
    // 否则整块会显示成"(整体) 从 X 变成 Y"，读的人看不出到底少了哪一项。
    const leftObject = isPlainObject(left) ? left : (left === null || left === undefined) && isPlainObject(right) ? {} : null
    const rightObject = isPlainObject(right) ? right : (right === null || right === undefined) && isPlainObject(left) ? {} : null
    if (leftObject !== null && rightObject !== null) {
      const source = leftObject
      const target = rightObject
      const keys = new Set([...Object.keys(source), ...Object.keys(target)])
      for (const key of [...keys].sort()) {
        const nextPath = path.length === 0 ? key : `${path}.${key}`
        walk(source[key], target[key], nextPath)
      }
      return
    }
    if (JSON.stringify(left) === JSON.stringify(right)) return
    rows.push({ path: path.length === 0 ? '(整体)' : path, before: left ?? null, after: right ?? null })
  }
  walk(redact(before), redact(after), '')
  return rows
}

/** 是不是普通对象（差异计算的判据）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 一次操作的"待写入审计"（不含 id 与时间，由写入器补齐）。
 */
export type AuditDraft = Omit<AuditEntry, 'id' | 'at'>

/** 审计日志句柄。 */
export interface AuditLog {
  /** 追加一条记录；返回落盘后的完整记录。 */
  readonly record: (draft: AuditDraft) => Promise<AuditEntry>
  /** 查询（过滤 + 分页 + 范围裁剪）。 */
  readonly query: (query: AuditQuery) => Promise<AuditQueryResult>
  /** 按 id 取一条。 */
  readonly detail: (id: string) => Promise<AuditEntry | null>
  /** 文件路径。 */
  readonly path: string
}

/** 审计记录的形状校验：坏行不进入结果集。 */
function isAuditEntry(raw: unknown): raw is AuditEntry {
  if (raw === null || typeof raw !== 'object') return false
  const row = raw as Record<string, unknown>
  return typeof row['id'] === 'string'
    && typeof row['at'] === 'number'
    && typeof row['action'] === 'string'
    && typeof row['result'] === 'string'
}

/**
 * 建审计日志。
 * @param options - 文件路径、时钟与 id 生成器（测试注入）。
 * @returns 句柄。
 */
export function createAuditLog(options: {
  readonly path: string
  readonly now?: () => number
  readonly newId?: () => string
  /** 读盘上限（字节）；默认 32 MiB。 */
  readonly maxBytes?: number
}): AuditLog {
  const now = options.now ?? (() => Date.now())
  const newId = options.newId ?? (() => `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`)
  /**
   * 串行队列。
   *
   * 为什么需要：`appendFile` 对同一个小文件并发调用时，写入顺序不保证，
   * 而审计"顺序"本身就是证据（谁先改的）。串起来就够，不需要锁。
   */
  let queue: Promise<unknown> = Promise.resolve()

  const read = async (): Promise<JsonlReadResult> => await readJsonl(options.path, {
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  })

  return {
    path: options.path,
    record: async (draft) => {
      const entry: AuditEntry = { id: newId(), at: now(), ...draft }
      queue = queue.then(async () => { await appendJsonl(options.path, redact(entry)) }).catch(() => { /* 交给下一条继续 */ })
      await queue
      return entry
    },
    query: async (query) => {
      const { rows, broken, truncated } = await read()
      const limit = Math.min(Math.max(Math.floor(query.limit ?? 50), 1), 500)
      const offset = Math.max(Math.floor(query.offset ?? 0), 0)
      const filtered = rows
        .filter(isAuditEntry)
        .filter(entry => query.from === undefined || entry.at >= query.from)
        .filter(entry => query.to === undefined || entry.at <= query.to)
        .filter(entry => query.actorId === undefined || entry.actorId === query.actorId)
        .filter(entry => query.actionPrefix === undefined || entry.action.startsWith(query.actionPrefix))
        .filter(entry => query.target === undefined || entry.target === query.target)
        .filter(entry => query.result === undefined || entry.result === query.result)
        // 数据范围：只见自己经办的操作。**在服务端裁剪**，前端拿到的就是裁剪后的结果。
        .filter(entry => query.scope !== 'self' || entry.actorId === query.selfId)
        .sort((left, right) => right.at - left.at)
      return {
        total: filtered.length,
        entries: filtered.slice(offset, offset + limit),
        brokenLines: broken,
        truncated,
      }
    },
    detail: async (id) => {
      const { rows } = await read()
      for (const row of rows) {
        if (isAuditEntry(row) && row.id === id) return row
      }
      return null
    },
  }
}
