/** Fictional bytes and grants only; no real upload, paid order, model or legal opinion. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindLegalDocumentAssignment, createLegalUploadedInputSource, type LegalDocumentAdmission, type LegalInputGrantProvider } from '../src/legal-document-task-binding.ts'
import { createLegalDocumentExecutor, type LegalDocumentProvider } from '../src/legal-document-bundle.ts'
import { ComputeExecutorRegistry } from '../src/executor.ts'
import { ComputeLocalTaskRunner } from '../src/local-task-runner.ts'

const bytes = Buffer.from('明确虚构的开发材料 FICTION-INPUT-1。人物和事件均不存在。')
const sha256 = createHash('sha256').update(bytes).digest('hex')
const key = `v8/account-167/developer/${'a'.repeat(32)}/input/fictional.txt`
const file = { objectKey: key, objectVersionId: 'fictional-version-1', filename: 'fictional.txt',
  bytes: bytes.length, sha256, contentType: 'text/plain' }
const documents = Array.from({ length: 15 }, (_, index) => ({ id: `fictional_${index + 1}`,
  title: `虚构结构文书${index + 1}`, purpose: '只验证结构，不作真实法律判断。' }))
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }) })
function admission(files: unknown = [file]): LegalDocumentAdmission {
  return { identity: { workerId: '11111111-1111-1111-1111-111111111111', workloadId: '22222222-2222-2222-2222-222222222222',
    shardId: '33333333-3333-3333-3333-333333333333', attempt: 1 }, accountId: 167,
  contractSha256: 'sha256:' + 'b'.repeat(64), deadlineAt: '2099-01-01T00:00:00.000Z', maxOutputBytes: 1024 * 1024,
  params: { instructions: '虚构材料的十五份结构交付验证。', document_plan: JSON.stringify(documents),
    input_manifest: JSON.stringify({ schema: 'qianshou.uploaded-inputs.v1', files }) } }
}
const grants: LegalInputGrantProvider = request => Promise.resolve({ ...request,
  schema: 'qianshou.native-document-input-grant.v1', method: 'GET', expires_at: Math.floor(Date.now() / 1000) + 60,
  url: `https://storage.example.test/${key}?versionId=fictional-version-1&fixture=1` })
describe('native legal upload-to-task binding', () => {
  it('stages the exact leased version, runs the exact executor and consumes fifteen Word drafts before cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legal-native-fixture-')); roots.push(root)
    const a = admission(), bound = bindLegalDocumentAssignment(a)
    const fetched = vi.fn<typeof fetch>(async (_target, options) => {
      expect(options).toMatchObject({ credentials: 'omit', redirect: 'error', method: 'GET' })
      expect(options?.headers).toBeUndefined()
      return new Response(bytes)
    })
    const provider: LegalDocumentProvider = { id: 'fictional-native-fixture', modelVersion: 'fixture-v1',
      preflight: () => Promise.resolve({ ready: true }), extract: () => Promise.resolve('unused'),
      generate: vi.fn<LegalDocumentProvider['generate']>(input => Promise.resolve({ body: input.materials[0]?.text,
        sourceReferences: [{ attachment: 'fictional.txt', sha256, locator: 'FICTION-INPUT-1' }], citations: [] })),
      verifyCitation: () => Promise.resolve(false) }
    const registry = new ComputeExecutorRegistry(); registry.register(createLegalDocumentExecutor(provider))
    const runner = new ComputeLocalTaskRunner(registry)
    const result = await runner.run(bound.task, { signal: new AbortController().signal,
      workspace: { rootPath: root, maxInputBytes: 16 * 1024 * 1024 }, reportProgress: () => {},
      source: createLegalUploadedInputSource(a, 'storage.example.test', grants, fetched),
      async consumeResult(result) {
        const output = result.outputs[0]; expect(output).toBeDefined()
        if (!output) throw new Error('FICTIONAL_NO_OUTPUT')
        const archive = unzipSync(await readFile(output.path))
        return { docs: Object.keys(archive).filter(name => name.endsWith('.docx')).length,
          sha256: output.sha256, scope: 'fictional-structure-only' }
      } })
    expect(result).toMatchObject({ docs: 15, scope: 'fictional-structure-only' })
    expect(provider.generate).toHaveBeenCalledTimes(15)
    expect(fetched).toHaveBeenCalledOnce()
    expect(await readdir(root)).toEqual([])
    await runner.close()
  })
  it('refuses unversioned, foreign-owner or duplicate material names before a grant or download', () => {
    const { objectVersionId: _version, ...unversioned } = file
    expect(() => bindLegalDocumentAssignment(admission([unversioned]))).toThrow('COMPUTE_LEGAL_ASSIGNMENT_INVALID')
    expect(() => bindLegalDocumentAssignment({ ...admission(), accountId: 168 })).toThrow('COMPUTE_LEGAL_ASSIGNMENT_INVALID')
    expect(() => bindLegalDocumentAssignment(admission([file, { ...file, objectKey: key.replace('a'.repeat(32), 'c'.repeat(32)) }]))).toThrow('COMPUTE_LEGAL_ASSIGNMENT_INVALID')
  })
  it('does not reuse an input grant for altered task instructions', async () => {
    const a = admission(), bound = bindLegalDocumentAssignment(a), grant = vi.fn<LegalInputGrantProvider>(grants)
    const source = createLegalUploadedInputSource(a, 'storage.example.test', grant)
    await expect(source.open({ ...bound.task, parameters: { changed: true } }, bound.task.inputRefs[0]!, new AbortController().signal))
      .rejects.toThrow('COMPUTE_LEGAL_ASSIGNMENT_INVALID')
    expect(grant).not.toHaveBeenCalled()
  })
  it.each(['reassigned', 'expired', 'wrong-version', 'foreign-host'])('rejects %s grants before any storage fetch', async (fault) => {
    const a = admission(), bound = bindLegalDocumentAssignment(a)
    const grant: LegalInputGrantProvider = async (request, signal) => {
      const good = await grants(request, signal) as Record<string, unknown>
      return { ...good, ...(fault === 'reassigned' ? { workerId: '44444444-4444-4444-4444-444444444444' }
        : fault === 'expired' ? { expires_at: 1 } : fault === 'wrong-version' ? { object_version_id: 'different-version' }
          : { url: `https://other.example.test/${key}?versionId=fictional-version-1` }) }
    }
    const fetched = vi.fn<typeof fetch>()
    const source = createLegalUploadedInputSource(a, 'storage.example.test', grant, fetched)
    await expect(source.open(bound.task, bound.task.inputRefs[0]!, new AbortController().signal)).rejects.toThrow('COMPUTE_LEGAL_ASSIGNMENT_INVALID')
    expect(fetched).not.toHaveBeenCalled()
  })
})
