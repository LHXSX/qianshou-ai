/** window projection: shell facts become a view/text tree. No renderer import here. */
import {
  bootWindowHost,
  type WindowHostBoot,
  type WindowHost,
  type WindowHostOptions,
  type SurfacePort,
} from './host.ts'
import type { MobileAgentShellSnapshot, MobileSyncAck, MobileTaskDecision, SurfaceState } from './mobile-agent-shell.ts'

/** One element the painter must emit. */
export interface WindowNode {
  readonly type: 'view' | 'text' | 'input'
  readonly value?: string
  readonly placeholder?: string
  readonly tap?: () => void
  readonly input?: (text: string) => void
  readonly testId: string
  readonly text?: string
  readonly children?: readonly WindowNode[]
}

/** One frame a mount paints. Codes are stable ids, not product copy. */
export interface WindowFrame {
  readonly code: string
  readonly tree: WindowNode
}

/** Inputs for {@link openWindow}. */
export interface OpenWindowOptions extends Partial<WindowHostOptions> {
  readonly surface?: SurfacePort
}

/** A live window session driven by the shell. */
export interface WindowSession {
  readonly boot: WindowHostBoot
  readonly host: WindowHost | null
  /** Current frame; call {@link WindowSession.refresh} after surface or sync changes. */
  frame: WindowFrame
  /** Rebuild the frame from the current shell snapshot. */
  readonly refresh: () => WindowFrame
  /**
   * Receive one task card, then refresh the frame.
   * A boot-error session has no host and returns `null` without changing the tree.
   */
  readonly receiveTaskCard: (value: unknown) => MobileTaskDecision | null
  /**
   * Pull one cursor page, then refresh the frame.
   * A boot-error session has no host and rejects with `WINDOW_SYNC_UNAVAILABLE`.
   */
  readonly sync: (limit?: number) => Promise<MobileSyncAck>
  /** Stop forwarding surface events. */
  readonly dispose: () => void
}

/**
 * Project one boot result (and optional snapshot) into the window tree.
 * @param boot - Result of {@link bootWindowHost}.
 * @param snapshot - Shell snapshot when a host exists.
 * @param authState - Non-secret auth state from the embedding port.
 * @param capabilityIds - Declared capability ids when a host exists.
 * @returns A frozen frame whose `tree` uses only `view` and `text`.
 */
export function projectWindow(
  boot: WindowHostBoot,
  snapshot: MobileAgentShellSnapshot | null,
  authState: 'signed-out' | 'authorizing' | 'authenticated' | 'expired' | null,
  capabilityIds: readonly string[] | null = null,
): WindowFrame {
  const code = boot.ok
    ? (authState === 'authenticated' ? 'WINDOW_READY' : 'WINDOW_SIGNED_OUT')
    : (boot.error ?? 'WINDOW_HOST_BOOT_FAILED')
  const fields: WindowNode[] = [textNode('window-code', code)]
  if (snapshot !== null) {
    fields.push(
      textNode('window-platform', snapshot.platform),
      textNode('window-surface', snapshot.surface),
      textNode('window-cursor', snapshot.cursor),
      textNode('window-revision', snapshot.lastSyncRevision === null ? 'none' : String(snapshot.lastSyncRevision)),
      textNode('window-online', snapshot.online ? 'online' : 'offline'),
      textNode('window-card-id', snapshot.lastCard?.cardId ?? 'none'),
      textNode('window-capability', snapshot.lastCard?.capability.id ?? 'none'),
      textNode('window-capabilities', capabilityIds === null || capabilityIds.length === 0
        ? 'none'
        : capabilityIds.join(',')),
      textNode('window-decision', snapshot.lastDecision === null
        ? 'none'
        : `${snapshot.lastDecision.disposition}:${snapshot.lastDecision.reason}`),
    )
  }
  return Object.freeze({
    code,
    tree: Object.freeze({
      type: 'view',
      testId: 'window',
      children: Object.freeze(fields),
    }),
  })
}

/**
 * Boot the shell and keep a window frame in sync with surface changes.
 * @param options - Same fields as the host boot, plus an optional surface port.
 * @returns A session. Missing required host fields become a boot-error frame.
 */
export function openWindow(options: OpenWindowOptions = {}): WindowSession {
  const boot = bootWindowHost(options)
  const unbind = boot.host !== null && options.surface !== undefined
    ? boot.host.bindSurface(options.surface)
    : () => {}
  const readAuth = (): 'signed-out' | 'authorizing' | 'authenticated' | 'expired' | null => (
    options.auth === undefined ? null : options.auth.state()
  )
  const session: WindowSession = {
    boot,
    host: boot.host,
    frame: projectWindow(
      boot, boot.host?.snapshot() ?? null, readAuth(), boot.host?.capabilityIds() ?? null,
    ),
    refresh: () => {
      session.frame = projectWindow(
        boot, boot.host?.snapshot() ?? null, readAuth(), boot.host?.capabilityIds() ?? null,
      )
      return session.frame
    },
    receiveTaskCard: (value) => {
      if (session.host === null) return null
      const decision = session.host.receiveTaskCard(value)
      session.refresh()
      return decision
    },
    sync: async (limit) => {
      if (session.host === null) throw new Error('WINDOW_SYNC_UNAVAILABLE')
      const ack = await session.host.sync(limit ?? 20)
      session.refresh()
      return ack
    },
    dispose: () => { unbind() },
  }
  return session
}

/**
 * Find one text node in a window tree.
 * @param frame - Projected frame.
 * @param testId - Node id, e.g. `window-cursor`.
 * @returns The text value, or `null` when the node is absent.
 */
export function readWindowText(frame: WindowFrame, testId: string): string | null {
  return findText(frame.tree, testId)
}

function textNode(testId: string, text: string): WindowNode {
  return Object.freeze({ type: 'text', testId, text })
}

function findText(node: WindowNode, testId: string): string | null {
  if (node.testId === testId && node.type === 'text') return node.text ?? null
  for (const child of node.children ?? []) {
    const hit = findText(child, testId)
    if (hit !== null) return hit
  }
  return null
}

export type { SurfaceState }
