/** Authenticated local knowledge management; user documents never become system instructions. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from './store.ts'
import { MemoryError, object, text, MAX_DOCUMENT_BYTES } from './validation.ts'
import type { MemoryKind, MemoryQuery, MemoryStatus } from './types.ts'
import type {} from './service.ts'

export const name = 'qianshou-memory-local'
export const inject = ['connection']

/** Optional dedicated vault path, useful for isolated deployments and tests. */
export interface Config {
  /** Absolute SQLite vault path; empty uses the DSH_HOME qianshou default. */
  path?: string
}
export const Config: z<Config> = z.object({ path: z.string().default('') })

const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const json = (value: unknown, status = 200): Response => Response.json(value, { status, headers: HEADERS })

async function body(request: Request): Promise<Record<string, unknown>> {
  const content = await request.text()
  // Buffered Connection routes already own transport limits; escaped JSON may be larger than its text document.
  if (Buffer.byteLength(content) > MAX_DOCUMENT_BYTES * 6 + 64_000) throw new MemoryError('MEMORY_DOCUMENT_TOO_LARGE', 413)
  try { return object(JSON.parse(content)) } catch (error) {
    if (error instanceof MemoryError) throw error
    throw new MemoryError('INVALID_MEMORY_JSON')
  }
}

/** Register the private vault and owner-only routes on the existing authenticated carrier. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const home = process.env.DSH_HOME ?? join(homedir(), '.deepseek-harness')
  const store = await MemoryStore.open(config.path || join(home, 'qianshou', 'memory.sqlite'))
  ctx.provide('memoryStore', store)
  const routes: Array<{ path: string; method: 'GET' | 'POST'; run: (request: Request) => Response | Promise<Response> }> = [
    { path: '', method: 'GET', run: (request) => {
      const params = new URL(request.url).searchParams
      const query: MemoryQuery = {
        ...(params.get('query') ? { query: params.get('query')! } : {}),
        ...(params.get('kind') ? { kind: params.get('kind') as MemoryKind } : {}),
        ...(params.get('status') ? { status: params.get('status') as MemoryStatus } : {}),
        ...(params.get('workspace') ? { workspace: params.get('workspace')! } : {}),
        ...(params.has('offset') ? { offset: Number(params.get('offset')) } : {}),
        ...(params.has('limit') ? { limit: Number(params.get('limit')) } : {}),
      }
      return json(store.list(query))
    } },
    { path: '/entry', method: 'GET', run: request => json(store.read(text(new URL(request.url).searchParams.get('id'), 80))) },
    { path: '/save', method: 'POST', run: async request => json(store.save(await body(request))) },
    { path: '/review', method: 'POST', run: async (request) => {
      const value = await body(request)
      return json(store.review(text(value.id, 80), Number(value.expectedRevision), value.action as 'accept' | 'reject'))
    } },
    { path: '/delete', method: 'POST', run: async (request) => {
      const value = await body(request)
      return json(store.delete(text(value.id, 80), Number(value.expectedRevision)))
    } },
    { path: '/export', method: 'GET', run: () => new Response(JSON.stringify(store.export(), null, 2), {
      headers: { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="qianshou-memory.json"' },
    }) },
  ]
  for (const route of routes) ctx.effect(() => ctx.connection.fetch.register({
    path: `/api/qianshou/memory${route.path}`, methods: [route.method], requestBody: 'buffered',
    fetch: async (request) => {
      try { return await route.run(request) }
      catch (error) { return json({ error: error instanceof MemoryError ? error.code : 'MEMORY_REQUEST_FAILED' }, error instanceof MemoryError ? error.status : 500) }
    },
  }), `memory: ${route.method} ${route.path}`)
  const timer = setInterval(() => {
    try { store.expire() } catch { /* Reads still surface a vault failure; timer cannot crash the Host. */ }
  }, 60_000)
  timer.unref()
  ctx.effect(() => () => { clearInterval(timer); store.close() }, 'memory: close vault')
}
