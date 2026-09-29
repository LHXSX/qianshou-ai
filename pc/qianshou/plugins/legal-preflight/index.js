/** Deterministic document preflight. This package makes no legal judgments. */
export const name = 'qianshou-legal-preflight'
export const inject = ['tools']

const notice = '仅供材料整理，可能漏检；不构成法律意见，须由执业律师复核。'
const dateNotice = '只做自然日加算，不处理法定节假日、法定期间或送达规则；不得作为法律截止日使用。'
const textInput = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }
const dateInput = { type: 'object', properties: { startDate: { type: 'string' }, durationDays: { type: 'integer' } },
  required: ['startDate', 'durationDays'], additionalProperties: false }
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }

function only(value, names) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key))
}

function checkedText(args) {
  if (!only(args, ['text']) || typeof args.text !== 'string' || Buffer.byteLength(args.text) > 65536) throw new Error('INVALID_ARGUMENT')
  return args.text
}

function redact(text) {
  let hitCount = 0
  const matchedKinds = []
  let redacted = text.replace(/(?<![0-9A-Za-z])\d{17}[0-9Xx](?![0-9A-Za-z])/gu, value => {
    hitCount++
    if (!matchedKinds.includes('id_card')) matchedKinds.push('id_card')
    return value.slice(0, 4) + '*'.repeat(10) + value.slice(-4)
  })
  redacted = redacted.replace(/(?<![0-9A-Za-z])1[3-9]\d{9}(?![0-9A-Za-z])/gu, value => {
    hitCount++
    if (!matchedKinds.includes('mobile')) matchedKinds.push('mobile')
    return value.slice(0, 3) + '****' + value.slice(-4)
  })
  return { redacted, hitCount, matchedKinds, notice }
}

const terms = ['保证责任', '定金', '订金', '保证', '担保', '解除', '撤销']
function scanTerms(text) {
  const occupied = new Set()
  const matches = []
  for (const term of terms) {
    let from = 0
    while (from < text.length) {
      const index = text.indexOf(term, from)
      if (index < 0) break
      if (Array.from({ length: term.length }, (_, offset) => index + offset).every(position => !occupied.has(position))) {
        matches.push({ term, index })
        for (let position = index; position < index + term.length; position++) occupied.add(position)
      }
      from = index + 1
    }
  }
  matches.sort((a, b) => a.index - b.index || b.term.length - a.term.length)
  return { matches, termCount: matches.length, notice }
}

function addCalendarDays(args) {
  if (!only(args, ['startDate', 'durationDays']) || typeof args.startDate !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/u.test(args.startDate)
    || !Number.isSafeInteger(args.durationDays) || args.durationDays < 1 || args.durationDays > 366) throw new Error('INVALID_ARGUMENT')
  const [year, month, day] = args.startDate.split('-').map(Number)
  const start = new Date(0)
  start.setUTCFullYear(year, month - 1, day)
  start.setUTCHours(0, 0, 0, 0)
  if (start.toISOString().slice(0, 10) !== args.startDate) throw new Error('INVALID_ARGUMENT')
  start.setUTCDate(start.getUTCDate() + args.durationDays)
  return { date: start.toISOString().slice(0, 10), approximate: true, notice: dateNotice }
}

export function apply(ctx) {
  for (const [toolName, title, parameters, run] of [
    ['qianshou_legal_redact', '号码遮蔽', textInput, text => redact(text)],
    ['qianshou_legal_terms', '术语定位', textInput, text => scanTerms(text)],
    ['qianshou_calendar_add', '自然日加算', dateInput, _ => null],
  ]) {
    ctx.effect(() => ctx.tools.register({
      name: toolName,
      description: `${title}；确定性材料前处理，不构成法律意见。`,
      parameters, output,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const value = toolName === 'qianshou_calendar_add' ? addCalendarDays(args) : run(checkedText(args))
        const result = JSON.stringify(value)
        if (Buffer.byteLength(result) > 131072) throw new Error('OUTPUT_TOO_LARGE')
        return result
      },
      presentCall: () => ({ card: 'generic', title, kind: 'read' }),
    }), `qianshou legal preflight: ${toolName}`)
  }
}
