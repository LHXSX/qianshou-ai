// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUpdateSettings, MOBILE_WEB_VERSION } from '../src/app-updates.ts'
import { appUpdatesCopy as t } from '../src/app-updates-copy.ts'

const metadataUrl = 'https://app.qianshousuanli.com/mobile/native-release.json'
const preference = 'qianshou.mobile.check-updates'
const lifetimes: AbortController[] = []
const manifest = () => ({
  schemaVersion: 1,
  web: { version: MOBILE_WEB_VERSION, buildId: '20260920-mobile-r3' },
  android: {
    status: 'testing', versionCode: 20260920, versionName: '0.2.0-test.1',
    downloadUrl: 'https://app.qianshousuanli.com/mobile/downloads/qianshou-android-0.2.0-test.1.apk',
    sha256: '9b66b1e4b5997d76ac9e39f3ec16736e921dd5c6c892eb71d3323ba92895bc46',
    bytes: 4135535, signature: 'android-debug-v2', minSdk: 24, packageName: 'com.qianshou.agent.mobile',
  },
  harmony: { status: 'pending-signing', versionName: '0.2.0-test.1' },
})
function response(value: unknown = manifest(), init?: ResponseInit): Response {
  const result = new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' }, ...init })
  Object.defineProperty(result, 'url', { value: metadataUrl, configurable: true })
  return result
}
function mount() {
  const lifetime = new AbortController()
  lifetimes.push(lifetime)
  const panel = createUpdateSettings(lifetime.signal)
  document.body.append(panel)
  return { panel, lifetime, status: panel.querySelector('[role="status"]')!, check: panel.querySelector('button')! }
}
function native(info: unknown = { platform: 'android', versionCode: 20260920, versionName: '0.2.0-test.1' }) {
  const getInfo = vi.fn().mockResolvedValue(info)
  vi.stubGlobal('Capacitor', { Plugins: { QianshouApp: { getInfo } } })
  return getInfo
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('Capacitor', undefined)
  vi.stubGlobal('QianshouApp', undefined)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()))
})
afterEach(() => {
  for (const lifetime of lifetimes.splice(0)) lifetime.abort()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('official mobile update notices', () => {
  it('uses the fixed metadata URL without credentials and renders the current web revision', async () => {
    const { panel, status, check } = mount()
    await vi.waitFor(() => { expect(status.textContent).toBe(t.current) })
    expect(fetch).toHaveBeenCalledWith(metadataUrl, expect.objectContaining({
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: expect.any(AbortSignal),
    }))
    expect(check.disabled).toBe(false)
    expect(panel.textContent).toContain(t.webVersion('2026.09.20-r3'))
    expect(panel.querySelector('a')).toBeNull()
    expect(panel.textContent).toMatchInlineSnapshot('"版本与更新网页版本 2026.09.20-r3自动检查更新检查更新当前已是最新可用版本。"')
  })
  it('announces a different web version without reload controls or automatic navigation', async () => {
    const feed = manifest()
    feed.web.version = '2026.09.20-r4'
    vi.mocked(fetch).mockResolvedValue(response(feed))
    const { panel, status } = mount()
    await vi.waitFor(() => { expect(status.textContent).toBe(t.webAvailable) })
    expect(panel.querySelectorAll('button')).toHaveLength(1)
    expect(panel.querySelector('a')).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each([20260920, 20260921])('does not offer an APK when installed versionCode is %i', async (versionCode) => {
    native({ platform: 'android', versionCode, versionName: '0.2.0-test.1', distribution: 'debug-testing' })
    const { panel, status } = mount()
    await vi.waitFor(() => { expect(status.textContent).toBe(t.current) })
    expect(panel.textContent).toContain(t.nativeVersion('Android', '0.2.0-test.1', MOBILE_WEB_VERSION))
    expect(panel.querySelector('a')).toBeNull()
  })
  it.each(['testing', 'available'])('offers a newer %s APK only through the official download page', async (releaseStatus) => {
    native({ platform: 'android', versionCode: 20260919, versionName: '0.1.0' })
    const feed = manifest()
    feed.android.status = releaseStatus
    vi.mocked(fetch).mockResolvedValue(response(feed))
    const { panel, status } = mount()
    await vi.waitFor(() => { expect(status.textContent).toBe(releaseStatus === 'testing' ? t.testingAvailable : t.nativeAvailable) })
    expect(panel.querySelector('a')?.href).toBe('https://qianshousuanli.com/#/downloads')
    expect(panel.querySelector('a')?.rel).toBe('noopener noreferrer')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('reads the Harmony bridge and keeps unsigned HAP unavailable', async () => {
    vi.stubGlobal('QianshouApp', { getInfo: vi.fn().mockResolvedValue({
      platform: 'harmony', versionCode: 20260920, versionName: '0.2.0-test.1', distribution: 'debug-testing',
    }) })
    const { panel, status } = mount()
    await vi.waitFor(() => { expect(status.textContent).toBe(t.nativePending) })
    expect(panel.textContent).toContain(t.nativeVersion('鸿蒙', '0.2.0-test.1', MOBILE_WEB_VERSION))
    expect(panel.querySelector('a')).toBeNull()
  })
  it('does not advertise an unavailable Android release', async () => {
    native()
    vi.mocked(fetch).mockResolvedValue(response({ ...manifest(), android: { status: 'unavailable' } }))
    const { panel, status } = mount()
    await vi.waitFor(() => { expect(status.textContent).toBe(t.nativePending) })
    expect(panel.querySelector('a')).toBeNull()
  })
  it.each([
    null,
    { ...manifest(), schemaVersion: 2 },
    { ...manifest(), web: { version: 'x'.repeat(65), buildId: 'current' } },
    { ...manifest(), android: { ...manifest().android, versionCode: 20260920.5 } },
    { ...manifest(), android: { ...manifest().android, sha256: 'not-a-checksum' } },
    { ...manifest(), android: { ...manifest().android, downloadUrl: 'https://example.com/app.apk' } },
    { ...manifest(), android: { ...manifest().android, downloadUrl: 'https://app.qianshousuanli.com/mobile/downloads/a.apk?next=external' } },
    { ...manifest(), android: { ...manifest().android, downloadUrl: 'https://app.qianshousuanli.com/mobile/downloads/%2e%2e/a.apk' } },
    { ...manifest(), android: { ...manifest().android, packageName: 'another.package' } },
    { ...manifest(), harmony: { status: 'available', downloadUrl: 'https://example.com/fake.hap' } },
  ])('refuses malformed or unsafe release metadata %#', async (value) => {
    vi.mocked(fetch).mockResolvedValue(response(value))
    const { panel, status } = mount()
    await vi.waitFor(() => { expect(status.textContent).toBe(t.unavailable) })
    expect(panel.querySelector('a')).toBeNull()
  })
  it.each([
    { platform: 'ios', versionCode: 1, versionName: '1.0' },
    { platform: 'android', versionCode: '20260920', versionName: '1.0' },
    { platform: 'android', versionCode: 1, versionName: '<private-native-diagnostic>' },
  ])('rejects invalid native bridge values before using them in the UI %#', async (value) => {
    native(value)
    const { panel, status } = mount()
    await vi.waitFor(() => { expect(status.textContent).toBe(t.unavailable) })
    expect(fetch).not.toHaveBeenCalled()
    expect(panel.textContent).not.toContain('private-native')
  })
  it.each(['status', 'content-type', 'redirect', 'wrong-url'])('refuses a metadata response with invalid %s', async (failure) => {
    const reply = response(undefined, failure === 'status' ? { status: 503 } : undefined)
    if (failure === 'content-type') reply.headers.set('content-type', 'text/html')
    if (failure === 'redirect') Object.defineProperty(reply, 'redirected', { value: true })
    if (failure === 'wrong-url') Object.defineProperty(reply, 'url', { value: 'https://example.com/native-release.json' })
    vi.mocked(fetch).mockResolvedValue(reply)
    const { status } = mount()
    await vi.waitFor(() => { expect(status.textContent).toBe(t.unavailable) })
  })
  it('stops reading an oversized chunked body before JSON allocation can grow unbounded', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(40_000)); controller.enqueue(new Uint8Array(40_000)) },
      cancel,
    })
    const reply = new Response(stream, { headers: { 'content-type': 'application/json' } })
    Object.defineProperty(reply, 'url', { value: metadataUrl })
    vi.mocked(fetch).mockResolvedValue(reply)
    const { status } = mount()
    await vi.waitFor(() => { expect(status.textContent).toBe(t.unavailable) })
    expect(cancel).toHaveBeenCalledTimes(1)
  })
  it('honors the stored automatic-check preference and still permits a manual check', async () => {
    localStorage.setItem(preference, 'false')
    const { panel, check, status } = mount()
    await Promise.resolve()
    expect(fetch).not.toHaveBeenCalled()
    expect(panel.querySelector<HTMLInputElement>('input')?.checked).toBe(false)
    check.click()
    await vi.waitFor(() => { expect(status.textContent).toBe(t.current) })
    const input = panel.querySelector('input')!
    input.checked = true
    input.dispatchEvent(new Event('change'))
    expect(localStorage.getItem(preference)).toBe('true')
  })
  it('does not start an automatically queued check after disposal', async () => {
    const { lifetime, status } = mount()
    lifetime.abort()
    await Promise.resolve()
    expect(fetch).not.toHaveBeenCalled()
    expect(status.textContent).toBe(t.description)
  })
  it.each(['native', 'network'])('ignores late %s results after the settings page has closed', async (phase) => {
    const pending = deferred<unknown>()
    if (phase === 'native') native().mockReturnValue(pending.promise)
    else vi.mocked(fetch).mockImplementation(() => pending.promise as Promise<Response>)
    const { panel, lifetime } = mount()
    await Promise.resolve()
    lifetime.abort()
    const before = panel.outerHTML
    pending.resolve(phase === 'native' ? { platform: 'android', versionCode: 1, versionName: '1' } : response())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(panel.outerHTML).toBe(before)
    if (phase === 'native') expect(fetch).not.toHaveBeenCalled()
    else expect(vi.mocked(fetch).mock.calls[0]![1]?.signal?.aborted).toBe(true)
  })
  it('times out a hung native bridge and prevents its late reply from replacing a newer successful check', async () => {
    vi.useFakeTimers()
    const pending = deferred<unknown>()
    const getInfo = native()
    getInfo.mockReturnValueOnce(pending.promise)
    const { panel, status, check } = mount()
    await vi.advanceTimersByTimeAsync(7000)
    expect(status.textContent).toBe(t.unavailable)
    expect(check.disabled).toBe(false)
    check.click()
    await vi.advanceTimersByTimeAsync(0)
    expect(status.textContent).toBe(t.current)
    const before = panel.outerHTML
    pending.resolve({ platform: 'android', versionCode: 1, versionName: 'stale' })
    await vi.advanceTimersByTimeAsync(0)
    expect(panel.outerHTML).toBe(before)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('cancels a stalled metadata body at the total check deadline', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const reply = new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'content-type': 'application/json' } })
    Object.defineProperty(reply, 'url', { value: metadataUrl })
    vi.mocked(fetch).mockResolvedValue(reply)
    const { status, check } = mount()
    await vi.advanceTimersByTimeAsync(7000)
    expect(status.textContent).toBe(t.unavailable)
    expect(check.disabled).toBe(false)
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
