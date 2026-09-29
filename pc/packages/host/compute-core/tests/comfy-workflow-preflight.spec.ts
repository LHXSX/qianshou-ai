import { describe, expect, it, vi } from 'vitest'
import { preflightLocalComfyWorkflow } from '../src/comfy-workflow-preflight.ts'

const json = (value: unknown): Response => new Response(JSON.stringify(value), {
  headers: { 'content-type': 'application/json' },
})

const workflow = {
  '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'private-unet.gguf' } },
  '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'private-clip.safetensors' } },
  '3': { class_type: 'VAELoader', inputs: { vae_name: 'private-vae.safetensors' } },
  '4': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'missing-unet.gguf' } },
  '5': { class_type: 'CLIPTextEncode', inputs: { text: 'private prompt text' } },
  '6': { class_type: 'MissingCustom', inputs: {} },
}

describe('owner graph local ComfyUI preflight', () => {
  it('checks each distinct class once and compares exact model options without returning values', async () => {
    const calls: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push(url)
      if (url.endsWith('/UnetLoaderGGUF')) return json({ UnetLoaderGGUF: { input: {
        required: { unet_name: [['private-unet.gguf'], {}] },
      } } })
      if (url.endsWith('/CLIPLoader')) return json({ CLIPLoader: { input: {
        required: { clip_name: [['other-clip.safetensors'], {}] },
      } } })
      if (url.endsWith('/VAELoader')) return json({ VAELoader: { input: {
        required: { vae_name: ['STRING', {}] },
      } } })
      if (url.endsWith('/CLIPTextEncode')) return json({ CLIPTextEncode: { input: { required: {} } } })
      if (url.endsWith('/MissingCustom')) return json({})
      throw new Error(`Unexpected request ${url}`)
    }) as typeof fetch

    const result = await preflightLocalComfyWorkflow({ workflow }, new AbortController().signal, fetcher)
    expect(result).toMatchObject({ nodeCount: 6, runnable: false, installable: false, dispatchable: false,
      nodes: [
        { nodeId: '1', classType: 'UnetLoaderGGUF', available: true,
          modelFields: [{ field: 'unet_name', selectable: true }] },
        { nodeId: '2', classType: 'CLIPLoader', available: true,
          modelFields: [{ field: 'clip_name', selectable: false }] },
        { nodeId: '3', classType: 'VAELoader', available: true,
          modelFields: [{ field: 'vae_name', selectable: 'unknown' }] },
        { nodeId: '4', classType: 'UnetLoaderGGUF', available: true,
          modelFields: [{ field: 'unet_name', selectable: false }] },
        { nodeId: '5', classType: 'CLIPTextEncode', available: true, modelFields: [] },
        { nodeId: '6', classType: 'MissingCustom', available: false, modelFields: [] },
      ] })
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(calls).toHaveLength(5)
    expect(calls.every(url => url.startsWith('http://127.0.0.1:8188/object_info/'))).toBe(true)
    expect(calls).not.toContain('http://127.0.0.1:8188/prompt')
    expect(JSON.stringify(result)).not.toMatch(/private|\.gguf|safetensors|prompt text/u)
  })

  it('refuses oversized class sets and unsafe ports before making requests', async () => {
    const fetcher = vi.fn(async () => json({})) as typeof fetch
    const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [String(index + 1),
      { class_type: `Node${index + 1}`, inputs: {} }]))
    await expect(preflightLocalComfyWorkflow({ workflow: tooMany }, new AbortController().signal, fetcher))
      .rejects.toThrow('COMPUTE_COMFY_PREFLIGHT_TOO_MANY_CLASSES')
    await expect(preflightLocalComfyWorkflow({ workflow, port: 80 }, new AbortController().signal, fetcher))
      .rejects.toThrow('COMPUTE_COMFY_PROBE_INVALID')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('marks unreadable class responses unknown and never follows a redirect', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302,
      headers: { location: 'https://example.com/private' },
    })) as typeof fetch
    const result = await preflightLocalComfyWorkflow({ workflow: {
      '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'private-unet.gguf' } },
    } }, new AbortController().signal, fetcher)
    expect(result.nodes).toEqual([{ nodeId: '1', classType: 'UnetLoaderGGUF', available: 'unknown',
      modelFields: [{ field: 'unet_name', selectable: 'unknown' }] }])
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:8188/object_info/UnetLoaderGGUF',
      expect.objectContaining({ method: 'GET', redirect: 'manual' }))
    expect(JSON.stringify(result)).not.toContain('private-unet.gguf')
  })

  it('bounds response bytes and propagates owner cancellation', async () => {
    const fetcher = vi.fn(async () => new Response('{}', {
      headers: { 'content-type': 'application/json', 'content-length': '200000' },
    })) as typeof fetch
    const one = { '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'private-unet.gguf' } } }
    const result = await preflightLocalComfyWorkflow({ workflow: one }, new AbortController().signal, fetcher)
    expect(result.nodes[0]).toMatchObject({ available: 'unknown',
      modelFields: [{ field: 'unet_name', selectable: 'unknown' }] })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(preflightLocalComfyWorkflow({ workflow: one }, cancelled.signal, fetcher))
      .rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
