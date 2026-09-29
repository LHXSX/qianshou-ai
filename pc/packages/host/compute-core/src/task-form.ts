/** Read-only Shanghai task form metadata and bounded scalar parameter admission. */
import { ComputeError } from './errors.ts'

export type TaskScalar = string | number | boolean
export interface TaskScalarField {
  type: 'string' | 'integer' | 'number' | 'boolean'
  title?: string
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  enum?: readonly TaskScalar[]
  default?: TaskScalar
}
export interface TaskParamsSchema {
  type: 'object'
  properties: Readonly<Record<string, TaskScalarField>>
  required: readonly string[]
  additionalProperties: false
}
export interface TaskFormMetadata {
  formSchemaVersion: string | null
  formReady: boolean
  inputSchema: Readonly<Record<string, unknown>> | null
  paramsSchema: TaskParamsSchema | null
}

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u
const FORM_VERSION = 'qianshou.task-input-form.v1'

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function boundedJsonObject(value: unknown): Record<string, unknown> | null {
  const root = object(value)
  if (!root) return null
  try {
    const serialized = JSON.stringify(root)
    if (Buffer.byteLength(serialized, 'utf8') > 65_536) return null
    const copy: unknown = JSON.parse(serialized)
    let entries = 0
    const safe = (node: unknown, depth: number): boolean => {
      if (depth > 10) return false
      if (Array.isArray(node)) return node.length <= 128 && node.every(item => safe(item, depth + 1))
      if (node !== null && typeof node === 'object') {
        const pairs = Object.entries(node)
        entries += pairs.length
        return entries <= 512 && pairs.every(([key, item]) => key.length <= 128
          && !['__proto__', 'constructor', 'prototype'].includes(key)
          && safe(item, depth + 1))
      }
      return node === null || typeof node === 'boolean'
        || (typeof node === 'number' && Number.isFinite(node))
        || (typeof node === 'string' && node.length <= 8_000)
    }
    return safe(copy, 0) ? object(copy) : null
  } catch { return null }
}

function boundedInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000
}

function matchesField(value: TaskScalar, rule: TaskScalarField): boolean {
  if (rule.type === 'string') {
    if (typeof value !== 'string' || value.length > 8_000) return false
    if (rule.minLength !== undefined && value.length < rule.minLength) return false
    if (rule.maxLength !== undefined && value.length > rule.maxLength) return false
  } else if (rule.type === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return false
  } else if (rule.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false
  } else if (typeof value !== 'boolean') return false
  if (typeof value === 'number') {
    if (rule.minimum !== undefined && value < rule.minimum) return false
    if (rule.maximum !== undefined && value > rule.maximum) return false
  }
  return rule.enum === undefined || rule.enum.includes(value)
}

