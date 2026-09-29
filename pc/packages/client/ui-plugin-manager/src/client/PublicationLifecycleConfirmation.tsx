import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LocalSkillKey } from './local-skill-locales.ts'
import { publicationActionEffect, publicationActionLabel, type PublicationLifecycleAction } from './publication-lifecycle.ts'

/** The owner's confirmation names the exact record and states what remains after the action. */
export function PublicationLifecycleConfirmation({ action, name, pending, valid, failed, t, onCancel, onConfirm }: {
  action: PublicationLifecycleAction
  name: string
  pending: boolean
  valid: boolean
  failed: boolean
  t: (key: LocalSkillKey) => string
  onCancel: () => void
  onConfirm: () => void
}) {
  const label = t(publicationActionLabel[action])
  return <Modal open title={t('publicationLifecycleConfirmTitle').replace('{action}', label).replace('{name}', name)}
    closeLabel={t('publicationLifecycleClose')} onClose={() => { if (!pending) onCancel() }} footer={<>
      <Button variant="outline" disabled={pending} onClick={onCancel}>{t('publicationLifecycleCancel')}</Button>
      <Button variant="primary" disabled={pending || !valid} onClick={onConfirm}>
        {pending ? t('publicationLifecycleWorking') : t('publicationLifecycleConfirm').replace('{action}', label)}
      </Button>
    </>}>
    <p>{t(publicationActionEffect[action])}</p>
    <p>{t('publicationLifecycleHistoryRetained')}</p>
    {failed && <p role="alert">{t('publicationLifecycleFailed')}</p>}
  </Modal>
}
