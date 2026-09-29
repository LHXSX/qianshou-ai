/** One task's explicit fifteen deliverables; no document body or legal opinion is generated here. */
import type { MarketTaskProgressLabels } from './market-task-progress-locales.ts'

export interface LegalTarget {
  id: string
  title: string
  purpose: string
}
export function legalTargets(serialized: string | boolean | undefined): LegalTarget[] {
  if (typeof serialized === 'string') {
    try {
      const value: unknown = JSON.parse(serialized)
      if (Array.isArray(value) && value.length === 15 && value.every((item, index) => item !== null
        && typeof item === 'object' && (item as Record<string, unknown>).id === `document_${index + 1}`
        && typeof (item as Record<string, unknown>).title === 'string'
        && String((item as Record<string, unknown>).title).length <= 100
        && typeof (item as Record<string, unknown>).purpose === 'string'
        && String((item as Record<string, unknown>).purpose).length <= 200)) return value as LegalTarget[]
    } catch { /* An incomplete restored form starts with empty controls. */ }
  }
  return Array.from({ length: 15 }, (_, index) => ({ id: `document_${index + 1}`, title: '', purpose: '' }))
}
export function LegalDocumentTargets({ value, onChange, disabled, labels }: {
  value: readonly LegalTarget[]
  onChange: (value: LegalTarget[]) => void
  disabled: boolean
  labels: MarketTaskProgressLabels
}) {
  return <fieldset disabled={disabled}><legend>{labels.taskDocumentTargets}</legend>
    {value.map((document, index) => <div key={document.id}>
      <label>{`${index + 1}. ${labels.taskDocumentTitle}`}<input type="text" value={document.title}
        maxLength={100} required onChange={(event) => { onChange(value.map((item, position) => position === index
          ? { ...item, title: event.currentTarget.value } : item)) }} /></label>
      <label>{labels.taskDocumentPurpose}<input type="text" value={document.purpose} maxLength={200} required
        onChange={(event) => { onChange(value.map((item, position) => position === index
          ? { ...item, purpose: event.currentTarget.value } : item)) }} /></label>
    </div>)}
  </fieldset>
}
