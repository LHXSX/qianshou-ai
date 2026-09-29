/** 广州讨论区管理接口。 */
import { postJson } from '@/api/client'
import { ENDPOINTS } from '@/api/endpoints'

export interface CommunityTopic {
  readonly id: string
  readonly category: 'help' | 'skills' | 'works' | 'activities'
  readonly title: string
  readonly content: string
  readonly authorId: string
  readonly authorName: string
  readonly status: 'open' | 'solved'
  readonly related: { readonly kind: 'skill' | 'product'; readonly id: string } | null
  readonly replyCount: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly pinned: boolean
  readonly official: boolean
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
}

export async function listCommunity(): Promise<{ ok: true; topics: CommunityTopic[]; reports: CommunityReport[] }> {
  return await postJson(ENDPOINTS.communityList)
}

export async function moderateCommunity(id: string, action: 'hide' | 'restore' | 'pin' | 'unpin', note: string): Promise<{ ok: true; topic: CommunityTopic }> {
  return await postJson(ENDPOINTS.communityModerate, { id, action, note })
}

export async function resolveCommunityReport(id: string, action: 'hide' | 'dismiss', note: string): Promise<{ ok: true; report: CommunityReport }> {
  return await postJson(ENDPOINTS.communityReportResolve, { id, action, note })
}

export async function createCommunityAnnouncement(title: string, content: string, related: CommunityTopic['related']): Promise<{ ok: true; topic: CommunityTopic }> {
  return await postJson(ENDPOINTS.communityAnnouncementCreate, { title, content, related })
}
