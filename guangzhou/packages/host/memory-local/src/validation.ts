/** Input validation is shared by owner routes and the narrower employee tools. */
import { isAbsolute, resolve } from 'node:path'
import type { MemoryInput, MemoryKind, MemoryStatus } from './types.ts'

export const MAX_DOCUMENT_BYTES = 512 * 1024
export const MEMORY_KINDS: MemoryKind[] = ['temporary', 'permanent', 'knowledge', 'experience']

/** Machine-readable validation error; never include input content or secrets. */
export class MemoryError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code) }
}

/** Parse an object while rejecting accidental array/scalar bodies. */
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MemoryError('INVALID_MEMORY_REQUEST')
  return value as Record<string, unknown>
}

/** Validate a finite nonempty string without echoing its value in errors. */
export function text(value: unknown, max: number, optional = false): string {
  if (optional && value === undefined) return ''
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || (!optional && !value.trim())) throw new MemoryError('INVALID_MEMORY_TEXT')
  return value
}

/** Canonical lexical absolute workspace identity; never opens paths supplied by a document. */
export function workspaceKey(value: unknown): string {
  const path = text(value, 4096)
  if (!isAbsolute(path)) throw new MemoryError('WORKSPACE_MUST_BE_ABSOLUTE')
  return resolve(path)
}

/** Validate an owner edit; actor status is always assigned by the caller. */
export function input(value: unknown): MemoryInput {
  const body = object(value)
  if (Object.keys(body).some(key => !['id', 'expectedRevision', 'title', 'content', 'kind', 'scope', 'workspace', 'source', 'evidence', 'expiresInDays'].includes(key))) throw new MemoryError('UNSUPPORTED_MEMORY_FIELD')
  const content = text(body.content, MAX_DOCUMENT_BYTES)
  if (Buffer.byteLength(content) > MAX_DOCUMENT_BYTES) throw new MemoryError('MEMORY_DOCUMENT_TOO_LARGE', 413)
  if (!MEMORY_KINDS.includes(body.kind as MemoryKind)) throw new MemoryError('INVALID_MEMORY_KIND')
  if (body.scope !== 'personal' && body.scope !== 'workspace') throw new MemoryError('INVALID_MEMORY_SCOPE')
  const days = body.expiresInDays ?? 7
  if (!Number.isInteger(days) || Number(days) < 1 || Number(days) > 90) throw new MemoryError('INVALID_MEMORY_EXPIRY')
  const id = body.id === undefined ? undefined : text(body.id, 80)
  const revision = body.expectedRevision
  if (id !== undefined && (!Number.isSafeInteger(revision) || Number(revision) < 1)) throw new MemoryError('MEMORY_REVISION_REQUIRED', 409)
  return {
    ...(id === undefined ? {} : { id, expectedRevision: Number(revision) }),
    title: text(body.title, 160), content, kind: body.kind as MemoryKind,
    scope: body.scope,
    ...(body.scope === 'workspace' ? { workspace: workspaceKey(body.workspace) } : {}),
    source: text(body.source, 2000, true), evidence: text(body.evidence, 4000, true),
    expiresInDays: Number(days),
  }
}

/** Validate status filters rather than passing unknown values to SQL. */
export function status(value: unknown): MemoryStatus {
  if (value !== 'active' && value !== 'candidate') throw new MemoryError('INVALID_MEMORY_STATUS')
  return value
}
