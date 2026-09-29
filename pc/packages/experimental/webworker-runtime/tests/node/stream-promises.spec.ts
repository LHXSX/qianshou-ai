/** The promise subpath uses real streams and preserves failure and cancellation. */
import { describe, expect, it } from 'vitest'
import { createNodeBuiltins } from '../../src/node/builtins.ts'
import { MODULE_PROXIES } from '../../src/module-proxies.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { PassThrough, Readable, Writable, promises } from '../../src/node/builtin_modules/implemented/stream.ts'
import * as streamPromises from '../../src/node/builtin_modules/implemented/stream/promises.ts'

describe('worker stream/promises', () => {
  it('resolves both names to the maintained stream promise helpers', () => {
    const vfs = new MemoryVfs()
    vfs.seedDirectory('/dsh')
    const loader = new WorkerModuleLoader({ vfs, root: '/dsh', staticModules: createNodeBuiltins() })
    const require = loader.createRequire('/dsh/')
    expect(require('stream/promises')).toBe(streamPromises)
    expect(require('node:stream/promises')).toBe(streamPromises)
    expect(streamPromises.pipeline).toBe(promises.pipeline)
    expect(streamPromises.finished).toBe(promises.finished)
    expect(MODULE_PROXIES['node:stream/promises']).toBe(MODULE_PROXIES['stream/promises'])
    expect(MODULE_PROXIES['node:stream/promises']).toBe('./node/builtin_modules/implemented/stream/promises.ts')
    expect(() => require('node:stream/not-implemented')).toThrow()
  })

  it('awaits a real pipeline and finished writable with its complete output', async () => {
    const chunks: string[] = []
    const target = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString())
        callback()
      },
    })
    const complete = streamPromises.finished(target)
    await streamPromises.pipeline(Readable.from(['first', 'second']), target)
    await complete
    expect(chunks).toEqual(['first', 'second'])
    expect(target.writableFinished).toBe(true)
  })

  it('rejects pipeline and finished when the writable fails', async () => {
    const failure = new Error('worker stream write refused')
    const target = new Writable({ write(_chunk, _encoding, callback) { callback(failure) } })
    const completed = expect(streamPromises.finished(target)).rejects.toBe(failure)
    const piped = expect(streamPromises.pipeline(Readable.from(['payload']), target)).rejects.toBe(failure)
    await Promise.all([completed, piped])
    expect(target.writableFinished).toBe(false)
  })

  it('rejects an aborted unfinished pipeline instead of reporting completion', async () => {
    const controller = new AbortController()
    const source = new PassThrough()
    const target = new Writable({ write(_chunk, _encoding, callback) { callback() } })
    const result = expect(streamPromises.pipeline(source, target, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' })
    source.write('partial')
    controller.abort()
    await result
    expect(target.writableFinished).toBe(false)
    expect(source.destroyed).toBe(true)
    expect(target.destroyed).toBe(true)
  })
})
