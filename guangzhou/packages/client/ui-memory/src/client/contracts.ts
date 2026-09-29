/** Human-managed memory layers supported by the local Host. */
export type MemoryKind = 'temporary' | 'permanent' | 'knowledge' | 'experience'
/** Searchable metadata returned by the authenticated memory directory. */
export interface MemorySummary {
  id: string
  title: string
  kind: MemoryKind
  scope: 'personal' | 'workspace'
  workspace: string | null
  status: 'active' | 'candidate'
  source: string
  evidence: string
  revision: number
  createdAt: number
  updatedAt: number
  expiresAt: number | null
  contentBytes: number
  snippet: string
}
/** Exact stored source text, including historical revisions. */
export interface MemoryEntry extends MemorySummary { content: string }
/** Editable values; existing entries require their last-read revision. */
export interface MemoryDraft {
  id?: string
  expectedRevision?: number
  title: string
  content: string
  kind: MemoryKind
  scope: 'personal' | 'workspace'
  workspace?: string
  source?: string
  evidence?: string
  expiresInDays?: number
}
/** Explicit directory filters, with a fixed page size of 50. */
export interface MemoryFilters { query: string; kind: MemoryKind | ''; status: 'active' | 'candidate'; workspace: string; offset: number }
/** Counts include all unexpired records owned by this local account. */
export interface MemoryStats { temporary: number; permanent: number; knowledge: number; experience: number; candidates: number }
/** Host directory response, without inventing an embedding or learning state. */
export interface MemoryDirectory { items: MemorySummary[]; total: number; stats: MemoryStats; storage: 'sqlite'; search: 'keyword' }
