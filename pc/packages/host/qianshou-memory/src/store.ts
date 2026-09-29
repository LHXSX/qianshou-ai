/** SQLite owner: mutations, history, search index and receipts commit in one transaction. */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite'
import { openMemoryDatabase } from './database.ts'
import { excerpt, splitDocument, searchExpression, words } from './search.ts'
import { MemoryFailure } from './validation.ts'
import type { MemoryAccess, MemoryDetail, MemoryEntry, MemoryExportPage, MemoryExportQuery, MemoryHistoryPage, MemoryId, MemoryInput, MemoryOrigin, MemoryPage, MemoryQuery, MemoryState, MemorySummary } from './types.ts'

type Row = Record<string, SQLOutputValue>
const SUMMARY = 'e.id,e.title,e.kind,e.scope,e.workspace_id,e.workspace_path,e.status,e.source,e.evidence,e.source_session,e.source_call,e.revision,e.created_at,e.updated_at,e.expires_at,e.content_bytes'
function entry(row: Row): MemoryEntry {
  return {
    id: String(row.id) as MemoryId, title: String(row.title), content: String(row.content ?? ''),
    kind: row.kind as MemoryEntry['kind'], scope: row.scope as MemoryEntry['scope'],
    workspaceId: row.workspace_id as MemoryEntry['workspaceId'], workspacePath: row.workspace_path as string | null,
    status: row.status as MemoryEntry['status'], source: String(row.source), evidence: String(row.evidence),
    origin: row.source_session === null ? null : { sessionId: row.source_session as MemoryOrigin['sessionId'], callId: row.source_call as MemoryOrigin['callId'] },
    revision: Number(row.revision), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at), contentBytes: Number(row.content_bytes),
    snippet: Array.from(String(row.snippet ?? row.content ?? '')).slice(0, 500).join(''),
  }
}
function summary(row: Row): MemorySummary { const { content: _, ...result } = entry(row); return result }
function retainedText(value: Pick<MemoryInput, 'title' | 'content' | 'source' | 'evidence'>): number {
  return Buffer.byteLength(value.title) + Buffer.byteLength(value.content)
    + Buffer.byteLength(value.source ?? '') + Buffer.byteLength(value.evidence ?? '')
}
function visible(row: MemoryEntry, access: MemoryAccess): boolean {
  return row.status === 'active' && (row.scope === 'device' || (access.workspaceId !== null && row.workspaceId === access.workspaceId))
}

