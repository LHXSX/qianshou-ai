/** Authoritative local memory lifecycle; every content mutation and index update is atomic. */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { openMemoryDatabase } from './database.ts'
import { excerpt, splitDocument, searchExpression, words } from './search.ts'
import { input, MemoryError, MEMORY_KINDS, status, text, workspaceKey } from './validation.ts'
import type { MemoryAccess, MemoryEntry, MemoryPage, MemoryQuery, MemoryStatus, MemorySummary } from './types.ts'

type Row = Record<string, unknown>
const SUMMARY = 'e.id,e.title,e.kind,e.scope,e.workspace,e.status,e.source,e.evidence,e.revision,e.created_at,e.updated_at,e.expires_at,e.content_bytes'
const MAX_VAULT_BYTES = 128 * 1024 * 1024

function entry(row: Row): MemoryEntry {
  return {
    id: String(row.id), title: String(row.title), content: String(row.content ?? ''),
    kind: row.kind as MemoryEntry['kind'], scope: row.scope as MemoryEntry['scope'], workspace: row.workspace === null ? null : String(row.workspace),
    status: row.status as MemoryStatus, source: String(row.source), evidence: String(row.evidence),
    revision: Number(row.revision), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at), contentBytes: Number(row.content_bytes),
    snippet: String(row.snippet ?? row.content ?? '').slice(0, 600),
  }
}
function summary(row: Row): MemorySummary { const { content: _, ...result } = entry(row); return result }

/** One durable vault, separate from credentials and disposable session-search indexes. */
export class MemoryStore {
  private closed = false
  private constructor(private readonly db: DatabaseSync, private readonly now: () => number) {}

  /** Open or validate the local SQLite vault; no remote service is contacted. */
  static async open(path: string, now: () => number = Date.now): Promise<MemoryStore> {
    return new MemoryStore(await openMemoryDatabase(path), now)
  }

  /** Close the owned SQLite handle; repeated disposal is harmless. */
  close(): void { if (!this.closed) { this.closed = true; this.db.close() } }

