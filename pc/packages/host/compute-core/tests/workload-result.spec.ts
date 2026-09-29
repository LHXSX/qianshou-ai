import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseOwnedWorkloadResult, parseWorkloadResult } from '../src/workload-result.ts'

const id = 'workload-1'
const max = 32_000
const mediaRef = `qianshou-media://task/${id}/${'a'.repeat(64)}.mp4`
const fileId = '12345678-1234-4234-8234-123456789abc'
const fileShardId = '87654321-4321-4321-8321-cba987654321'
const fileResultId = '01234567-abcd-4123-8abc-0123456789ab'
const fileRef = `qianshou-file://task/${fileId}/${'a'.repeat(64)}`
const fileManifest = { schema: 'artifact.v1', workload_id: fileId, account_id: 167,
  object_key: `v8/account-167/workload-${fileId}/shard-${fileShardId}/result/${fileResultId}/output.bin`,
  object_version_id: 'private-version-1', result_id: fileResultId, shard_id: fileShardId,
  filename: 'output.bin', content_type: 'application/octet-stream', size_bytes: 100, sha256: 'a'.repeat(64) }
const fileIntent = { schema: 'qianshou.reviewed-workload-contract.v1', contract_sha256: `sha256:${'b'.repeat(64)}`,
  result_strategy: 'independent-file-bytes.v1', output_kind: 'artifact_ref',
  output_schema_sha256: `sha256:${'c'.repeat(64)}`, contract_version: 'v1', file_schema_sha256: 'd'.repeat(64) }
const fileSpec = { verification_policy: 'artifact', requirements: { _reviewed_task_contract: fileIntent } }

/**
 * 平台 `GET /api/v8/developer/tasks/{id}/result` 的**真实响应原文**
 * （2026-09-17 抓取，来源与脱敏说明写在夹具的 `_provenance` 里）。
 *
 * 为什么要读真响应而不是手写一个像样的：AT-01/AT-07 的原始观察是产品结果路由
 * 回 `inlineOutput=null`，原因是当时只认顶层的 `inline_output`/`output_ref`。
 * 用真响应做夹具才能钉住字段名，不靠猜。
 */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/developer-task-result.json', import.meta.url), 'utf8')) as {
  wordCountDone: Record<string, unknown>
  base64DoneWithFailedItems: Record<string, unknown>
}

