import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { CommunityController, type CommunityEntry } from '../src/client/community-controller.ts'

const first: CommunityEntry = {
  name: '@example/writer', version: '1.2.3', description: 'Write documents',
  publisher: 'example', license: 'MIT', packageUrl: 'https://www.npmjs.com/package/%40example%2Fwriter/v/1.2.3',
  installSpec: '@example/writer@1.2.3',
}

const second: CommunityEntry = {
  name: '@example/reader', version: '2.0.0', description: 'Read documents',
  publisher: 'example', license: 'MIT', packageUrl: 'https://www.npmjs.com/package/%40example%2Freader/v/2.0.0',
  installSpec: '@example/reader@2.0.0',
}

function page(query: string, entries: CommunityEntry[], nextOffset: number | null, offset = 0) {
  return { ok: true as const, value: {
    source: 'https://registry.npmjs.org/', query, offset, nextOffset,
    checkedAt: 1_700_000_000_000 + offset, excluded: 1, unavailable: 2, entries,
  } }
}

function controllerWith(search: ReturnType<typeof vi.fn>): CommunityController {
  return new CommunityController({ remote: { qianshouPluginCatalog: { search } } } as unknown as Context)
}

describe('community discovery ownership', () => {
  it('does not contact the public registry until a search is explicitly requested', async () => {
    const search = vi.fn().mockResolvedValue(page('writer', [first], null))
    const controller = controllerWith(search)
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'idle', entries: [] })
    expect(search).not.toHaveBeenCalled()
    await controller.loadMore()
    expect(search).not.toHaveBeenCalled()

    await controller.search('  writer  ')
    expect(search).toHaveBeenCalledExactlyOnceWith({ query: 'writer', offset: 0 })
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready', query: 'writer', source: 'https://registry.npmjs.org/', entries: [first],
    })
    controller.dispose()
  })

  it('appends only the next page and keeps its source, omissions, and observation time', async () => {
    const search = vi.fn()
      .mockResolvedValueOnce(page('plugin', [first], 12))
      .mockResolvedValueOnce(page('plugin', [second], null, 12))
    const controller = controllerWith(search)
    await controller.search('plugin')
    await controller.loadMore()

    expect(search).toHaveBeenNthCalledWith(1, { query: 'plugin', offset: 0 })
    expect(search).toHaveBeenNthCalledWith(2, { query: 'plugin', offset: 12 })
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready', entries: [first, second], nextOffset: null,
      source: 'https://registry.npmjs.org/', excluded: 2, unavailable: 4,
      checkedAt: 1_700_000_000_012, loadingMore: false,
    })
    await controller.loadMore()
    expect(search).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('ignores an older search response after the user starts a newer search', async () => {
    const old = Promise.withResolvers<ReturnType<typeof page>>()
    const search = vi.fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(page('reader', [second], null))
    const controller = controllerWith(search)
    const pending = controller.search('writer')
    await controller.search('reader')
    old.resolve(page('writer', [first], null))
    await pending

    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready', query: 'reader', entries: [second],
    })
    controller.dispose()
  })

  it('does not let a stale next page append to a fresh search', async () => {
    const oldPage = Promise.withResolvers<ReturnType<typeof page>>()
    const search = vi.fn()
      .mockResolvedValueOnce(page('writer', [first], 12))
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce(page('reader', [second], null))
    const controller = controllerWith(search)
    await controller.search('writer')
    const pending = controller.loadMore()
    await controller.search('reader')
    oldPage.resolve(page('writer', [first], null, 12))
    await pending

    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready', query: 'reader', entries: [second], nextOffset: null,
    })
    controller.dispose()
  })

  it('keeps verified entries and reports a failed next page so it can be retried', async () => {
    const search = vi.fn()
      .mockResolvedValueOnce(page('writer', [first], 12))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(page('writer', [second], null, 12))
    const controller = controllerWith(search)
    await controller.search('writer')
    await controller.loadMore()
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready', entries: [first], nextOffset: 12, pageError: true,
    })
    await controller.loadMore()
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready', entries: [first, second], nextOffset: null, pageError: false,
    })
    controller.dispose()
  })
})
