// @vitest-environment jsdom
/** Original image payloads, intent boundaries, and account/Session changes during file reads. */
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionBinding } from '../src/window/mobile-workspace-types.ts'
import { prepareVisionImages, resolveVisionInput, validateVisionImages, visionInputError, VISION_INPUT_LIMITS } from '../src/vision-input.ts'
import { visionCopy } from '../src/vision-copy.ts'

const binding = { accountId: '42', sessionId: 's1' } as AgentSessionBinding
const pngBytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 64)
const file = () => new File([pngBytes], 'original.png', { type: 'image/png' })
const source = { id: 'upload1', file: file() }
const signal = () => new AbortController().signal
const context = () => ({ binding, attachments: [source], now: 10_000 })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it.each(['这是什么', '分析一下这张图片', '读图', '帮我识别文字', 'OCR', 'Describe this photo', '不要修改，只分析这张图片'])('routes understanding without modifying originals: %s', (text) => {
  expect(resolveVisionInput(text, context())).toEqual({ route: 'vision', sources: [source] })
})
it.each(['把背景换成蓝色', '修改图片的颜色', '修图', '换背景', '这张图片帮我改个背景', '帮我把猫换成狗', 'Replace the background with a beach'])('keeps actual editing on the edit path: %s', (text) => {
  expect(resolveVisionInput(text, context())).toEqual({ route: 'edit', sources: [source] })
})
it('asks one short question for an upload without an operation, without calling a model', () => {
  expect(resolveVisionInput('', context())).toEqual({ route: 'clarify', message: visionCopy.chooseOperation })
  expect(resolveVisionInput('你好', context()).route).toBe('clarify')
})
it('requires an original for explicit visual questions and passes ordinary text through', () => {
  expect(resolveVisionInput('这张图片是什么', { ...context(), attachments: [] })).toEqual({ route: 'clarify', message: visionCopy.chooseImage })
  expect(resolveVisionInput('你好', { ...context(), attachments: [] })).toEqual({ route: 'none' })
  expect(resolveVisionInput('给我出一张小猫图', { ...context(), attachments: [] })).toEqual({ route: 'none' })
})
it('reuses a recent original only for explicit visual follow-up in the same Session', () => {
  const recent = { binding, sources: [source], at: 1000, userTurnsSinceImage: 1 }
  const base = { binding, attachments: [], recent, now: 10_000 }
  expect(resolveVisionInput('这是什么', base)).toEqual({ route: 'vision', sources: [source] })
  expect(resolveVisionInput('分析一下', base).route).toBe('vision')
  expect(resolveVisionInput('把背景改成蓝色', base).route).toBe('edit')
  for (const text of ['你好', '分析当前经济', 'What is gravity?', '把会议改成明天上午', '什么是 OCR', '识图功能怎么实现'])
    expect(resolveVisionInput(text, base).route).toBe('none')
  for (const invalid of [
    { ...recent, binding: { ...binding, accountId: 'other' } },
    { ...recent, binding: { ...binding, sessionId: 'other' } as AgentSessionBinding },
    { ...recent, at: Number.NaN }, { ...recent, at: 10_001 }, { ...recent, at: -999_000 },
    { ...recent, userTurnsSinceImage: 3 }, { ...recent, userTurnsSinceImage: -1 },
  ]) expect(resolveVisionInput('这张图片是什么', { ...base, recent: invalid }).route).toBe('clarify')
})
it('encodes exact original bytes in order without canvas, dimensions or remote fetching', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  const images = await prepareVisionImages([file(), new File([Uint8Array.of(1, 2, 3)], 'second.webp', { type: 'image/webp' })], { binding, currentBinding: () => binding, signal: signal() })
  expect(images).toEqual([
    { mediaType: 'image/png', data: btoa(String.fromCharCode(...pngBytes)), name: 'original.png' },
    { mediaType: 'image/webp', data: 'AQID', name: 'second.webp' },
  ])
  expect(fetcher).not.toHaveBeenCalled()
})
it('checks count, individual size, aggregate size and MIME before starting a file read', async () => {
  const read = vi.spyOn(FileReader.prototype, 'readAsDataURL')
  const sized = (bytes: number) => { const f = file(); Object.defineProperty(f, 'size', { value: bytes }); return f }
  const ctx = { binding, currentBinding: () => binding, signal: signal() }
  await expect(prepareVisionImages(Array.from({ length: 5 }, file), ctx)).rejects.toThrow('MOBILE_AGENT_IMAGE_LIMIT')
  await expect(prepareVisionImages([], ctx)).rejects.toThrow('MOBILE_AGENT_IMAGE_LIMIT')
  await expect(prepareVisionImages([sized(VISION_INPUT_LIMITS.fileBytes + 1)], ctx)).rejects.toThrow('MOBILE_AGENT_IMAGE_FILE_LIMIT')
  await expect(prepareVisionImages([sized(VISION_INPUT_LIMITS.fileBytes), sized(VISION_INPUT_LIMITS.fileBytes), file()], ctx)).rejects.toThrow('MOBILE_AGENT_REQUEST_LIMIT')
  await expect(prepareVisionImages([new File(['svg'], 'image.svg', { type: 'image/svg+xml' })], ctx)).rejects.toThrow('MOBILE_AGENT_INVALID_IMAGE')
  expect(read).not.toHaveBeenCalled()
})
it('drops file bytes if the account or Session changes while reading', async () => {
  for (const next of [{ ...binding, accountId: '99' }, { ...binding, sessionId: 'new' } as AgentSessionBinding]) {
    let current: AgentSessionBinding | null = binding
    const reading = prepareVisionImages([file()], { binding, currentBinding: () => current, signal: signal() })
    current = next
    await expect(reading).rejects.toThrow('MOBILE_AGENT_IMAGE_CONTEXT_CHANGED')
  }
})
it('cancels an ongoing original read and rejects already-aborted requests', async () => {
  const abort = new AbortController()
  const abortRead = vi.spyOn(FileReader.prototype, 'abort')
  const reading = prepareVisionImages([file()], { binding, currentBinding: () => binding, signal: abort.signal })
  abort.abort()
  await expect(reading).rejects.toHaveProperty('name', 'AbortError')
  expect(abortRead).toHaveBeenCalledTimes(1)
  await expect(prepareVisionImages([file()], { binding, currentBinding: () => binding, signal: abort.signal })).rejects.toHaveProperty('name', 'AbortError')
})
it('rejects malformed or noncanonical wire bytes without decoding large images', () => {
  for (const data of ['', 'not-base64', 'AAAA=', 'AQI===', 'AB==', 'AAF=', 'data:image/png;base64,AQID'])
    expect(() => validateVisionImages([{ mediaType: 'image/png', data }])).toThrow('MOBILE_AGENT_INVALID_IMAGE')
  const data = btoa('x'.repeat(VISION_INPUT_LIMITS.fileBytes))
  expect(() => validateVisionImages([{ mediaType: 'image/png', data }, { mediaType: 'image/png', data }])).not.toThrow()
  expect(() => validateVisionImages([{ mediaType: 'image/png', data }, { mediaType: 'image/png', data }, { mediaType: 'image/png', data: 'AQID' }])).toThrow('MOBILE_AGENT_REQUEST_LIMIT')
})
it('shows local friendly limits without leaking raw diagnostics', () => {
  expect(visionInputError(new Error('MOBILE_AGENT_IMAGE_LIMIT'))).toBe(visionCopy.count)
  expect(visionInputError(new Error('MOBILE_AGENT_IMAGE_FILE_LIMIT'))).toBe(visionCopy.fileSize)
  expect(visionInputError(new Error('MOBILE_AGENT_REQUEST_LIMIT'))).toBe(visionCopy.totalSize)
  expect(visionInputError(new Error('MOBILE_AGENT_INVALID_IMAGE'))).toBe(visionCopy.invalid)
  expect(visionInputError(new Error('MOBILE_AGENT_IMAGE_UNAVAILABLE'))).toBe(visionCopy.unavailable)
  expect(visionInputError(new Error('provider-secret'))).toBe(visionCopy.retry)
})
