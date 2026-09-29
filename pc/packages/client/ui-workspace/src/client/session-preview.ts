/** Read-only feature content for Workspace Session navigation and presentation. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Exact-Session content; unavailable content still prevents blank Session reuse. */
export type WorkspaceSessionPreview =
  | {
    readonly kind: 'content'
    /** Feature-owned plain text; Workspace bounds the displayed preview to 48 code points. */
    readonly title: string
    /** Additional plain text for local search; Workspace bounds the combined text to 512 code points. */
    readonly searchText?: string
    /** Observed content time, never evidence that an operation completed. */
    readonly updatedAt?: number
  }
  | { readonly kind: 'unavailable' }

/** Feature-owned synchronous reader; it never retains a Session or starts an operation. */
export interface WorkspaceSessionPreviewProvider {
  /**
   * Read one exact Session without creating, executing, quoting, or mutating it.
   * @param sessionId - exact Session identity, including cold Sessions.
   * @returns null only after confirming no content; unreadable or bounded-out data is unavailable.
   */
  read(sessionId: SessionId): WorkspaceSessionPreview | null
  /**
   * Subscribe to changes of the exact Session whose read result changed.
   * @param notify - invalidates that Session's read-only Workspace preview.
   * @returns disposer; notifications retained after disposal must have no effect.
   */
  subscribe(notify: (sessionId: SessionId) => void): () => void
}

/** Stable observable snapshots contain only Session identities in the current catalog. */
export type WorkspaceSessionPreviewSnapshot = ReadonlyMap<SessionId, WorkspaceSessionPreview>