describe('developer-task result admission', () => {
  it('projects an ordinary finished media manifest into an owner-granted media reference', () => {
    const manifest = { schema: 'artifact.v1', workload_id: id, account_id: 167,
      object_key: `v8/account-167/workload-${id}/shard-shard-1/result/result-1/result.png`, object_version_id: 'version-1', result_id: 'result-1',
      shard_id: 'shard-1', filename: 'result.png', content_type: 'image/png',
      size_bytes: 1704534, sha256: 'f'.repeat(64) }
    const body = { id, owner_id: 167, status: 'DONE',
      result: { output_ref: JSON.stringify(manifest), inline_output: null } }
    expect(parseOwnedWorkloadResult(id, body, max)).toEqual({ id, status: 'DONE', inlineOutput: null,
      artifactRef: `qianshou-media://task/${id}/${'f'.repeat(64)}.png` })
    expect(() => parseOwnedWorkloadResult(id, { ...body, result: { output_ref: JSON.stringify({
      ...manifest, workload_id: 'other',
    }) } }, max)).toThrow('CORE_INVALID_RESPONSE')
    const htmlRef = JSON.stringify({ ...manifest, content_type: 'text/html' })
    expect(parseOwnedWorkloadResult(id, { ...body, result: { output_ref: htmlRef } }, max))
      .toMatchObject({ artifactRef: htmlRef, inlineOutput: null })
    expect(() => parseOwnedWorkloadResult(id, { ...body, owner_id: 168 }, max)).toThrow('CORE_INVALID_RESPONSE')
  })

  it.each(['application/pdf', 'application/octet-stream', 'audio/flac', 'image/svg+xml'])(
    'preserves %s as bounded file metadata without promoting it to viewable media', (contentType) => {
      const ref = JSON.stringify({ schema: 'artifact.v1', workload_id: id, account_id: 167,
        object_key: `v8/account-167/workload-${id}/shard-shard-1/result/result-1/output.bin`,
        object_version_id: 'version-1', result_id: 'result-1', shard_id: 'shard-1',
        filename: 'output.bin', content_type: contentType, size_bytes: 2 * 1024 * 1024 * 1024, sha256: 'a'.repeat(64) })
      const parsed = parseOwnedWorkloadResult(id, { id, owner_id: 167, status: 'DONE', output_ref: ref }, max)
      expect(parsed).toEqual({ id, status: 'DONE', artifactRef: ref, inlineOutput: null })
      expect(parsed.artifactRef).not.toContain('qianshou-media:')
    },
  )

  it('rejects wrong file identity, mutable versions, invalid MIME and oversized metadata', () => {
    const manifest = { schema: 'artifact.v1', workload_id: id, account_id: 167,
      object_key: `v8/account-167/workload-${id}/shard-shard-1/result/result-1/output.pdf`,
      object_version_id: 'version-1', result_id: 'result-1', shard_id: 'shard-1',
      filename: 'output.pdf', content_type: 'application/pdf', size_bytes: 100, sha256: 'a'.repeat(64) }
    for (const change of [
      { account_id: 168 }, { workload_id: 'other' }, { shard_id: 'other' }, { result_id: 'other' },
      { object_key: manifest.object_key.replace('account-167', 'account-168') },
      { object_key: `${manifest.object_key}/extra` }, { object_version_id: 'null' },
      { object_version_id: '' }, { object_version_id: 'bad/version' }, { object_version_id: undefined },
      { content_type: 'application/*' }, { filename: '../output.pdf' },
      { size_bytes: 2 * 1024 * 1024 * 1024 + 1 }, { sha256: 'b'.repeat(63) },
    ]) {
      expect(() => parseOwnedWorkloadResult(id, { id, owner_id: 167, status: 'DONE',
        output_ref: JSON.stringify({ ...manifest, ...change }) }, max)).toThrow('CORE_INVALID_RESPONSE')
    }
  })

  it('accepts wrapped inline UTF-8 and ignores unrelated result fields', () => {
    expect(parseWorkloadResult(id, {
      ok: true, id, status: 'DONE', result: { inline_output: '3\n', private: 'discard' },
    }, max)).toEqual({
      id, status: 'DONE', inlineOutput: '3\n', artifactRef: null,
    })
  })

  it('accepts a flat WorkloadResult and workload_id or task_id as the identity', () => {
    expect(parseWorkloadResult(id, {
      ok: true, workload_id: id, status: 'DONE', inline_output: 'hello',
    }, max)).toEqual({ id, status: 'DONE', inlineOutput: 'hello', artifactRef: null })
    expect(parseWorkloadResult(id, {
      task_id: id, status: 'DONE', inline_output: '',
    }, max)).toEqual({ id, status: 'DONE', inlineOutput: '', artifactRef: null })
  })

  it('records an artifact reference without downloading bytes', () => {
    expect(parseWorkloadResult(id, {
      ok: true, id, status: 'DONE', result: { output_ref: 'obj://result-1' },
    }, max)).toEqual({ id, status: 'DONE', inlineOutput: null, artifactRef: 'obj://result-1' })
  })

  it('preserves only the independently verified media output reference from Shanghai', () => {
    const verified = parseWorkloadResult(id, {
      ok: true, id, task_id: id, status: 'DONE', output_ref: mediaRef,
      result: { media_ref: mediaRef, summary_text: '视频已生成' },
    }, max)
    expect(verified).toEqual({ id, status: 'DONE', inlineOutput: null, artifactRef: mediaRef })

    // A media hint inside an unverified result cannot become a viewable artifact.
    expect(parseWorkloadResult(id, {
      ok: true, id, status: 'DONE', output_ref: null,
      result: { media_ref: mediaRef },
    }, max)).toEqual({ id, status: 'DONE', inlineOutput: null, artifactRef: null })
    expect(() => parseWorkloadResult(id, {
      ok: true, id, status: 'DONE', output_ref: mediaRef.replace(`/task/${id}/`, '/task/other-task/'),
    }, max)).toThrow('CORE_INVALID_RESPONSE')
  })

  it('keeps a null result as unavailable inline text', () => {
    expect(parseWorkloadResult(id, { ok: true, id, status: 'RUNNING', result: null }, max)).toEqual({
      id, status: 'RUNNING', inlineOutput: null, artifactRef: null,
    })
    expect(parseWorkloadResult(id, { ok: true, id, status: 'DONE', result: {} }, max)).toEqual({
      id, status: 'DONE', inlineOutput: null, artifactRef: null,
    })
  })

  it('rejects both inline and artifact, mismatched identity, and hostile wrappers', () => {
    for (const body of [
      { ok: false, id, status: 'DONE', inline_output: 'x' },
      { id: 'other', status: 'DONE', inline_output: 'x' },
      { status: 'DONE', inline_output: 'x' },
      { id, status: 'DONE', inline_output: 'x', output_ref: 'obj://x' },
      { id, status: 'DONE', result: { inline_output: 'x', output_ref: 'obj://x' } },
      { id, status: 'DONE', result: 'raw' },
      { id, status: 'DONE', result: { inline_output: 3 } },
      { id, status: 'DONE', result: { output_ref: '' } },
      { id, status: 'DONE', result: { output_ref: 'x\0' } },
      { id, status: 'DONE', result: { output_ref: 'x'.repeat(2049) } },
      { id: 1, status: 'DONE', inline_output: 'x' },
      { id, workload_id: 'other', status: 'DONE', inline_output: 'x' },
      { id: '.', status: 'DONE', inline_output: 'x' },
      { id, status: 'DONE', inline_output: 'x\0hidden' },
      { id, status: 'bad\nstatus', inline_output: 'x' },
      { id: '..', status: 'DONE', inline_output: 'x' },
    ]) {
      expect(() => parseWorkloadResult(id, body, max)).toThrow('CORE_INVALID_RESPONSE')
    }
    expect(() => parseWorkloadResult(id, { id, status: 'DONE', inline_output: 'x' }, 0)).toThrow('CORE_INVALID_RESPONSE')
    expect(() => parseWorkloadResult(id, { id, status: 'DONE', inline_output: 'x' }, 1.5)).toThrow('CORE_INVALID_RESPONSE')
  })

  it('rejects oversized inline UTF-8 at the byte ceiling', () => {
    expect(() => parseWorkloadResult(id, { id, status: 'DONE', inline_output: '用户' }, 2)).toThrow('CORE_RESPONSE_TOO_LARGE')
    expect(parseWorkloadResult(id, { id, status: 'DONE', inline_output: '用户' }, 6)).toMatchObject({ inlineOutput: '用户' })
  })
})

