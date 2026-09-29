/** Shared window entry: open the shell window, then keep the injected painter on the current frame. */
import { MobileWorkspace } from './mobile-workspace.ts'
import { projectMobileWorkspace } from './mobile-workspace-view.ts'
import type { MobileWorkspaceOptions } from './mobile-workspace-types.ts'
import type { SurfacePort } from './host.ts'
import type { MobileSyncAck, MobileTaskDecision, SurfaceState } from './mobile-agent-shell.ts'
import { openWindow, type WindowFrame, type OpenWindowOptions } from './window.ts'

/** Live entry: dispose, refresh, and receive cards; each mutator paints again. */
export interface WindowEntryHandle {
  /** Mobile agent and PC conversation controller when adapters are supplied. */
  readonly mobile: MobileWorkspace | null
  readonly dispose: () => void
  readonly refresh: () => WindowFrame
  readonly receiveTaskCard: (value: unknown) => MobileTaskDecision | null
  readonly sync: (limit?: number) => Promise<MobileSyncAck>
}

/**
 * Forward surface events, then ask the entry to paint the new snapshot.
 * @param port - Embedding surface source.
 * @param after - Called after the shell has stored the new surface.
 * @returns A port the window can bind.
 */
function followSurface(port: SurfacePort, after: () => void): SurfacePort {
  return {
    subscribe: listener => port.subscribe((surface: SurfaceState) => {
      listener(surface)
      after()
    }),
  }
}

/**
 * Start the window and keep the painter aligned with the shell.
 * Every mount injects `paint`; the repository ships no native
 * painter, so a missing painter is a wiring bug rather than a dropped frame.
 * @param options - Host boot fields plus optional surface port.
 * @param paint - Painter for each new frame. Required by every mount.
 * @returns Handle whose refresh and receiveTaskCard paint the new frame.
 */
export function startWindowEntry(
  options: OpenWindowOptions & { readonly mobile?: MobileWorkspaceOptions } = {},
  paint?: (frame: WindowFrame) => void,
): WindowEntryHandle {
  let closed = false
  const draw = (frame: WindowFrame): void => {
    if (closed) return
    if (paint !== undefined) {
      paint(frame)
      return
    }
    throw new Error('WINDOW_NATIVE_PAINTER_REMOVED')
  }
  let mobile: MobileWorkspace | null = null
  const inputs = new Map<string, string>()
  const sendingInputs = new Set<string>()
  let inputAccount: string | null = null
  const inputKey = (): string => {
    const snapshot = mobile?.snapshot()
    const target = snapshot?.target
    if (inputAccount !== (snapshot?.accountId ?? null)) { inputs.clear(); inputAccount = snapshot?.accountId ?? null }
    return JSON.stringify([snapshot?.accountId, target?.kind, target?.kind === 'pc' ? target.binding.pcId : null, target?.binding.sessionId])
  }
  const mobileFrame = (): WindowFrame => {
    const workspace = mobile
    if (workspace === null) throw new Error('WINDOW_MOBILE_WORKSPACE_UNAVAILABLE')
    return projectMobileWorkspace(workspace.snapshot(), {
      openAgent: () => { void workspace.openAgent() },
      openPc: (pcId) => { void workspace.openPc(pcId) },
      select: (target) => { workspace.selectConversation(target) },
      refresh: () => { void workspace.refreshDevices(); void workspace.refreshConversation() },
      changeText: (text) => { inputs.set(inputKey(), text) },
      send: () => {
        const id = inputKey()
        const text = inputs.get(id) ?? ''
        if (workspace.snapshot().target === null || text.trim() === '') return
        const submission = JSON.stringify([id, text])
        if (sendingInputs.has(submission)) return
        sendingInputs.add(submission)
        void workspace.send(text).then((recorded) => {
          if (recorded && inputs.get(id) === text) inputs.delete(id)
          draw(mobileFrame())
        }).finally(() => { sendingInputs.delete(submission) })
      },
    }, inputs.get(inputKey()) ?? '', options.mobile?.locale ?? 'zh-CN')
  }
  if (options.mobile !== undefined && options.platform !== 'desktop') {
    mobile = new MobileWorkspace(options.mobile, () => { draw(mobileFrame()) })
    draw(mobileFrame())
    void mobile.refreshDevices()
  }
  const bound: OpenWindowOptions = options.surface === undefined
    ? options
    : { ...options, surface: followSurface(options.surface, () => {
      draw(mobile === null ? session.refresh() : mobileFrame())
    }) }
  const session = openWindow(bound)
  const stopMobileSurface = mobile !== null && options.surface !== undefined
    ? options.surface.subscribe((surface) => { mobile.setForeground(surface === 'foreground') })
    : () => {}
  if (mobile === null) draw(session.frame)
  return {
    mobile,
    dispose: () => { closed = true; stopMobileSurface(); mobile?.dispose(); inputs.clear(); session.dispose() },
    refresh: () => {
      const frame = mobile === null ? session.refresh() : mobileFrame()
      draw(frame)
      return frame
    },
    receiveTaskCard: (value) => {
      const decision = session.receiveTaskCard(value)
      draw(mobile === null ? session.frame : mobileFrame())
      return decision
    },
    sync: async (limit) => {
      const ack = await session.sync(limit)
      draw(mobile === null ? session.frame : mobileFrame())
      return ack
    },
  }
}
