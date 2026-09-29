import { mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalPluginCandidateBuilder } from '../src/plugin-candidate.ts'
import { LocalPluginDraftStore } from '../src/plugin-draft.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

const text = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }
const result = { type: 'object', properties: { characters: { type: 'integer' }, utf8Bytes: { type: 'integer' },
  nonemptyLines: { type: 'integer' }, sha256: { type: 'string' } },
  required: ['characters', 'utf8Bytes', 'nonemptyLines', 'sha256'], additionalProperties: false }
const resultV2 = { type: 'object', properties: { ...result.properties,
  wordCounts: { type: 'array', items: { type: 'object', properties: {
    word: { type: 'string' }, count: { type: 'integer' },
  }, required: ['word', 'count'], additionalProperties: false } } },
required: [...result.required, 'wordCounts'], additionalProperties: false }
const resultReverse = { type: 'object', properties: { reversed: { type: 'string' } },
  required: ['reversed'], additionalProperties: false }

function spec(ref = 'qianshou:text-statistics-v1') {
  const v2 = ref === 'qianshou:text-statistics-v2'
  const reverse = ref === 'qianshou:text-reverse-v1'
  return { pluginId: 'owner.text-statistics', version: v2 ? '2.0.0' : '1.0.0', displayName: '文字统计', operations: [{
    id: 'owner.text-statistics.count', title: '统计文字', description: '计算文本字数与 SHA-256',
    binding: { kind: 'workflow', ref }, inputSchema: text,
    outputSchema: reverse ? resultReverse : v2 ? resultV2 : result,
    permissions: [], dataScope: 'task-inputs', networkOrigins: [], dependencies: [],
    resources: { minTotalMemoryBytes: 0, minFreeDiskBytes: 0, maxInputBytes: 65536,
      maxOutputBytes: v2 || reverse ? 262144 : 1024, maxRunMs: 1000 },
  }] }
}

