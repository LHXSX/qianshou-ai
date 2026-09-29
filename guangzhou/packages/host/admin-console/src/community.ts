/** 千手讨论区的数据与操作。用户身份由调用方从上海账号服务核验。 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from './store.ts'

export const COMMUNITY_PREFIX = '/api/qianshou/community'

export const COMMUNITY_CATEGORIES = [
  { id: 'help', title: '问题求助', description: '提问、补充信息，并标记解决方法。' },
  { id: 'skills', title: '技能交流', description: '讨论技能、插件的使用和制作。' },
  { id: 'works', title: '作品分享', description: '展示图文、视频及其他作品。' },
  { id: 'activities', title: '活动公告', description: '查看官方活动与更新。' },
] as const

export type CommunityCategory = typeof COMMUNITY_CATEGORIES[number]['id']
export interface CommunityActor { readonly id: string; readonly name: string }
export interface CommunityRelated { readonly kind: 'skill' | 'product'; readonly id: string }
export interface CommunityTopic {
  readonly id: string
  readonly category: CommunityCategory
  readonly title: string
  readonly content: string
  readonly authorId: string
  readonly authorName: string
  readonly status: 'open' | 'solved'
  readonly related: CommunityRelated | null
  readonly replyCount: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly pinned: boolean
  readonly official: boolean
  readonly visibility: 'visible' | 'hidden'
  readonly acceptedReplyId: string | null
}
export interface CommunityReply {
  readonly id: string
  readonly topicId: string
  readonly content: string
  readonly authorId: string
  readonly authorName: string
  readonly createdAt: string
  readonly accepted: boolean
  readonly visibility: 'visible' | 'hidden'
}
export interface CommunityReport {
  readonly id: string
  readonly targetKind: 'topic' | 'reply'
  readonly targetId: string
  readonly reason: string
  readonly reporterId: string
  readonly createdAt: string
  readonly status: 'open' | 'dismissed' | 'actioned'
  readonly reviewerId: string | null
  readonly reviewedAt: string | null
  readonly note: string | null
}
interface CommunityFile {
  readonly version: 1
  readonly topics: readonly CommunityTopic[]
  readonly replies: readonly CommunityReply[]
  readonly reports: readonly CommunityReport[]
}

export class CommunityError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function validText(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new CommunityError(400, 'bad_request', `${name}应为 ${min}–${max} 个字。`)
  const text = value.trim()
  if (text.length < min || text.length > max) throw new CommunityError(400, 'bad_request', `${name}应为 ${min}–${max} 个字。`)
  return text
}

function categoryOf(value: unknown): CommunityCategory {
  if (COMMUNITY_CATEGORIES.some(item => item.id === value)) return value as CommunityCategory
  throw new CommunityError(400, 'bad_request', '请选择讨论分类。')
}

function relatedOf(value: unknown): CommunityRelated | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new CommunityError(400, 'bad_request', '关联技能或商品无效。')
  const row = value as Record<string, unknown>
  if ((row['kind'] !== 'skill' && row['kind'] !== 'product') || typeof row['id'] !== 'string' ||
      !/^[\w:./-]{1,160}$/.test(row['id']) || row['id'].includes('://')) throw new CommunityError(400, 'bad_request', '关联技能或商品无效。')
  return { kind: row['kind'], id: row['id'] }
}

function validFile(value: unknown): value is CommunityFile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return row['version'] === 1 && Array.isArray(row['topics']) && Array.isArray(row['replies']) && Array.isArray(row['reports'])
}

/** 单进程串行写入；磁盘损坏时拒绝继续写，避免覆盖历史。 */
export function createCommunityStore(options: { readonly dataDir: string; readonly now?: () => number; readonly newId?: () => string }) {
  const path = join(options.dataDir, 'community.json')
  const now = options.now ?? (() => Date.now())
  const newId = options.newId ?? randomUUID
  let loaded: Promise<CommunityFile> | null = null
  let pending: Promise<unknown> = Promise.resolve()
  const timestamp = (): string => new Date(now()).toISOString()
  const limitPosts = (times: readonly string[], perMinute: number, perHour: number): void => {
    const recent = times.map(value => Date.parse(value)).filter(value => Number.isFinite(value))
    if (recent.filter(value => now() - value < 60_000).length >= perMinute ||
        recent.filter(value => now() - value < 3_600_000).length >= perHour) {
      throw new CommunityError(429, 'rate_limited', '操作太频繁，请稍后再试。')
    }
  }
  const read = async (): Promise<CommunityFile> => {
    loaded ??= (async () => {
      let contents: string
      try { contents = await readFile(path, 'utf8') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, topics: [], replies: [], reports: [] }
        throw error
      }
      const parsed: unknown = JSON.parse(contents)
      if (!validFile(parsed)) throw new Error('community.json 格式不受支持，已停止写入以保护数据。')
      return parsed
    })()
    return await loaded
  }
  const mutate = async <T>(change: (data: CommunityFile) => { readonly next: CommunityFile; readonly result: T }): Promise<T> => {
    const operation = pending.then(async () => {
      const current = await read()
      const changed = change(current)
      await writeJsonAtomic(path, changed.next)
      loaded = Promise.resolve(changed.next)
      return changed.result
    })
    pending = operation.catch(() => undefined)
    return await operation
  }
  const visibleTopic = (data: CommunityFile, id: string): CommunityTopic => {
    const topic = data.topics.find(item => item.id === id && item.visibility === 'visible')
    if (!topic) throw new CommunityError(404, 'not_found', '讨论不存在或已下架。')
    return topic
  }
  const expose = (topic: CommunityTopic): Omit<CommunityTopic, 'visibility' | 'acceptedReplyId'> => {
    const { visibility: _visibility, acceptedReplyId: _accepted, ...publicTopic } = topic
    return publicTopic
  }
  const exposeReply = (reply: CommunityReply): Omit<CommunityReply, 'visibility'> => {
    const { visibility: _visibility, ...publicReply } = reply
    return publicReply
  }
  return {
    categories: () => COMMUNITY_CATEGORIES,
    list: async (input: { category?: unknown; cursor?: unknown; limit?: unknown; query?: unknown }) => {
      const data = await read()
      const category = input.category === undefined || input.category === '' ? null : categoryOf(input.category)
      const query = input.query === undefined ? '' : validText(input.query, '搜索内容', 0, 80).toLowerCase()
      const limit = input.limit === undefined ? 20 : input.limit
      if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new CommunityError(400, 'bad_request', '每页数量应为 1–50。')
      let offset = 0
      if (input.cursor !== undefined && input.cursor !== null) {
        if (typeof input.cursor !== 'string' || !/^\d{1,8}$/.test(input.cursor)) throw new CommunityError(400, 'bad_request', '分页位置无效。')
        offset = Number(input.cursor)
      }
      const filtered = data.topics.filter(item => item.visibility === 'visible' && (category === null || item.category === category) &&
        (query.length === 0 || `${item.title} ${item.content}`.toLowerCase().includes(query)))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
      const items = filtered.slice(offset, offset + limit).map(expose)
      return { items, nextCursor: offset + limit < filtered.length ? String(offset + limit) : null }
    },
    detail: async (id: string, input: { replyCursor?: unknown; replyLimit?: unknown } = {}) => {
      const data = await read()
      const topic = visibleTopic(data, id)
      const replyLimit = input.replyLimit === undefined ? 50 : input.replyLimit
      if (typeof replyLimit !== 'number' || !Number.isSafeInteger(replyLimit) || replyLimit < 1 || replyLimit > 100) {
        throw new CommunityError(400, 'bad_request', '每页回复数量应为 1–100。')
      }
      if (input.replyCursor !== undefined && (typeof input.replyCursor !== 'string' || !/^\d{1,8}$/.test(input.replyCursor))) {
        throw new CommunityError(400, 'bad_request', '回复分页位置无效。')
      }
      const offset = input.replyCursor === undefined ? 0 : Number(input.replyCursor)
      const visible = data.replies.filter(item => item.topicId === id && item.visibility === 'visible')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      return { topic: expose(topic), replies: visible.slice(offset, offset + replyLimit).map(exposeReply),
        nextReplyCursor: offset + replyLimit < visible.length ? String(offset + replyLimit) : null }
    },
    createTopic: async (actor: CommunityActor, input: { category: unknown; title: unknown; content: unknown; related?: unknown }, official = false) => {
      const category = categoryOf(input.category)
      if (category === 'activities' && !official) throw new CommunityError(403, 'forbidden', '活动公告只能由管理员发布。')
      const title = validText(input.title, '标题', 4, 100)
      const content = validText(input.content, '正文', 10, 10000)
      const related = relatedOf(input.related)
      const at = timestamp()
      const topic: CommunityTopic = { id: newId(), category, title, content, authorId: actor.id, authorName: actor.name,
        status: 'open', related, replyCount: 0, createdAt: at, updatedAt: at, pinned: official, official,
        visibility: 'visible', acceptedReplyId: null }
      return await mutate(data => {
        limitPosts(data.topics.filter(item => item.authorId === actor.id).map(item => item.createdAt), 3, 20)
        return { next: { ...data, topics: [...data.topics, topic] }, result: expose(topic) }
      })
    },
    createReply: async (actor: CommunityActor, topicId: string, contentInput: unknown) => {
      const content = validText(contentInput, '回复', 1, 5000)
      return await mutate(data => {
        const topic = visibleTopic(data, topicId)
        limitPosts(data.replies.filter(item => item.authorId === actor.id).map(item => item.createdAt), 10, 120)
        const at = timestamp()
        const reply: CommunityReply = { id: newId(), topicId, content, authorId: actor.id, authorName: actor.name,
          createdAt: at, accepted: false, visibility: 'visible' }
        return { next: { ...data, topics: data.topics.map(item => item.id === topic.id
          ? { ...item, replyCount: item.replyCount + 1, updatedAt: at } : item), replies: [...data.replies, reply] },
        result: exposeReply(reply) }
      })
    },
    solve: async (actor: CommunityActor, id: string, replyId?: unknown) => await mutate(data => {
      const topic = visibleTopic(data, id)
      if (topic.authorId !== actor.id) throw new CommunityError(403, 'forbidden', '只有发帖人可以标记已解决。')
      if (topic.category !== 'help') throw new CommunityError(409, 'invalid_state', '仅问题求助可标记已解决。')
      if (replyId !== undefined && replyId !== null && !data.replies.some(reply => reply.id === replyId && reply.topicId === id && reply.visibility === 'visible')) {
        throw new CommunityError(400, 'bad_request', '所选回复不存在。')
      }
      const acceptedReplyId = typeof replyId === 'string' ? replyId : null
      const updated = { ...topic, status: 'solved' as const, acceptedReplyId, updatedAt: timestamp() }
      return { next: { ...data, topics: data.topics.map(item => item.id === id ? updated : item),
        replies: data.replies.map(item => item.topicId === id ? { ...item, accepted: item.id === acceptedReplyId } : item) }, result: expose(updated) }
    }),
    report: async (actor: CommunityActor, targetKind: unknown, targetId: unknown, reasonInput: unknown) => {
      if (targetKind !== 'topic' && targetKind !== 'reply') throw new CommunityError(400, 'bad_request', '举报对象无效。')
      if (typeof targetId !== 'string') throw new CommunityError(400, 'bad_request', '举报对象无效。')
      const reason = validText(reasonInput, '举报原因', 4, 500)
      return await mutate(data => {
        const found = targetKind === 'topic' ? data.topics.some(item => item.id === targetId && item.visibility === 'visible')
          : data.replies.some(item => item.id === targetId && item.visibility === 'visible')
        if (!found) throw new CommunityError(404, 'not_found', '举报对象不存在。')
        if (data.reports.some(item => item.targetKind === targetKind && item.targetId === targetId && item.reporterId === actor.id && item.status === 'open')) {
          throw new CommunityError(409, 'already_reported', '你已举报过这条内容。')
        }
        limitPosts(data.reports.filter(item => item.reporterId === actor.id).map(item => item.createdAt), 5, 30)
        const report: CommunityReport = { id: newId(), targetKind, targetId, reason, reporterId: actor.id,
          createdAt: timestamp(), status: 'open', reviewerId: null, reviewedAt: null, note: null }
        return { next: { ...data, reports: [...data.reports, report] }, result: report.id }
      })
    },
    adminList: async () => {
      const data = await read()
      return { topics: [...data.topics].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        reports: data.reports.filter(item => item.status === 'open').sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }
    },
    moderate: async (actor: CommunityActor, id: string, action: 'hide' | 'restore' | 'pin' | 'unpin', noteInput: unknown) => {
      const note = validText(noteInput, '处理原因', 4, 500)
      return await mutate(data => {
        const topic = data.topics.find(item => item.id === id)
        if (!topic) throw new CommunityError(404, 'not_found', '讨论不存在。')
        const updated: CommunityTopic = action === 'hide' ? { ...topic, visibility: 'hidden' }
          : action === 'restore' ? { ...topic, visibility: 'visible' }
            : action === 'pin' ? { ...topic, pinned: true } : { ...topic, pinned: false }
        return { next: { ...data, topics: data.topics.map(item => item.id === id ? updated : item) }, result: { topic: updated, note, actorId: actor.id } }
      })
    },
    resolveReport: async (actor: CommunityActor, id: string, action: 'dismiss' | 'hide', noteInput: unknown) => {
      const note = validText(noteInput, '处理原因', 4, 500)
      return await mutate(data => {
        const report = data.reports.find(item => item.id === id && item.status === 'open')
        if (!report) throw new CommunityError(404, 'not_found', '待处理举报不存在。')
        const targetTopic = report.targetKind === 'topic' ? report.targetId : data.replies.find(item => item.id === report.targetId)?.topicId
        const changed: CommunityReport = { ...report, status: action === 'hide' ? 'actioned' : 'dismissed', reviewerId: actor.id,
          reviewedAt: timestamp(), note }
        const hiddenReply = action === 'hide' && report.targetKind === 'reply'
          ? data.replies.find(item => item.id === report.targetId && item.visibility === 'visible') : undefined
        return { next: { ...data, reports: data.reports.map(item => item.id === id ? changed : item),
          topics: data.topics.map(item => {
            if (action === 'hide' && report.targetKind === 'topic' && item.id === report.targetId) return { ...item, visibility: 'hidden' }
            if (hiddenReply && item.id === hiddenReply.topicId) return { ...item, replyCount: Math.max(0, item.replyCount - 1),
              acceptedReplyId: item.acceptedReplyId === hiddenReply.id ? null : item.acceptedReplyId }
            return item
          }),
          replies: action === 'hide' && report.targetKind === 'reply' ? data.replies.map(item => item.id === report.targetId ? { ...item, visibility: 'hidden' } : item) : data.replies },
        result: { report: changed, topicId: targetTopic ?? null } }
      })
    },
  }
}

export type CommunityStore = ReturnType<typeof createCommunityStore>
