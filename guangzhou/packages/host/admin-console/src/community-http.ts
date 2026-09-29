/** 讨论区用户接口。只认上海账号 Bearer，不复用管理台 cookie。 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AccountUpstream } from './account-upstream.ts'
import { CommunityError, COMMUNITY_PREFIX, type CommunityStore } from './community.ts'
import { checkOrigin, readJsonBody, sendJson } from './http.ts'

const OPERATIONS = new Set(['categories', 'topics', 'topic', 'topic/create', 'reply/create', 'topic/solve', 'report'])

/**
 * 处理讨论区的七个 POST JSON 操作。
 * @param options - 账号服务、数据存储及同源地址。
 * @returns HTTP 处理器；非讨论区路径必须由调用方自行处理。
 */
export function createCommunityHttp(options: {
  readonly upstream: AccountUpstream
  readonly store: CommunityStore
  readonly origin: string
}) {
  return async (request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> => {
    const operation = pathname.slice(COMMUNITY_PREFIX.length + 1)
    if (!pathname.startsWith(`${COMMUNITY_PREFIX}/`) || !OPERATIONS.has(operation)) {
      sendJson(response, 404, { ok: false, code: 'not_found', message: '讨论区接口不存在。' })
      return
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, code: 'method_not_allowed', message: '请使用 POST。' })
      return
    }
    const originError = checkOrigin(request, options.origin)
    if (originError !== null) {
      sendJson(response, 403, { ok: false, code: 'forbidden', message: originError })
      return
    }
    const match = /^Bearer ([A-Za-z0-9._~+/-]{16,8192})$/.exec(request.headers.authorization ?? '')
    if (!match) {
      sendJson(response, 401, { ok: false, code: 'unauthenticated', message: '请先登录千手账号。' })
      return
    }
    const identity = await options.upstream.verify({ access: match[1]!, refresh: null })
    if (identity.kind === 'unauthorized') {
      sendJson(response, 401, { ok: false, code: 'unauthenticated', message: '登录已失效，请重新登录。' })
      return
    }
    if (identity.kind === 'unavailable') {
      sendJson(response, 503, { ok: false, code: 'account_unavailable', message: '账号服务暂时不可用，请稍后重试。' })
      return
    }
    const body = await readJsonBody(request)
    if (!body.ok) {
      sendJson(response, body.code === 'too_large' ? 413 : 400, { ok: false, code: body.code, message: body.message })
      return
    }
    const actor = { id: identity.account.id, name: identity.account.displayName }
    const data = body.value
    try {
      switch (operation) {
        case 'categories':
          sendJson(response, 200, { ok: true, categories: options.store.categories() })
          return
        case 'topics':
          sendJson(response, 200, { ok: true, ...await options.store.list(data) })
          return
        case 'topic':
          sendJson(response, 200, { ok: true, ...await options.store.detail(String(data['id'] ?? ''), {
            replyCursor: data['replyCursor'], replyLimit: data['replyLimit'],
          }) })
          return
        case 'topic/create':
          sendJson(response, 200, { ok: true, topic: await options.store.createTopic(actor, {
            category: data['category'], title: data['title'], content: data['content'], related: data['related'],
          }) })
          return
        case 'reply/create':
          sendJson(response, 200, { ok: true, reply: await options.store.createReply(actor, String(data['topicId'] ?? ''), data['content']) })
          return
        case 'topic/solve':
          sendJson(response, 200, { ok: true, topic: await options.store.solve(actor, String(data['id'] ?? ''), data['replyId']) })
          return
        case 'report':
          await options.store.report(actor, data['targetKind'], data['targetId'], data['reason'])
          sendJson(response, 200, { ok: true })
          return
      }
    } catch (error) {
      if (!(error instanceof CommunityError)) throw error
      sendJson(response, error.status, { ok: false, code: error.code, message: error.message })
    }
  }
}
