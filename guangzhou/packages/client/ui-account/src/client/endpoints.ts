/**
 * 账户卡读的两个端点。
 *
 * 两条都是**宿主自己的**路由，不是上游账号站：
 * - `/api/qianshou/account/state` 回答「有没有登录、是谁」（宿主账号会话）；
 * - `/api/qianshou/ai/status` 回答「什么档位、还剩多少额度」（订阅网关）。
 *
 * 为什么不合并成一条：它们的**真相来源不同**。账号会话归账号插件，
 * 额度归计费账本；合并读会把两个独立生命周期绑死，而且一旦网关没挂，
 * 连"你已登录"都显示不出来——那正是最需要显示的场合。
 *
 * 两条都必须是 **POST**：宿主 `/api` 前缀的注册方法集里没有 GET
 * （实测：同一路径 GET 得到 `404 not found` 纯文本，POST 得到 200 JSON）。
 * 把这条写进注释是因为它极容易被"顺手改成 GET"而看不出错。
 */

/** 宿主账号会话状态路由。 */
export const ACCOUNT_STATE_PATH = '/api/qianshou/account/state'

/** 订阅网关的档位与额度路由，与手机端读的是同一条。 */
export const AI_STATUS_PATH = '/api/qianshou/ai/status'

/** 网关暂时无响应时，多久之后才允许再打一次，避免界面反复戳。 */
export const UNAVAILABLE_RETRY_MS = 5_000

/** 读到有效结果后的最短复用时间；比宿主的 2 秒账本缓存略长一点。 */
export const READY_TTL_MS = 2_500

/**
 * 一次读请求的写法：POST + JSON + 同源凭据。
 *
 * `credentials: 'include'` 是固定的，不做条件分支——宿主 `/api` 门的凭据
 * 就是同源携带的，丢掉它整条读链路会变成 401，而 401 在别处有别的含义。
 */
export function readRequest(path: string, signal: AbortSignal): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: '{}',
    signal,
  })
}
