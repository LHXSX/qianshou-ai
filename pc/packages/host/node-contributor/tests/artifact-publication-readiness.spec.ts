import { describe, expect, it } from 'vitest'
import { readArtifactPublicationReadiness } from '../src/artifact-publication-readiness.ts'

const digest = `sha256:${'a'.repeat(64)}`
const packageDigest = `sha256:${'b'.repeat(64)}`
const input = {
  origin: 'https://edge.example.test', token: 'owner-token', ownerId: 7,
  taskType: 'bar_chart_svg_v1', artifactDigest: digest, packageDigest,
}

describe('owner-scoped artifact publication gate', () => {
  it('opens only for an owner receipt and the exact installed digest', async () => {
    const calls: Array<{ url: string; auth: string | null }> = []
    const fetcher: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') })
      return Response.json({ task_type: 'bar_chart_svg_v1', ready: true, owner_id: 7,
        publication_id: 'publication-1', approved_artifact_digest: digest,
        approved_package_digest: packageDigest })
    }
    expect(await readArtifactPublicationReadiness({ ...input, fetch: fetcher })).toEqual({
      ready: true, publicationId: 'publication-1',
    })
    expect(calls).toEqual([{
      url: 'https://edge.example.test/api/v8/task-adapter-publications/readiness/bar_chart_svg_v1',
      auth: 'Bearer owner-token',
    }])
  })

  it('closes for wrong owner, wrong digest, missing publication and missing route', async () => {
    for (const change of [{ owner_id: 8 }, { approved_artifact_digest: `sha256:${'c'.repeat(64)}` },
      { approved_package_digest: `sha256:${'c'.repeat(64)}` },
      { approved_package_digest: undefined }, { publication_id: null }, { ready: false }]) {
      const fetcher: typeof fetch = async () => Response.json({ task_type: 'bar_chart_svg_v1',
        ready: true, owner_id: 7, publication_id: 'publication-1', approved_artifact_digest: digest,
        approved_package_digest: packageDigest,
        ...change })
      expect(await readArtifactPublicationReadiness({ ...input, fetch: fetcher })).toEqual({
        ready: false, publicationId: null,
      })
    }
    expect(await readArtifactPublicationReadiness({ ...input,
      fetch: async () => new Response('', { status: 404 }) })).toEqual({ ready: false, publicationId: null })
  })
})