  private transaction<T>(run: () => T): T {
    if (this.closed) throw new MemoryError('MEMORY_CLOSED', 503)
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = run(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private audit(id: string, action: string, actor: string, revision: number): void {
    this.db.prepare('INSERT INTO events(entry_id,action,actor,time,revision) VALUES (?,?,?,?,?)').run(id, action, actor, this.now(), revision)
  }

  private remove(id: string, action: string, actor: string, revision: number): void {
    this.db.prepare('DELETE FROM chunk_search WHERE rowid IN (SELECT id FROM chunks WHERE entry_id=?)').run(id)
    this.db.prepare('DELETE FROM entries WHERE id=?').run(id)
    this.audit(id, action, actor, revision)
  }

  /** Physically remove expired content, revisions and index rows; retain content-free audit receipts. */
  expire(): void {
    this.transaction(() => {
      const rows = this.db.prepare('SELECT id,revision FROM entries WHERE expires_at IS NOT NULL AND expires_at<=?').all(this.now())
      for (const row of rows) this.remove(String(row.id), 'expired', 'system', Number(row.revision))
    })
  }

  private visible(row: MemoryEntry, access: MemoryAccess): boolean {
    return row.status === 'active' && (row.scope === 'personal' || (access.workspace !== null && row.workspace === workspaceKey(access.workspace)))
  }

  private current(id: string): MemoryEntry {
    const row = this.db.prepare('SELECT * FROM entries WHERE id=?').get(text(id, 80))
    if (!row) throw new MemoryError('MEMORY_NOT_FOUND', 404)
    return entry(row)
  }

  /** Read original content and historical versions; scoped model readers never see candidates or other workspaces. */
  read(id: string, access?: MemoryAccess): { entry: MemoryEntry; revisions: MemoryEntry[] } {
    this.expire()
    const result = this.current(id)
    if (access && !this.visible(result, access)) throw new MemoryError('MEMORY_NOT_FOUND', 404)
    const revisions = access ? [] : this.db.prepare('SELECT snapshot FROM revisions WHERE entry_id=? ORDER BY revision DESC').all(id).map(row => JSON.parse(String(row.snapshot)) as MemoryEntry)
    return { entry: result, revisions }
  }

  /** Owner saves are active; tools may create only temporary work notes or unconfirmed experience candidates. */
  save(value: unknown, actor: 'owner' | 'agent' = 'owner', access?: MemoryAccess): MemoryEntry {
    const draft = input(value)
    if (actor === 'agent' && (draft.id !== undefined || !access || draft.scope !== 'workspace'
      || access.workspace === null || draft.workspace !== workspaceKey(access.workspace)
      || (draft.kind !== 'temporary' && draft.kind !== 'experience'))) throw new MemoryError('MEMORY_WRITE_DENIED', 403)
    if (draft.kind === 'experience' && !draft.evidence?.trim()) throw new MemoryError('MEMORY_EVIDENCE_REQUIRED')
    this.expire()
    return this.transaction(() => {
      const previous = draft.id ? this.current(draft.id) : undefined
      if (previous && previous.revision !== draft.expectedRevision) throw new MemoryError('MEMORY_REVISION_CONFLICT', 409)
      const retained = Number(this.db.prepare('SELECT COALESCE(SUM(content_bytes),0) AS bytes FROM entries').get()?.bytes)
      const history = Number(this.db.prepare('SELECT COALESCE(SUM(length(CAST(snapshot AS BLOB))),0) AS bytes FROM revisions').get()?.bytes)
      const bytes = Buffer.byteLength(draft.content)
      if (retained + history + bytes > MAX_VAULT_BYTES) throw new MemoryError('MEMORY_CAPACITY_REACHED', 413)
      const id = previous?.id ?? randomUUID()
      const revision = (previous?.revision ?? 0) + 1
      const now = this.now()
      const active: MemoryStatus = actor === 'agent' && draft.kind === 'experience' ? 'candidate' : (previous?.status ?? 'active')
      if (previous) this.db.prepare('INSERT INTO revisions(entry_id,revision,snapshot) VALUES (?,?,?)').run(id, previous.revision, JSON.stringify(previous))
      this.db.prepare(`INSERT INTO entries(id,title,content,kind,scope,workspace,status,source,evidence,revision,created_at,updated_at,expires_at,content_bytes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=excluded.content,kind=excluded.kind,
        scope=excluded.scope,workspace=excluded.workspace,status=excluded.status,source=excluded.source,evidence=excluded.evidence,
        revision=excluded.revision,updated_at=excluded.updated_at,expires_at=excluded.expires_at,content_bytes=excluded.content_bytes`).run(
        id, draft.title, draft.content, draft.kind, draft.scope, draft.workspace ?? null, active,
        draft.source ?? '', draft.evidence ?? '', revision, previous?.createdAt ?? now, now,
        draft.kind === 'temporary' ? now + (draft.expiresInDays ?? 7) * 86400000 : null, bytes,
      )
      this.db.prepare('DELETE FROM chunk_search WHERE rowid IN (SELECT id FROM chunks WHERE entry_id=?)').run(id)
      this.db.prepare('DELETE FROM chunks WHERE entry_id=?').run(id)
      for (const [ordinal, content] of splitDocument(draft.content).entries()) {
        const inserted = this.db.prepare('INSERT INTO chunks(entry_id,ordinal,content) VALUES (?,?,?)').run(id, ordinal, content)
        this.db.prepare('INSERT INTO chunk_search(rowid,tokens) VALUES (?,?)').run(inserted.lastInsertRowid, words(`${draft.title}\n${content}`).join(' '))
      }
      this.audit(id, previous ? 'edited' : active === 'candidate' ? 'proposed' : 'created', actor, revision)
      return this.current(id)
    })
  }

  /** Confirm a candidate, or erase a rejected one. Only authenticated owner routes expose this method. */
  review(id: string, expectedRevision: number, action: 'accept' | 'reject'): MemoryEntry | { deleted: true } {
    this.expire()
    return this.transaction(() => {
      const value = this.current(id)
      if (value.revision !== expectedRevision) throw new MemoryError('MEMORY_REVISION_CONFLICT', 409)
      if (value.status !== 'candidate') throw new MemoryError('MEMORY_NOT_CANDIDATE', 409)
      if (action === 'reject') { this.remove(id, 'rejected', 'owner', expectedRevision); return { deleted: true } }
      if (action !== 'accept') throw new MemoryError('INVALID_MEMORY_REVIEW')
      this.db.prepare('INSERT INTO revisions(entry_id,revision,snapshot) VALUES (?,?,?)').run(id, value.revision, JSON.stringify(value))
      this.db.prepare("UPDATE entries SET status='active',revision=revision+1,updated_at=? WHERE id=?").run(this.now(), id)
      this.audit(id, 'accepted', 'owner', value.revision + 1)
      return this.current(id)
    })
  }

  /** Erase original content, prior versions and index entries with a revision fence. */
  delete(id: string, expectedRevision: number): { deleted: true } {
    this.expire()
    this.transaction(() => {
      const value = this.current(id)
      if (value.revision !== expectedRevision) throw new MemoryError('MEMORY_REVISION_CONFLICT', 409)
      this.remove(id, 'deleted', 'owner', value.revision)
    })
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return { deleted: true }
  }

  /** Search active scoped knowledge for agents, or browse filtered owner records; bounds include metadata. */
  list(query: MemoryQuery = {}, access?: MemoryAccess): MemoryPage {
    this.expire()
    const where: string[] = []
    const args: SQLInputValue[] = []
    if (query.kind) {
      if (!MEMORY_KINDS.includes(query.kind)) throw new MemoryError('INVALID_MEMORY_KIND')
      where.push('e.kind=?'); args.push(query.kind)
    }
    if (access) {
      where.push("e.status='active' AND (e.scope='personal' OR e.workspace=?)")
      args.push(access.workspace === null ? null : workspaceKey(access.workspace))
    } else if (query.status) { where.push('e.status=?'); args.push(status(query.status)) }
    if (query.workspace) { where.push('e.workspace=?'); args.push(workspaceKey(query.workspace)) }
    const limit = query.limit ?? 50
    const offset = query.offset ?? 0
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new MemoryError('INVALID_MEMORY_PAGE')
    const needle = query.query ? text(query.query, 500) : ''
    const expression = searchExpression(needle)
    if (needle && !expression) return { items: [], total: 0, stats: this.stats(access), storage: 'sqlite', search: 'keyword' }
    const matching = expression ? 'e.id IN (SELECT c.entry_id FROM chunk_search JOIN chunks c ON c.id=chunk_search.rowid WHERE chunk_search MATCH ?)' : ''
    if (matching) { where.push(matching); args.push(expression) }
    const filter = where.length ? ` WHERE ${where.join(' AND ')}` : ''
    const total = Number(this.db.prepare(`SELECT count(*) AS count FROM entries e${filter}`).get(...args)?.count)
    const rows = this.db.prepare(`SELECT ${SUMMARY},substr(e.content,1,600) AS snippet FROM entries e${filter} ORDER BY e.updated_at DESC,e.id LIMIT ? OFFSET ?`).all(...args, limit, offset)
    if (expression) {
      const snippetQuery = this.db.prepare('SELECT c.content FROM chunk_search JOIN chunks c ON c.id=chunk_search.rowid WHERE chunk_search MATCH ? AND c.entry_id=? ORDER BY bm25(chunk_search),c.ordinal LIMIT 1')
      for (const row of rows) row.snippet = excerpt(String(snippetQuery.get(expression, row.id as string)?.content ?? row.snippet ?? ''), needle)
    }
    return { items: rows.map(summary), total, stats: this.stats(access), storage: 'sqlite', search: 'keyword' }
  }

  private stats(access?: MemoryAccess): MemoryPage['stats'] {
    const counts: MemoryPage['stats'] = { temporary: 0, permanent: 0, knowledge: 0, experience: 0, candidates: 0 }
    const where = access ? " WHERE status='active' AND (scope='personal' OR workspace=?)" : ''
    const rows = this.db.prepare(`SELECT kind,status,count(*) AS count FROM entries${where} GROUP BY kind,status`).all(...access ? [access.workspace === null ? null : workspaceKey(access.workspace)] : [])
    for (const row of rows) {
      counts[row.kind as keyof typeof counts] += Number(row.count)
      if (row.status === 'candidate') counts.candidates += Number(row.count)
    }
    return counts
  }

  /** Export original records, retained revisions and content-free learning receipts for local backups. */
  export(): { format: 'qianshou-memory-v1'; exportedAt: number; entries: MemoryEntry[]; revisions: MemoryEntry[]; events: Row[] } {
    this.expire()
    return {
      format: 'qianshou-memory-v1', exportedAt: this.now(),
      entries: this.db.prepare('SELECT * FROM entries ORDER BY created_at,id').all().map(entry),
      revisions: this.db.prepare('SELECT snapshot FROM revisions ORDER BY entry_id,revision').all().map(row => JSON.parse(String(row.snapshot)) as MemoryEntry),
      events: this.db.prepare('SELECT * FROM events ORDER BY seq').all(),
    }
  }
}
