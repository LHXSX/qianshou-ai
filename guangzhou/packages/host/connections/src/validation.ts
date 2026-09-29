/** Validate durable, HTTP and tool JSON without allowing secret-bearing extra fields. */
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { ConnectionDraft, ConnectionId, ConnectionRecord } from './types.ts'

const idSchema = z.string().uuid()
const base = {
  id: idSchema.optional(),
  label: z.string().trim().min(1).max(80),
  allowedPresets: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).max(64).transform(items => [...new Set(items)]),
}
const draftSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('ssh'), ssh: z.object({
    host: z.string().min(1).max(253).regex(/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/),
    port: z.number().int().min(1).max(65535),
    user: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}\$?$/),
    keyPath: z.string().max(4096).refine(value => isAbsolute(value) && !/[\r\n\0]/.test(value)).optional(),
  }).strict() }).strict(),
  z.object({ ...base, kind: z.literal('github'), github: z.object({
    auth: z.enum(['gh', 'credential']), credentialRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  }).strict().refine(value => value.auth !== 'credential' || value.credentialRef !== undefined) }).strict(),
])

/** Validate a browser or stored draft.
 * @param value - Untrusted JSON input.
 * @returns Normalized non-secret draft.
 */
export function connectionDraft(value: unknown): ConnectionDraft {
  const parsed = draftSchema.safeParse(value)
  if (!parsed.success) throw new Error('INVALID_CONNECTION')
  return parsed.data as ConnectionDraft
}
/** Parse an opaque connection id.
 * @param value - Untrusted id.
 * @returns Validated connection id.
 */
export function connectionId(value: unknown): ConnectionId {
  const parsed = idSchema.safeParse(value)
  if (!parsed.success) throw new Error('INVALID_CONNECTION_ID')
  return parsed.data as ConnectionId
}
/** Parse one required id object, refusing ignored fields.
 * @param value - Request body.
 * @returns Validated id.
 */
export function idRequest(value: unknown): ConnectionId {
  const parsed = z.object({ id: idSchema }).strict().safeParse(value)
  if (!parsed.success) throw new Error('INVALID_CONNECTION_ID')
  return parsed.data.id as ConnectionId
}
/** Read a versioned metadata file.
 * @param value - Untrusted parsed document.
 * @returns Validated stored rows.
 */
export function storedConnections(value: unknown): Array<ConnectionRecord & { revision: number; updatedAt: string }> {
  const parsed = z.object({ version: z.literal(1), connections: z.array(z.unknown()).max(200) }).strict().safeParse(value)
  if (!parsed.success) throw new Error('INVALID_CONNECTION_STORE')
  const ids = new Set<string>()
  return parsed.data.connections.map((item) => {
    const row = z.object({ revision: z.number().int().positive(), updatedAt: z.string().datetime() }).passthrough().safeParse(item)
    if (!row.success) throw new Error('INVALID_CONNECTION_STORE')
    const { revision, updatedAt, ...input } = row.data
    const draft = connectionDraft(input)
    if (draft.id === undefined || ids.has(draft.id)) throw new Error('INVALID_CONNECTION_STORE')
    ids.add(draft.id)
    return { ...draft, id: draft.id, revision, updatedAt }
  })
}
