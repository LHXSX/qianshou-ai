import { marketInputDraft, type MarketInputDraft, type MarketInputRule } from './market-input-form.ts'

export interface MarketInputLabels {
  content: string
  optional: string
  choose: string
  yes: string
  no: string
  add: string
  remove: string
}

/** Recursive controls are derived from reviewed data; they never infer business fields from examples. */
export function MarketInputFields({ rule, value, onChange, disabled, labels, required = true }: {
  rule: MarketInputRule
  value: MarketInputDraft
  onChange(value: MarketInputDraft): void
  disabled: boolean
  labels: MarketInputLabels
  required?: boolean
}) {
  if (Object.prototype.hasOwnProperty.call(rule, 'constant') || rule.type === 'null') return null
  const title = rule.title ?? labels.content
  const label = `${title}${required ? '' : ` (${labels.optional})`}`
  if (rule.type === 'object') {
    const values = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    const fields = Object.entries(rule.properties ?? {})
    const content = fields.map(([key, child]) => <MarketInputFields key={key} rule={child}
      value={values[key] ?? marketInputDraft(child)} required={rule.required?.includes(key) === true}
      disabled={disabled} labels={labels} onChange={next => { onChange({ ...values, [key]: next }) }} />)
    return rule.title ? <fieldset disabled={disabled}><legend>{label}</legend>{content}</fieldset> : <>{content}</>
  }
  if (rule.type === 'array') {
    const items = Array.isArray(value) ? value : []
    return <fieldset disabled={disabled}><legend>{label}</legend>
      {items.map((item, index) => <div key={index}>
        <MarketInputFields rule={rule.items!} value={item} disabled={disabled} labels={labels}
          onChange={next => { onChange(items.map((previous, at) => at === index ? next : previous)) }} />
        <button type="button" disabled={disabled || items.length <= (rule.minItems ?? 0)}
          aria-label={`${labels.remove} ${index + 1}`} onClick={() => { onChange(items.filter((_, at) => at !== index)) }}>
          {labels.remove}
        </button>
      </div>)}
      <button type="button" disabled={disabled || items.length >= (rule.maxItems ?? 128)}
        onClick={() => { onChange([...items, marketInputDraft(rule.items!)]) }}>{labels.add}</button>
    </fieldset>
  }
  if (rule.type === 'boolean') return <label>{label}
    <select value={typeof value === 'boolean' ? String(value) : ''} disabled={disabled}
      onChange={event => { onChange(event.currentTarget.value === '' ? '' : event.currentTarget.value === 'true') }}>
      <option value="">{labels.choose}</option><option value="true">{labels.yes}</option><option value="false">{labels.no}</option>
    </select>
  </label>
  const text = typeof value === 'string' ? value : ''
  if (rule.choices) return <label>{label}<select value={text} disabled={disabled}
    onChange={event => { onChange(event.currentTarget.value) }}>
    <option value="">{labels.choose}</option>
    {rule.choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}
  </select></label>
  if (rule.type === 'string') return <label>{label}<textarea value={text} rows={3}
    disabled={disabled} maxLength={(rule.maxLength ?? 16384) * 2} required={required}
    placeholder={title} onChange={event => { onChange(event.currentTarget.value) }} /></label>
  return <label>{label}<input type="number" value={text} required={required} disabled={disabled}
    step={rule.type === 'integer' ? 1 : 'any'} min={rule.minimum} max={rule.maximum}
    onChange={event => { onChange(event.currentTarget.value) }} /></label>
}
