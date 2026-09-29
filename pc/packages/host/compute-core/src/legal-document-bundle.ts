/** Task-owned legal document delivery. Attachment/model bytes stay on the executing PC. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { zipSync } from 'fflate'
import { ComputeCapabilityId, type ComputeTaskEnvelope } from './protocol.ts'
import { CAPABILITY_BY_TASK_TYPE } from './capability-registry.ts'
import type { ComputeExecutionContext, ComputeExecutor } from './executor.ts'
import { ComputeError } from './errors.ts'

export const LEGAL_DOCUMENT_TASK = 'legal_doc_bundle_v1'
function registeredLegalCapability(): string {
  const id = CAPABILITY_BY_TASK_TYPE[LEGAL_DOCUMENT_TASK]
  if (id === undefined) throw new Error('COMPUTE_LEGAL_CAPABILITY_NOT_REGISTERED')
  return id
}
export const LEGAL_DOCUMENT_CAPABILITY = registeredLegalCapability()
export const LEGAL_DOCUMENT_COUNT = 15
export const LEGAL_DOCUMENT_VERSION = '1.0.0'
const MAX_INPUT = 16 * 1024 * 1024
const MAX_TEXT = 200_000

export interface LegalCitation {
  title: string
  sourceUrl: string
  sourceSha256: string
  checkedAt: string
}
export interface LegalSourceReference {
  attachment: string
  sha256: string
  locator: string
}
export interface LegalDocumentRequest {
  id: string
  title: string
  purpose: string
}
export interface LegalMaterial {
  name: string
  sha256: string
  text: string
}
/** Node-installed provider port. A chat message or user task cannot supply this implementation. */
export interface LegalDocumentProvider {
  id: string
  modelVersion: string
  preflight: (signal: AbortSignal) => Promise<{ ready: boolean }>
  extract: (input: {
    name: string
    bytes: Uint8Array
  }, signal: AbortSignal) => Promise<string>
  generate: (input: {
    taskId: string
    instructions: string
    document: LegalDocumentRequest
    materials: readonly LegalMaterial[]
  }, signal: AbortSignal) => Promise<unknown>
  /** Independent source lookup, on PC/Guangzhou. The model's assertion is never sufficient. */
  verifyCitation: (citation: LegalCitation, signal: AbortSignal) => Promise<boolean>
}

function fail(code: string): never { throw new ComputeError(code, 422) }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('COMPUTE_LEGAL_REQUEST_INVALID')
  return value as Record<string, unknown>
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
    && !value.includes('\0') && value.isWellFormed()
}
function digest(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex') }

function generatedDocument(value: unknown): {
  body: string
  sourceReferences: LegalSourceReference[]
  citations: LegalCitation[]
} {
  const row = object(value)
  if (Object.keys(row).sort().join(',') !== 'body,citations,sourceReferences'
    || !text(row.body, 100_000) || !Array.isArray(row.sourceReferences)
    || row.sourceReferences.length < 1 || row.sourceReferences.length > 128
    || !Array.isArray(row.citations) || row.citations.length > 64) fail('COMPUTE_LEGAL_DOCUMENT_INVALID')
  const sourceReferences = (row.sourceReferences as unknown[]).map((value) => {
    const source = object(value)
    if (Object.keys(source).sort().join(',') !== 'attachment,locator,sha256'
      || !text(source.attachment, 128) || !text(source.sha256, 64) || !text(source.locator, 2000)) fail('COMPUTE_LEGAL_SOURCE_INVALID')
    return { attachment: source.attachment, sha256: source.sha256, locator: source.locator }
  })
  const citations = (row.citations as unknown[]).map((value) => {
    const citation = object(value)
    if (Object.keys(citation).sort().join(',') !== 'checkedAt,sourceSha256,sourceUrl,title'
      || !text(citation.title, 256) || !text(citation.sourceUrl, 2048) || !text(citation.sourceSha256, 64)
      || !text(citation.checkedAt, 64)) fail('COMPUTE_LEGAL_CITATION_INVALID')
    return { title: citation.title, sourceUrl: citation.sourceUrl, sourceSha256: citation.sourceSha256, checkedAt: citation.checkedAt }
  })
  return { body: row.body, sourceReferences, citations }
}

/** Validate a metadata-only request before any attachment is read or model is invoked. */
export function parseLegalDocumentRequest(value: unknown): {
  taskType: typeof LEGAL_DOCUMENT_TASK
  instructions: string
  documents: readonly LegalDocumentRequest[]
} {
  const row = object(value)
  if (Object.keys(row).sort().join(',') !== 'documents,instructions,taskType'
    || row.taskType !== LEGAL_DOCUMENT_TASK || !text(row.instructions, 8000)
    || !Array.isArray(row.documents) || row.documents.length !== LEGAL_DOCUMENT_COUNT) fail('COMPUTE_LEGAL_REQUEST_INVALID')
  const ids = new Set<string>()
  const documents = row.documents.map((value) => {
    const document = object(value)
    if (Object.keys(document).sort().join(',') !== 'id,purpose,title'
      || typeof document.id !== 'string' || !/^[a-z][a-z0-9_]{0,47}$/u.test(document.id)
      || ids.has(document.id) || !text(document.title, 100) || !text(document.purpose, 1000)) fail('COMPUTE_LEGAL_REQUEST_INVALID')
    ids.add(document.id)
    return Object.freeze({ id: document.id, title: document.title, purpose: document.purpose })
  })
  return Object.freeze({ taskType: LEGAL_DOCUMENT_TASK, instructions: row.instructions,
    documents: Object.freeze(documents) })
}

async function readMaterial(root: string, input: ComputeExecutionContext['inputs'][number], signal: AbortSignal): Promise<Uint8Array> {
  const path = await realpath(input.path)
  const local = relative(root, path)
  if (!local || local === '..' || local.startsWith('..' + sep) || isAbsolute(local)
    || (await lstat(input.path)).isSymbolicLink()) fail('COMPUTE_LEGAL_ATTACHMENT_INVALID')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size !== input.bytes
      || before.size < 1 || before.size > MAX_INPUT) fail('COMPUTE_LEGAL_ATTACHMENT_INVALID')
    const bytes = await file.readFile()
    signal.throwIfAborted()
    const after = await file.stat()
    if (bytes.length !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || digest(bytes) !== input.sha256) fail('COMPUTE_LEGAL_ATTACHMENT_INVALID')
    return bytes
  } finally { await file.close() }
}

