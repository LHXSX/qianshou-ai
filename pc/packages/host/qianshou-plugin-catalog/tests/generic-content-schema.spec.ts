import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { runGenericOrderChallenge, verifyGenericOrderAdapter } from '../src/generic-order-adapter.ts'
import { readGenericOrderSource } from '../src/generic-order-source.ts'
import { canonicalOrderJson } from '../src/order-json-canonical.ts'
import { skillAuthoringTemplate } from '../src/skill-authoring-template.ts'

const homes: string[] = []
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }) })

const contentSchema = { type: 'object', title: '整理资料', additionalProperties: false,
  required: ['label', 'quantity', 'ratio', 'enabled', 'rows'], properties: {
    label: { type: 'string', title: '名称', minLength: 1, maxLength: 4, enum: ['甲🙂', '乙'] },
    quantity: { type: 'integer', title: '数量', minimum: 1, maximum: 3 },
    ratio: { type: 'number', title: '比例', minimum: 0, maximum: 1 },
    enabled: { type: 'boolean', title: '启用' },
    rows: { type: 'array', title: '条目', minItems: 1, maxItems: 2,
      items: { type: 'object', additionalProperties: false, required: ['memo'],
        properties: { memo: { type: 'null', title: '备注' } } } },
  } }
const value = { label: '甲🙂', quantity: 2, ratio: 0.5, enabled: true, rows: [{ memo: null }] }

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'reviewed-content-schema-'))
  homes.push(home)
  await cp(fileURLToPath(new URL('../examples/quickjs-char-count-skill/', import.meta.url)), home, { recursive: true })
  const root = join(home, 'scripts/order_adapter')
  const definitionPath = join(root, 'task-definition.json')
  const definition = JSON.parse(await readFile(definitionPath, 'utf8')) as Record<string, unknown>
  definition.inputSchema = { type: 'string', title: '整理资料', minLength: 1, maxLength: 16384,
    contentMediaType: 'application/json', contentSchema }
  await writeFile(definitionPath, canonicalOrderJson(definition))
  await writeFile(join(root, 'samples/count-one.input.json'), canonicalOrderJson(value))
  await writeFile(join(root, 'samples/count-two.input.json'), canonicalOrderJson({ ...value, label: '乙' }))
  for (const sample of ['count-one.expected.json', 'count-two.expected.json']) {
    await writeFile(join(root, 'samples', sample), '{"count":1}')
  }
  // A permissive executable makes admission, rather than business code, own rejection.
  await writeFile(join(root, 'src/adapter.quickjs.js'), 'function run() { return { count: 1 } }')
  return { home, root, skill: join(home, 'SKILL.md'), definition, definitionPath }
}

it('uses the reviewed nested input schema for samples and a runtime challenge', async () => {
  const { skill } = await fixture()
  const source = await readGenericOrderSource(skill)
  expect(source.taskDefinition?.inputSchema.contentSchema).toEqual(contentSchema)
  expect(await verifyGenericOrderAdapter(source)).toMatchObject({ localVerified: true, platformReady: false })
  expect((await runGenericOrderChallenge(source, Buffer.from(JSON.stringify(value)))).output).toEqual({ count: 1 })
})

it.each([
  { extra: 1 }, { label: '' }, { label: 'unknown' }, { quantity: true },
  { quantity: 0 }, { quantity: 4 }, { quantity: 1.5 }, { ratio: -0.1 }, { ratio: 1.1 },
  { enabled: 'true' }, { rows: [] }, { rows: [{ memo: null }, { memo: null }, { memo: null }] },
  { rows: [{ memo: '' }] }, { rows: [{ memo: null, extra: 1 }] },
])('rejects runtime values outside the signed declaration: %j', async patch => {
  const { skill } = await fixture()
  const source = await readGenericOrderSource(skill)
  await expect(runGenericOrderChallenge(source, Buffer.from(JSON.stringify({ ...value, ...patch }))))
    .rejects.toMatchObject({ code: 'order-local-verification-failed' })
})

it.each(['{}', '[]', '{"label":"甲🙂"}', '{"label":"a","label":"b"}',
  '{"quantity":NaN}', '{"ratio":1e999}', '{"label":"\\ud800"}'])('rejects invalid JSON input %s', async raw => {
  const { skill } = await fixture()
  const source = await readGenericOrderSource(skill)
  await expect(runGenericOrderChallenge(source, Buffer.from(raw)))
    .rejects.toMatchObject({ code: 'order-local-verification-failed' })
})

