import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComputeExecutorRegistry } from '../src/executor.ts'
import { ComputeCapabilityId, ComputeTaskId, type ComputeTaskEnvelope } from '../src/protocol.ts'
import { createLegalDocumentExecutor, parseLegalDocumentRequest, type LegalDocumentProvider } from '../src/legal-document-bundle.ts'
import { verifyTaskOutputs } from '../src/task-output.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const documents = Array.from({ length: 15 }, (_, index) => ({ id: `fictional_${index + 1}`,
  title: `虚构测试文书 ${index + 1}`, purpose: `验证批量任务交付的第 ${index + 1} 份文件；不是实际法律意见。` }))
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'legal-task-fixture-')); roots.push(root)
  const bytes = Buffer.from('这是明确虚构的开发测试材料。人物甲与人物乙均不存在。材料编号：FICTION-001。')
  const path = join(root, 'fictional.txt'); await writeFile(path, bytes)
  const ref = { name: 'fictional.txt', bytes: bytes.length, sha256: sha(bytes) }
  const task: ComputeTaskEnvelope = { version: 'qianshou.task.v1', taskId: ComputeTaskId('task-fictional-legal'),
    capabilityId: ComputeCapabilityId('legal.doc.bundle'), capabilityVersion: '1.0.0', inputRefs: [ref],
    parameters: { taskType: 'legal_doc_bundle_v1', instructions: '仅验证虚构样本的批量文件流程，不作法律判断。', documents },
    deadlineAt: '2099-01-01T00:00:00.000Z', maxOutputBytes: 2 * 1024 * 1024, idempotencyKey: 'fictional-test-1' }
  const provider: LegalDocumentProvider = { id: 'explicit-fictional-fixture', modelVersion: 'fixture-v1',
    preflight: vi.fn(async () => ({ ready: true })), extract: vi.fn(async () => '虚构提取文本'),
    generate: vi.fn<LegalDocumentProvider['generate']>(async ({ document, materials, taskId }) => ({
      body: `开发验证用虚构文本。\n任务：${taskId}\n用途：${document.purpose}\n材料：${materials[0]!.text}`,
      sourceReferences: [{ attachment: ref.name, sha256: ref.sha256, locator: 'FICTION-001' }], citations: [],
    })), verifyCitation: vi.fn(async () => true) }
  const context = { signal: new AbortController().signal, workspacePath: root, inputs: [{ ...ref, path }],
    interactionPolicy: 'autonomous' as const, reportProgress: vi.fn(async () => undefined) }
  const registry = new ComputeExecutorRegistry(); registry.register(createLegalDocumentExecutor(provider))
  return { root, bytes, task, provider, context, registry }
}

