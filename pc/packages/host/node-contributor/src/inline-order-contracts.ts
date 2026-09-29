/** Exact platform inline task contracts this Host can verify without an agent or file transport. */
import { capabilityIdIfRegistered } from '@deepseek-ai/dsh-compute-core'

export type InlineOrderTaskType = 'word_count' | 'text_sort'

export interface InlineOrderContract {
  readonly taskType: InlineOrderTaskType
  readonly capabilityId: 'text.transform'
  readonly inputKind: 'inline'
  readonly outputKind: 'inline_json'
  readonly contractVersion: 'v1'
  readonly sampleInput: string
  readonly sampleResultLines: readonly string[]
  readonly additionalSampleInputs?: readonly string[]
}

const CONTRACTS: Readonly<Record<InlineOrderTaskType, InlineOrderContract>> = Object.freeze({
  word_count: Object.freeze({ taskType: 'word_count', capabilityId: 'text.transform', inputKind: 'inline',
    outputKind: 'inline_json', contractVersion: 'v1', sampleInput: 'word word', sampleResultLines: ['word\t2'] }),
  text_sort: Object.freeze({ taskType: 'text_sort', capabilityId: 'text.transform', inputKind: 'inline',
    outputKind: 'inline_json', contractVersion: 'v1', sampleInput: 'z\na\nz', sampleResultLines: ['a', 'z', 'z'],
    additionalSampleInputs: [
      JSON.stringify({ lines: ['2', '11', 'bad'], params: { numeric: true, reverse: true } }),
      JSON.stringify({ lines: ['b', 'a', 'b'], params: { unique: true, case_insensitive: true } }),
    ] }),
})

/** Unknown task names have no trusted local output validator and cannot be selected. */
export function inlineOrderContractOf(taskType: string): InlineOrderContract | null {
  const contract = Object.hasOwn(CONTRACTS, taskType) ? CONTRACTS[taskType as InlineOrderTaskType] : undefined
  return contract !== undefined && capabilityIdIfRegistered(taskType) === contract.capabilityId ? contract : null
}

interface SortRequest { readonly lines: readonly string[]; readonly numeric: boolean; readonly reverse: boolean;
  readonly unique: boolean; readonly caseInsensitive: boolean }

function pythonSplitlines(raw: string): string[] {
  if (raw === '') return []
  const lines = raw.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function bool(value: unknown): boolean {
  if (value === undefined || value === false || value === null) return false
  if (value === true) return true
  throw new Error('TEXT_SORT_PARAMETERS_UNSUPPORTED')
}

/** Parse only the exact inline forms accepted by the platform text_sort script. */
function sortRequest(raw: string): SortRequest {
  const trimmed = raw.trimStart()
  let lines: unknown = pythonSplitlines(raw)
  let params: Record<string, unknown> = {}
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('TEXT_SORT_INPUT_UNSUPPORTED')
    const object = parsed as Record<string, unknown>
    params = object.params === undefined ? {} : object.params as Record<string, unknown>
    if (typeof params !== 'object' || params === null || Array.isArray(params)) throw new Error('TEXT_SORT_INPUT_UNSUPPORTED')
    lines = Array.isArray(object.lines) && object.lines.length > 0 ? object.lines : params.lines ?? []
  }
  if (!Array.isArray(lines) || !lines.every(line => typeof line === 'string')) throw new Error('TEXT_SORT_INPUT_UNSUPPORTED')
  return { lines, numeric: bool(params.numeric), reverse: bool(params.reverse), unique: bool(params.unique),
    caseInsensitive: bool(params.case_insensitive) }
}

/** Codepoint ordering matches Python's default string sort for ordinary valid UTF-8 input. */
function compareCodepoints(left: string, right: string): number {
  const a = Array.from(left)
  const b = Array.from(right)
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const delta = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!
    if (delta !== 0) return delta
  }
  return a.length - b.length
}

function numericKey(value: string): number {
  const text = value.trim()
  if (/^[+-]?nan$/iu.test(text) || text.includes('_')) throw new Error('TEXT_SORT_INPUT_UNSUPPORTED')
  if (!/^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|inf(?:inity)?)$/iu.test(text)) {
    return Number.POSITIVE_INFINITY
  }
  if (/^[+-]?inf(?:inity)?$/iu.test(text)) return text.startsWith('-')
    ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
  return Number(text)
}

/** Compute a trusted result validator without executing untrusted package code. */
export function expectedTextSort(raw: string): { readonly lines: readonly string[]; readonly summary: {
  readonly input_lines: number; readonly output_lines: number; readonly numeric: boolean;
  readonly reverse: boolean; readonly unique: boolean
}; readonly accepts: (lines: unknown) => boolean } {
  const request = sortRequest(raw)
  if (request.lines.length > 20_000) throw new Error('TEXT_SORT_INPUT_UNSUPPORTED')
  const source = request.unique ? [...new Set(request.lines)] : [...request.lines]
  const compare = (left: string, right: string): number => {
    if (request.numeric) {
      const a = numericKey(left)
      const b = numericKey(right)
      return a < b ? -1 : a > b ? 1 : 0
    }
    return compareCodepoints(request.caseInsensitive ? left.toLowerCase() : left,
      request.caseInsensitive ? right.toLowerCase() : right)
  }
  const sorted = source.sort(compare)
  if (request.reverse) sorted.reverse()
  const expectedCounts = new Map<string, number>()
  for (const line of source) expectedCounts.set(line, (expectedCounts.get(line) ?? 0) + 1)
  return { lines: sorted, summary: { input_lines: source.length, output_lines: sorted.length,
    numeric: request.numeric, reverse: request.reverse, unique: request.unique },
  accepts: (lines: unknown): boolean => {
    if (!Array.isArray(lines) || lines.length !== source.length || !lines.every(line => typeof line === 'string')) return false
    const counts = new Map(expectedCounts)
    for (const line of lines as string[]) {
      const count = counts.get(line) ?? 0
      if (count === 0) return false
      counts.set(line, count - 1)
    }
    for (let index = 1; index < lines.length; index += 1) {
      const order = compare(lines[index - 1]!, lines[index]!)
      if (request.reverse ? order < 0 : order > 0) return false
    }
    return true
  } }
}
