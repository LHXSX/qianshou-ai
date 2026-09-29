/** Bounded durable membership reads shared by discovery, admission and human retirement. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection'
import type { RetiredSubagent } from './retirement-projection.ts'
import { SubagentError } from './error.ts'

/** Read authoritative projection values from a resident Session or a shared cold observation. */
export async function retirementValues(ctx: Context, id: SessionId, signal?: AbortSignal): Promise<Partial<SessionProjectionMap>> {
  signal?.throwIfAborted()
  const live = ctx.get('sessions')?.get(id)
  const projections = ctx.get('sessionProjections')
  if (live !== undefined && projections !== undefined) return projections.snapshot(live).values
  const query = ctx.get('sessionQuery')
  if (query === undefined) throw new SubagentError('retirement requires session query', 'RETIREMENT_UNAVAILABLE')
  using observation = await query.observeSession(id, signal === undefined ? {} : { signal })
  signal?.throwIfAborted()
  if (observation.projections === undefined) throw new SubagentError('retirement requires authoritative projections', 'RETIREMENT_UNAVAILABLE')
  return observation.projections.values
}

/** Verified membership plus employee branches whose parent authority could not be read. */
export interface RetirementIndex {
  readonly entries: readonly RetiredSubagent[]
  readonly unavailable: ReadonlySet<SessionId>
}

/** Collect direct parent-owned retirements without letting one damaged branch suppress other projects. */
export async function readRetirements(ctx: Context, headers: readonly SessionHeader[], signal?: AbortSignal): Promise<RetirementIndex> {
  const owners = new Set(headers.filter(header => header.origin === 'subagent').map(header => header.parentSession).filter((id): id is SessionId => id !== undefined))
  const rows = new Map(headers.map(header => [header.id, header]))
  const queue = [...owners]
  const retired = new Map<SessionId, RetiredSubagent>()
  const unavailableOwners = new Set<SessionId>()
  await Promise.all(Array.from({ length: Math.min(queue.length, 8) }, async () => {
    for (let owner = queue.shift(); owner !== undefined; owner = queue.shift()) {
      signal?.throwIfAborted()
      const header = rows.get(owner)
      if (header === undefined) { unavailableOwners.add(owner); continue }
      try {
        // Membership changes after creation. A header has no current event watermark,
        // so a cached hint cannot prove that it includes the latest retirement.
        const values = (await retirementValues(ctx, owner, signal)).subagentRetirements
        if (values === undefined) throw new SubagentError('retirement projection is unavailable', 'RETIREMENT_UNAVAILABLE')
        for (const entry of values) {
          const actual = rows.get(entry.id)
          if (actual?.createdAt === entry.createdAt && actual.parentSession === entry.parentSessionId) retired.set(entry.id, entry)
        }
      } catch {
        signal?.throwIfAborted()
        unavailableOwners.add(owner)
      }
    }
  }))
  const unknown = headers.flatMap(header => header.origin === 'subagent'
    && header.parentSession !== undefined && unavailableOwners.has(header.parentSession)
    ? [{ id: header.id, createdAt: header.createdAt, parentSessionId: header.parentSession }]
    : [])
  const unavailable = retiredIds(headers, unknown)
  return { entries: [...retired.values()], unavailable }
}

/** Include descendants of retired roots, even when a pre-commit corpus snapshot omitted a newly settled child. */
export function retiredIds(headers: readonly SessionHeader[], entries: readonly RetiredSubagent[]): Set<SessionId> {
  const removed = new Set(entries.map(entry => entry.id))
  let changed = true
  while (changed) {
    changed = false
    for (const header of headers) if (header.origin === 'subagent' && !removed.has(header.id) && header.parentSession !== undefined && removed.has(header.parentSession)) {
      removed.add(header.id); changed = true
    }
  }
  return removed
}