describe('private plugin candidate package', () => {
  it('builds only the reviewed local text workflow, without installing or publishing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-plugin-candidate-'))
    roots.push(root)
    const drafts = new LocalPluginDraftStore({ path: join(root, 'drafts.json'), maxDrafts: 3, maxBytes: 131072 })
    try {
      const draft = await drafts.save({ spec: spec() })
      const builder = new LocalPluginCandidateBuilder(drafts, join(root, 'candidates'))
      const candidate = await builder.prepare(draft.id)
      expect(candidate).toMatchObject({ draftId: draft.id, installableLocally: true, published: false, dispatchable: false })
      expect(candidate.sourceDigest).toMatch(/^[0-9a-f]{64}$/u)
      expect(candidate.packageDigest).toMatch(/^[0-9a-f]{64}$/u)
      const manifest = JSON.parse(await readFile(join(candidate.packagePath, 'package.json'), 'utf8')) as {
        name: string; dsh: { bundle: { patch: string } }; private: boolean
      }
      expect(manifest).toMatchObject({ name: candidate.packageName, private: true,
        dsh: { bundle: { patch: './cordis.patch.yml' } } })
      expect(await readFile(join(candidate.packagePath, 'index.js'), 'utf8')).toContain(candidate.toolName)
      expect((await stat(candidate.packagePath)).mode & 0o777).toBe(0o700)
      expect((await stat(join(candidate.packagePath, 'index.js'))).mode & 0o777).toBe(0o600)
      expect(await builder.list()).toMatchObject([{ packageName: candidate.packageName,
        displayName: '文字统计', description: '统计字符数、UTF-8 字节数、非空行数和 SHA-256 摘要',
        installableLocally: true, published: false, dispatchable: false }])
      await writeFile(join(candidate.packagePath, 'index.js'), 'changed')
      expect(await builder.list()).toEqual([])
      await unlink(join(candidate.packagePath, 'index.js'))
      await symlink('/etc/hosts', join(candidate.packagePath, 'index.js'))
      expect(await builder.list()).toEqual([])
    } finally { await drafts.close() }
  })

  it('refuses arbitrary workflows rather than writing executable code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-plugin-candidate-'))
    roots.push(root)
    const drafts = new LocalPluginDraftStore({ path: join(root, 'drafts.json'), maxDrafts: 3, maxBytes: 131072 })
    try {
      const draft = await drafts.save({ spec: spec('flow:user-command') })
      const builder = new LocalPluginCandidateBuilder(drafts, join(root, 'candidates'))
      await expect(builder.prepare(draft.id)).rejects.toThrow('COMPUTE_PLUGIN_CANDIDATE_UNSUPPORTED')
    } finally { await drafts.close() }
  })

  it('marks a v2 word-count candidate without changing the private v1 contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-plugin-candidate-'))
    roots.push(root)
    const drafts = new LocalPluginDraftStore({ path: join(root, 'drafts.json'), maxDrafts: 3, maxBytes: 131072 })
    try {
      const old = await drafts.save({ spec: spec() })
      const next = await drafts.save({ spec: spec('qianshou:text-statistics-v2') })
      const builder = new LocalPluginCandidateBuilder(drafts, join(root, 'candidates'))
      const oldBundle = await builder.prepare(old.id)
      const nextBundle = await builder.prepare(next.id)
      const oldManifest = JSON.parse(await readFile(join(oldBundle.packagePath, 'package.json'), 'utf8')) as Record<string, unknown>
      const nextManifest = JSON.parse(await readFile(join(nextBundle.packagePath, 'package.json'), 'utf8')) as Record<string, unknown>
      expect(oldManifest.qianshouWorkflowRef).toBeUndefined()
      expect(nextManifest.qianshouWorkflowRef).toBe('qianshou:text-statistics-v2')
      expect(await readFile(join(nextBundle.packagePath, 'index.js'), 'utf8')).toContain('wordCounts')
      const listed = await builder.list()
      expect(listed.find(item => item.draftId === old.id)?.orderAdapter).toBeUndefined()
      expect(listed.find(item => item.draftId === next.id)?.orderAdapter).toEqual({
        version: 1, capabilityId: 'text.transform', taskType: 'word_count', inputKind: 'inline',
        outputKind: 'inline_json', contractVersion: 'v1',
      })
    } finally { await drafts.close() }
  })

  it('prepares a different reviewed text-reverse operation, with no word-count order authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-plugin-candidate-'))
    roots.push(root)
    const drafts = new LocalPluginDraftStore({ path: join(root, 'drafts.json'), maxDrafts: 3, maxBytes: 131072 })
    try {
      const draft = await drafts.save({ spec: spec('qianshou:text-reverse-v1') })
      const builder = new LocalPluginCandidateBuilder(drafts, join(root, 'candidates'))
      const candidate = await builder.prepare(draft.id)
      const manifest = JSON.parse(await readFile(join(candidate.packagePath, 'package.json'), 'utf8')) as Record<string, unknown>
      expect(manifest.qianshouOrderAdapter).toBeUndefined()
      expect(manifest.qianshouWorkflowRef).toBeUndefined()
      const source = await readFile(join(candidate.packagePath, 'index.js'), 'utf8')
      expect(source).toContain("Array.from(args.text).reverse().join('')")
      expect(source).not.toContain('wordCounts')
      expect(source).toContain('按 Unicode 字符顺序反转输入文字')
      expect(source).not.toContain('计算文本字数与 SHA-256')
      const listed = await builder.list()
      expect(listed).toMatchObject([{ draftId: draft.id }])
      expect(listed[0]?.orderAdapter).toBeUndefined()
      expect(listed[0]?.description).toBe('按 Unicode 字符顺序反转输入文字')
      const wrongSchema = await drafts.save({ spec: { ...spec('qianshou:text-reverse-v1'),
        operations: [{ ...spec('qianshou:text-reverse-v1').operations[0], outputSchema: result }] } })
      await expect(builder.prepare(wrongSchema.id)).rejects.toThrow('COMPUTE_PLUGIN_CANDIDATE_UNSUPPORTED')
    } finally { await drafts.close() }
  })
})
