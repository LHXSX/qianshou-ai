/** Resolve authority from actual Session cwd and current canonical workspace registrations. */
import { realpath } from 'node:fs/promises'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { Session } from '@deepseek-ai/dsh-session'
import { MemoryFailure } from './validation.ts'
import type { MemoryAccess } from './types.ts'

/**

 * Resolve after filesystem lookup so removed registrations cannot survive an await.

 * @param registry - Current Host registry.

 * @param session - Actual caller Session.

 * @param signal - Tool lifetime.

 * @returns Current workspace or device-only access.

 */
export async function sessionAccess(registry: WorkspaceRegistry, session: Session, signal: AbortSignal): Promise<MemoryAccess> {
  signal.throwIfAborted()
  const cwd = session.header.cwd
  if (!cwd) return { workspaceId: null, workspacePath: null }
  let canonical: string
  try { canonical = await realpath(cwd) }
  catch (error) {
    signal.throwIfAborted()
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return { workspaceId: null, workspacePath: null }
    throw new MemoryFailure('storage-failed')
  }
  signal.throwIfAborted()
  const workspace = registry.list().find(item => item.path === canonical)
  return { workspaceId: workspace?.id ?? null, workspacePath: workspace?.path ?? null }
}