describe('bounded file download requests', () => {
  it.each(['application/pdf', 'application/octet-stream', 'text/html', 'image/svg+xml', 'image/png', 'video/mp4'])(
    'projects frozen %s file intent as attachment-only without claiming verification', (contentType) => {
      const parsed = parseOwnedWorkloadResult(fileId, { id: fileId, owner_id: 167, status: 'DONE', spec: fileSpec,
        result: { output_ref: JSON.stringify({ ...fileManifest, content_type: contentType }), inline_output: null } }, max)
      expect(parsed).toEqual({ id: fileId, status: 'DONE', inlineOutput: null, artifactRef: fileRef })
      const visible = JSON.stringify(parsed)
      for (const privateField of ['private-version-1', 'v8/account-', 'output.bin', 'file_bytes_attested', 'contract_sha256']) {
        expect(visible).not.toContain(privateField)
      }
      expect(parsed.artifactRef).not.toContain('qianshou-media:')
    },
  )

  it.each([1, 16_384])('admits exactly %i bytes as a request without reading those bytes', (sizeBytes) => {
    expect(parseOwnedWorkloadResult(fileId, { id: fileId, owner_id: 167, status: 'DONE', spec: fileSpec,
      output_ref: JSON.stringify({ ...fileManifest, size_bytes: sizeBytes }) }, max)).toMatchObject({ artifactRef: fileRef })
  })

  it.each([0, 16_385])('does not turn %i byte metadata into a file or media link', (sizeBytes) => {
    const ref = JSON.stringify({ ...fileManifest, size_bytes: sizeBytes, content_type: 'image/png' })
    expect(parseOwnedWorkloadResult(fileId, { id: fileId, owner_id: 167, status: 'DONE', spec: fileSpec,
      output_ref: ref }, max)).toMatchObject({ artifactRef: ref })
  })

  it('keeps legacy files diagnostic and legacy media on their unchanged path', () => {
    const raw = JSON.stringify(fileManifest)
    expect(parseOwnedWorkloadResult(fileId, { id: fileId, owner_id: 167, status: 'DONE', output_ref: raw }, max))
      .toMatchObject({ artifactRef: raw })
    expect(parseOwnedWorkloadResult(fileId, { id: fileId, owner_id: 167, status: 'DONE',
      output_ref: JSON.stringify({ ...fileManifest, content_type: 'image/png' }) }, max))
      .toMatchObject({ artifactRef: `qianshou-media://task/${fileId}/${'a'.repeat(64)}.png` })
  })

  it('requires DONE and canonical workload, shard and result UUIDs for manifest projection', () => {
    const raw = JSON.stringify({ ...fileManifest, content_type: 'image/png' })
    expect(parseOwnedWorkloadResult(fileId, { id: fileId, owner_id: 167, status: 'RUNNING', spec: fileSpec,
      output_ref: raw }, max)).toMatchObject({ artifactRef: raw })
    for (const replacement of [fileId.toUpperCase(), id]) {
      const ref = JSON.stringify({ ...fileManifest, workload_id: replacement,
        object_key: fileManifest.object_key.replace(fileId, replacement), content_type: 'image/png' })
      expect(parseOwnedWorkloadResult(replacement, { id: replacement, owner_id: 167, status: 'DONE', spec: fileSpec,
        output_ref: ref }, max)).toMatchObject({ artifactRef: ref })
    }
    for (const field of ['shard_id', 'result_id'] as const) {
      const replacement = fileManifest[field].toUpperCase()
      const ref = JSON.stringify({ ...fileManifest, [field]: replacement, content_type: 'image/png',
        object_key: fileManifest.object_key.replace(fileManifest[field], replacement) })
      expect(parseOwnedWorkloadResult(fileId, { id: fileId, owner_id: 167, status: 'DONE', spec: fileSpec,
        output_ref: ref }, max)).toMatchObject({ artifactRef: ref })
    }
  })

  it('rejects malformed file intent without falling back to media preview', () => {
    const changes = [{ schema: 'other' }, { contract_version: 'v2' }, { output_kind: 'inline_text' },
      { contract_sha256: 'b'.repeat(64) }, { output_schema_sha256: 'sha256:bad' },
      { file_schema_sha256: 'SHA256:' + 'd'.repeat(64) }, { file_schema_sha256: undefined }, { extra: true },
      { result_strategy: 'legacy-media' }, { result_strategy: undefined },
      { contract_sha256: fileIntent.contract_sha256 + '\n' }, { file_schema_sha256: fileIntent.file_schema_sha256 + '\n' }]
    for (const change of changes) {
      expect(() => parseOwnedWorkloadResult(fileId, { id: fileId, owner_id: 167, status: 'DONE',
        spec: { verification_policy: 'artifact', requirements: { _reviewed_task_contract: { ...fileIntent, ...change } } },
        output_ref: JSON.stringify({ ...fileManifest, content_type: 'image/png' }) }, max)).toThrow('CORE_INVALID_RESPONSE')
    }
    expect(() => parseOwnedWorkloadResult(fileId, { id: fileId, owner_id: 167, status: 'DONE',
      spec: { ...fileSpec, verification_policy: 'inline' }, output_ref: JSON.stringify(fileManifest) }, max))
      .toThrow('CORE_INVALID_RESPONSE')
  })

  it('pins the strict filename to the object leaf before creating a request', () => {
    const exactLimit = 'a'.repeat(124) + '.bin'
    expect(parseOwnedWorkloadResult(fileId, { id: fileId, owner_id: 167, status: 'DONE', spec: fileSpec,
      output_ref: JSON.stringify({ ...fileManifest, filename: exactLimit,
        object_key: fileManifest.object_key.replace('output.bin', exactLimit) }) }, max)).toMatchObject({ artifactRef: fileRef })
    for (const filename of ['output..bin', '.output.bin', '输出.bin', 'a'.repeat(129)]) {
      const ref = JSON.stringify({ ...fileManifest, filename,
        object_key: fileManifest.object_key.replace('output.bin', filename) })
      expect(() => parseOwnedWorkloadResult(fileId, { id: fileId, owner_id: 167, status: 'DONE', spec: fileSpec,
        output_ref: ref }, max)).toThrow('CORE_INVALID_RESPONSE')
    }
    expect(() => parseOwnedWorkloadResult(fileId, { id: fileId, owner_id: 167, status: 'DONE', spec: fileSpec,
      output_ref: JSON.stringify({ ...fileManifest, filename: 'different.bin' }) }, max)).toThrow('CORE_INVALID_RESPONSE')
    expect(() => parseOwnedWorkloadResult(fileId, { id: fileId, owner_id: 167, status: 'DONE', spec: fileSpec,
      output_ref: JSON.stringify({ ...fileManifest, sha256: fileManifest.sha256 + '\n' }) }, max)).toThrow('CORE_INVALID_RESPONSE')
  })

  it('admits a canonical reserved reference only for its exact DONE task', () => {
    const result = { id: fileId, status: 'DONE', inlineOutput: null, artifactRef: fileRef }
    expect(parseWorkloadResult(fileId, { id: fileId, status: 'DONE', output_ref: fileRef }, max)).toEqual(result)
    expect(parseOwnedWorkloadResult(fileId, { id: fileId, status: 'DONE', result: { output_ref: fileRef } }, max)).toEqual(result)
    for (const status of ['RUNNING', 'FAILED', 'CANCELLED']) {
      expect(() => parseWorkloadResult(fileId, { id: fileId, status, result: { output_ref: fileRef } }, max))
        .toThrow('CORE_INVALID_RESPONSE')
    }
    for (const ref of [fileRef.replace(fileId, fileResultId), fileRef.replace(fileId, fileId.toUpperCase()),
      fileRef.replace('qianshou-file:', 'QIANSHOU-FILE:'), fileRef + '?token=private', fileRef + '#hash',
      fileRef + '/extra', fileRef + '.pdf', fileRef + '\n', fileRef.replace('a'.repeat(64), 'a'.repeat(63))]) {
      expect(() => parseOwnedWorkloadResult(fileId, { id: fileId, status: 'DONE', output_ref: ref }, max))
        .toThrow('CORE_INVALID_RESPONSE')
    }
  })
})

