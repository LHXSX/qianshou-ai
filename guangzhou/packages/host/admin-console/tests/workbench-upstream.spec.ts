import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWorkbenchUpstream } from '../src/workbench-upstream.ts'

const config = { baseUrl: 'http://127.0.0.1:7080', audience: 'fixture', keyId: 'v1', credentialRef: 'QIANSHOU_ADMIN_KEY' }

async function home() {
  const dir = await mkdtemp(join(tmpdir(), 'qianshou-workbench-probe-')); const dshHome = join(dir, 'home'); await mkdir(dshHome)
  await writeFile(join(dshHome, '.credentials.yaml'), 'version: 1\nrefs:\n  QIANSHOU_ADMIN_KEY: ' + 'a'.repeat(43) + '\n', { mode: 0o600 })
  return dshHome
}

describe('workbench readiness probe', () => {
  it('reports unconfigured before attempting a request', async () => {
    const upstream = createWorkbenchUpstream({ dshHome: '/unused' })
    expect(await upstream.probe()).toMatchObject({ status: 'unconfigured' })
  })

  it('distinguishes unauthorized service credentials from a reachable dry-run endpoint', async () => {
    const dshHome = await home(); let status = 401
    const upstream = createWorkbenchUpstream({ config, dshHome, fetch: async () => Response.json({ ok: false }, { status }) })
    expect(await upstream.probe()).toMatchObject({ status: 'unauthorized' })
    status = 422
    expect(await upstream.probe()).toMatchObject({ status: 'ready' })
  })
})
