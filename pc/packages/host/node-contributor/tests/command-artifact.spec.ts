import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createCommandArtifactAdapter, type NativeArtifactOutput } from '../src/command-artifact.ts'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

it.each(['native_media_a', 'native_media_b'])('executes %s through the shared command and actual-byte manifest path', async (taskType) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-command-fixture-')))
  roots.push(root)
  const bytes = Buffer.from('0000ftyp-independent-command-fixture')
  const output: NativeArtifactOutput = { path: join(root, 'actual.mp4'), filename: 'result.mp4', contentType: 'video/mp4',
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  const program = vi.fn(async () => { await writeFile(output.path, bytes); return { stdout: JSON.stringify(output) } })
  let claimedSha = output.sha256
  const verifyOutput = vi.fn(async () => undefined)
  const adapter = createCommandArtifactAdapter({ taskType, inputKind: 'inline', outputKind: 'artifact_ref',
    contractVersion: 'v1', artifactDigest: `sha256:${'a'.repeat(64)}`, packageDigest: `sha256:${'b'.repeat(64)}`,
    outputFormats: ['mp4'], command: async () => ({ program: '/owner/python', args: ['/owner/entry.py'], env: {},
      timeoutMs: 1000, normalizeResult: value => ({ ...(value as NativeArtifactOutput), sha256: claimedSha }), verifyOutput }) }, program)
  const result = await adapter.run({ recipeJson: '{}', outputFormat: 'mp4', workspacePath: root,
    signal: new AbortController().signal })
  expect(result).toEqual({ path: output.path, filename: 'result.mp4', contentType: 'video/mp4' })
  expect(verifyOutput).toHaveBeenCalledOnce()
  claimedSha = '0'.repeat(64)
  await expect(adapter.run({ recipeJson: '{}', outputFormat: 'mp4', workspacePath: root,
    signal: new AbortController().signal })).rejects.toMatchObject({ code: 'COMPUTE_NATIVE_OUTPUT_CHANGED' })
  expect(verifyOutput).toHaveBeenCalledOnce()
})
