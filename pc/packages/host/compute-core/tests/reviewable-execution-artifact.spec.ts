import { expect, it } from 'vitest'
import { parsePluginDraftSpec, type LocalPluginDraft, type PluginDraftResources } from '../src/plugin-draft.ts'
import { buildReviewableExecutionArtifact, evaluateReviewableExecution,
  verifyReviewableExecutionArtifact } from '../src/reviewable-execution-artifact.ts'

const resources: PluginDraftResources = { platforms: ['darwin', 'win32'], architectures: ['arm64', 'x64'],
  minTotalMemoryBytes: 0, minFreeDiskBytes: 0, maxInputBytes: 4096,
  maxOutputBytes: 4096, maxRunMs: 10_000 }
function draft(): LocalPluginDraft {
  const spec = parsePluginDraftSpec({ pluginId: 'creator.string-kit', version: '1.0.0',
    displayName: 'Private /Users/owner/secret-name', operations: [
      { id: 'text.clean', title: 'Do not export secret-title', description: 'secret-demo-token',
        binding: { kind: 'tool', ref: 'tool:qianshou.string-map.v1' },
        inputSchema: { type: 'object', description: '/Users/owner/private/sample.txt',
          properties: { source: { type: 'string', description: 'secret-demo-token' } },
          required: ['source'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { cleaned: { type: 'string' } },
          required: ['cleaned'], additionalProperties: false },
        permissions: [], dataScope: 'task-inputs', networkOrigins: [], dependencies: [], resources },
      { id: 'text.case', title: 'Case conversion', description: 'A second operation',
        binding: { kind: 'tool', ref: 'tool:qianshou.string-map.v1' },
        inputSchema: { type: 'object', properties: { source: { type: 'string' } },
          required: ['source'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { upper: { type: 'string' }, lower: { type: 'string' } },
          required: ['upper', 'lower'], additionalProperties: false },
        permissions: [], dataScope: 'task-inputs', networkOrigins: [], dependencies: [], resources },
    ] })
  return { id: 'plugin_draft_00000000-0000-0000-0000-000000000009',
    createdAt: '2026-09-24T08:00:00.000Z', updatedAt: '2026-09-24T08:30:00.000Z',
    state: 'private-draft', installable: false, dispatchable: false,
    readiness: { adapter: 'pending', probe: 'pending', signing: 'pending', review: 'pending' }, spec }
}
function input() {
  return { draft: draft(), capabilityIds: { 'text.clean': 'text.clean', 'text.case': 'text.case' },
    programs: {
      'text.clean': { mappings: [{ from: 'source', to: 'cleaned', transform: 'trim' }] },
      'text.case': { mappings: [
        { from: 'source', to: 'upper', transform: 'ascii-upper' },
        { from: 'source', to: 'lower', transform: 'ascii-lower' },
      ] },
    } }
}

it('builds deterministic multi-operation implementation bytes and executes only packaged programs', () => {
  const first = buildReviewableExecutionArtifact(input())
  const second = buildReviewableExecutionArtifact(input())
  expect(first.bytes.equals(second.bytes)).toBe(true)
  expect(first.packageSha256).toBe(second.packageSha256)
  expect(first).toMatchObject({ reviewed: false, installable: false,
    publishable: false, dispatchable: false })
  const checked = verifyReviewableExecutionArtifact(first.bytes)
  expect(checked.packageSha256).toBe(first.packageSha256)
  expect(checked.manifest.operations).toHaveLength(2)
  expect(checked.manifest.operations[0]?.executor.kind).toBe('qianshou.string-map.v1')
  expect(checked.manifest.operations[1]?.implementationSha256).toMatch(/^[0-9a-f]{64}$/u)
  expect(evaluateReviewableExecution(first.bytes, 'text.clean', { source: '  Hello World  ' }))
    .toEqual({ cleaned: 'Hello World' })
  expect(evaluateReviewableExecution(first.bytes, 'text.case', { source: 'AbC Ä' }))
    .toEqual({ lower: 'abc Ä', upper: 'ABC Ä' })
  for (const privateText of ['secret-demo-token', 'secret-title', '/Users/owner',
    'Private /Users', 'sample.txt']) expect(first.bytes.includes(Buffer.from(privateText))).toBe(false)
})

it('rejects executable-looking or unsupported bindings and every undeclared capability', () => {
  const valid = input()
  for (const binding of [
    { kind: 'workflow' as const, ref: 'workflow:owner-local' },
    { kind: 'local-model' as const, ref: 'model:owner-local' },
    { kind: 'tool' as const, ref: 'tool:arbitrary-adapter' },
  ]) {
    const altered = { ...valid.draft, spec: { ...valid.draft.spec,
      operations: [{ ...valid.draft.spec.operations[0]!, binding,
        permissions: binding.kind === 'local-model' ? ['model.local'] as const : [] },
      valid.draft.spec.operations[1]!] } }
    expect(() => buildReviewableExecutionArtifact({ ...valid, draft: altered }))
      .toThrow('COMPUTE_REVIEWABLE_EXECUTION_INVALID')
  }
  expect(() => buildReviewableExecutionArtifact({ ...valid,
    capabilityIds: { 'text.clean': 'text.clean' } }))
    .toThrow('COMPUTE_REVIEWABLE_EXECUTION_INVALID')
  const workspace = { ...valid.draft, spec: { ...valid.draft.spec, operations: [
    { ...valid.draft.spec.operations[0]!, permissions: ['workspace.read'] as const,
      dataScope: 'workspace' as const }, valid.draft.spec.operations[1]!,
  ] } }
  expect(() => buildReviewableExecutionArtifact({ ...valid, draft: workspace }))
    .toThrow('COMPUTE_REVIEWABLE_EXECUTION_INVALID')
})

it('rejects literal, path, extra-key and missing-field programs instead of silently stripping them', () => {
  const valid = input()
  const attempts: unknown[] = [
    { mappings: [{ from: '/Users/owner/file', to: 'cleaned', transform: 'copy' }] },
    { mappings: [{ from: 'source', to: 'cleaned', transform: 'copy', literal: 'secret' }] },
    { mappings: [{ from: 'source', to: 'cleaned', transform: 'eval' }] },
    { mappings: [] },
  ]
  for (const program of attempts) {
    expect(() => buildReviewableExecutionArtifact({ ...valid,
      programs: { ...valid.programs, 'text.clean': program } }))
      .toThrow('COMPUTE_REVIEWABLE_EXECUTION_INVALID')
  }
})

it('rejects mutation, ambiguous JSON and unknown executor versions before evaluation', () => {
  const built = buildReviewableExecutionArtifact(input())
  const changed = JSON.parse(built.bytes.toString('utf8')) as Record<string, unknown>
  const operations = changed['operations'] as Array<Record<string, unknown>>
  const executor = operations[0]!['executor'] as Record<string, unknown>
  const program = executor['program'] as Record<string, unknown>
  const mappings = program['mappings'] as Array<Record<string, unknown>>
  mappings[0]!['transform'] = 'copy'
  expect(() => verifyReviewableExecutionArtifact(Buffer.from(JSON.stringify(changed))))
    .toThrow('COMPUTE_REVIEWABLE_EXECUTION_INVALID')
  executor['kind'] = 'qianshou.shell.v1'
  expect(() => verifyReviewableExecutionArtifact(Buffer.from(JSON.stringify(changed))))
    .toThrow('COMPUTE_REVIEWABLE_EXECUTION_INVALID')
  expect(() => verifyReviewableExecutionArtifact(Buffer.from(`${built.bytes.toString('utf8')} `)))
    .toThrow('COMPUTE_REVIEWABLE_EXECUTION_INVALID')
  expect(() => verifyReviewableExecutionArtifact(Buffer.from('{"format":"a","format":"b"}')))
    .toThrow('COMPUTE_REVIEWABLE_EXECUTION_INVALID')
  expect(() => evaluateReviewableExecution(built.bytes, 'text.clean', { source: 'x', extra: 'y' }))
    .toThrow('COMPUTE_REVIEWABLE_EXECUTION_INVALID')
  expect(() => evaluateReviewableExecution(built.bytes, 'text.unknown', { source: 'x' }))
    .toThrow('COMPUTE_REVIEWABLE_EXECUTION_INVALID')
})

it('enforces complete input and output byte caps with multibyte values', () => {
  const valid = input()
  const limited = { ...valid.draft, spec: { ...valid.draft.spec, operations: [
    { ...valid.draft.spec.operations[0]!, resources: { ...resources, maxInputBytes: 24,
      maxOutputBytes: 24 } }, valid.draft.spec.operations[1]!,
  ] } }
  const built = buildReviewableExecutionArtifact({ ...valid, draft: limited })
  expect(() => evaluateReviewableExecution(built.bytes, 'text.clean', { source: '😀😀😀' }))
    .toThrow('COMPUTE_REVIEWABLE_EXECUTION_INVALID')
  const outputLimited = { ...valid.draft, spec: { ...valid.draft.spec, operations: [
    { ...valid.draft.spec.operations[0]!, resources: { ...resources, maxInputBytes: 100,
      maxOutputBytes: 17 } }, valid.draft.spec.operations[1]!,
  ] } }
  const output = buildReviewableExecutionArtifact({ ...valid, draft: outputLimited })
  expect(() => evaluateReviewableExecution(output.bytes, 'text.clean', { source: 'abcde' }))
    .toThrow('COMPUTE_REVIEWABLE_EXECUTION_INVALID')
})
