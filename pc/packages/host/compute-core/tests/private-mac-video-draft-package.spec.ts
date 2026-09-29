import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { LocalPluginDraftStore } from '../src/plugin-draft.ts'
import { installReviewedMacVideoDraft, MAC_VIDEO_DRAFT_TEMPLATE } from '../src/private-mac-video-draft-package.ts'
import { PRIVATE_MAC_VIDEO_ARCHIVE_SHA256 } from '../src/private-mac-video-install.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it.skipIf(process.platform !== 'darwin')('requires an exact saved template and a fresh owner decision before private packaging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-mac-video-draft-package-'))
  roots.push(root)
  const drafts = new LocalPluginDraftStore({ path: join(root, 'drafts.json'), maxDrafts: 10, maxBytes: 131072 })
  const saved = await drafts.save({ spec: MAC_VIDEO_DRAFT_TEMPLATE })
  const installs: string[] = []
  const manager = {
    listBundles: async () => [], checkBundle: async () => ({ state: 'missing', selected: false, rows: [] }),
    installBundle: async (path: string) => { installs.push(path); return { application: 'restart-required', bundle: 'qianshou-mac-drawn-video' } },
  }
  const base = { draftId: saved.id, expectedUpdatedAt: saved.updatedAt, drafts,
    packageRoot: join(root, 'private-packages'), profileDir: join(root, 'profile'), manager,
    executors: { resolve: () => { throw new Error('must not resolve before restart') } },
    factory: { available: true }, signal: new AbortController().signal }
  try {
    await expect(installReviewedMacVideoDraft({ ...base, approve: async () => 'rejected' }))
      .rejects.toThrow('COMPUTE_PRIVATE_MAC_VIDEO_OWNER_APPROVAL_REQUIRED')
    expect(installs).toEqual([])
    await expect(installReviewedMacVideoDraft({ ...base, expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
      approve: async () => 'allowed-once' })).rejects.toThrow('COMPUTE_PRIVATE_MAC_VIDEO_DRAFT_MISMATCH')
    expect(installs).toEqual([])
    const changed = await drafts.save({ spec: { ...MAC_VIDEO_DRAFT_TEMPLATE, displayName: '不同模板' } })
    await expect(installReviewedMacVideoDraft({ ...base, draftId: changed.id, expectedUpdatedAt: changed.updatedAt,
      approve: async () => 'allowed-once' })).rejects.toThrow('COMPUTE_PRIVATE_MAC_VIDEO_DRAFT_MISMATCH')
    expect(installs).toEqual([])

    let approvalReason = ''
    const result = await installReviewedMacVideoDraft({ ...base, approve: async reason => {
      approvalReason = reason; return 'allowed-once'
    } })
    expect(result).toMatchObject({ draftId: saved.id, state: 'restart-required',
      archiveSha256: PRIVATE_MAC_VIDEO_ARCHIVE_SHA256, localOnly: true,
      signed: false, marketInstalled: false, dispatchable: false })
    expect(approvalReason).toContain(saved.updatedAt)
    expect(approvalReason).toContain(PRIVATE_MAC_VIDEO_ARCHIVE_SHA256)
    expect(installs).toEqual([result.archivePath])
    const bytes = await readFile(result.archivePath)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(PRIVATE_MAC_VIDEO_ARCHIVE_SHA256)
    bytes[20] = (bytes[20] ?? 0) ^ 1
    await writeFile(result.archivePath, bytes)
    await expect(installReviewedMacVideoDraft({ ...base, approve: async () => 'allowed-once' }))
      .rejects.toThrow('COMPUTE_PRIVATE_MAC_VIDEO_PACKAGE_CHANGED')
    expect(installs).toHaveLength(1)
  } finally { await drafts.close() }
})
