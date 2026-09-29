import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createIsolatedOllamaSession, resolveIsolatedOllamaOrigin } from '../src/isolated-ollama.ts'

async function listen(handler: (url: URL, body: string) => { status: number; json: unknown }) {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1`)
      const reply = handler(url, Buffer.concat(chunks).toString('utf8'))
      response.writeHead(reply.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(reply.json))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  return { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  }) }
}

describe('isolated Ollama session', () => {
  it('resolves the default loopback origin and refuses non-loopback URLs', () => {
    expect(resolveIsolatedOllamaOrigin(undefined)).toBe('http://127.0.0.1:11434/')
    expect(resolveIsolatedOllamaOrigin('')).toBeNull()
    expect(resolveIsolatedOllamaOrigin('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434/')
    expect(() => resolveIsolatedOllamaOrigin('https://127.0.0.1:11434')).toThrow('COMPUTE_NODE_CONTRIBUTOR_ISOLATED_ROUTE_INVALID')
    expect(() => resolveIsolatedOllamaOrigin('http://example.test:11434')).toThrow('COMPUTE_NODE_CONTRIBUTOR_ISOLATED_ROUTE_INVALID')
  })

  it('chats on the explicit model and returns assistant UTF-8', async () => {
    const seen: string[] = []
    const server = await listen((url, body) => {
      seen.push(`${url.pathname}:${body}`)
      return { status: 200, json: { message: { role: 'assistant', content: 'local answer' } } }
    })
    try {
      const run = createIsolatedOllamaSession({ origin: server.origin, model: 'qwen2.5:7b', timeoutMs: 2_000 })
      await expect(run.run({
        taskType: 'local_llm_chat',
        inlineInput: 'summarize this',
        signal: new AbortController().signal,
      })).resolves.toEqual({ text: 'local answer' })
      expect(seen).toHaveLength(1)
      expect(seen[0]).toContain('/api/chat')
      expect(seen[0]).toContain('task_type=local_llm_chat')
      expect(seen[0]).toContain('qwen2.5:7b')
    } finally {
      await server.close()
    }
  })

  it('picks the first installed tag when no model is pinned', async () => {
    const server = await listen((url) => {
      if (url.pathname === '/api/tags') {
        return { status: 200, json: { models: [{ name: 'llama3.2:latest' }] } }
      }
      return { status: 200, json: { message: { content: 'from tag' } } }
    })
    try {
      const run = createIsolatedOllamaSession({ origin: server.origin, timeoutMs: 2_000 })
      await expect(run.run({
        taskType: 'local_llm_chat',
        inlineInput: '{"prompt":"hi"}',
        signal: new AbortController().signal,
      })).resolves.toEqual({ text: 'from tag' })
    } finally {
      await server.close()
    }
  })

  it('uses an inline ollama_model field and maps a down origin to unavailable', async () => {
    const server = await listen((_url, body) => {
      expect(body).toContain('"model":"phi3:mini"')
      return { status: 200, json: { message: { content: 'ok' } } }
    })
    try {
      const run = createIsolatedOllamaSession({ origin: server.origin, timeoutMs: 2_000 })
      await expect(run.run({
        taskType: 'local_llm_chat',
        inlineInput: '{"ollama_model":"phi3:mini","prompt":"hi"}',
        signal: new AbortController().signal,
      })).resolves.toEqual({ text: 'ok' })
    } finally {
      await server.close()
    }
    const down = createIsolatedOllamaSession({ origin: 'http://127.0.0.1:9', timeoutMs: 200 })
    await expect(down.run({
      taskType: 'local_llm_chat',
      inlineInput: 'goal',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'COMPUTE_ISOLATED_SESSION_UNAVAILABLE' })
  })
})