describe('developer-task envelope fixtures (AT-01 / AT-07 regression)', () => {
  /** 改前判据：这两份真响应里**没有**顶层 `inline_output`/`output_ref`，也没有 `result` 里的同名键。 */
  it('documents why the old reader reported null: no canonical field anywhere', () => {
    for (const payload of [fixture.wordCountDone, fixture.base64DoneWithFailedItems]) {
      const inner = payload.result as Record<string, unknown>
      expect(payload.inline_output).toBeUndefined()
      expect(payload.output_ref).toBeUndefined()
      expect(inner.inline_output).toBeUndefined()
      expect(inner.output_ref).toBeUndefined()
    }
  })

  it('hands the word_count deliverable back as non-empty inline text', () => {
    const payload = fixture.wordCountDone
    expect(parseWorkloadResult(payload.id as string, payload, 32_000)).toEqual({
      id: payload.id,
      status: 'DONE',
      // 逐字节等于平台的分片结果行；没有掺进 summary_text 那句中文说明。
      inlineOutput: 'alpha\t3\nbeta\t2\ngamma\t1',
      artifactRef: null,
    })
  })

  it('renders per-item results (including per-item errors) as one line each', () => {
    const payload = fixture.base64DoneWithFailedItems
    const parsed = parseWorkloadResult(payload.id as string, payload, 32_000)
    expect(parsed.status).toBe('DONE')
    expect(parsed.artifactRef).toBeNull()
    // 键名排序后序列化，同一份载荷永远得到同一串字节。
    expect(parsed.inlineOutput).toBe('{"error":"invalid base64","value":"@@@ not base64 @@@"}')
  })

  it('keeps every earlier shape working and never invents text', () => {
    // 平台将来改成下发规范字段时走老路：嵌套的 inline_output / output_ref 优先。
    expect(parseWorkloadResult(id, { ok: true, id, status: 'DONE', result: { inline_output: '3\n' } }, max))
      .toEqual({ id, status: 'DONE', inlineOutput: '3\n', artifactRef: null })
    expect(parseWorkloadResult(id, { ok: true, id, status: 'DONE', result: { output_ref: 'obj://result-1' } }, max))
      .toEqual({ id, status: 'DONE', inlineOutput: null, artifactRef: 'obj://result-1' })
    // 没有可交付内容的 result 依旧如实回 null，不拿 summary 之类的说明文字顶替。
    expect(parseWorkloadResult(id, { id, status: 'DONE', result: { status: 'ok', summary: { items: 0 } } }, max))
      .toEqual({ id, status: 'DONE', inlineOutput: null, artifactRef: null })
    expect(parseWorkloadResult(id, { id, status: 'DONE', result: {} }, max))
      .toEqual({ id, status: 'DONE', inlineOutput: null, artifactRef: null })
    expect(parseWorkloadResult(id, { id, status: 'DONE', result: null }, max))
      .toEqual({ id, status: 'DONE', inlineOutput: null, artifactRef: null })
    // 两个规范字段同时出现仍然是协议违规；畸形 result 仍然拒绝，不被静默忽略。
    expect(() => parseWorkloadResult(id, { id, status: 'DONE', result: { inline_output: 'x', output_ref: 'obj://x' } }, max))
      .toThrow('CORE_INVALID_RESPONSE')
    expect(() => parseWorkloadResult(id, { id, status: 'DONE', result: 'raw' }, max)).toThrow('CORE_INVALID_RESPONSE')
    // 非列表、或列表里混进非文本条目时不猜：整个派生回落，结果如实为空。
    expect(parseWorkloadResult(id, { id, status: 'DONE', result: { result_lines: 'not-a-list' } }, max))
      .toEqual({ id, status: 'DONE', inlineOutput: null, artifactRef: null })
    expect(parseWorkloadResult(id, { id, status: 'DONE', result: { result_lines: [1, 2] } }, max))
      .toEqual({ id, status: 'DONE', inlineOutput: null, artifactRef: null })
    // 只有 caption 时用 caption；空数组不算交付物。
    expect(parseWorkloadResult(id, { id, status: 'DONE', result: { result_lines: [], summary_text: '合并 1 个分片' } }, max))
      .toEqual({ id, status: 'DONE', inlineOutput: '合并 1 个分片', artifactRef: null })
    // 派生文本同样受字节上限约束。
    expect(() => parseWorkloadResult(fixture.wordCountDone.id as string, { ...fixture.wordCountDone }, 4))
      .toThrow('CORE_RESPONSE_TOO_LARGE')
  })
})
