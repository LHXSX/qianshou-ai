/** Interactive window projection; preparation cards never submit compute jobs. */
import { mobileCopy } from './mobile-locales.ts'
import type { MobileConversationTarget, MobileWorkspaceSnapshot } from './mobile-workspace-types.ts'
import type { WindowFrame, WindowNode } from './window.ts'

/** Actions retain execution targeting in the workspace controller. */
export interface MobileWorkspaceActions {
  readonly openAgent: () => void
  readonly openPc: (pcId: string) => void
  readonly select: (target: MobileConversationTarget) => void
  readonly refresh: () => void
  readonly changeText: (text: string) => void
  readonly send: () => void
}

/**
 * Project current-account facts into a sidebar, transcript and input composer.
 * @param snapshot - Detached state from the workspace controller.
 * @param actions - Entry-owned action handlers.
 * @param input - Draft text for the selected conversation.
 * @param locale - Explicit product locale.
 * @returns The frame consumed by the existing window painter.
 */
export function projectMobileWorkspace(snapshot: MobileWorkspaceSnapshot, actions: MobileWorkspaceActions, input: string, locale: 'zh-CN' | 'en'): WindowFrame {
  const t = mobileCopy(locale)
  const text = (testId: string, value: string): WindowNode => ({ type: 'text', testId, text: value })
  const button = (testId: string, value: string, tap: () => void): WindowNode => ({ type: 'view', testId, tap, children: [text(`${testId}-label`, value)] })
  const directoryStatus = snapshot.directoryState === 'error' ? t.directoryError : snapshot.directoryState === 'loading' ? t.loading
    : snapshot.directoryState === 'unconfigured' ? t.unconfigured : snapshot.directoryState === 'ready' && !snapshot.devices.some(pc => pc.online) ? t.noPc : ''
  const phoneSessions = snapshot.conversations.filter((target): target is Extract<MobileConversationTarget, { kind: 'agent' }> => target.kind === 'agent')
  const computerSessions = snapshot.conversations.filter((target): target is Extract<MobileConversationTarget, { kind: 'pc' }> => target.kind === 'pc')
  const children: WindowNode[] = [
    text('mobile-title', t.title),
    { type: 'view', testId: 'mobile-sidebar', children: [
      button('mobile-new-agent', t.cloud, actions.openAgent),
      { type: 'view', testId: 'mobile-pc-drawer', children: [text('mobile-pc-drawer-title', t.computers), text('mobile-pc-directory-state', directoryStatus),
        ...snapshot.devices.map(pc => button(`mobile-pc-${pc.pcId}`, `${pc.label} · ${pc.platform === 'windows' ? 'Windows' : 'Mac'} · ${pc.online ? t.online : t.offline}`, () => { actions.openPc(pc.pcId) })),
      ] },
      text('mobile-sessions-title', t.sessions),
      ...phoneSessions.map((target, index) => button(`mobile-conversation-${String(index)}`, `${t.conversation} ${String(index + 1)}`, () => { actions.select(target) })),
      ...(computerSessions.length === 0 ? [] : [
        text('mobile-pc-sessions-title', t.computerSessions),
        ...computerSessions.map((target, index) => button(`mobile-pc-session-${String(index)}`, target.label, () => { actions.select(target) })),
      ]),
      button('mobile-refresh', t.refresh, actions.refresh),
    ] },
    text('mobile-target', snapshot.target?.kind === 'pc' ? snapshot.target.label : t.agent),
    text('mobile-status', snapshot.status === 'running' ? t.running : snapshot.status === 'idle' ? t.idle : snapshot.status === 'offline' ? t.pcOffline : t.unavailable),
    { type: 'view', testId: 'mobile-transcript', children: snapshot.turns.map(turn => text(`mobile-turn-${turn.id}`, turn.text)) },
    { type: 'view', testId: 'mobile-admissions', children: [] },
  ]
  const draft = snapshot.draft
  if (draft?.kind === 'trigger') children.push({ type: 'view', testId: 'mobile-request-draft', children: [text('mobile-request-draft-title', t.preparing), text('mobile-request-draft-description', t[draft.draft.mode])] })
  if (snapshot.error !== null) {
    const errors = { 'signed-out': t.signedOut, 'agent-unavailable': t.agentUnavailable, 'directory-error': t.directoryError, 'pc-offline': t.pcOffline, 'target-error': t.targetError, 'send-error': t.sendError }
    children.push(text('mobile-error', errors[snapshot.error]))
  }
  children.push({ type: 'input', testId: 'mobile-input', value: input, placeholder: t.placeholder, input: actions.changeText })
  children.push(button('mobile-send', t.send, actions.send))
  return { code: 'WINDOW_MOBILE_WORKSPACE', tree: { type: 'view', testId: 'mobile-workspace', children } }
}
