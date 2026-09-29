/** Same-origin discussion API; the desktop Host supplies the account token upstream. */
import { COMMUNITY_PATH } from './paths.ts'

export interface CommunityCategory {
  readonly id: string
  readonly title: string
  readonly description: string
}

export interface CommunityRelated {
  readonly kind: 'skill' | 'product'
  readonly id: string
}

export interface CommunityTopic {
  readonly id: string
  readonly category: string
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
}

export interface CommunityReply {
  readonly id: string
  readonly topicId: string
  readonly content: string
  readonly authorId: string
  readonly authorName: string
  readonly createdAt: string
  readonly accepted: boolean
}

export interface CommunityTransport {
  categories(signal?: AbortSignal): Promise<readonly CommunityCategory[]>
  topics(input: { category?: string; cursor?: string; query?: string }, signal?: AbortSignal): Promise<{
    readonly items: readonly CommunityTopic[]
    readonly nextCursor: string | null
  }>
  topic(id: string, input?: { readonly replyCursor?: string }, signal?: AbortSignal): Promise<{
    readonly topic: CommunityTopic
    readonly replies: readonly CommunityReply[]
    readonly nextReplyCursor: string | null
  }>
  createTopic(input: { category: string; title: string; content: string; related?: CommunityRelated }): Promise<CommunityTopic>
  createReply(topicId: string, content: string): Promise<CommunityReply>
  solve(id: string, replyId?: string): Promise<CommunityTopic>
  report(targetKind: 'topic' | 'reply', targetId: string, reason: string): Promise<void>
}

export class CommunityFailure extends Error {
  constructor(readonly code: string) { super(code) }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new CommunityFailure('FORUM_RESPONSE_INVALID')
  return value as Record<string, unknown>
}

function string(value: unknown, max = 10_000): string {
  if (typeof value !== 'string' || value.length > max) throw new CommunityFailure('FORUM_RESPONSE_INVALID')
  return value
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new CommunityFailure('FORUM_RESPONSE_INVALID')
  return value
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new CommunityFailure('FORUM_RESPONSE_INVALID')
  return value
}

function related(value: unknown): CommunityRelated | null {
  if (value === null) return null
  const row = object(value)
  if (row.kind !== 'skill' && row.kind !== 'product') throw new CommunityFailure('FORUM_RESPONSE_INVALID')
  return { kind: row.kind, id: string(row.id, 160) }
}

function topic(value: unknown): CommunityTopic {
  const row = object(value)
  if (row.status !== 'open' && row.status !== 'solved') throw new CommunityFailure('FORUM_RESPONSE_INVALID')
  return {
    id: string(row.id, 160), category: string(row.category, 80), title: string(row.title, 240),
    content: string(row.content), authorId: string(row.authorId, 80), authorName: string(row.authorName, 120),
    status: row.status, related: related(row.related), replyCount: count(row.replyCount),
    createdAt: string(row.createdAt, 64), updatedAt: string(row.updatedAt, 64),
    pinned: boolean(row.pinned), official: boolean(row.official),
  }
}

function reply(value: unknown): CommunityReply {
  const row = object(value)
  return {
    id: string(row.id, 160), topicId: string(row.topicId, 160), content: string(row.content),
    authorId: string(row.authorId, 80), authorName: string(row.authorName, 120),
    createdAt: string(row.createdAt, 64), accepted: boolean(row.accepted),
  }
}

function rows<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 100) throw new CommunityFailure('FORUM_RESPONSE_INVALID')
  return value.map(parse)
}

/** Pass only forum JSON through the Host's authenticated same-origin route. */
export function createCommunityTransport(options: { readonly fetchImpl?: typeof fetch; readonly baseUri?: string } = {}): CommunityTransport {
  const request = options.fetchImpl ?? fetch
  const baseUri = options.baseUri ?? (typeof document === 'undefined' ? 'http://127.0.0.1/' : document.baseURI)
  const call = async (action: string, payload: object, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    let response: Response
    try {
      response = await request(new URL(`${COMMUNITY_PATH}/${action}`, baseUri), {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload), ...(signal === undefined ? {} : { signal }),
      })
    } catch { throw new CommunityFailure('FORUM_UNAVAILABLE') }
    let raw: unknown
    try { raw = await response.json() }
    catch { throw new CommunityFailure('FORUM_RESPONSE_INVALID') }
    const result = object(raw)
    if (!response.ok || result.ok !== true) {
      throw new CommunityFailure(typeof result.code === 'string' ? result.code : 'FORUM_UNAVAILABLE')
    }
    return result
  }
  return {
    async categories(signal) { return rows((await call('categories', {}, signal)).categories, item => {
      const row = object(item)
      return { id: string(row.id, 80), title: string(row.title, 120), description: string(row.description, 500) }
    }) },
    async topics(input, signal) {
      const result = await call('topics', { ...input, limit: 20 }, signal)
      const nextCursor = result.nextCursor === null ? null : string(result.nextCursor, 512)
      return { items: rows(result.items, topic), nextCursor }
    },
    async topic(id, input, signal) {
      const result = await call('topic', { id, ...(input ?? {}) }, signal)
      return { topic: topic(result.topic), replies: rows(result.replies, reply),
        nextReplyCursor: result.nextReplyCursor === null ? null : string(result.nextReplyCursor, 512) }
    },
    async createTopic(input) { return topic((await call('topic/create', input)).topic) },
    async createReply(topicId, content) { return reply((await call('reply/create', { topicId, content })).reply) },
    async solve(id, replyId) { return topic((await call('topic/solve', { id, ...(replyId === undefined ? {} : { replyId }) })).topic) },
    async report(targetKind, targetId, reason) { await call('report', { targetKind, targetId, reason }) },
  }
}
