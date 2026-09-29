/** Session-scoped voice controls; status stays outside the input card. */
import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { VoiceController, VoiceTarget } from './controller.ts'
import { bindHoldToTalk } from './hold.ts'
import { spokenText } from './speech.ts'
import css from './VoiceControls.module.css'

/** Session binding resolution and observable state are injected at registration. */
export interface VoiceInjected {
  controller: VoiceController
  target(): VoiceTarget | undefined
  hooks: { voice: VoiceController['store']; speech: VoiceController['speech']['store'] }
}
type Shared = InjectFace<VoiceInjected> & PropsLocale<'qianshou.voice'>

/** Compact held button and explicit release-action selector. */
export function VoiceControl(props: Shared & PropsRuntime<'conversation.input.right'>) {
  const { controller, target, useVoice, sessionId, locked, t } = props
  const state = useVoice(value => value)
  const holder = useRef<HTMLSpanElement>(null)
  const owner = useRef({})
  const [menu, setMenu] = useState(false)
  const current = useRef({ target, locked })
  current.current = { target, locked }
  const own = state.sessionId === sessionId
  const capturing = own && controller.owns(owner.current) && ['checking', 'permission', 'recording'].includes(state.phase)
  const busy = controller.active() && !capturing
  useEffect(() => {
    const button = holder.current?.querySelector('button')
    if (button === undefined || button === null) return
    const dispose = bindHoldToTalk(button, {
      start: () => { if (!current.current.locked) void controller.start(current.current.target(), owner.current) },
      finish: () => { if (controller.owns(owner.current)) void controller.finish() },
      cancel: () => { if (controller.owns(owner.current)) void controller.cancel() },
      active: () => controller.owns(owner.current) && controller.active(),
      cancelling: (value) => { if (controller.owns(owner.current)) controller.setCancelling(value) },
    })
    return () => { dispose(); controller.release(owner.current) }
  }, [controller, sessionId])
  useEffect(() => {
    if (locked) controller.release(owner.current)
  }, [controller, locked])
  return <span className={css.controls}>
    <span ref={holder}>
      <Button size="sm" variant="toolbar" className={css.hold} disabled={locked || busy}
        aria-label={capturing ? t('release') : t('hold')} aria-pressed={capturing}
        title={t(state.mode === 'insert' ? 'insertMode' : 'sendMode')}>
        <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="2" width="6" height="10" rx="3" fill="none" stroke="currentColor" /><path d="M4 9v1a6 6 0 0 0 12 0V9M10 16v2M7 18h6" fill="none" stroke="currentColor" /></svg>
      </Button>
    </span>
    <Menu open={menu} onClose={() => { setMenu(false) }} selectedId={state.mode} side="top" portal
      anchor={<Button size="sm" variant="toolbar" aria-label={t('mode')} disabled={locked || controller.active()}
        onClick={() => { setMenu(value => !value) }}><span aria-hidden="true">⌄</span></Button>}
      items={[{ id: 'insert', label: t('insertMode') }, { id: 'send', label: t('sendMode') }]}
      onSelect={(id) => { if (id === 'insert' || id === 'send') controller.setMode(id); setMenu(false) }} />
  </span>
}

/** Full-width recognition and conflict feedback above the composer. */
export function VoiceStatus(props: Shared & PropsRuntime<'conversation.input.dock'>) {
  const { controller, useVoice, sessionId, t } = props
  const state = useVoice(value => value)
  if (state.sessionId !== sessionId || state.phase === 'idle') return null
  return <div className={css.status} role="status" aria-live="polite">
    <div>{t(state.cancelling ? 'cancelling' : state.notice)}</div>
    {state.pendingText !== null && <div className={css.transcript}>{state.pendingText}</div>}
    <div className={css.actions}>
      {state.pendingText !== null && <Button size="sm" onClick={() => { void controller.insertPending() }}>{t('insertPending')}</Button>}
      <Button size="sm" onClick={() => { void controller.cancel() }}>{t(state.phase === 'result' ? 'discard' : 'cancel')}</Button>
    </div>
  </div>
}

/** Narrate only owner-provided final assistant text with an actually available local voice. */
export function ReadAloudAction(props: Shared & PropsRuntime<'conversation.chat.assistant-actions'>) {
  const { controller, useSpeech, useVoice, sessionId, messageId, text, t } = props
  const state = useSpeech(value => value)
  const voiceBusy = useVoice(value => !['idle', 'result'].includes(value.phase))
  const owner = { sessionId, messageId }
  useEffect(() => () => { controller.speech.release({ sessionId, messageId }) }, [controller, sessionId, messageId, text])
  const own = state.active?.sessionId === sessionId && state.active.messageId === messageId
  const failed = state.failed?.sessionId === sessionId && state.failed.messageId === messageId
  const available = controller.speech.available(t('language')) && spokenText(text) !== ''
  const label = own ? t('stopReading') : failed ? t('speechFailed') : state.loading ? t('speechLoading')
    : !available ? t('speechUnavailable') : t('read')
  return <Button size="sm" variant="toolbar" disabled={!own && (!available || voiceBusy)}
    aria-label={label} title={own && state.active.phase === 'starting' ? t('speechStarting') : label} aria-pressed={own}
    onClick={() => { if (own) controller.speech.stop(); else controller.speech.speak(owner, text, t('language')) }}>
    <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
      {own ? <rect x="5" y="5" width="10" height="10" rx="2" fill="currentColor" />
        : <path d="M9 4 5 7H2v6h3l4 3V4ZM12 7c2 1.5 2 4.5 0 6m3-9c4 3 4 9 0 12" fill="none" stroke="currentColor" />}
    </svg>
  </Button>
}
