/** Local knowledge contracts; model access is derived from its actual workspace. */
export type MemoryKind = 'temporary' | 'permanent' | 'knowledge' | 'experience'
export type MemoryStatus = 'active' | 'candidate'
export type MemoryScope = 'personal' | 'workspace'

/** List metadata excludes original documents and credentials. */
export interface MemorySummary {
  id: string
  title: string
  kind: MemoryKind
  scope: MemoryScope
  workspace: string | null
  status: MemoryStatus
  source: string
  evidence: string
  revision: number
  createdAt: number
  updatedAt: number
  expiresAt: number | null
  contentBytes: number
  snippet: string
}

/** Complete user-supplied document, with explicit provenance. */
export interface MemoryEntry extends MemorySummary { content: string }

/** Owner edits use optimistic concurrency; omission of id creates a new record. */
export interface MemoryInput {
  id?: string
  expectedRevision?: number
  title: string
  content: string
  kind: MemoryKind
  scope: MemoryScope
  workspace?: string
  source?: string
  evidence?: string
  expiresInDays?: number
}

/** A model can access personal memories and its actual workspace only. */
export interface MemoryAccess { workspace: string | null }

/** Owner listing filters; model consumers must also supply a separate access fence. */
export interface MemoryQuery {
  query?: string
  kind?: MemoryKind
  status?: MemoryStatus
  workspace?: string
  offset?: number
  limit?: number
}

/** Bounded search/list result with unfiltered owner counts. */
export interface MemoryPage {
  items: MemorySummary[]
  total: number
  stats: Record<MemoryKind | 'candidates', number>
  storage: 'sqlite'
  search: 'keyword'
}
