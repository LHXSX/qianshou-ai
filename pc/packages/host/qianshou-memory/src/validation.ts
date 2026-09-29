/** Validate owner wire and model input without echoing document text. */
import { z } from 'zod'
import type { MemoryInput, MemoryQuery, MemoryRevision, MemoryReview, MemoryExportQuery, MemoryFailureCode } from './types.ts'

/** Protocol document ceiling independent of deployment storage capacity. */
export const MAX_DOCUMENT_BYTES = 512 * 1024
/** Categories persisted in the new device vault format. */
export const MEMORY_KINDS = ['temporary', 'permanent', 'knowledge', 'experience'] as const
/** Safe RPC error whose message contains only its stable code. */
export class MemoryFailure extends Error {
  constructor(readonly code: MemoryFailureCode) { super(`QIANSHOU_MEMORY_${code}`) }
}
const text = (max: number) => z.string().max(max).refine(s => !s.includes('\0'))
const requiredText = (max: number) => text(max).refine(s => !!s.trim())
const id = z.uuid()
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const inputSchema = z.strictObject({
  id: id.optional(), expectedRevision: revision.optional(), title: requiredText(160),
  content: requiredText(MAX_DOCUMENT_BYTES).refine(s => Buffer.byteLength(s) <= MAX_DOCUMENT_BYTES),
  kind: z.enum(MEMORY_KINDS), scope: z.enum(['device', 'workspace']), workspaceId: id.optional(),
  source: text(2000).optional(), evidence: text(4000).optional(), expiresInDays: z.number().int().min(1).max(90).optional(),
}).refine(v => !v.id || !!v.expectedRevision).refine(v => v.scope === 'workspace' ? !!v.workspaceId : !v.workspaceId)
const querySchema = z.strictObject({
  query: text(500).optional(), kind: z.enum(MEMORY_KINDS).optional(), status: z.enum(['active', 'candidate']).optional(),
  scope: z.enum(['device', 'workspace']).optional(), workspaceId: id.optional(),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), limit: z.number().int().min(1).max(100).optional(),
})
const revisionSchema = z.strictObject({ id, expectedRevision: revision })
function parse(schema: z.ZodType, value: unknown): unknown {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new MemoryFailure('invalid-request')
  return parsed.data
}
/**
 * Parse an owner draft.
 * @param value - Remote input.
 * @returns Validated draft.
 */
export function parseInput(value: unknown): MemoryInput { return parse(inputSchema, value) as MemoryInput }
/**
 * Parse owner list filters.
 * @param value - Remote input.
 * @returns Bounded filters.
 */
export function parseQuery(value: unknown): MemoryQuery { return parse(querySchema, value) as MemoryQuery }
/**
 * Parse a record id.
 * @param value - Remote or model identifier.
 * @returns Valid identifier.
 */
export function parseId(value: unknown): MemoryRevision['id'] { return parse(id, value) as MemoryRevision['id'] }
/**
 * Parse a destructive edit fence.
 * @param value - Remote input.
 * @returns Valid id/revision.
 */
export function parseRevision(value: unknown): MemoryRevision { return parse(revisionSchema, value) as MemoryRevision }
/**
 * Parse a human candidate decision.
 * @param value - Remote input.
 * @returns Valid decision.
 */
export function parseReview(value: unknown): MemoryReview { return parse(revisionSchema.extend({ action: z.enum(['accept', 'reject']) }), value) as MemoryReview }
/**
 * Parse a bounded export cursor.
 * @param value - Remote input.
 * @returns Valid cursor.
 */
export function parseExport(value: unknown): MemoryExportQuery { return parse(z.strictObject({ revision: revision.optional(), stage: z.enum(['entries', 'revisions', 'receipts']).optional(), offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() }), value) as MemoryExportQuery }
/**
 * Mask implementation failures at all public owner/tool calls.
 * @param action - Synchronous storage operation.
 * @returns Its value.
 */
export function safeMemory<T>(action: () => T): T {
  try { return action() } catch (error) { if (error instanceof MemoryFailure) throw error; throw new MemoryFailure('storage-failed') }
}
