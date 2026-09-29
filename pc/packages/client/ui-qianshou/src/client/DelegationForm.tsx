/** Explicit user requests for the CEO, sent through the ordinary session queue. */
import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { TaskAddress } from './AgentTasks.tsx'
import css from './DelegationForm.module.css'

/** Real execution strategies supported by the shipped CEO preset. */
export type DelegationMode = 'auto' | 'one-shot' | 'continuable'

/** User-selected specialties; these describe responsibility, not credentials. */
export const specialistRoles = [
  'roleAuto', 'roleFrontend', 'roleBackend', 'roleProduct', 'roleDesign', 'roleColor',
  'roleArchitecture', 'roleTesting', 'roleSecurity', 'roleResearch', 'rolePsychology',
  'roleBehavior', 'roleEcology', 'roleLogic', 'roleCode', 'roleCommunication', 'roleProtocol',
] as const

/** Queue a visible instruction in the parent session without touching its draft. */
export interface DelegationActions {
  dispatch: (parent: TaskAddress['parentSessionId'], text: string) => Promise<void>
}

/** Inputs owned by the task window. */
export type DelegationFormProps = PropsLocale<'qianshou.brand'> & DelegationActions & {
  parent: TaskAddress['parentSessionId']
}

/**
 * Let the user choose execution mode and specialty before asking the CEO to delegate.
 * A queued request is not displayed as a running or accepted task.
 * @param props - parent address, localized copy, and queued-send action.
 * @returns the delegation form.
 */
export function DelegationForm({ parent, dispatch, t }: DelegationFormProps) {
  const [mode, setMode] = useState<DelegationMode>('auto')
  const [role, setRole] = useState<string>('roleAuto')
  const [customRole, setCustomRole] = useState('')
  const [task, setTask] = useState('')
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<'queued' | 'error' | null>(null)
  const roleText = role === 'custom' ? customRole.trim() : t(specialistRoles.find(key => key === role) ?? 'roleAuto')
  const modeKey = mode === 'one-shot' ? 'dispatchOnce' : mode === 'continuable' ? 'dispatchContinuous' : 'dispatchAuto'
  return <form className={css.form} data-qianshou-delegation-form onSubmit={(event) => {
    event.preventDefault()
    if (pending || task.trim() === '' || roleText === '') return
    const request = [t('dispatchRequest'), t('dispatchRole', { role: roleText }), t(modeKey),
      t('dispatchRequirements'), t('dispatchTask', { task: task.trim() })].join('\n\n')
    setPending(true)
    setResult(null)
    void dispatch(parent, request).then(() => {
      setTask('')
      setResult('queued')
    }, () => { setResult('error') }).finally(() => { setPending(false) })
  }}>
    <p>{t('dispatchHint')}</p>
    <label>{t('executionChoice')}<select aria-label={t('executionChoice')} value={mode} disabled={pending}
      onChange={(event) => { setMode(event.currentTarget.value as DelegationMode); setResult(null) }}>
      <option value="auto">{t('modeAuto')}</option>
      <option value="one-shot">{t('modeOnce')}</option>
      <option value="continuable">{t('modeContinuous')}</option>
    </select></label>
    <p className={css.help}>{t(mode === 'one-shot' ? 'onceHint' : mode === 'continuable' ? 'continuousHint' : 'autoHint')}</p>
    <label>{t('roleChoice')}<select aria-label={t('roleChoice')} value={role} disabled={pending}
      onChange={(event) => { setRole(event.currentTarget.value); setResult(null) }}>
      {specialistRoles.map(key => <option key={key} value={key}>{t(key)}</option>)}
      <option value="custom">{t('roleCustom')}</option>
    </select></label>
    {role === 'custom' && <label>{t('customRoleLabel')}<input aria-label={t('customRoleLabel')} value={customRole} maxLength={80} required disabled={pending}
      onChange={(event) => { setCustomRole(event.currentTarget.value) }} /></label>}
    <label>{t('taskRequest')}<textarea aria-label={t('taskRequest')} value={task} required rows={4} maxLength={20000} disabled={pending}
      placeholder={t('taskPlaceholder')} onChange={(event) => { setTask(event.currentTarget.value); setResult(null) }} /></label>
    <button type="submit" disabled={pending || task.trim() === '' || roleText === ''}>{t(pending ? 'dispatchSending' : 'dispatchSubmit')}</button>
    {result === 'queued' && <p role="status">{t('dispatchQueued')}</p>}
    {result === 'error' && <p role="alert">{t('dispatchFailed')}</p>}
  </form>
}
