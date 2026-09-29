/**
 * 审计的对外接口。
 *
 * 账本里本来就有**逐调用记录**（谁、什么时候、用了哪个前台名字、真实 token 用量、
 * 扣了多少 SP），但一直没有出口——那等于"记了但没人能看"，
 * 而目标③要求的"逐调用审计"必须是**能查的**。
 *
 * 两条路由，边界刻意分开：
 * - `POST /api/qianshou/ai/audit`：查**自己的**记录。任何登录用户都能用，
 *   但只能看到自己的——这是"我的钱花在哪了"，属于用户权利。
 * - `POST /api/qianshou/ai/admin/audit`：查**任意账号**的记录。仅管理员，
 *   用于对账与客诉核查。
 *
 * 出参只给前台名字与 SP，**不给上游厂商标识**（`backendKey` 只留给管理面并标注为内部字段）：
 * 用户看到的是「千手·迅捷」，账单口径就该是这个名字。
 */
import type { CallRecord, CreditLedger } from './ledger.ts'
import type { Principal } from './admin-routes.ts'

/** 查自己记录的路由。 */
export const AI_AUDIT_PATH = '/api/qianshou/ai/audit'
/** 管理面查任意账号记录的路由。 */
export const ADMIN_AUDIT_PATH = '/api/qianshou/ai/admin/audit'

/** 一条给用户看的用量记录。 */
interface AuditEntry {
  /** 何时发生（毫秒时间戳）。 */
  readonly at: number
  /** 前台模型名（用户看到的那个）。 */
  readonly model: string
  /** 输入与输出 token。 */
  readonly inputTokens: number
  readonly outputTokens: number
  /** 本次消耗的订阅点数。 */
  readonly sp: number
}

/** 把账本记录投影成用户可见的形状。 */
function toEntry(record: CallRecord, includeBackend: boolean): AuditEntry & { readonly accountId?: string; readonly backendKey?: string } {
  return {
    at: record.at,
    model: record.publishedName,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    sp: record.sp,
    ...(includeBackend ? { accountId: record.accountId, backendKey: record.backendKey } : {}),
  }
}

/** 用户侧审计路由依赖。 */
export interface AiAuditDeps {
  readonly ledger: CreditLedger
  /** 认出请求是哪个主体；与对话路由同一套判据。 */
  readonly authenticate: (request: Request) => Promise<Principal | null> | Principal | null
}

/** 管理面审计路由依赖。 */
export interface AiAdminAuditDeps {
  readonly ledger: CreditLedger
  readonly authenticate: (request: Request) => Promise<Principal | null> | Principal | null
}

/** 统一 JSON 响应；审计数据同样不许被中间层缓存。 */
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

/** 审计查询的参数。 */
interface AuditQuery {
  /** 最多返回多少条；已封顶。 */
  readonly limit: number
  /** 只看某个账号（仅管理面会用）。 */
  readonly accountId: string | null
}

/**
 * **一次性**读完审计查询的参数。
 *
 * 为什么强调"一次性"：`Request` 的体是**流**，读完就没了。这里一开始拆成
 * `readLimit()` 与"再读一次取 accountId"两步，第二步永远抛错并被静默吞掉，
 * 于是管理员查谁都是在查自己——测试当场抓到了。
 * @param request - 原始请求。
 * @returns 上限与可选账号。
 */
async function readQuery(request: Request): Promise<AuditQuery> {
  const fallback: AuditQuery = { limit: 50, accountId: null }
  try {
    const body = await request.json() as { limit?: unknown; accountId?: unknown }
    const raw = body.limit
    const limit = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 500) : 50
    const accountId = typeof body.accountId === 'string' && body.accountId.length > 0 ? body.accountId : null
    return { limit, accountId }
  } catch {
    // 没有请求体或不是 JSON 都无所谓：审计查询不强制带参数。
    return fallback
  }
}

/**
 * 建用户侧审计处理器。
 * @param deps - 账本与身份解析。
 * @returns 一个处理器。
 */
export function createAiAuditRoutes(deps: AiAuditDeps): {
  readonly audit: (request: Request) => Promise<Response>
} {
  return {
    audit: async (request) => {
      const principal = await deps.authenticate(request)
      if (principal === null) return json({ ok: false, message: '请先登录。' }, 401)
      const { limit } = await readQuery(request)
      // 用户侧**忽略** accountId：查别人的用量是越权，接口层面就不给这个口子。
      const records = deps.ledger.recordsOf(principal.accountId, limit)
      return json({
        ok: true,
        count: records.length,
        // 用户看不到 `backendKey`：他知道的是「千手·迅捷」，账单口径就该是这个。
        entries: records.map(record => toEntry(record, false)),
      })
    },
  }
}

/**
 * 建管理面审计处理器。
 *
 * 判据和模型路由控制台一致：**身份来自宿主侧账号会话的服务端核验结果**，且必须是管理员。
 * 状态码与另外两处管理面对齐（WP1 A-11）：未登录 401、**已登录但不是管理员 403**。
 * 早先这两条路由把非管理员也回 401，于是界面按状态码把"权限不够"显示成"请去登录"——
 * 用户去重新登录，回来还是不行。
 * @param deps - 账本与身份解析。
 * @returns 一个处理器。
 */
export function createAiAdminAuditRoutes(deps: AiAdminAuditDeps): {
  readonly audit: (request: Request) => Promise<Response>
} {
  return {
    audit: async (request) => {
      const principal = await deps.authenticate(request)
      if (principal === null) return json({ ok: false, message: '请先登录。' }, 401)
      if (!principal.isAdmin) return json({ ok: false, message: '这个操作需要管理员权限。' }, 403)
      const query = await readQuery(request)
      // 不带账号就查自己的；管理员查自己同样有意义。
      const accountId = query.accountId ?? principal.accountId
      const records = deps.ledger.recordsOf(accountId, query.limit)
      return json({
        ok: true,
        accountId,
        count: records.length,
        // 管理面带上后端键：换过绑定时靠它核对成本口径。
        entries: records.map(record => toEntry(record, true)),
      })
    },
  }
}