/** One local profile vault, independent of cloud login and Session retention. */
export class MemoryStore {
  private closed = false
  private constructor(private readonly db: DatabaseSync, private readonly capacityBytes: number, private readonly now: () => number) {}
  /**
   * Open a dedicated new-format vault.
   * @param path - Database path.
   * @param capacityBytes - Maximum retained text and serialized revisions.
   * @param now - Clock.
   * @returns Owned store.
   */
  static async open(path: string, capacityBytes: number, now: () => number = Date.now): Promise<MemoryStore> {
    return new MemoryStore(await openMemoryDatabase(path), capacityBytes, now)
  }
  /** Close synchronously after current synchronous transactions finish. */
  close(): void { if (!this.closed) { this.closed = true; this.db.close() } }
  private transaction<T>(run: () => T): T {
    if (this.closed) throw new MemoryFailure('closed')
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = run(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private audit(id: MemoryId, action: string, actor: string, revision: number): void {
    this.db.prepare('INSERT INTO receipts(entry_id,action,actor,time,revision) VALUES (?,?,?,?,?)').run(id, action, actor, this.now(), revision)
    this.db.exec('UPDATE meta SET revision=revision+1 WHERE id=1')
  }
  private remove(value: MemoryEntry, action: string, actor: string): void {
    this.db.prepare('DELETE FROM chunk_search WHERE rowid IN (SELECT id FROM chunks WHERE entry_id=?)').run(value.id)
    this.db.prepare('DELETE FROM entries WHERE id=?').run(value.id)
    this.audit(value.id, action, actor, value.revision)
  }
  /** Delete expired content, history and index while preserving content-free receipts. */
  expire(): void {
    this.transaction(() => {
      for (const row of this.db.prepare('SELECT * FROM entries WHERE expires_at IS NOT NULL AND expires_at<=?').all(this.now())) this.remove(entry(row), 'expired', 'system')
    })
  }
  private current(id: MemoryId): MemoryEntry {
    const row = this.db.prepare('SELECT * FROM entries WHERE id=?').get(id)
    if (!row) throw new MemoryFailure('not-found')
    return entry(row)
  }
  /**
   * Read the vault identity after expiry.
   * @returns Metadata without user documents.
   */
  identity(): Omit<MemoryState, 'workspaces'> {
    this.expire()
    const row = this.db.prepare('SELECT vault_id,revision FROM meta WHERE id=1').get()
    if (!row) throw new MemoryFailure('storage-failed')
    return { format: 'qianshou-device-memory-v1', ownerKind: 'local-device-profile', vaultId: String(row.vault_id), revision: Number(row.revision) }
  }
  /**
   * Read one original and owner history; Agent reads apply scope and omit versions.
   * @param id - Identifier.
   * @param access - Actual Session access, omitted only for owner operations.
   * @returns Original and allowed history.
   */
  read(id: MemoryId, access?: MemoryAccess): MemoryDetail {
    this.expire()
    const value = this.current(id)
    if (access && !visible(value, access)) throw new MemoryFailure('not-found')
    const history = access ? { revisions: [], total: 0, nextOffset: null } : this.historyPage(id, value.revision, 0)
    return { entry: value, revisions: history.revisions, revisionCount: history.total, nextRevisionOffset: history.nextOffset }
  }
  /**
   * Read at most two historical originals under a current revision fence.
   * @param id - Entry id.
   * @param revision - Current revision.
   * @param offset - Version page offset.
   * @returns Bounded history.
   */
  historyPage(id: MemoryId, revision: number, offset: number): MemoryHistoryPage {
    this.expire()
    const value = this.current(id)
    if (value.revision !== revision) throw new MemoryFailure('conflict')
    const total = Number(this.db.prepare('SELECT count(*) AS count FROM revisions WHERE entry_id=?').get(id)?.count)
    const revisions = this.db.prepare('SELECT snapshot FROM revisions WHERE entry_id=? ORDER BY revision DESC LIMIT 2 OFFSET ?').all(id, offset).map(row => JSON.parse(String(row.snapshot)) as MemoryEntry)
    return { revisions, total, nextOffset: offset + revisions.length < total ? offset + revisions.length : null }
  }
  private capacity(delta: number): void {
    const retained = Number(this.db.prepare('SELECT COALESCE(SUM(length(CAST(title AS BLOB))+length(CAST(content AS BLOB))+length(CAST(source AS BLOB))+length(CAST(evidence AS BLOB))),0) AS bytes FROM entries').get()?.bytes)
    const history = Number(this.db.prepare('SELECT COALESCE(SUM(length(CAST(snapshot AS BLOB))),0) AS bytes FROM revisions').get()?.bytes)
    if (retained + history + delta > this.capacityBytes) throw new MemoryFailure('capacity')
  }
  private history(value: MemoryEntry): void {
    this.db.prepare('INSERT INTO revisions(entry_id,revision,snapshot) VALUES (?,?,?)').run(value.id, value.revision, JSON.stringify(value))
  }
  private index(value: MemoryEntry): void {
    this.db.prepare('DELETE FROM chunk_search WHERE rowid IN (SELECT id FROM chunks WHERE entry_id=?)').run(value.id)
    this.db.prepare('DELETE FROM chunks WHERE entry_id=?').run(value.id)
    for (const [ordinal, content] of splitDocument(value.content).entries()) {
      const row = this.db.prepare('INSERT INTO chunks(entry_id,ordinal,content) VALUES (?,?,?)').run(value.id, ordinal, content)
      this.db.prepare('INSERT INTO chunk_search(rowid,tokens) VALUES (?,?)').run(row.lastInsertRowid, words(`${value.title}\n${content}`).join(' '))
    }
  }
  private write(draft: MemoryInput, workspacePath: string | null, origin: MemoryOrigin | null): MemoryEntry {
    const previous = draft.id ? this.current(draft.id) : undefined
    if (previous && previous.revision !== draft.expectedRevision) throw new MemoryFailure('conflict')
    if (previous?.status === 'candidate') throw new MemoryFailure('candidate-readonly')
    const bytes = Buffer.byteLength(draft.content)
    this.capacity(retainedText(draft) - (previous ? retainedText(previous) : 0)
      + (previous ? Buffer.byteLength(JSON.stringify(previous)) : 0))
    const id = previous?.id ?? randomUUID() as MemoryId
    const revision = (previous?.revision ?? 0) + 1
    if (previous) this.history(previous)
    const time = this.now()
    this.db.prepare(`INSERT INTO entries(id,title,content,kind,scope,workspace_id,workspace_path,status,source,evidence,source_session,source_call,revision,created_at,updated_at,expires_at,content_bytes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=excluded.content,kind=excluded.kind,scope=excluded.scope,
      workspace_id=excluded.workspace_id,workspace_path=excluded.workspace_path,source=excluded.source,evidence=excluded.evidence,
      revision=excluded.revision,updated_at=excluded.updated_at,expires_at=excluded.expires_at,content_bytes=excluded.content_bytes`).run(
      id, draft.title, draft.content, draft.kind, draft.scope, draft.workspaceId ?? null, workspacePath, origin ? 'candidate' : 'active',
      draft.source ?? '', draft.evidence ?? '', origin?.sessionId ?? null, origin?.callId ?? null,
      revision, previous?.createdAt ?? time, time, draft.kind === 'temporary' ? time + (draft.expiresInDays ?? 7) * 86400000 : null, bytes,
    )
    const result = this.current(id)
    this.index(result)
    this.audit(id, previous ? 'edited' : origin ? 'proposed' : 'created', origin ? 'agent' : 'owner', revision)
    return result
  }
  /**
   * Save a validated owner draft against a current destination.
   * @param draft - Parsed draft.
   * @param workspacePath - Registry path snapshot.
   * @returns Committed entry.
   */
  save(draft: MemoryInput, workspacePath: string | null): MemoryEntry {
    if (draft.kind === 'experience' && !draft.evidence?.trim()) throw new MemoryFailure('evidence-required')
    this.expire()
    return this.transaction(() => this.write(draft, workspacePath, null))
  }
  /**
   * Create exactly one candidate per actual Session/tool call; deleted proposals cannot resurrect.
   * @param draft - Validated candidate content.
   * @param access - Current registered workspace.
   * @param origin - Actual tool identity.
   * @returns Existing or newly committed candidate.
   */
  propose(draft: Pick<MemoryInput, 'title' | 'content' | 'evidence'>, access: MemoryAccess, origin: MemoryOrigin): MemoryEntry {
    const workspaceId = access.workspaceId
    if (!workspaceId || !access.workspacePath) throw new MemoryFailure('workspace-required')
    if (!draft.evidence?.trim()) throw new MemoryFailure('evidence-required')
    this.expire()
    return this.transaction(() => {
      const old = this.db.prepare('SELECT entry_id FROM proposals WHERE session_id=? AND call_id=?').get(origin.sessionId, origin.callId)
      if (old) {
        try { return this.current(String(old.entry_id) as MemoryId) }
        catch (error) { if (error instanceof MemoryFailure && error.code === 'not-found') throw new MemoryFailure('proposal-removed'); throw error }
      }
      const result = this.write({ ...draft, kind: 'experience', scope: 'workspace', workspaceId, source: `session:${origin.sessionId}` }, access.workspacePath, origin)
      this.db.prepare('INSERT INTO proposals VALUES (?,?,?)').run(origin.sessionId, origin.callId, result.id)
      return result
    })
  }
  /**
   * Accept or erase an unchanged candidate.
   * @param id - Candidate id.
   * @param revision - Expected version.
   * @param action - Human decision.
   * @returns Accepted entry or deletion receipt.
   */
  review(id: MemoryId, revision: number, action: 'accept' | 'reject'): MemoryEntry | { deleted: true } {
    this.expire()
    const result = this.transaction(() => {
      const value = this.current(id)
      if (value.revision !== revision) throw new MemoryFailure('conflict')
      if (value.status !== 'candidate') throw new MemoryFailure('candidate-readonly')
      if (action === 'reject') { this.remove(value, 'rejected', 'owner'); return { deleted: true as const } }
      this.capacity(Buffer.byteLength(JSON.stringify(value)))
      this.history(value)
      this.db.prepare("UPDATE entries SET status='active',revision=revision+1,updated_at=? WHERE id=?").run(this.now(), id)
      this.audit(id, 'accepted', 'owner', revision + 1)
      return this.current(id)
    })
    if (action === 'reject') this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return result
  }
  /**
   * Erase current text, every version and FTS rows. Session logs and external backups are unaffected.
   * @param id - Record id.
   * @param revision - Expected version.
   * @returns Deletion receipt.
   */
  delete(id: MemoryId, revision: number): { deleted: true } {
    this.expire()
    this.transaction(() => {
      const value = this.current(id)
      if (value.revision !== revision) throw new MemoryFailure('conflict')
      this.remove(value, 'deleted', 'owner')
    })
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return { deleted: true }
  }
  /**
   * Search original text with access-filtered counts and bounded passages.
   * @param query - Parsed owner filters or bounded Agent query.
   * @param access - Session-derived access when called by tools.
   * @returns Matching summaries.
   */
  list(query: MemoryQuery, access?: MemoryAccess): MemoryPage {
    this.expire()
    const where: string[] = []; const args: SQLInputValue[] = []
    if (access) { where.push("e.status='active' AND (e.scope='device' OR e.workspace_id=?)"); args.push(access.workspaceId) }
    if (query.kind) { where.push('e.kind=?'); args.push(query.kind) }
    if (query.status) { where.push('e.status=?'); args.push(query.status) }
    if (query.scope) { where.push('e.scope=?'); args.push(query.scope) }
    if (query.workspaceId) { where.push('e.workspace_id=?'); args.push(query.workspaceId) }
    const needle = query.query ?? ''; const expression = searchExpression(needle)
    if (needle && !expression) return { items: [], total: 0, stats: this.stats(access) }
    if (expression) { where.push('e.id IN (SELECT c.entry_id FROM chunk_search JOIN chunks c ON c.id=chunk_search.rowid WHERE chunk_search MATCH ?)'); args.push(expression) }
    const filter = where.length ? ` WHERE ${where.join(' AND ')}` : ''
    const total = Number(this.db.prepare(`SELECT count(*) AS count FROM entries e${filter}`).get(...args)?.count)
    const rows = this.db.prepare(`SELECT ${SUMMARY},substr(e.content,1,600) AS snippet FROM entries e${filter} ORDER BY e.updated_at DESC,e.id LIMIT ? OFFSET ?`).all(...args, query.limit ?? 50, query.offset ?? 0)
    if (expression) {
      const passage = this.db.prepare('SELECT c.content FROM chunk_search JOIN chunks c ON c.id=chunk_search.rowid WHERE chunk_search MATCH ? AND c.entry_id=? ORDER BY bm25(chunk_search),c.ordinal LIMIT 1')
      for (const row of rows) row.snippet = excerpt(String(passage.get(expression, String(row.id))?.content ?? row.snippet ?? ''), needle)
    }
    return { items: rows.map(summary), total, stats: this.stats(access) }
  }
  private stats(access?: MemoryAccess): MemoryPage['stats'] {
    const counts: MemoryPage['stats'] = { temporary: 0, permanent: 0, knowledge: 0, experience: 0, candidates: 0 }
    const where = access ? " WHERE status='active' AND (scope='device' OR workspace_id=?)" : ''
    for (const row of this.db.prepare(`SELECT kind,status,count(*) AS count FROM entries${where} GROUP BY kind,status`).all(...access ? [access.workspaceId] : [])) {
      counts[row.kind as keyof typeof counts] += Number(row.count)
      if (row.status === 'candidate') counts.candidates += Number(row.count)
    }
    return counts
  }
  /**
   * Export bounded pages from one unchanged revision; mutation or expiry invalidates later pages.
   * @param query - Cursor from the previous page.
   * @returns Metadata, data page and next cursor.
   */
  exportPage(query: MemoryExportQuery): MemoryExportPage {
    const identity = this.identity()
    if (query.revision !== undefined && query.revision !== identity.revision) throw new MemoryFailure('export-changed')
    if ((query.offset || query.stage && query.stage !== 'entries') && query.revision === undefined) throw new MemoryFailure('invalid-request')
    const stage = query.stage ?? 'entries'; const offset = query.offset ?? 0
    const limit = stage === 'receipts' ? 100 : 2
    const table = stage === 'entries' ? 'entries' : stage === 'revisions' ? 'revisions' : 'receipts'
    const order = stage === 'entries' ? 'id' : stage === 'revisions' ? 'entry_id,revision' : 'seq'
    const rows = this.db.prepare(`SELECT * FROM ${table} ORDER BY ${order} LIMIT ? OFFSET ?`).all(limit + 1, offset)
    const page = rows.slice(0, limit)
    const receipts = page.map(row => ({ seq: Number(row.seq),
      entryId: row.entry_id as MemoryId,
      action: String(row.action),
      actor: String(row.actor),
      time: Number(row.time),
      revision: Number(row.revision) }))
    return {
      ...identity, entries: stage === 'entries' ? page.map(entry) : [],
      revisions: stage === 'revisions' ? page.map(row => JSON.parse(String(row.snapshot)) as MemoryEntry) : [],
      receipts: stage === 'receipts' ? receipts : [],
      next: rows.length > limit ? { stage, offset: offset + limit } : stage === 'entries' ? { stage: 'revisions', offset: 0 } : stage === 'revisions' ? { stage: 'receipts', offset: 0 } : null,
    }
  }
}
