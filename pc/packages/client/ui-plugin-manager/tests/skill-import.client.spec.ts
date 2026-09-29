import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SkillImportController, type SkillImportInspectionView } from '../src/client/skill-import-controller.ts'

const inspection: SkillImportInspectionView = {
  inspectionId: 'review-1', name: 'draft-helper', description: 'Help draft short text.',
  sha256: 'a'.repeat(64), bytes: 74, targetPath: '/test/skills/draft-helper/SKILL.md',
  expiresAt: Date.now() + 60_000, modelInvocable: true, userInvocable: true,
}

function file(bytes: Uint8Array, name = 'SKILL.md'): File {
  return { name, size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer } as File
}

function controllerWith(inspect: ReturnType<typeof vi.fn>, install: ReturnType<typeof vi.fn>, verify = vi.fn()) {
  return new SkillImportController({ remote: { qianshouSkillImport: { inspect, install, verify } } } as unknown as Context)
}

describe('local skill import review', () => {
  it('reads exact UTF-8 bytes, reviews them, and writes only after a separate confirmation', async () => {
    const inspect = vi.fn().mockResolvedValue({ ok: true, value: inspection })
    const install = vi.fn().mockResolvedValue({ ok: true, value: { state: 'written', name: inspection.name,
      sha256: inspection.sha256, bytes: inspection.bytes, path: inspection.targetPath } })
    const controller = controllerWith(inspect, install)
    const content = '---\nname: draft-helper\ndescription: Help draft short text.\n---\n\nInstructions.\n'
    await controller.inspectFile(file(new TextEncoder().encode(content)))
    expect(inspect).toHaveBeenCalledExactlyOnceWith(content)
    expect(install).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', inspection })

    await controller.install()
    expect(install).toHaveBeenCalledExactlyOnceWith('review-1')
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'written', writtenPath: inspection.targetPath })
    controller.dispose()
  })

  it('rejects an unsupported file, invalid UTF-8, and oversized bytes before any Host call', async () => {
    const inspect = vi.fn()
    const controller = controllerWith(inspect, vi.fn())
    await controller.inspectFile(file(new TextEncoder().encode('content'), 'archive.zip'))
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', error: 'invalidFile' })
    await controller.inspectFile(file(new Uint8Array([0xff])))
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', error: 'readFailed' })
    await controller.inspectFile(file(new Uint8Array(256 * 1024 + 1)))
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', error: 'tooLarge' })
    expect(inspect).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('ignores a late inspection after the user chooses another file', async () => {
    const old = Promise.withResolvers<{ ok: true; value: SkillImportInspectionView }>()
    const inspect = vi.fn().mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ ok: true, value: { ...inspection, name: 'new-skill' } })
    const controller = controllerWith(inspect, vi.fn())
    const first = controller.inspectFile(file(new TextEncoder().encode('first')))
    await vi.waitFor(() => { expect(inspect).toHaveBeenCalledTimes(1) })
    await controller.inspectFile(file(new TextEncoder().encode('second')))
    old.resolve({ ok: true, value: inspection })
    await first
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', inspection: { name: 'new-skill' } })
    controller.dispose()
  })

  it('keeps a Host conflict distinct from a written receipt', async () => {
    const inspect = vi.fn().mockResolvedValue({ ok: true, value: inspection })
    const install = vi.fn().mockResolvedValue({ ok: false, error: { code: 'skill-import/conflict', message: 'exists' } })
    const controller = controllerWith(inspect, install)
    await controller.inspectFile(file(new TextEncoder().encode('review')))
    await controller.install()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', error: 'conflict', writtenPath: null })
    controller.dispose()
  })

  it('checks the target after an interrupted install reply and never starts another upload meanwhile', async () => {
    const inspect = vi.fn().mockResolvedValue({ ok: true, value: inspection })
    const deferred = Promise.withResolvers<never>()
    const install = vi.fn().mockReturnValue(deferred.promise)
    const verify = vi.fn().mockResolvedValueOnce({ ok: true, value: { state: 'missing' } })
      .mockResolvedValueOnce({ ok: true, value: { state: 'matched' } })
    const controller = controllerWith(inspect, install, verify)
    await controller.inspectFile(file(new TextEncoder().encode('review')))
    const pending = controller.install()
    await controller.inspectFile(file(new TextEncoder().encode('replacement')))
    expect(inspect).toHaveBeenCalledTimes(1)
    deferred.reject(new Error('connection lost'))
    await pending
    expect(verify).toHaveBeenCalledExactlyOnceWith(inspection.name, inspection.sha256)
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'unconfirmed', inspection })
    await controller.inspectFile(file(new TextEncoder().encode('replacement')))
    expect(inspect).toHaveBeenCalledTimes(1)
    await controller.checkWrite()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'written', writtenPath: inspection.targetPath })
    controller.dispose()
  })
})
