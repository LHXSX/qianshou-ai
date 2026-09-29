import { describe, expect, it, vi } from 'vitest'
import { parseComfyProbeRequest, probeLocalComfy } from '../src/comfy-local-probe.ts'

const json = (value: unknown): Response => new Response(JSON.stringify(value), {
  headers: { 'content-type': 'application/json' },
})

describe('owner-local ComfyUI observation', () => {
  it('reads only loopback endpoints and returns aggregate facts without raw paths or model names', async () => {
    const calls: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push(url)
      if (url.endsWith('/system_stats')) return json({ system: { comfyui_version: '0.37.0',
        argv: ['C:\\secret\\ComfyUI', '--token', 'private-key'] },
      devices: [{ type: 'cuda', name: 'private device name', vram_total: 8_000_000_000 }] })
      if (url.endsWith('/models')) return json(['diffusion_models', 'checkpoints', 'vae'])
      if (url.endsWith('/models/diffusion_models')) return json(['secret-h3.safetensors'])
      if (url.endsWith('/models/checkpoints')) return json([])
      if (url.endsWith('/models/vae')) return json(['private-vae.safetensors'])
      if (url.endsWith('/object_info/KSampler')) return json({ KSampler: { input: { secret: 'private' } } })
      if (url.endsWith('/object_info/SaveImage')) return json({})
      throw new Error(`Unexpected request ${url}`)
    }) as typeof fetch
    const result = await probeLocalComfy({ classTypes: ['KSampler', 'SaveImage'] },
      new AbortController().signal, fetcher)
    expect(result).toMatchObject({ endpoint: 'http://127.0.0.1:8188', version: '0.37.0',
      devices: [{ type: 'cuda', vramTotalBytes: 8_000_000_000 }],
      modelCounts: { diffusion_models: 1, checkpoints: 0, vae: 1 },
      classChecks: [{ classType: 'KSampler', available: true }, { classType: 'SaveImage', available: false }],
      verification: 'service-observed', runnable: false, installable: false, dispatchable: false })
    expect(calls.every(url => url.startsWith('http://127.0.0.1:8188/'))).toBe(true)
    expect(calls).not.toContain('http://127.0.0.1:8188/prompt')
    const shown = JSON.stringify(result)
    expect(shown).not.toMatch(/secret|private|safetensors|argv|token/u)
  })

  it('rejects arbitrary hosts, unsafe ports, duplicate classes and oversized responses', async () => {
    for (const request of [{ url: 'http://example.com' }, { port: 80 }, { port: 8188.5 },
      { classTypes: ['KSampler', 'KSampler'] }, { classTypes: ['../prompt'] }]) {
      expect(() => parseComfyProbeRequest(request)).toThrow()
    }
    const oversize = vi.fn(async () => new Response('{}', {
      headers: { 'content-type': 'application/json', 'content-length': '200000' },
    })) as typeof fetch
    await expect(probeLocalComfy({}, new AbortController().signal, oversize)).rejects.toThrow()
    expect(oversize).toHaveBeenCalledTimes(1)
  })

  it('refuses redirects and non-JSON responses without following them', async () => {
    const redirect = vi.fn(async () => new Response(null, { status: 302,
      headers: { location: 'https://example.com/secret' } })) as typeof fetch
    await expect(probeLocalComfy({}, new AbortController().signal, redirect)).rejects.toThrow()
    expect(redirect).toHaveBeenCalledTimes(1)
    expect(redirect).toHaveBeenCalledWith('http://127.0.0.1:8188/system_stats',
      expect.objectContaining({ redirect: 'manual' }))
  })
})
