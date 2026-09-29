/** 展示层格式化工具：只做纯函数转换，不含任何业务判断。 */

/** 时间戳（毫秒）→ 本地时间字符串；空值返回 `—` 而不是伪造数据。 */
export function formatTime(value: number | undefined | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—'
  const date = new Date(value)
  const pad = (input: number, width = 2): string => String(input).padStart(width, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/** 毫秒 → 「x天x小时x分」；用于健康检查 uptime。 */
export function formatDuration(ms: number | undefined | null): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
  const totalSeconds = Math.floor(ms / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (days > 0) return `${days} 天 ${hours} 小时 ${minutes} 分`
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`
  return `${seconds} 秒`
}

/** 数值兜底显示：非数字返回 `—`，避免把 undefined 渲染成 0。 */
export function formatNumber(value: number | undefined | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return value.toLocaleString('zh-CN')
}

/** SP（算力点）显示：带正负号，便于在流水里一眼看清增减。 */
export function formatSignedSp(value: number | undefined | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toLocaleString('zh-CN')}`
}

/** 金额（元）显示。 */
export function formatCny(value: number | undefined | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return `¥${value.toFixed(2)}`
}

/** JSON 差异展示：未知值序列化，保证「不显示 undefined」。 */
export function stringifyDiffValue(value: unknown): string {
  if (value === undefined) return '（未提供）'
  if (value === null) return 'null'
  if (typeof value === 'string') return value === '' ? '（空字符串）' : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** 复制到剪贴板；返回是否成功（失败由调用方决定是否提示）。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    return false
  }
  return false
}
