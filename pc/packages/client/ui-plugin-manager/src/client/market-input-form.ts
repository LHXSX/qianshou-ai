/** A bounded, reviewed input shape becomes ordinary controls, never user-written JSON. */
export type MarketInputValue = null | string | number | boolean | MarketInputValue[]
  | { [key: string]: MarketInputValue }

export interface MarketInputRule {
  type: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null'
  title?: string
  constant?: string | number | boolean | null
  properties?: Record<string, MarketInputRule>
  required?: string[]
  items?: MarketInputRule
  minItems?: number
  maxItems?: number
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  choices?: string[]
}

export type MarketInputDraft = string | boolean | null | MarketInputDraft[]
  | { [key: string]: MarketInputDraft }

const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MARKET_INPUT_FORM_INVALID')
  return value as Record<string, unknown>
}

/** Reject unsupported rules before exposing controls that could promise the wrong contract. */
export function parseMarketInputRule(schema: unknown): MarketInputRule {
  if (new TextEncoder().encode(JSON.stringify(schema)).byteLength > 4096) throw new Error('MARKET_INPUT_FORM_INVALID')
  let nodes = 0
  const walk = (value: unknown, depth: number): MarketInputRule => {
    if (++nodes > 64 || depth > 5) throw new Error('MARKET_INPUT_FORM_INVALID')
    const row = record(value)
    const title = row.title
    if (title !== undefined && (typeof title !== 'string' || title.length > 100)) throw new Error('MARKET_INPUT_FORM_INVALID')
    const base = typeof title === 'string' ? { title } : {}
    if (own(row, 'const')) {
      const constant = row.const
      if ((constant !== null && !['string', 'number', 'boolean'].includes(typeof constant))
        || (typeof constant === 'number' && !Number.isFinite(constant))
        || Object.keys(row).some(key => !['const', 'type', 'title'].includes(key))) throw new Error('MARKET_INPUT_FORM_INVALID')
      const type = constant === null ? 'null' : typeof constant as 'string' | 'number' | 'boolean'
      if (row.type !== undefined && row.type !== type) throw new Error('MARKET_INPUT_FORM_INVALID')
      return { ...base, type, constant: constant as string | number | boolean | null }
    }
    const type = row.type
    if (!['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(String(type))) throw new Error('MARKET_INPUT_FORM_INVALID')
    const allowed = ['type', 'title']
    const bounded = (lowName: string, highName: string, fallbackLow: number, fallbackHigh: number, ceiling: number): [number, number] => {
      const low = row[lowName] ?? fallbackLow, high = row[highName] ?? fallbackHigh
      if (typeof low !== 'number' || typeof high !== 'number' || !Number.isSafeInteger(low)
        || !Number.isSafeInteger(high) || low < 0 || high < low || high > ceiling) throw new Error('MARKET_INPUT_FORM_INVALID')
      return [low, high]
    }
    let rule: MarketInputRule = { ...base, type: type as MarketInputRule['type'] }
    if (type === 'object') {
      allowed.push('properties', 'required', 'additionalProperties')
      const properties = record(row.properties), keys = Object.keys(properties), required = row.required ?? []
      if (row.additionalProperties !== false || keys.length > 32 || !Array.isArray(required)
        || required.length > 32 || new Set(required).size !== required.length
        || required.some(key => typeof key !== 'string' || !own(properties, key))
        || keys.some(key => !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u.test(key)
          || ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('MARKET_INPUT_FORM_INVALID')
      rule = { ...rule, required: required as string[],
        properties: Object.fromEntries(keys.map(key => [key, walk(properties[key], depth + 1)])) }
    } else if (type === 'array') {
      allowed.push('items', 'minItems', 'maxItems')
      const [minItems, maxItems] = bounded('minItems', 'maxItems', 0, 128, 128)
      rule = { ...rule, minItems, maxItems, items: walk(row.items, depth + 1) }
    } else if (type === 'string') {
      allowed.push('minLength', 'maxLength', 'enum')
      const [minLength, maxLength] = bounded('minLength', 'maxLength', 0, 16384, 16384)
      if (row.enum !== undefined && (!Array.isArray(row.enum) || row.enum.length < 1 || row.enum.length > 32
        || row.enum.some(item => typeof item !== 'string'))) throw new Error('MARKET_INPUT_FORM_INVALID')
      rule = { ...rule, minLength, maxLength, ...(row.enum === undefined ? {} : { choices: row.enum as string[] }) }
    } else if (type === 'integer' || type === 'number') {
      allowed.push('minimum', 'maximum')
      const minimum = row.minimum, maximum = row.maximum
      if ([minimum, maximum].some(item => item !== undefined && (typeof item !== 'number' || !Number.isFinite(item)))
        || (typeof minimum === 'number' && typeof maximum === 'number' && minimum > maximum)) throw new Error('MARKET_INPUT_FORM_INVALID')
      rule = { ...rule, ...(typeof minimum === 'number' ? { minimum } : {}),
        ...(typeof maximum === 'number' ? { maximum } : {}) }
    }
    if (Object.keys(row).some(key => !allowed.includes(key))) throw new Error('MARKET_INPUT_FORM_INVALID')
    return rule
  }
  const rule = walk(schema, 0)
  if (rule.type !== 'object' || !Object.keys(rule.properties ?? {}).length) throw new Error('MARKET_INPUT_FORM_INVALID')
  return rule
}

/** Initialize from model-provided structured data only when it fits the declared controls. */
export function marketInputDraft(rule: MarketInputRule, initial?: unknown): MarketInputDraft {
  if (own(rule, 'constant')) return rule.constant === null ? null : String(rule.constant)
  if (rule.type === 'object') {
    const source = initial && typeof initial === 'object' && !Array.isArray(initial) ? initial as Record<string, unknown> : {}
    return Object.fromEntries(Object.entries(rule.properties ?? {}).map(([key, child]) => [key, marketInputDraft(child, source[key])]))
  }
  if (rule.type === 'array') {
    const source = Array.isArray(initial) ? initial.slice(0, rule.maxItems ?? 128) : Array.from({ length: rule.minItems ?? 0 })
    return source.map(item => marketInputDraft(rule.items!, item))
  }
  if (rule.type === 'null') return null
  if (rule.type === 'boolean') return typeof initial === 'boolean' ? initial : ''
  return typeof initial === 'string' || typeof initial === 'number' ? String(initial) : ''
}

/** Serialize controls against the same bounded shape, preserving whitespace in task text. */
export function serializeMarketInput(rule: MarketInputRule, draft: MarketInputDraft, maxLength = 16384): string | null {
  const invalid = Symbol('invalid'), absent = Symbol('absent')
  const empty = (value: MarketInputDraft): boolean => value === '' || value === undefined
    || (Array.isArray(value) ? value.length === 0
      : value !== null && typeof value === 'object' && Object.values(value).every(empty))
  const build = (node: MarketInputRule, value: MarketInputDraft, required: boolean): MarketInputValue | typeof invalid | typeof absent => {
    if (own(node, 'constant')) return node.constant!
    if (!required && !own(node, 'constant') && empty(value)) return absent
    if (node.type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid
      const output: Record<string, MarketInputValue> = {}
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        const item = build(child, value[key] ?? '', node.required?.includes(key) === true)
        if (item === invalid) return invalid
        if (item !== absent) output[key] = item
      }
      return !required && !Object.keys(output).length ? absent : output
    }
    if (node.type === 'array') {
      if (!Array.isArray(value) || value.length < (node.minItems ?? 0) || value.length > (node.maxItems ?? 128)) return invalid
      const output: MarketInputValue[] = []
      for (const item of value) {
        const parsed = build(node.items!, item, true)
        if (parsed === invalid || parsed === absent) return invalid
        output.push(parsed)
      }
      return output
    }
    if (node.type === 'null') return null
    if (node.type === 'boolean') return typeof value === 'boolean' ? value : invalid
    if (typeof value !== 'string') return invalid
    if (node.type === 'string') {
      const length = Array.from(value).length
      return length >= (node.minLength ?? 0) && length <= (node.maxLength ?? 16384)
        && (!node.choices || node.choices.includes(value)) ? value : invalid
    }
    if (!value.trim()) return invalid
    const number = Number(value)
    return Number.isFinite(number) && (node.type !== 'integer' || Number.isSafeInteger(number))
      && (node.minimum === undefined || number >= node.minimum)
      && (node.maximum === undefined || number <= node.maximum) ? number : invalid
  }
  const value = build(rule, draft, true)
  if (value === invalid || value === absent) return null
  const result = JSON.stringify(value)
  return result.length <= maxLength && new TextEncoder().encode(result).byteLength <= 64 * 1024 ? result : null
}