describe('legal document task bundle with explicitly fictional provider', () => {
  it('runs through exact executor admission and delivers fifteen usable Word files in one verified ZIP', async () => {
    const f = await fixture()
    const result = await f.registry.execute(f.task, f.context)
    const verified = await verifyTaskOutputs(f.root, result, f.task.maxOutputBytes, f.context.signal)
    expect(verified.outputs).toHaveLength(1)
    const archive = unzipSync(await readFile(verified.outputs[0]!.path))
    expect(Object.keys(archive).filter(name => name.endsWith('.docx'))).toHaveLength(15)
    const manifest = JSON.parse(Buffer.from(archive['manifest.json']!).toString()) as {
      documents: {
        filename: string
        sha256: string
        title: string
      }[]
    }
    expect(manifest).toMatchObject({ taskId: f.task.taskId, documentCount: 15,
      providerId: 'explicit-fictional-fixture', status: 'drafts_for_review',
      inputs: [{ name: 'fictional.txt', sha256: sha(f.bytes) }] })
    for (const document of manifest.documents) {
      const bytes = archive[document.filename]!
      expect(sha(bytes)).toBe(document.sha256)
      const word = unzipSync(bytes)
      const xml = Buffer.from(word['word/document.xml']!).toString()
      expect(xml).toContain('FICTION-001')
      expect(xml).toContain(document.title)
      expect(xml).toContain('w:pgSz w:w="11906" w:h="16838"')
      expect(xml).not.toContain('TargetMode="External"')
    }
    expect(f.provider.generate).toHaveBeenCalledTimes(15)
    expect(f.context.reportProgress).toHaveBeenLastCalledWith(1, 'packaged')
  })

  it('rejects a changed attachment before any model call', async () => {
    const f = await fixture(); await writeFile(f.context.inputs[0]!.path, Buffer.alloc(f.bytes.length, 65))
    await expect(f.registry.execute(f.task, f.context)).rejects.toThrow('COMPUTE_LEGAL_ATTACHMENT_INVALID')
    expect(f.provider.generate).not.toHaveBeenCalled()
    expect(await readdir(f.root)).toEqual(['fictional.txt'])
  })

  it('refuses a linked outside file even when its digest matches', async () => {
    const f = await fixture(), outside = await fixture()
    await rm(f.context.inputs[0]!.path); await symlink(outside.context.inputs[0]!.path, f.context.inputs[0]!.path)
    await expect(f.registry.execute(f.task, f.context)).rejects.toThrow('COMPUTE_LEGAL_ATTACHMENT_INVALID')
    expect(f.provider.generate).not.toHaveBeenCalled()
  })

  it('refuses unavailable configured providers and never returns a chat answer', async () => {
    const f = await fixture(); vi.mocked(f.provider.preflight).mockResolvedValue({ ready: false })
    await expect(f.registry.execute(f.task, f.context)).rejects.toThrow('COMPUTE_LEGAL_PROVIDER_UNAVAILABLE')
    expect(f.provider.generate).not.toHaveBeenCalled()
  })

  it('does not deliver a partial bundle if document fifteen fails', async () => {
    const f = await fixture(); const generate = f.provider.generate
    f.provider.generate = vi.fn<LegalDocumentProvider['generate']>(async (input, signal) => {
      if (input.document.id === 'fictional_15') throw new Error('FICTIONAL_GENERATION_FAILED')
      return generate(input, signal)
    })
    await expect(f.registry.execute(f.task, f.context)).rejects.toThrow('FICTIONAL_GENERATION_FAILED')
    expect(await readdir(f.root)).toEqual(['fictional.txt'])
  })

  it('rejects references to absent material and unverified citations', async () => {
    const f = await fixture()
    vi.mocked(f.provider.generate).mockResolvedValue({ body: '虚构内容',
      sourceReferences: [{ attachment: 'absent.txt', sha256: 'a'.repeat(64), locator: '不存在' }], citations: [] })
    await expect(f.registry.execute(f.task, f.context)).rejects.toThrow('COMPUTE_LEGAL_SOURCE_INVALID')
    vi.mocked(f.provider.generate).mockResolvedValue({ body: '虚构内容',
      sourceReferences: [{ attachment: 'fictional.txt', sha256: sha(f.bytes), locator: 'FICTION-001' }],
      citations: [{ title: '虚构引用', sourceUrl: 'https://example.invalid/fiction', sourceSha256: 'a'.repeat(64),
        checkedAt: '2026-09-27T00:00:00Z' }] })
    vi.mocked(f.provider.verifyCitation).mockResolvedValue(false)
    await expect(f.registry.execute(f.task, f.context)).rejects.toThrow('COMPUTE_LEGAL_CITATION_INVALID')
    expect(await readdir(f.root)).toEqual(['fictional.txt'])
  })

  it('checks batch size, unique document identities and the aggregate output allowance', async () => {
    const f = await fixture()
    expect(() => parseLegalDocumentRequest({ ...f.task.parameters as object, documents: documents.slice(0, 14) })).toThrow('COMPUTE_LEGAL_REQUEST_INVALID')
    expect(() => parseLegalDocumentRequest({ ...f.task.parameters as object,
      documents: [...documents.slice(0, 14), documents[0]] })).toThrow('COMPUTE_LEGAL_REQUEST_INVALID')
    await expect(f.registry.execute({ ...f.task, maxOutputBytes: 1 }, f.context)).rejects.toThrow('COMPUTE_OUTPUT_LIMIT_EXCEEDED')
    expect(await readdir(f.root)).toEqual(['fictional.txt'])
  })
})
