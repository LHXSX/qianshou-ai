import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { EdgeWorkerConnection } from '../../src/edge-worker/connection.ts'
import type { EdgeTaskOffer } from '../../src/edge-worker/types.ts'

class Socket extends EventTarget {
  static OPEN = 1
  static latest: Socket
  readyState = 1
  sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  constructor() { super(); Socket.latest = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
  send(data: string) {
    const frame = JSON.parse(data) as { type: string; payload: Record<string, unknown> }
    this.sent.push(frame)
    if (frame.type === 'hello') this.reply('welcome', { hb_interval_s: 60 })
    if (frame.type === 'auth') this.reply('auth_ok', { worker_id: 'worker-1', owner_id: 7 })
    if (frame.type === 'hb') this.reply('hb_ack', {})
  }
  reply(type: string, payload: Record<string, unknown>) {
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ v: '8.0', type, payload }),
    })))
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
}

let directory: string | undefined
function jsonBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('expected JSON body')
  return JSON.parse(init.body) as Record<string, unknown>
}
afterEach(async () => {
  vi.unstubAllGlobals()
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

it.each(['confirmed', 'mismatched'] as const)(
  'only sends artifact after Shanghai complete is %s for the same immutable MP4 version', async (mode) => {
    vi.stubGlobal('WebSocket', Socket)
    directory = await mkdtemp(join(tmpdir(), 'reviewed-video-edge-'))
    const sourcePath = join(directory, 'result.mp4')
    const media = Buffer.from('00000018ftypmp42reviewed-media')
    await writeFile(sourcePath, media)
    const sha256 = createHash('sha256').update(media).digest('hex')
    const resultId = '123e4567-e89b-42d3-a456-426614174000'
    const events: string[] = []
    const send = vi.fn(async (address: URL | RequestInfo, init?: RequestInit) => {
      const url = address instanceof URL ? address : address instanceof Request
        ? new URL(address.url) : new URL(address)
      if (url.pathname.endsWith('result-upload-url')) {
        events.push('presign')
        const body = jsonBody(init)
        expect(body).toMatchObject({ shard_id: 'shard-1', worker_id: 'worker-1',
          lease_token: 'private-lease', result_id: resultId, sha256, size_bytes: media.length,
          content_type: 'video/mp4' })
        const key = `v8/account-42/workload-workload-1/shard-shard-1/result/${resultId}/result.mp4`
        return Response.json({ schema_version: 'artifact.v1', method: 'PUT', object_key: key,
          bucket: 'reviewed-evidence', upload_hostname: 'media.example.test',
          url: 'https://media.example.test/put?sig=opaque',
          upload_url: 'https://media.example.test/put?sig=opaque',
          expires_at: Math.floor(Date.now() / 1000) + 600,
          headers: { 'Content-Type': 'video/mp4', 'Content-MD5': body.content_md5,
            'x-amz-checksum-sha256': Buffer.from(sha256, 'hex').toString('base64'),
            'x-amz-meta-sha256': sha256, 'x-amz-object-lock-mode': 'COMPLIANCE',
            'x-amz-object-lock-retain-until-date': new Date(Date.now() + 73 * 60 * 60 * 1000).toISOString() },
          issuance_receipt: { key_id: 'issuance-key', signature: 'a'.repeat(86),
            payload: { schema: 'qianshou.artifact-upload-issuance.v1',
              workload_id: 'workload-1', shard_id: 'shard-1', worker_id: 'worker-1',
              attempt: 0, result_id: resultId, object_key: key, sha256,
              size_bytes: media.length, content_type: 'video/mp4' } } })
      }
      if (url.pathname.endsWith('result-complete')) {
        events.push('complete')
        const body = jsonBody(init)
        expect(body).toMatchObject({ shard_id: 'shard-1', worker_id: 'worker-1',
          lease_token: 'private-lease', result_id: resultId, object_version_id: 'version-1' })
        return Response.json({ ok: true, completed: true, bucket: 'reviewed-evidence',
          object_key: body.object_key, object_version_id: body.object_version_id,
          sha256: mode === 'mismatched' ? '0'.repeat(64) : sha256,
          size_bytes: media.length, content_type: 'video/mp4',
          signed_video_upload_completion_receipt: { key_id: 'upload-key', signature: 'a'.repeat(86),
            payload: { schema: 'qianshou.reviewed-video-object-upload.v1',
              purpose: 'shanghai.video.upload.v1', role: 'output', account_id: 42,
              workload_id: 'workload-1', shard_id: 'shard-1', worker_id: 'worker-1', attempt: 0,
              object: { bucket: 'reviewed-evidence', key: body.object_key,
                version_id: body.object_version_id, sha256, size_bytes: media.length,
                mime_type: 'video/mp4' } } } })
      }
      expect(url.hostname).toBe('media.example.test')
      events.push('put')
      const reader = (init?.body as ReadableStream<Uint8Array>).getReader()
      const chunks: Buffer[] = []
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        chunks.push(Buffer.from(part.value))
      }
      expect(Buffer.concat(chunks)).toEqual(media)
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
      return new Response(null, { status: 200, headers: { 'x-cos-version-id': 'version-1' } })
    }) as typeof fetch
    const onOffer = vi.fn(async (_offer: EdgeTaskOffer) => undefined)
    const connection = new EdgeWorkerConnection({ origin: 'https://shanghai.example.test', loopbackOnly: false,
      tokenProvider: () => 'account-token', expectedOwnerId: 7, name: 'test', clientBuild: 'test',
      os: 'win32', arch: 'x64', capabilities: {}, allowedTaskTypes: ['owner_video_v1'],
      handshakeTimeoutMs: 1000, maxFrameBytes: 65536, maxOutputBytes: 4096,
      readLoad: () => 0, onOffer, onEvent: vi.fn(), artifactFetch: send })
    try {
      await connection.connect()
      connection.updateMode('running')
      Socket.latest.reply('shard_assign', { workload_id: 'workload-1', shard_id: 'shard-1',
        attempt: 0, task_type: 'owner_video_v1', runtime: 'python3', input_kind: 'multi_file',
        inline_input: null, input_ref: 'https://media.example.test/first.png?versionId=v1',
        input_refs: ['https://media.example.test/first.png?versionId=v1'], params: {},
        code_url: '', code_sha256: '', timeout_s: 60, verification_policy: 'semantic',
        execution_model: 'runtime_v2', runtime_api: '2.0', capability: 'video.render',
        capability_version: 'v1', lease_token: 'private-lease', reviewed_video_order: { signed: 'test' } })
      await vi.waitFor(() => { expect(onOffer).toHaveBeenCalledOnce() })
      const offer = onOffer.mock.calls[0]![0]
      const upload = { sourcePath,
        expectedBytes: media.length, expectedSha256: sha256, resultId,
        storageOrigin: new URL('https://media.example.test') }
      if (mode === 'mismatched') {
        await expect(connection.uploadReviewedVideoFile(offer, upload))
          .rejects.toMatchObject({ code: 'EDGE_VIDEO_COMPLETE_OUTCOME_UNKNOWN' })
        expect(events).toEqual(['presign', 'put', 'complete'])
        await expect(connection.uploadReviewedVideoFile(offer, upload))
          .rejects.toMatchObject({ code: 'EDGE_REVIEWED_VIDEO_UPLOAD_DENIED' })
        expect(Socket.latest.sent.some(frame => frame.type === 'shard_result')).toBe(false)
        return
      }
      const artifact = await connection.uploadReviewedVideoFile(offer, upload)
      expect(events).toEqual(['presign', 'put', 'complete'])
      expect(artifact).toMatchObject({ object_version_id: 'version-1', sha256,
        size_bytes: media.length, account_id: 42 })
      expect(() => connection.completeArtifact(offer, { artifact: { ...artifact,
        object_version_id: 'different' }, elapsedMs: 1 })).toThrow('EDGE_ARTIFACT_RESULT_INVALID')
      connection.completeArtifact(offer, { artifact, elapsedMs: 1 })
      expect(Socket.latest.sent.at(-1)?.type).toBe('shard_result')
      expect(events).toEqual(['presign', 'put', 'complete'])
    } finally { await connection.close() }
  })
