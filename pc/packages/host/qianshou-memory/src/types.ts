/** Device-owner knowledge DTOs
  cloud accounts never determine ownership. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

/** Opaque identifier inside one device vault. */
export type MemoryId = string & Branded<'QianshouMemoryId'>
/** User-selected content category. */
export type MemoryKind = 'temporary' | 'permanent' | 'knowledge' | 'experience'
/** Candidates remain invisible to all Agent retrieval. */
export type MemoryStatus = 'active' | 'candidate'
/** Device entries are shared by authorized local Sessions
  workspace entries are registry-id bound. */
export type MemoryScope = 'device' | 'workspace'
/** Immutable attribution for an Agent proposal, supplied by the Tool runtime. */
export interface MemoryOrigin { sessionId: SessionId
  callId: ToolCallId }
/** List metadata and a bounded original passage. */
export interface MemorySummary {
  id: MemoryId
  title: string
  kind: MemoryKind
  scope: MemoryScope
  workspaceId: WorkspaceId | null
  workspacePath: string | null
  status: MemoryStatus
  source: string
  evidence: string
  origin: MemoryOrigin | null
  revision: number
  createdAt: number
  updatedAt: number
  expiresAt: number | null
  contentBytes: number
  snippet: string
}
/** Owner-supplied original text, never interpreted as instructions. */
export interface MemoryEntry extends MemorySummary { content: string }
/** Owner input
  an existing id requires an optimistic revision fence. */
export interface MemoryInput {
  id?: MemoryId
  expectedRevision?: number
  title: string
  content: string
  kind: MemoryKind
  scope: MemoryScope
  workspaceId?: WorkspaceId
  source?: string
  evidence?: string
  expiresInDays?: number
}
/** Owner filters
  consumers supply Agent access independently. */
export interface MemoryQuery {
  query?: string
  kind?: MemoryKind
  status?: MemoryStatus
  scope?: MemoryScope
  workspaceId?: WorkspaceId
  offset?: number
  limit?: number
}
/** Confirmed and candidate counters are owner-only unless access-filtered. */
export interface MemoryPage {
  items: MemorySummary[]
  total: number
  stats: Record<MemoryKind | 'candidates', number>
}
/** Historical owner view
  Agent reads omit all revisions. */
export interface MemoryDetail { entry: MemoryEntry
  revisions: MemoryEntry[]
  revisionCount: number
  nextRevisionOffset: number | null }
/** Bounded owner history, tied to an unchanged current revision. */
export interface MemoryHistoryPage { revisions: MemoryEntry[]
  total: number
  nextOffset: number | null }
/** Actual Session-derived, current registry identity. */
export interface MemoryAccess { workspaceId: WorkspaceId | null
  workspacePath: string | null }
/** Available owner destinations and vault identity
  no cloud identity fields. */
export interface MemoryState {
  format: 'qianshou-device-memory-v1'
  ownerKind: 'local-device-profile'
  vaultId: string
  revision: number
  workspaces: Array<{ id: WorkspaceId
    path: string
    title: string }>
}
/** Optimistic revision check shared by destructive owner requests. */
export interface MemoryRevision { id: MemoryId
  expectedRevision: number }
/** Explicit human decision on one unchanged candidate. */
export interface MemoryReview extends MemoryRevision { action: 'accept' | 'reject' }
/** Content-free receipt retained after hard deletion. */
export interface MemoryReceipt { seq: number
  entryId: MemoryId
  action: string
  actor: string
  time: number
  revision: number }
/** One bounded export page
  the same revision must cover every page. */
export interface MemoryExportPage {
  format: 'qianshou-device-memory-v1'
  ownerKind: 'local-device-profile'
  vaultId: string
  revision: number
  entries: MemoryEntry[]
  revisions: MemoryEntry[]
  receipts: MemoryReceipt[]
  next: { stage: 'entries' | 'revisions' | 'receipts'
    offset: number } | null
}
/** Export cursor
  a changed vault rejects an in-progress export instead of mixing snapshots. */
export interface MemoryExportQuery { revision?: number
  stage?: 'entries' | 'revisions' | 'receipts'
  offset?: number }
/** Stable safe error identifiers: backend exceptions never include documents in RPC failures. */
export type MemoryFailureCode = 'invalid-request' | 'not-found' | 'conflict' | 'workspace-required' | 'candidate-readonly' | 'evidence-required' | 'capacity' | 'closed' | 'storage-failed' | 'export-changed' | 'proposal-removed'
