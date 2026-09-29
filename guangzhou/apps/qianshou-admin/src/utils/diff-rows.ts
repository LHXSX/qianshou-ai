/** `before → after` 差异的展示行构造（纯函数，便于单测）。 */

import { stringifyDiffValue } from '@/utils/format'

export interface DiffRow {
  readonly path: string
  readonly before: string
  readonly after: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把两个 JSON 对象压平成逐字段对照表；非对象值退化为单个整体对比行。 */
export function flattenDiffRows(before: unknown, after: unknown): DiffRow[] {
  if (!isPlainObject(before) && !isPlainObject(after)) {
    return [{ path: '（整个对象）', before: stringifyDiffValue(before), after: stringifyDiffValue(after) }]
  }

  const left = isPlainObject(before) ? before : {}
  const right = isPlainObject(after) ? after : {}
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort((a, b) => a.localeCompare(b))
  return keys.map(key => ({
    path: key,
    before: stringifyDiffValue(left[key]),
    after: stringifyDiffValue(right[key]),
  }))
}

/** 值是否真的变化（用于视觉弱化未变化的行）。 */
export function rowChanged(row: DiffRow): boolean {
  return row.before !== row.after
}
