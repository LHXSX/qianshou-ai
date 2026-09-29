/** Human-owned team retirement coordinates durable membership with in-flight admission. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SubagentError } from './error.ts'
import type { SubagentAddress, SubagentListEntry, SubagentRetirementReceipt } from './control-types.ts'
import type { RetiredSubagent } from './retirement-projection.ts'
import { readRetirements, retiredIds, retirementValues } from './retirement-query.ts'

interface Admission { readonly parentId: SessionId; readonly targetId: SessionId | undefined }
const busy = (agent: Agent | undefined): boolean => agent !== undefined
  && (agent.status === 'running' || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0)

/** Own pending-entry evidence and one synchronous retirement cutoff for the service lifetime. */
export class SubagentRetirementManager {
  private readonly pending = new Set<Admission>()
  private readonly committed = new Map<SessionId, RetiredSubagent>()
  private retirementTail: Promise<unknown> = Promise.resolve()
  private readonly admissionGeneration = new Map<SessionId, number>()
  constructor(private readonly ctx: Context) {
    ctx.on('session/event', (session, event) => {
      if (event.type === 'subagent/retired' && session.isOwnSeq(event.seq)) {
        for (const child of event.data.children) this.committed.set(child.id, child)
      }
    })
    ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.origin === 'subagent' && agent.session.header.parentSession !== undefined) {
        this.bump(agent.session.header.parentSession)
        this.assertActiveNow(agent.session.header.parentSession)
      }
      this.assertActiveNow(agent.id)
    })
  }
  private bump(id: SessionId): void { this.admissionGeneration.set(id, (this.admissionGeneration.get(id) ?? 0) + 1) }
  private assertActiveNow(id: SessionId): void {
    const retired = this.committed.get(id)
    if (retired === undefined) return
    const header = this.ctx.get('sessions')?.get(id)?.header
    if (header === undefined || header.createdAt === retired.createdAt) {
      throw new SubagentError('this employee has been retired; create or choose another employee', 'RETIRED')
    }
  }
  private remember(entries: readonly RetiredSubagent[]): void {
    for (const entry of entries) this.committed.set(entry.id, entry)
  }
  /** Check each ancestor's own membership decision before a retained child may receive work. */
  private assertActive(parent: Agent, targetId: SessionId | undefined, signal?: AbortSignal): void | Promise<void> {
    this.assertActiveNow(parent.id)
    if (targetId !== undefined) this.assertActiveNow(targetId)
    const first = this.ctx.get('sessionProjections')?.snapshot(parent.session, ['subagentRetirements']).values.subagentRetirements
    if (first !== undefined) this.remember(first)
    if (targetId !== undefined) this.assertActiveNow(targetId)
    return this.assertAncestors(parent.session.header, targetId, signal)
  }
  private assertAncestors(initial: SessionHeader, targetId: SessionId | undefined, signal?: AbortSignal,
    seen = new Set<SessionId>()): void | Promise<void> {
    let header = initial
    while (header.origin === 'subagent' && header.parentSession !== undefined && !seen.has(header.id)) {
      seen.add(header.id)
      const ancestor = header.parentSession
      const live = this.ctx.get('sessions')?.get(ancestor)
      const values = live === undefined ? undefined
        : this.ctx.get('sessionProjections')?.snapshot(live, ['subagentRetirements']).values.subagentRetirements
      if (live !== undefined && values !== undefined) {
        this.remember(values)
        this.assertActiveNow(header.id)
        header = live.header
        continue
      }
      const query = this.ctx.get('sessionQuery')
      if (query === undefined) throw new SubagentError('employee lineage is unavailable', 'RETIREMENT_UNAVAILABLE')
      return (async () => {
        using observed = await query.observeSession(ancestor, signal === undefined ? {} : { signal })
        const retired = observed.projections?.values.subagentRetirements
        if (retired === undefined) throw new SubagentError('employee lineage is unavailable', 'RETIREMENT_UNAVAILABLE')
        this.remember(retired)
        this.assertActiveNow(header.id)
        if (targetId !== undefined) this.assertActiveNow(targetId)
        await this.assertAncestors(observed.header, targetId, signal, seen)
      })()
    }
    if (header.origin === 'subagent' && header.parentSession !== undefined) {
      throw new SubagentError('employee lineage contains a cycle', 'RETIREMENT_UNAVAILABLE')
    }
    this.assertActiveNow(initial.id)
    if (targetId !== undefined) this.assertActiveNow(targetId)
  }
  /** Keep admission visible until publication or inbox acceptance; retirement refuses racing work. */
  async admit<T>(parent: Agent, targetId: SessionId | undefined, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const admission = { parentId: parent.id, targetId }
    this.bump(parent.id)
    if (targetId !== undefined) this.bump(targetId)
    this.pending.add(admission)
    try {
      const check = this.assertActive(parent, targetId, signal)
      if (check !== undefined) await check
      signal?.throwIfAborted()
      return await operation()
    } finally { this.pending.delete(admission); this.bump(parent.id); if (targetId !== undefined) this.bump(targetId) }
  }
  /** Read membership exclusions for Host summary and catalog consumers. */
  async excluded(signal?: AbortSignal): Promise<ReadonlySet<SessionId>> {
    const headers = await this.headers(signal)
    const index = await readRetirements(this.ctx, headers, signal)
    this.remember(index.entries)
    return new Set([...retiredIds(headers, index.entries), ...index.unavailable])
  }
  /** Attach one authoritative busy hint to every direct child, including cold queued descendants. */
  async decorate(entries: readonly SubagentListEntry[], signal?: AbortSignal): Promise<readonly SubagentListEntry[]> {
    if (entries.length === 0) return entries
    let headers: readonly SessionHeader[]
    try { headers = await this.headers(signal) }
    catch { signal?.throwIfAborted(); return entries.map(entry => entry.kind === 'child' ? { ...entry, retireBlocked: 'unavailable' } : entry) }
    return Promise.all(entries.map(async (entry) => {
      if (entry.kind !== 'child') return entry
      try {
        const members = this.members(headers, entry.id)
        if (members.length === 0) return { ...entry, retireBlocked: 'unavailable' as const }
        const blocked = await this.busyMembers(members, signal)
        return blocked.length ? { ...entry, retireBlocked: 'busy' as const } : entry
      } catch { signal?.throwIfAborted(); return { ...entry, retireBlocked: 'unavailable' as const } }
    }))
  }
  /** Retire one inactive subtree atomically in its live direct parent's log, then await durability. */
  retire(parent: Agent, address: SubagentAddress, signal: AbortSignal, drain: () => Promise<void>): Promise<SubagentRetirementReceipt> {
    const result = this.retirementTail.then(async () => {
      signal.throwIfAborted()
      if (this.ctx.get('agents')?.get(parent.id) !== parent || parent.id !== address.parentSessionId) throw new SubagentError('retirement requires the live direct parent', 'UNAUTHORIZED')
      const generation = new Map(this.admissionGeneration)
      const headers = await this.headers(signal)
      const members = this.members(headers, address.childSessionId)
      const child = members[0]
      if (child?.origin !== 'subagent' || child.parentSession !== parent.id) throw new SubagentError('child does not belong to this parent', 'UNAUTHORIZED')
      const identity = (await retirementValues(this.ctx, child.id, signal)).subagent
      if (identity?.mode !== address.mode) throw new SubagentError('child identity cannot be verified', 'RETIREMENT_UNAVAILABLE')
      const ownRetirements = (await retirementValues(this.ctx, parent.id, signal)).subagentRetirements ?? []
      const already = ownRetirements.some(entry => entry.id === child.id && entry.createdAt === child.createdAt)
      if (!already) {
        const blocked = await this.busyMembers(members, signal)
        signal.throwIfAborted()
        if (this.ctx.get('agents')?.get(parent.id) !== parent) throw new SubagentError('retirement parent left the registry', 'UNAUTHORIZED')
        // No await separates this complete activity/admission check from the single log commit.
        for (const id of this.liveBusyMembers(members)) if (!blocked.includes(id)) blocked.push(id)
        // A completed admission can add a descendant absent from the corpus snapshot.
        // Refuse this attempt rather than applying an outdated subtree decision.
        const changed = members.some(member => generation.get(member.id) !== this.admissionGeneration.get(member.id))
        if (changed && !blocked.includes(child.id)) blocked.push(child.id)
        if (blocked.length) throw new SubagentBusyError(blocked)
        const children = members.map(header => ({
          id: header.id, createdAt: header.createdAt, parentSessionId: header.parentSession ?? parent.id,
        }))
        parent.session.append('subagent/retired', { version: 1, childId: child.id, children })
        this.remember(children)
      }
      // A failed flush leaves a committed, fail-closed decision; retry flushes it without another event.
      if (!await parent.ctx.sessions.flush(parent.session)) throw new SubagentError('retirement has no durability listener', 'RETIREMENT_UNAVAILABLE')
      await drain()
      const receipt = { accepted: true as const, parentSessionId: parent.id, childSessionIds: members.map(header => header.id) }
      this.ctx.emit('subagents/retired', receipt)
      return receipt
    })
    this.retirementTail = result.catch(() => { /* The caller receives failure; later independent retirements remain possible. */ })
    return result
  }
  private async headers(signal?: AbortSignal): Promise<readonly SessionHeader[]> {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) throw new SubagentError('retirement requires session query', 'RETIREMENT_UNAVAILABLE')
    return (await query.listSessions(signal)).map(record => record.header)
  }
  private members(headers: readonly SessionHeader[], root: SessionId): SessionHeader[] {
    const byParent = new Map<SessionId, SessionHeader[]>()
    for (const header of headers) if (header.origin === 'subagent' && header.parentSession !== undefined) {
      const list = byParent.get(header.parentSession) ?? []
      list.push(header); byParent.set(header.parentSession, list)
    }
    const rootHeader = headers.find(header => header.id === root)
    if (rootHeader === undefined) return []
    const pending = [rootHeader], members: SessionHeader[] = [], seen = new Set<SessionId>()
    for (let header = pending.shift(); header !== undefined; header = pending.shift()) {
      if (seen.has(header.id)) continue
      seen.add(header.id); members.push(header)
      pending.push(...(byParent.get(header.id) ?? []))
    }
    return members
  }
  private liveBusyMembers(members: readonly SessionHeader[]): SessionId[] {
    const ids = new Set(members.map(header => header.id)), blocked = new Set<SessionId>()
    for (const id of ids) {
      const agent = this.ctx.get('agents')?.get(id)
      if (busy(agent)) blocked.add(id)
      if (agent !== undefined && this.ctx.get('jobs')?.list(agent).some(job => job.ownerSession === id
        && (job.status === 'running' || job.status === 'stopping'))) blocked.add(id)
    }
    for (const entry of this.pending) {
      if (ids.has(entry.parentId)) blocked.add(entry.parentId)
      if (entry.targetId !== undefined && ids.has(entry.targetId)) blocked.add(entry.targetId)
    }
    return [...blocked]
  }
  private async busyMembers(members: readonly SessionHeader[], signal?: AbortSignal): Promise<SessionId[]> {
    const blocked = new Set(this.liveBusyMembers(members))
    for (const header of members) {
      const live = this.ctx.get('agents')?.get(header.id)
      if (live !== undefined) { if (busy(live)) blocked.add(header.id); continue }
      const inbox = (await retirementValues(this.ctx, header.id, signal)).inbox
      if (inbox === undefined) throw new SubagentError('pending child input cannot be verified', 'RETIREMENT_UNAVAILABLE')
      if (inbox['next-turn'].length || inbox['next-step'].length) blocked.add(header.id)
    }
    return [...blocked]
  }
}

/** Precise subtree members that blocked a retirement request. */
export class SubagentBusyError extends SubagentError {
  constructor(readonly childSessionIds: readonly SessionId[]) { super('a child is running, queued or being admitted', 'BUSY') }
}