it('rejects a sample field outside contentSchema before running executable code', async () => {
  const { root, skill } = await fixture()
  await writeFile(join(root, 'samples/count-one.input.json'), JSON.stringify({ ...value, extra: 1 }))
  await expect(readGenericOrderSource(skill)).rejects.toMatchObject({ code: 'order-adapter-invalid' })
})

it.each([
  { type: 'string', pattern: '.*' }, { type: 'string', const: 'a' }, { type: 'string', $ref: '#' },
  { type: ['string'] }, { type: 'unknown' }, { type: 'string', maxLength: 16385 },
  { type: 'string', minLength: 4, maxLength: 3 }, { type: 'number', minimum: null },
  { type: 'number', minimum: 3, maximum: 2 }, { type: 'array', items: { type: 'boolean' }, maxItems: 129 },
])('rejects unsupported schema rules %j', async rule => {
  const { definition, definitionPath, skill } = await fixture()
  const inputSchema = definition.inputSchema as Record<string, unknown>
  inputSchema.contentSchema = { type: 'object', properties: { field: rule }, additionalProperties: false }
  await writeFile(definitionPath, canonicalOrderJson(definition))
  await expect(readGenericOrderSource(skill)).rejects.toMatchObject({ code: 'order-adapter-invalid' })
})

it('keeps the input schema within its own 4096 byte limit', async () => {
  const { definition, definitionPath, skill } = await fixture()
  const inputSchema = definition.inputSchema as Record<string, unknown>
  inputSchema.contentSchema = { type: 'object', additionalProperties: false,
    properties: Object.fromEntries(Array.from({ length: 14 }, (_, index) => [
      `field${index}`, { type: 'string', title: '文'.repeat(100) },
    ])) }
  const bytes = canonicalOrderJson(definition)
  expect(Buffer.byteLength(canonicalOrderJson(inputSchema))).toBeGreaterThan(4096)
  expect(Buffer.byteLength(bytes)).toBeLessThan(8192)
  await writeFile(definitionPath, bytes)
  await expect(readGenericOrderSource(skill)).rejects.toMatchObject({ code: 'order-adapter-invalid' })
})

it('rejects JSON envelope overflow independently of field values', async () => {
  const { definition, definitionPath, skill, root } = await fixture()
  const raw = JSON.stringify(value)
  const inputSchema = definition.inputSchema as Record<string, unknown>
  inputSchema.maxLength = [...raw].length
  await writeFile(definitionPath, canonicalOrderJson(definition))
  await writeFile(join(root, 'samples/count-one.input.json'), raw)
  const source = await readGenericOrderSource(skill)
  await expect(runGenericOrderChallenge(source, Buffer.from(raw + ' ')))
    .rejects.toMatchObject({ code: 'order-local-verification-failed' })
})

it('embeds the same Chinese schema and files distributed as the public skill template', async () => {
  const root = fileURLToPath(new URL('../examples/quickjs-char-count-skill/', import.meta.url))
  for (const [path, bytes] of Object.entries(skillAuthoringTemplate.files)) {
    expect(await readFile(join(root, path), 'utf8')).toBe(bytes)
  }
  const definition = JSON.parse(skillAuthoringTemplate.files['scripts/order_adapter/task-definition.json']) as {
    inputSchema: { title: string; contentSchema: { properties: { text: { title: string } } } }
  }
  expect(definition.inputSchema.title).toBe('需要统计的文字')
  expect(definition.inputSchema.contentSchema.properties.text.title).toBe('文字内容')
  expect(skillAuthoringTemplate.files['SKILL.md']).toContain('displayName: 文字统计')
})

it('binds executable service metadata into the canonical definition and source digest', async () => {
  const { skill, definition, definitionPath } = await fixture()
  const before = await readGenericOrderSource(skill)
  definition.title = '机械文书检查'
  definition.description = '检查给定文本的格式和术语，返回定位结果。'
  await writeFile(definitionPath, canonicalOrderJson(definition))
  const after = await readGenericOrderSource(skill)
  expect(after.taskDefinition).toMatchObject({ title: definition.title, description: definition.description })
  expect(after.digest).not.toBe(before.digest)
})

it.each([
  ['title', ''], ['title', '文'.repeat(81)], ['title', 1],
  ['description', ' '], ['description', '文'.repeat(501)], ['description', false],
  ['unknownMetadata', 'unsupported'],
])('rejects invalid executable metadata %s', async (key, invalid) => {
  const { skill, definition, definitionPath } = await fixture()
  definition[String(key)] = invalid
  await writeFile(definitionPath, canonicalOrderJson(definition))
  await expect(readGenericOrderSource(skill)).rejects.toMatchObject({ code: 'order-adapter-invalid' })
})
