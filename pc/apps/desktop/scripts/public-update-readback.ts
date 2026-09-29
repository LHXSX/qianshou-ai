/** Compare public updater bytes with the completed local release, without publishing. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { DesktopUploadArtifact, DesktopUploadPlan } from './desktop-upload-plan.ts'

export interface PublicUpdateReadback {
  readonly key: string
  readonly url: string
  readonly size: number
  readonly sha512: string
  readonly channelMetadata: boolean
}

async function digestLocal(artifact: DesktopUploadArtifact): Promise<{ size: number; sha512: string }> {
  const hash = createHash('sha512')
  let size = 0
  const source = artifact.contents === undefined
    ? createReadStream(artifact.path)
    : [Buffer.from(artifact.contents)]
  for await (const bytes of source) {
    size += bytes.length
    hash.update(bytes)
  }
  if (size === 0) throw new Error(`desktop update readback: empty local artifact ${artifact.key}`)
  return { size, sha512: hash.digest('base64') }
}

async function digestPublic(response: Response, expectedSize: number): Promise<{ size: number; sha512: string }> {
  if (response.body === null) throw new Error('desktop update readback: public response has no body')
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) !== expectedSize)) {
    throw new Error('desktop update readback: public Content-Length differs')
  }
  const encoding = response.headers.get('content-encoding')
  if (encoding !== null && encoding.toLowerCase() !== 'identity') {
    throw new Error('desktop update readback: public bytes are content encoded')
  }
  const hash = createHash('sha512')
  const reader = response.body.getReader()
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > expectedSize) throw new Error('desktop update readback: public artifact exceeds local size')
      hash.update(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  return { size, sha512: hash.digest('base64') }
}

/**
 * Read every public binary before reading the channel feed; never use a cache-busting URL.
 * A success proves the exact public bytes observed at this time, not later availability.
 * @param plan Validated local release plan; credentials are neither read nor transmitted.
 * @param fetchPublic Network transport, injectable only for isolated tests.
 * @returns Per-object byte receipts for release evidence.
 */
export async function verifyPublicDesktopUpdate(
  plan: DesktopUploadPlan,
  fetchPublic: typeof fetch = fetch,
): Promise<readonly PublicUpdateReadback[]> {
  const feed = new URL(plan.publicUrl)
  if (feed.protocol !== 'https:' || feed.username !== '' || feed.password !== '' || feed.search !== '' || feed.hash !== '') {
    throw new Error('desktop update readback: feed must be a credential-free HTTPS URL')
  }
  let channelSeen = false
  for (const artifact of plan.artifacts) {
    if (channelSeen && !artifact.channelMetadata) {
      throw new Error('desktop update readback: channel metadata must follow all binaries')
    }
    channelSeen ||= artifact.channelMetadata
    if (!/^[A-Za-z0-9._/-]+$/u.test(artifact.key)
      || artifact.key.startsWith('/') || artifact.key.split('/').includes('..')) {
      throw new Error('desktop update readback: invalid object key')
    }
  }
  if (!channelSeen) throw new Error('desktop update readback: release plan has no channel feed')
  const output: PublicUpdateReadback[] = []
  for (const artifact of plan.artifacts) {
    const url = new URL(`/${artifact.key}`, feed.origin)
    const expected = await digestLocal(artifact)
    const response = await fetchPublic(url, {
      headers: { 'accept-encoding': 'identity' },
      redirect: 'manual',
      signal: AbortSignal.timeout(900_000),
    })
    if (response.status !== 200 || response.url !== url.href) {
      await response.body?.cancel()
      throw new Error(`desktop update readback: public ${artifact.key} returned HTTP ${response.status} or redirected`)
    }
    const actual = await digestPublic(response, expected.size)
    if (actual.size !== expected.size || actual.sha512 !== expected.sha512) {
      throw new Error(`desktop update readback: public ${artifact.key} differs from the local release`)
    }
    output.push({ key: artifact.key, url: url.href, ...actual, channelMetadata: artifact.channelMetadata })
  }
  return output
}
