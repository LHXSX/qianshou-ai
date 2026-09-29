/** Confirmation for Host-persisted removal of one idle team branch. */
import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import { NS } from './locales.ts'
import { teamRemovalErrorText, type TeamRemovalBlocker, type TeamRemovalTarget } from './team-removal.ts'
import css from './TeamRemovalDialog.module.css'

/** Exact branch confirmation and async persistence callback. */
export interface TeamRemovalDialogProps {
  readonly target: TeamRemovalTarget
  readonly blocked: TeamRemovalBlocker | undefined
  readonly removeChild: (address: SubagentAddress) => Promise<void>
  readonly onClose: () => void
  readonly t: TranslateNS<typeof NS>
}

/**
 * Await durable removal without hiding errors or stopping active work.
 * @param props - branch identity, current activity checks and persistence action.
 * @returns the shared localized confirmation dialog.
 */
export function TeamRemovalDialog({ target, blocked, removeChild, onClose, t }: TeamRemovalDialogProps) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const close = () => { if (!inFlight.current) onClose() }
  const confirm = async () => {
    if (blocked !== undefined || inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError(undefined)
    try {
      await removeChild(target.address)
      if (mounted.current) onClose()
    } catch (failure: unknown) {
      if (mounted.current) setError(teamRemovalErrorText(failure, t))
    } finally {
      inFlight.current = false
      if (mounted.current) setPending(false)
    }
  }
  return <div onKeyDown={(event) => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); close(); return }
    if (event.key !== 'Tab') return
    const dialog = body.current?.closest('[role="dialog"]')
    const controls = dialog?.querySelectorAll<HTMLElement>('button:not([disabled])')
    if (!controls?.length) return
    const first = controls[0]!
    const last = controls[controls.length - 1]!
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }}>
    <Modal open title={t('remove.title', { label: target.label })} closeLabel={t('remove.cancel')}
      className={css.dialog ?? ''} onClose={close}
      footer={<>
        <Button variant="outline" autoFocus disabled={pending} onClick={close}>{t('remove.cancel')}</Button>
        <Button variant="primary" disabled={pending || blocked !== undefined} onClick={() => { void confirm() }}>
          {t(pending ? 'remove.pending' : 'remove.confirm')}
        </Button>
      </>}>
      <div ref={body} data-team-removal aria-busy={pending || undefined}>
        <p className={css.description}>{t('remove.description')}</p>
        <p className={css.hint}>{t('remove.history')}</p>
        {blocked !== undefined && <p className={css.notice} role="status">{t(`remove.blocked.${blocked}`)}</p>}
        {error !== undefined && <p className={css.error} role="alert">{error}</p>}
      </div>
    </Modal>
  </div>
}
