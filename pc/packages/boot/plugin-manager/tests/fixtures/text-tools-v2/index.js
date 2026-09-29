/** Controlled local fixture: deterministic text statistics, with no file or network access. */
import { createHash } from 'node:crypto'
export const name = 'qianshou-text-tools-fixture'
export const inject = ['tools']
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'qianshou_text_statistics',
    description: 'Compute deterministic Unicode character, nonempty line and UTF-8 byte counts and SHA-256 for supplied text. No file or network access.',
    parameters: { type: 'object', properties: { text: { type: 'string', description: 'Text to measure, at most 65536 UTF-8 bytes.' } },
      required: ['text'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (typeof args !== 'object' || args === null || typeof args.text !== 'string' || Object.keys(args).some(key => key !== 'text')) {
        throw new Error('INVALID_TEXT_ARGUMENT')
      }
      const { text } = args
      exec.signal.throwIfAborted()
      const bytes = Buffer.byteLength(text)
      if (bytes > 65536) throw new Error('TEXT_TOO_LARGE')
      return JSON.stringify({ version: '2.0.0', characters: Array.from(text).length, utf8Bytes: bytes,
        nonemptyLines: text.split(/\r?\n/).filter(line => line.trim() !== '').length,
        sha256: createHash('sha256').update(text).digest('hex'), whitespaceSeparatedWords: text.trim() === '' ? 0 : text.trim().split(/\s+/u).length })
    },
    presentCall: args => ({ card: 'generic', title: '文本统计', kind: 'read', rawInput: args }),
  }), 'qianshou-text-tools: text statistics')
}
