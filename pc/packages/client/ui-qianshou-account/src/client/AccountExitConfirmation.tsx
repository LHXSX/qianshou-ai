/** Confirm a local account exit before invoking the Host-owned authentication operation. */
import { useEffect } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountController } from './controller.ts'
import type { AccountKey } from './locales.ts'
import css from './AccountPanel.module.css'

/** A confirmation belongs to the account that opened it, including a persisted signed-out session. */
export interface AccountExitIntent {
  ownerId: string | null
  kind: 'logout' | 'switch'
}
interface AccountExitConfirmationProps {
  controller: AccountController
  intent: AccountExitIntent | null
  busy: boolean
  failed: boolean
  t: (key: AccountKey) => string
  onClose: () => void
}

/** A stale confirmation must never sign out a subsequently selected account. */
export function AccountExitConfirmation({ controller, intent, busy, failed, t, onClose }: AccountExitConfirmationProps) {
  const ownerId = controller.store.getSnapshot().snapshot?.account?.id ?? null
  const matches = intent !== null && intent.ownerId === ownerId
  useEffect(() => { if (intent !== null && !matches) onClose() }, [intent, matches, onClose])
  const close = () => { if (!busy) onClose() }
  const confirm = async () => {
    const current = controller.store.getSnapshot()
    if (intent === null || current.busy || (current.snapshot?.account?.id ?? null) !== intent.ownerId) return
    await controller.logout()
    const next = controller.store.getSnapshot()
    if (!next.failed && next.snapshot?.account === null && !next.snapshot.restorable) onClose()
  }
  return <Modal open={matches} onClose={close} title={t(intent?.kind === 'switch' ? 'switchConfirmTitle' : 'logoutConfirmTitle')}
    closeLabel={t('close')} description={t(intent?.kind === 'switch' ? 'switchConfirmHint' : 'logoutConfirmHint')}
    footer={<div className={css.exitActions}>
      <button type="button" disabled={busy} onClick={close}>{t('keepAccount')}</button>
      <button type="button" className={css.exitConfirm} disabled={busy} onClick={() => { void confirm() }}>
        {t(busy ? 'busy' : intent?.kind === 'switch' ? 'confirmSwitch' : 'confirmLogout')}
      </button>
    </div>}>
    {failed && <p role="alert" className={css.hint}>{t('connection-failed')}</p>}
  </Modal>
}
