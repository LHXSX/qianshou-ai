/**
 * Python package catalogue: advertised names match platform required_software,
 * not import-module spelling, and missing imports stay off hello.
 */
import { describe, expect, it } from 'vitest'
import { HOST_SUPPLY_PACKAGES } from '../../src/supply/package-catalog.ts'
import { HOST_SUPPLY_TOOLS } from '../../src/supply/tool-catalog.ts'
import { probeLocalSupply } from '../../src/supply/local-probe.ts'
import { projectNodeCapabilities } from '../../src/node-capability.ts'
import { SupplyError } from '../../src/supply/policy.ts'

/** 2026-09-19 Shanghai TASK_REGISTRY nonempty required_software (evidence/HX-94-原始/01-registry.log). */
const NONEMPTY_REQUIRED_SOFTWARE: readonly (readonly [string, readonly string[]])[] = [
  ['blender_render', ['blender']],
  ['video_analyze', ['faster_whisper', 'ffmpeg', 'local_llm']],
  ['audio_extract', ['ffmpeg']],
  ['audio_transcode', ['ffmpeg']],
  ['video_compress', ['ffmpeg']],
  ['video_info', ['ffmpeg']],
  ['video_repurpose', ['ffmpeg']],
  ['video_thumbnail', ['ffmpeg']],
  ['whisper_transcribe', ['ffmpeg', 'whisper']],
  ['local_llm_chat', ['local_llm']],
  ['image_caption', ['moondream2', 'pillow']],
  ['fft_compute', ['numpy']],
  ['onnx_infer', ['onnxruntime']],
  ['excel_export', ['openpyxl']],
  ['image_compress', ['pillow']],
  ['image_convert', ['pillow']],
  ['image_info', ['pillow']],
  ['image_resize', ['pillow']],
  ['image_thumbnail', ['pillow']],
  ['pdf_info', ['pymupdf']],
  ['pdf_ocr', ['pymupdf']],
  ['pdf_to_text', ['pymupdf']],
  ['crawl_batch_fetch', ['requests', 'selectolax']],
  ['crawl_url_fetch', ['requests', 'selectolax']],
  ['crawl_url_extract', ['requests', 'selectolax', 'readability']],
  ['audio_transcribe_refine', ['whisper', 'ffmpeg']],
]

function reachableTypes(have: ReadonlySet<string>): readonly string[] {
  return NONEMPTY_REQUIRED_SOFTWARE
    .filter(([, needed]) => needed.every(name => have.has(name)))
    .map(([taskType]) => taskType)
}

describe('HOST_SUPPLY_PACKAGES', () => {
  it('covers every Python member of the platform 14 and none of the binaries or pandas/PIL', () => {
    expect(HOST_SUPPLY_PACKAGES.map(pkg => pkg.id)).toEqual([
      'faster_whisper', 'numpy', 'onnxruntime', 'openpyxl', 'pillow',
      'pymupdf', 'readability', 'requests', 'selectolax', 'whisper',
    ])
    expect(HOST_SUPPLY_PACKAGES.map(pkg => pkg.id)).not.toContain('pandas')
    expect(HOST_SUPPLY_PACKAGES.map(pkg => pkg.id)).not.toContain('PIL')
    expect(HOST_SUPPLY_PACKAGES.find(pkg => pkg.id === 'pillow')?.module).toBe('PIL')
    expect(HOST_SUPPLY_PACKAGES.find(pkg => pkg.id === 'pymupdf')?.module).toBe('fitz')
  })

  it('marks packages unavailable when python3 is not verified', async () => {
    const result = await probeLocalSupply({
      timeoutMs: 1000, maxResponseBytes: 65536,
      tools: HOST_SUPPLY_TOOLS,
      packages: HOST_SUPPLY_PACKAGES,
      readHostActivity: () => ({ foregroundTaskActive: null, voiceActive: null }),
    }, undefined, async () => { throw new SupplyError('LOCAL_PROBE_UNAVAILABLE') })
    const numpy = result.localServices.find(service => service.id === 'numpy')
    expect(numpy).toMatchObject({ kind: 'package', verification: 'unavailable', reason: 'LOCAL_PYTHON_UNAVAILABLE' })
  })

  it('advertises a package only when the catalogue python3 can import it, as pillow not PIL', async () => {
    const result = await probeLocalSupply({
      timeoutMs: 1000, maxResponseBytes: 65536,
      tools: [{ id: 'python3', name: 'Python 3', command: '/fixture/python3', args: ['--version'] }],
      packages: HOST_SUPPLY_PACKAGES,
      readHostActivity: () => ({ foregroundTaskActive: null, voiceActive: null }),
    }, undefined, async (_command, args) => {
      if (args[0] === '--version') return 'Python 3.14.3'
      const code = String(args[1] ?? '')
      if (code.includes('"numpy"')) return '2.4.3'
      if (code.includes('"requests"')) return '2.32.3'
      throw new SupplyError('LOCAL_PROBE_UNAVAILABLE')
    })
    const profile = projectNodeCapabilities(result)
    expect(profile.software).toEqual(['python3', 'numpy', 'requests'])
    expect(profile.runtimes).toEqual(['python3'])
    expect(profile.native_binaries).toEqual(['python3'])
    expect(profile.software).not.toContain('PIL')
    expect(profile.software).not.toContain('pandas')
    expect(profile.software).not.toContain('pillow')
    const numpy = result.localServices.find(service => service.id === 'numpy')
    expect(numpy).toMatchObject({ kind: 'package', verification: 'verified', version: '2.4.3' })
    const pillow = result.localServices.find(service => service.id === 'pillow')
    expect(pillow).toMatchObject({ kind: 'package', verification: 'unavailable', reason: 'LOCAL_PACKAGE_CHECK_FAILED' })
  })

  it('raises nonempty-required types from the ffmpeg six to seven when numpy is verified', () => {
    const ffmpegOnly = new Set(['ffmpeg', 'ffprobe', 'node', 'git', 'python3'])
    expect([...reachableTypes(ffmpegOnly)].sort()).toEqual([
      'audio_extract', 'audio_transcode', 'video_compress', 'video_info', 'video_repurpose', 'video_thumbnail',
    ])
    const withNumpy = new Set([...ffmpegOnly, 'numpy'])
    const risen = reachableTypes(withNumpy)
    expect(risen).toHaveLength(7)
    expect(risen).toContain('fft_compute')
  })

  it('aborts the whole probe when a package import is cancelled', async () => {
    const controller = new AbortController()
    await expect(probeLocalSupply({
      timeoutMs: 1000, maxResponseBytes: 65536,
      tools: [{ id: 'python3', name: 'Python 3', command: '/fixture/python3', args: ['--version'] }],
      packages: [HOST_SUPPLY_PACKAGES[1]!],
      readHostActivity: () => ({ foregroundTaskActive: null, voiceActive: null }),
    }, controller.signal, async (_command, args) => {
      if (args[0] === '--version') return 'Python 3.14.3'
      controller.abort()
      throw new SupplyError('SUPPLY_ABORTED')
    })).rejects.toMatchObject({ code: 'SUPPLY_ABORTED' })
  })
})