/** Admit the reviewed scalar subset; unsupported nested schemas remain unavailable. */
export function parseTaskParamsSchema(value: unknown): TaskParamsSchema | null {
  const raw = boundedJsonObject(value)
  if (!raw || raw.type !== 'object' || raw.additionalProperties !== false) return null
  const properties = object(raw.properties)
  if (!properties || Object.keys(properties).length > 32 || !Array.isArray(raw.required)
    || raw.required.length > 32) return null
  const fields: Record<string, TaskScalarField> = Object.create(null) as Record<string, TaskScalarField>
  for (const [name, candidate] of Object.entries(properties)) {
    if (!FIELD_NAME.test(name) || name === 'constructor' || name === 'prototype') return null
    const field = object(candidate)
    if (!field || !['string', 'integer', 'number', 'boolean'].includes(String(field.type))) return null
    const rule: TaskScalarField = { type: field.type as TaskScalarField['type'] }
    if (field.title !== undefined) {
      if (typeof field.title !== 'string' || field.title.length > 128) return null
      rule.title = field.title
    }
    for (const key of ['minLength', 'maxLength'] as const) {
      if (field[key] !== undefined) {
        if (!boundedInteger(field[key])) return null
        rule[key] = field[key]
      }
    }
    if (rule.minLength !== undefined && rule.maxLength !== undefined && rule.minLength > rule.maxLength) return null
    for (const key of ['minimum', 'maximum'] as const) {
      if (field[key] !== undefined) {
        if (typeof field[key] !== 'number' || !Number.isFinite(field[key])) return null
        rule[key] = field[key]
      }
    }
    if (rule.minimum !== undefined && rule.maximum !== undefined && rule.minimum > rule.maximum) return null
    if (field.enum !== undefined) {
      if (!Array.isArray(field.enum) || field.enum.length < 1 || field.enum.length > 32
        || !field.enum.every(item => ['string', 'number', 'boolean'].includes(typeof item)
          && (typeof item !== 'number' || Number.isFinite(item)))) return null
      rule.enum = field.enum as TaskScalar[]
      const withoutEnum = { ...rule }
      delete withoutEnum.enum
      if (!rule.enum.every(item => matchesField(item, withoutEnum))) return null
    }
    if (field.default !== undefined) {
      if (!['string', 'number', 'boolean'].includes(typeof field.default)
        || !matchesField(field.default as TaskScalar, rule)) return null
      rule.default = field.default as TaskScalar
    }
    fields[name] = rule
  }
  const required = raw.required as unknown[]
  if (new Set(required).size !== required.length
    || !required.every(name => typeof name === 'string' && Object.hasOwn(fields, name))) return null
  return { type: 'object', properties: fields, required: required as string[], additionalProperties: false }
}

/** Copy only bounded catalog form data; malformed new forms cannot authorize a quote. */
export function parseTaskFormMetadata(item: Record<string, unknown>): TaskFormMetadata {
  const formSchemaVersion = typeof item.form_schema_version === 'string' ? item.form_schema_version : null
  const inputSchema = boundedJsonObject(item.input_schema)
  const paramsSchema = parseTaskParamsSchema(item.params_schema)
  return {
    formSchemaVersion,
    formReady: formSchemaVersion === FORM_VERSION && item.form_ready === true
      && inputSchema !== null && paramsSchema !== null,
    inputSchema,
    paramsSchema,
  }
}

/** Validate the exact submitted scalar fields against the reviewed catalog row. */
export function admitInlineTaskParams(
  params: Readonly<Record<string, TaskScalar>> | undefined,
  requiredParams: readonly string[] | null | undefined,
  metadata: TaskFormMetadata,
): Record<string, TaskScalar> {
  const supplied = params ?? {}
  const keys = Object.keys(supplied)
  if (metadata.formSchemaVersion !== null && !metadata.formReady) {
    throw new ComputeError('COMPUTE_INPUT_KIND_UNSUPPORTED', 409)
  }
  if (keys.length === 0 && (!requiredParams || requiredParams.length === 0) && metadata.formSchemaVersion === null) return {}
  const schema = metadata.paramsSchema
  if (!metadata.formReady || !schema || !Array.isArray(requiredParams)
    || !requiredParams.every(name => Object.hasOwn(schema.properties, name))) {
    throw new ComputeError('COMPUTE_INPUT_PARAMS_INVALID', 409)
  }
  const required = new Set([...requiredParams, ...schema.required])
  if ([...required].some(name => !Object.hasOwn(supplied, name))) throw new ComputeError('COMPUTE_INPUT_PARAMS_INVALID', 409)
  const admitted: Record<string, TaskScalar> = Object.create(null) as Record<string, TaskScalar>
  for (const key of keys.sort()) {
    const rule = schema.properties[key]
    const value = supplied[key]
    if (!rule || value === undefined || !matchesField(value, rule)
      || (required.has(key) && typeof value === 'string' && !value.trim())) {
      throw new ComputeError('COMPUTE_INPUT_PARAMS_INVALID', 409)
    }
    admitted[key] = value
  }
  return admitted
}
