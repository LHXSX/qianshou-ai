import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authenticateWebHost, forwardWebRequest, serveShellDocument, serveWebDocument } from '../src/web-document.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('serves the Web entry and assets without starting or contacting a Host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-web-'))
  roots.push(root)
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'index.html'), '<html><head></head><body><script src="assets/entry.js"></script></body></html>')
  await writeFile(join(root, 'assets/entry.js'), 'globalThis.entryLoaded = true')
  await writeFile(join(root, 'assets/qianshou-getting-started.mp4'), new Uint8Array([0, 1, 2]))
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const response = await serveWebDocument(new Request('dsh-app://app/'), root)
  const html = await response.text()
  expect(html.indexOf('Promise.withResolvers()')).toBeLessThan(html.indexOf('assets/entry.js'))
  expect(await (await serveWebDocument(new Request('dsh-app://app/assets/entry.js'), root)).text()).toContain('entryLoaded')
  const guideVideo = await serveWebDocument(new Request('dsh-app://app/assets/qianshou-getting-started.mp4'), root)
  expect(guideVideo.headers.get('content-type')).toBe('video/mp4')
  expect(new Uint8Array(await guideVideo.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2]))
  expect(fetch).not.toHaveBeenCalled()
  expect((await serveWebDocument(new Request('dsh-app://app/%2e%2e%2fprivate'), root)).status).toBe(403)
  expect((await serveWebDocument(new Request('dsh-app://app/missing.js'), root)).status).toBe(404)
})

it('serves shipped update dialogs on the isolated shell origin and rejects other files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-shell-'))
  roots.push(root)
  await writeFile(join(root, 'update-dialog.html'), '<html><head></head><body>update dialog</body></html>')
  await writeFile(join(root, 'update-dialog.js'), 'globalThis.shellLoaded = true')
  await writeFile(join(root, 'mandatory-update.html'), '<html><body>mandatory update</body></html>')
  await writeFile(join(root, 'policy-login-loading.html'), 'private')
  const dialog = await serveShellDocument(new Request('dsh-app://shell/update-dialog.html'), root)
  expect(dialog.status).toBe(200)
  expect(dialog.headers.get('content-type')).toBe('text/html; charset=utf-8')
  expect(await dialog.text()).toContain('update dialog')
  expect(await (await serveShellDocument(new Request('dsh-app://shell/update-dialog.js'), root)).text()).toContain('shellLoaded')
  expect((await serveShellDocument(new Request('dsh-app://shell/mandatory-update.html', { method: 'HEAD' }), root)).status).toBe(200)
  expect((await serveShellDocument(new Request('dsh-app://shell/policy-login-loading.html'), root)).status).toBe(404)
  expect((await serveShellDocument(new Request('dsh-app://shell/%2e%2e%2fprivate'), root)).status).toBe(404)
  expect((await serveShellDocument(new Request('dsh-app://app/update-dialog.html'), root)).status).toBe(404)
  expect((await serveShellDocument(new Request('dsh-app://shell/update-dialog.html', { method: 'POST' }), root)).status).toBe(405)
})

it('uses the installed Qianshou mark for the local document favicon and brand asset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-brand-'))
  roots.push(root)
  await mkdir(join(root, 'brand'))
  await writeFile(join(root, 'index.html'), '<html><head><link rel="icon" type="image/svg+xml" href="/favicon.svg" /></head><body></body></html>')
  await writeFile(join(root, 'brand', 'qianshou-mark.png'), new Uint8Array([137, 80, 78, 71]))
  const url = new Request('dsh-app://app/')
  expect(await (await serveWebDocument(url, root)).text()).toContain('href="/favicon.svg"')
  const branded = await (await serveWebDocument(url, root, true)).text()
  expect(branded).toContain('type="image/png" href="/brand/qianshou-mark.png"')
  expect(branded).not.toContain('href="/favicon.svg"')
  const icon = await serveWebDocument(new Request('dsh-app://app/brand/qianshou-mark.png'), root)
  expect(icon.headers.get('content-type')).toBe('image/png')
  expect(new Uint8Array(await icon.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]))
})

it('requires the Host authentication exchange and retains only its cookie value', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 303, headers: { 'set-cookie': 'session=owned; HttpOnly; SameSite=Strict' } }))
    .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
  vi.stubGlobal('fetch', fetch)
  expect(await authenticateWebHost('http://127.0.0.1:1234/?token=owned')).toBe('session=owned')
  await expect(authenticateWebHost('http://127.0.0.1:1234/')).rejects.toThrow('authentication failed')
})

it('forwards upload bytes and cancellation with Host credentials while keeping the response streaming', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('stream')); controller.close() } })
  const fetch = vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-encoding': 'gzip', 'set-cookie': 'private' } }))
  vi.stubGlobal('fetch', fetch)
  const request = new Request('dsh-app://app/api/upload?name=file', {
    method: 'POST', body: 'upload bytes', headers: { origin: 'dsh-app://app', cookie: 'untrusted' },
  })
  const response = await forwardWebRequest(request, 'http://127.0.0.1:1234/?token=secret', 'session=owned')
  const [target, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit]
  expect(target.href).toBe('http://127.0.0.1:1234/api/upload?name=file')
  expect(new Headers(init.headers).get('cookie')).toBe('session=owned')
  expect(new Headers(init.headers).get('origin')).toBeNull()
  expect(init.signal).toBe(request.signal)
  expect(init.body).toBe(request.body)
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(response.headers.get('content-encoding')).toBeNull()
  expect(await response.text()).toBe('stream')
})

it('forwards a media byte range from the desktop page and preserves its partial response', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([3, 4, 5]), {
    status: 206,
    headers: {
      'accept-ranges': 'bytes',
      'content-range': 'bytes 3-5/12',
      'content-length': '3',
      'content-type': 'video/mp4',
    },
  }))
  vi.stubGlobal('fetch', fetch)
  const request = new Request('dsh-app://app/api/file?path=%2Ftmp%2Fclip.mp4', {
    headers: { range: 'bytes=3-5' },
  })
  const response = await forwardWebRequest(request, 'http://127.0.0.1:1234/', 'session=owned')
  const [target, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit]
  expect(target.href).toBe('http://127.0.0.1:1234/api/file?path=%2Ftmp%2Fclip.mp4')
  expect(new Headers(init.headers).get('range')).toBe('bytes=3-5')
  expect(new Headers(init.headers).get('cookie')).toBe('session=owned')
  expect(response.status).toBe(206)
  expect(response.headers.get('content-range')).toBe('bytes 3-5/12')
  expect(response.headers.get('accept-ranges')).toBe('bytes')
  expect(response.headers.get('content-length')).toBeNull()
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([3, 4, 5]))
})

it('refuses another page origin without forwarding its request', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const response = await forwardWebRequest(new Request('dsh-app://app/api/read', { headers: { origin: 'https://other.example' } }), 'http://127.0.0.1:1234/', 'session=owned')
  expect(response.status).toBe(403)
  expect(fetch).not.toHaveBeenCalled()
})
