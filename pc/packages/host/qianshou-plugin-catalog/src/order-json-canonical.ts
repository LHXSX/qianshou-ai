/** Canonical UTF-8 JSON used by the Shanghai and Guangzhou v5 source contract. */
import { CatalogFailure } from './registry.ts'

function invalid(): never { throw new CatalogFailure('order-adapter-invalid') }

function number(value: number): string {
  if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) invalid()
  if (value === 0) return '0'
  const encoded = Math.abs(value) < 1e-4 ? value.toExponential() : JSON.stringify(value)
  if (!encoded.includes('e')) return encoded
  const [mantissa, exponentText] = encoded.split('e')
  const exponent = Number(exponentText)
  if (!Number.isSafeInteger(exponent) || mantissa === undefined) invalid()
  return `${mantissa}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`
}

/** Match Python's sorted-key, compact, ensure_ascii=False JSON for the bounded source subset. */
export function canonicalOrderJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalOrderJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalOrderJson(row[key])}`).join(',')}}`
  }
  if (typeof value === 'number') return number(value)
  const encoded = JSON.stringify(value)
  if (encoded === undefined) invalid()
  return encoded
}