/** Register explicitly in the installed node runtime; this factory grants no intake authority. */
export function createLegalDocumentExecutor(provider: LegalDocumentProvider): ComputeExecutor {
  if (!text(provider.id, 128) || !text(provider.modelVersion, 128)) fail('COMPUTE_LEGAL_PROVIDER_INVALID')
  return {
    capabilityId: ComputeCapabilityId(LEGAL_DOCUMENT_CAPABILITY), version: LEGAL_DOCUMENT_VERSION,
    async execute(task: ComputeTaskEnvelope, context: ComputeExecutionContext) {
      const request = parseLegalDocumentRequest(task.parameters)
      if (task.capabilityId !== 'legal.doc.bundle' || task.capabilityVersion !== LEGAL_DOCUMENT_VERSION
        || task.inputRefs.length < 1
        || task.inputRefs.length > 15 || context.inputs.length !== task.inputRefs.length) fail('COMPUTE_LEGAL_ATTACHMENT_INVALID')
      const root = await realpath(context.workspacePath)
      const materials: LegalMaterial[] = []
      let inputBytes = 0
      const names = new Set<string>()
      for (const ref of task.inputRefs) {
        context.signal.throwIfAborted()
        const input = context.inputs.find(item => item.name === ref.name)
        if (!input || input.bytes !== ref.bytes || input.sha256 !== ref.sha256
          || names.has(ref.name) || !/\.(?:txt|md|pdf|docx)$/iu.test(ref.name)) fail('COMPUTE_LEGAL_ATTACHMENT_INVALID')
        names.add(ref.name)
        inputBytes += ref.bytes
        if (!Number.isSafeInteger(inputBytes) || inputBytes > MAX_INPUT) fail('COMPUTE_LEGAL_ATTACHMENT_INVALID')
        const bytes = await readMaterial(root, input, context.signal)
        const extracted = /\.(?:txt|md)$/iu.test(ref.name)
          ? new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          : await provider.extract({ name: ref.name, bytes }, context.signal)
        if (!text(extracted, MAX_TEXT) || materials.reduce((sum, item) => sum + item.text.length, 0)
          + extracted.length > MAX_TEXT) fail('COMPUTE_LEGAL_EXTRACTION_INVALID')
        materials.push(Object.freeze({ name: ref.name, sha256: ref.sha256, text: extracted }))
      }
      context.signal.throwIfAborted()
      if (!(await provider.preflight(context.signal)).ready) throw new ComputeError('COMPUTE_LEGAL_PROVIDER_UNAVAILABLE', 409)
      const files: {
        name: string
        bytes: Uint8Array
      }[] = []
      const documents: Record<string, unknown>[] = []
      for (const [index, document] of request.documents.entries()) {
        context.signal.throwIfAborted()
        const output = generatedDocument(await provider.generate({ taskId: task.taskId, instructions: request.instructions,
          document, materials: Object.freeze(materials) }, context.signal))
        if ((/《[^》\n]{1,64}》第[^\s，。；]{1,20}条/u.test(output.body)
          || /[（(](?:19|20)\d{2}[）)][^\s，。；]{1,24}号/u.test(output.body))
          && output.citations.length === 0) fail('COMPUTE_LEGAL_CITATION_INVALID')
        for (const source of output.sourceReferences) {
          if (!text(source.locator, 2000)
            || !materials.some(item => item.name === source.attachment && item.sha256 === source.sha256)) fail('COMPUTE_LEGAL_SOURCE_INVALID')
        }
        for (const citation of output.citations) {
          let url: URL
          try { url = new URL(citation.sourceUrl) } catch { fail('COMPUTE_LEGAL_CITATION_INVALID') }
          if (!text(citation.title, 256) || url.protocol !== 'https:' || url.username || url.password
            || !/^[0-9a-f]{64}$/u.test(citation.sourceSha256) || !Number.isFinite(Date.parse(citation.checkedAt))
            || !(await provider.verifyCitation(citation, context.signal))) fail('COMPUTE_LEGAL_CITATION_INVALID')
        }
        context.signal.throwIfAborted()
        const name = `${String(index + 1).padStart(2, '0')}-${document.id}.docx`
        const bytes = docx(document.title, output.body)
        files.push({ name, bytes })
        documents.push({ id: document.id, title: document.title, filename: name, sizeBytes: bytes.length,
          sha256: digest(bytes), sourceReferences: output.sourceReferences.map(item => ({ ...item })),
          citations: output.citations.map(item => ({ ...item })), requiresLawyerReview: true })
        await context.reportProgress((index + 1) / (LEGAL_DOCUMENT_COUNT + 1), 'documents')
      }
      const manifest = { schema: 'qianshou.legal-document-bundle.v1', taskId: task.taskId,
        capabilityId: task.capabilityId, capabilityVersion: task.capabilityVersion,
        providerId: provider.id, modelVersion: provider.modelVersion, documentCount: LEGAL_DOCUMENT_COUNT,
        status: 'drafts_for_review', inputs: materials.map(({ name, sha256 }) => ({ name, sha256 })), documents }
      const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2))
      files.push({ name: 'manifest.json', bytes: manifestBytes })
      const bundle = zip(files)
      if (bundle.length > task.maxOutputBytes) throw new ComputeError('COMPUTE_OUTPUT_LIMIT_EXCEEDED', 413)
      context.signal.throwIfAborted()
      const filename = 'legal-documents.zip'
      const path = join(root, filename)
      await writeFile(path, bundle, { flag: 'wx', mode: 0o600 })
      await context.reportProgress(1, 'packaged')
      return { outputs: [{ name: filename, path, bytes: bundle.length, sha256: digest(bundle) }],
        metadata: { taskType: LEGAL_DOCUMENT_TASK, documentCount: String(LEGAL_DOCUMENT_COUNT),
          manifestSchema: manifest.schema, manifestSha256: digest(manifestBytes),
          providerId: provider.id, modelVersion: provider.modelVersion, status: manifest.status } }
    },
  }
}

function xml(value: string): string {
  return value.replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/gu, '')
    .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;')
}
/** Standard A4 Word files, with preserved paragraphs and no macros or external relationships. */
function docx(title: string, body: string): Uint8Array {
  const paragraph = (value: string, heading = false): string => `<w:p><w:pPr>${heading ? '<w:jc w:val="center"/>' : ''}<w:spacing w:after="160" w:line="360" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="${heading ? 32 : 24}"/>${heading ? '<w:b/>' : ''}</w:rPr><w:t xml:space="preserve">${xml(value)}</w:t></w:r></w:p>`
  return zip([
    { name: '[Content_Types].xml', bytes: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
    { name: '_rels/.rels', bytes: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { name: 'word/document.xml', bytes: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraph(title, true)}${body.split(/\r?\n/u).map(line => paragraph(line)).join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`) },
  ])
}
/** Deterministic archive timestamps avoid leaking the executing PC's clock. */
function zip(files: readonly { name: string; bytes: Uint8Array }[]): Uint8Array {
  return zipSync(Object.fromEntries(files.map(file => [file.name,
    [file.bytes, { mtime: new Date('1980-01-01T00:00:00Z') }]])), { level: 6 })
}
