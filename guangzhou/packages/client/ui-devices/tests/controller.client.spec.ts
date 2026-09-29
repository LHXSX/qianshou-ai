import { describe, it, expect, vi } from 'vitest'
import { DevicesController } from '../src/client/controller.ts'
describe('device coordinator view', () => {
  it('calls the browser fetch with its global receiver', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async function (this: unknown) {
      expect(this).toBe(globalThis)
      return Response.json({ devices: [], jobs: [] })
    }
    const c = new DevicesController()
    try {
      await c.refresh()
      expect(c.store.getSnapshot().error).toBeNull()
    } finally {
      c.dispose()
      globalThis.fetch = original
    }
  })
  it('shows returned devices and forwards a task for remote approval', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push([String(input), init])
        return Response.json(
          String(input).endsWith('/devices')
            ? {
                devices: [
                  {
                    id: 'd',
                    name: 'Workstation',
                    connected: true,
                    workspaces: [],
                  },
                ],
                jobs: [],
              }
            : { id: 'j', status: 'awaiting-approval' },
        )
      },
    )
    const c = new DevicesController(fetcher)
    await c.refresh()
    expect(c.store.getSnapshot().devices[0]?.name).toBe('Workstation')
    await c.act('jobs', {
      deviceId: 'd',
      kind: 'command',
      payload: { command: 'pwd' },
    })
    const request = calls.find(([u]) => u.endsWith('/jobs'))?.[1]
    expect(request?.credentials).toBe('same-origin')
    expect(JSON.parse(String(request?.body)).payload.command).toBe('pwd')
    c.dispose()
  })
  it('preserves service errors instead of showing an invented success', async () => {
    const c = new DevicesController(
      vi.fn(async () =>
        Response.json({ error: 'DEVICE_OFFLINE' }, { status: 409 }),
      ),
    )
    await c.act('jobs', {})
    expect(c.store.getSnapshot().error).toBe('DEVICE_OFFLINE')
    expect(c.store.getSnapshot().busy).toBe(false)
    c.dispose()
  })
  it('does not publish a late response after disposal', async () => {
    let resolve!: (r: Response) => void
    const c = new DevicesController(
      vi.fn(
        () =>
          new Promise<Response>((r) => {
            resolve = r
          }),
      ),
    )
    const task = c.refresh()
    c.dispose()
    resolve(Response.json({ devices: [{ id: 'late' }], jobs: [] }))
    await task
    expect(c.store.getSnapshot().devices).toEqual([])
  })
  it('does not submit duplicate mutations while waiting', async () => {
    let resolve!: (r: Response) => void
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolve = r
        }),
    )
    const c = new DevicesController(fetcher)
    const first = c.act('jobs', {})
    await c.act('jobs', {})
    expect(fetcher).toHaveBeenCalledTimes(1)
    c.dispose()
    resolve(Response.json({}))
    await first
  })
})
