import { afterEach, expect, it } from 'vitest'
import { bindInlineEdgeResident } from '../src/edge-binding.ts'
import { prepareH3OrderInput } from '../src/h3-video.ts'
import type { ArtifactOrderAdapter } from '../src/artifact-order.ts'
import { FixtureWebSocketServer } from '../../compute-core/tests/transport/fixture-ws-server.ts'

const servers: FixtureWebSocketServer[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close() })

it('announces the actual native H3 binding and withdraws its route when the local proof is unavailable', async () => {
  const server = await FixtureWebSocketServer.start({ script(frame, context) {
    if (frame.type === 'hello') context.reply('welcome', { hb_interval_s: 60, server_time: '2026-09-27T00:00:00.000Z' })
    if (frame.type === 'auth') context.reply('auth_ok', { worker_id: 'h3-fixture-worker', owner_id: 7, reconnect: false })
    if (frame.type === 'hb') context.reply('hb_ack', {})
  } })
  servers.push(server)
  let verified = true
  const adapter: ArtifactOrderAdapter = { taskType: 'video_generate', inputKind: 'inline', outputKind: 'artifact_ref',
    contractVersion: 'v1', artifactDigest: `sha256:${'a'.repeat(64)}`, packageDigest: `sha256:${'b'.repeat(64)}`,
    outputFormats: ['mp4'], maxInputBytes: 32 * 1024, prepareRequest: prepareH3OrderInput,
    run: async () => { throw new Error('this socket fixture never generates video') } }
  const edge = bindInlineEdgeResident({ nodeId: 'h3-fixture-node', agentVersion: 'fixture',
    allowedTaskTypes: ['word_count', 'video_generate'], handshakeTimeoutMs: 2000, maxFrameBytes: 65536,
    maxOutputBytes: 4096, supply: () => 'paused', originOf: () => server.origin,
    tokenOf: async () => 'fixture-token', ownerIdOf: async () => 7, verification: false,
    probe: async () => { throw new Error('isolated fixture; no actual machine survey') },
    nativeArtifactOrders: [{ taskType: 'video_generate', loadAndSelfTest: async () => verified ? adapter : null }],
  })
  expect(edge.artifactReady('video_generate')).toBe(false)
  const first = await edge.connector.connect(new AbortController().signal)
  const hello = server.frames.find(frame => frame.type === 'hello')?.payload.capabilities as Record<string, unknown>
  expect(hello.verified_task_adapters).toContainEqual(expect.objectContaining({ task_type: 'video_generate',
    capability_id: 'video.render', output_kind: 'artifact_ref', installation_state: 'installed',
    health: 'verified', self_test: 'passed' }))
  expect(hello.provided_capabilities).toContainEqual({ name: 'video.render', version: '1.0.0', health: 'ok' })
  expect(edge.artifactReady('video_generate')).toBe(true)
  const offer = { workerId: 'h3-fixture-worker', workloadId: 'h3-work', shardId: 'shard', attempt: 0,
    taskType: 'video_generate', runtime: 'python3', inputKind: 'inline', inlineInput: '五秒镜头', inputRef: '',
    inputRefs: [], codeUrl: '', codeSha256: '', timeoutSeconds: 1500, verificationPolicy: 'semantic' as const,
    executionModel: '', capability: '', capabilityVersion: '', params: { seconds: 5, seed: 1 } }
  const context = { workerId: 'h3-fixture-worker', receivedAt: '2026-09-27T00:00:00.000Z' }
  expect(edge.binding.bridge.toNodeOffer(offer, context)).toMatchObject({ envelope: {
    capabilityId: 'video.render', maxOutputBytes: 16 * 1024 * 1024,
    parameters: { taskType: 'video_generate', taskParams: { seconds: 5, seed: 1 } } } })
  await first.close()
  verified = false
  const second = await edge.connector.connect(new AbortController().signal)
  const next = server.frames.filter(frame => frame.type === 'hello').at(-1)?.payload.capabilities as Record<string, unknown>
  expect(next.verified_task_adapters).toEqual([])
  expect(next.provided_capabilities).not.toContainEqual(expect.objectContaining({ name: 'video.render' }))
  expect(edge.artifactReady('video_generate')).toBe(false)
  expect(edge.binding.bridge.toNodeOffer(offer, context)).toEqual({ refuse: 'TASK_TYPE_DENIED' })
  await second.close()
})
