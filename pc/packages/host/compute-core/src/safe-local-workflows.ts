/** Reviewed, no-network recipes that the Host can turn into private local plugins.
 * Adding an entry requires a matching fixed implementation in plugin-candidate.ts.
 * A model-provided reference alone never becomes executable code.
 */
import type { PluginDraftSchema, PluginDraftSpec } from './plugin-draft.ts'

const textInput: PluginDraftSchema = { type: 'object', properties: { text: { type: 'string' } },
  required: ['text'], additionalProperties: false }
const statisticsOutput: PluginDraftSchema = { type: 'object', properties: {
  characters: { type: 'integer' }, utf8Bytes: { type: 'integer' },
  nonemptyLines: { type: 'integer' }, sha256: { type: 'string' },
}, required: ['characters', 'utf8Bytes', 'nonemptyLines', 'sha256'], additionalProperties: false }
const wordCounts: PluginDraftSchema = { type: 'array', items: { type: 'object', properties: {
  word: { type: 'string' }, count: { type: 'integer' },
}, required: ['word', 'count'], additionalProperties: false } }

export const SAFE_LOCAL_WORKFLOWS = {
  'qianshou:text-statistics-v1': {
    category: 'text', version: '1.0.0', pluginId: 'owner.text-statistics', operationId: 'owner.text-statistics.count',
    title: '统计文字', description: '统计字符数、UTF-8 字节数、非空行数和 SHA-256 摘要',
    inputSchema: textInput, outputSchema: statisticsOutput, minOutputBytes: 256,
  },
  'qianshou:text-statistics-v2': {
    category: 'text', version: '2.0.0', pluginId: 'owner.text-statistics', operationId: 'owner.text-statistics.count',
    title: '统计文字', description: '统计词频、字符数、UTF-8 字节数、非空行数和 SHA-256 摘要',
    inputSchema: textInput, outputSchema: { type: 'object', properties: {
      ...statisticsOutput.properties, wordCounts,
    }, required: [...statisticsOutput.required!, 'wordCounts'], additionalProperties: false } as PluginDraftSchema,
    minOutputBytes: 262144,
  },
  'qianshou:text-reverse-v1': {
    category: 'text', version: '1.0.0', pluginId: 'owner.text-reverse', operationId: 'owner.text-reverse.reverse',
    title: '反转文字', description: '按 Unicode 字符顺序反转输入文字',
    inputSchema: textInput, outputSchema: { type: 'object', properties: { reversed: { type: 'string' } },
      required: ['reversed'], additionalProperties: false } as PluginDraftSchema,
    minOutputBytes: 262144,
  },
} as const

export type SafeLocalWorkflowRef = keyof typeof SAFE_LOCAL_WORKFLOWS

export function safeLocalWorkflow(ref: string) {
  return Object.hasOwn(SAFE_LOCAL_WORKFLOWS, ref)
    ? SAFE_LOCAL_WORKFLOWS[ref as SafeLocalWorkflowRef] : undefined
}

/** Build the full, strictly scoped draft rather than asking a model to invent schemas. */
export function safeLocalWorkflowSpec(ref: SafeLocalWorkflowRef, displayName: string, pluginId?: string): PluginDraftSpec {
  const workflow = SAFE_LOCAL_WORKFLOWS[ref]
  return { pluginId: pluginId ?? workflow.pluginId, version: workflow.version, displayName,
    operations: [{ id: workflow.operationId, title: workflow.title, description: workflow.description,
      binding: { kind: 'workflow', ref }, inputSchema: workflow.inputSchema,
      outputSchema: workflow.outputSchema, permissions: [], dataScope: 'task-inputs',
      networkOrigins: [], dependencies: [], resources: {
        minTotalMemoryBytes: 0, minFreeDiskBytes: 0, maxInputBytes: 65536,
        maxOutputBytes: workflow.minOutputBytes, maxRunMs: 1000,
      } }],
  }
}
