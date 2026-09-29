/** Bounded official release checks; installation and conversation reload are never performed here. */
import { appUpdatesCopy as t } from './app-updates-copy.ts'

/** Web revision published with this mobile entry. */
export const MOBILE_WEB_VERSION = '2026.09.20-r3'
const preference = 'qianshou.mobile.check-updates'
const metadataUrl = 'https://app.qianshousuanli.com/mobile/native-release.json'
const downloadPage = 'https://qianshousuanli.com/#/downloads'
const maximumBytes = 65_536
const timeoutMs = 7000

interface AppInfo {
  platform: 'android' | 'harmony'
  versionCode: number
  versionName: string
}
interface NativeAppBridge { getInfo(): Promise<unknown> }
interface NativeHost {
  Capacitor?: { Plugins?: { QianshouApp?: NativeAppBridge } }
  QianshouApp?: NativeAppBridge
}
interface AndroidRelease {
  status: 'testing' | 'available'
  versionCode: number
}
interface Release {
  webVersion: string
  android?: AndroidRelease
}

function invalid(): never { throw new Error('UPDATE_INVALID') }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function label(value: unknown, limit = 64): string {
  if (typeof value !== 'string' || value.length > limit || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(value)) invalid()
  return value
}
function positiveInteger(value: unknown, maximum = 2_147_483_647): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) invalid()
  return value
}
function parseAppInfo(value: unknown): AppInfo {
  const info = record(value)
  if (info.platform !== 'android' && info.platform !== 'harmony') invalid()
  if (info.distribution !== undefined && info.distribution !== 'debug-testing' && info.distribution !== 'release') invalid()
  return { platform: info.platform, versionCode: positiveInteger(info.versionCode), versionName: label(info.versionName) }
}
function validateDownload(value: unknown): void {
  if (typeof value !== 'string' || value.length > 2048) invalid()
  const url = new URL(value)
  const official = url.origin === 'https://qianshousuanli.com' && /^\/downloads\/[A-Za-z0-9][A-Za-z0-9._-]*\.apk$/u.test(url.pathname)
  const mobile = url.origin === 'https://app.qianshousuanli.com' && /^\/mobile\/downloads\/[A-Za-z0-9][A-Za-z0-9._-]*\.apk$/u.test(url.pathname)
  if (!(official || mobile) || url.href !== value || url.username || url.password || url.search || url.hash) invalid()
}
function parseRelease(value: unknown): Release {
  const root = record(value)
  if (root.schemaVersion !== 1) invalid()
  const web = record(root.web)
  const webVersion = label(web.version)
  label(web.buildId, 96)
  const harmony = record(root.harmony)
  if (harmony.status !== 'pending-signing' && harmony.status !== 'unavailable') invalid()
  if (harmony.versionName !== undefined) label(harmony.versionName)
  if (harmony.downloadUrl !== undefined) invalid()
  const android = record(root.android)
  if (android.status === 'unavailable' || android.status === 'pending-signing') {
    if (android.downloadUrl !== undefined) invalid()
    return { webVersion }
  }
  if (android.status !== 'testing' && android.status !== 'available') invalid()
  const versionCode = positiveInteger(android.versionCode)
  label(android.versionName)
  validateDownload(android.downloadUrl)
  if (typeof android.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(android.sha256)) invalid()
  if (android.bytes !== undefined) positiveInteger(android.bytes)
  if (android.minSdk !== undefined) positiveInteger(android.minSdk, 1000)
  if (android.packageName !== undefined && android.packageName !== 'com.qianshou.agent.mobile') invalid()
  if (android.signature !== undefined) label(android.signature)
  return { webVersion, android: { status: android.status, versionCode } }
}

/** Race even non-cancellable native bridges against this page's finite request lifetime. */
function withinLifetime<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort)
      reject(new Error('UPDATE_ABORTED'))
    }
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
    if (signal.aborted) abort()
  })
}

async function readRelease(response: Response, signal: AbortSignal): Promise<Release> {
  if (!response.ok || response.redirected || response.url !== metadataUrl) invalid()
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') invalid()
  const declaredSize = response.headers.get('content-length')
  if (declaredSize !== null && (!/^\d+$/u.test(declaredSize) || Number(declaredSize) > maximumBytes)) invalid()
  if (!response.body) invalid()
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  let complete = false
  try {
    while (true) {
      const part = await withinLifetime(reader.read(), signal)
      if (signal.aborted) throw new Error('UPDATE_ABORTED')
      if (part.done) { complete = true; break }
      bytes += part.value.byteLength
      if (bytes > maximumBytes) invalid()
      text += decoder.decode(part.value, { stream: true })
    }
    text += decoder.decode()
    const value: unknown = JSON.parse(text)
    return parseRelease(value)
  } finally {
    if (!complete) {
      // A failed read/overflow is already reported by the owning check; cancellation can also fail on a closed stream.
      void reader.cancel().catch(() => {})
    }
    reader.releaseLock()
  }
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  element.textContent = text
  return element
}

/**
 * Mount update notices and an opt-out preference inside Settings.
 * @param signal Settings lifetime; abort silences late bridge/network responses and stops reading metadata.
 * @returns The panel. It only reads official metadata and links to the official download page.
 */
export function createUpdateSettings(signal: AbortSignal): HTMLElement {
  const section = node('section')
  section.className = 'account-preferences app-updates'
  const heading = node('h3', t.title)
  heading.className = 'account-section-title'
  const version = node('p', t.webVersion(MOBILE_WEB_VERSION))
  const status = node('p', t.description)
  status.setAttribute('role', 'status')
  const check = node('button', t.check)
  check.type = 'button'
  check.className = 'account-menu-row'
  const autoLabel = node('label')
  autoLabel.className = 'account-preference'
  const auto = node('input')
  auto.type = 'checkbox'
  auto.setAttribute('role', 'switch')
  auto.ariaLabel = t.automatic
  try { auto.checked = localStorage.getItem(preference) !== 'false' }
  catch { auto.checked = true /* Storage-denied browsers keep this preference in the mounted page. */ }
  auto.addEventListener('change', () => {
    if (signal.aborted) return
    try { localStorage.setItem(preference, String(auto.checked)) }
    catch { /* Storage-denied browsers keep the checked value in this page. */ }
  }, { signal })
  autoLabel.append(node('span', t.automatic), auto)
  const action = node('div')
  action.className = 'app-update-action'
  let attempt = 0
  const run = async (): Promise<void> => {
    if (signal.aborted || check.disabled) return
    const id = ++attempt
    const request = new AbortController()
    const cancel = (): void => { request.abort() }
    signal.addEventListener('abort', cancel, { once: true })
    const timeout = setTimeout(cancel, timeoutMs)
    const current = (): boolean => !signal.aborted && attempt === id
    check.disabled = true
    action.replaceChildren()
    status.textContent = t.checking
    try {
      const host = window as unknown as NativeHost
      const native = host.Capacitor?.Plugins?.QianshouApp ?? host.QianshouApp
      let info: AppInfo | undefined
      if (native) {
        if (typeof native.getInfo !== 'function') invalid()
        info = parseAppInfo(await withinLifetime(native.getInfo(), request.signal))
      }
      if (!current() || request.signal.aborted) return
      if (info) version.textContent = t.nativeVersion(t.platform[info.platform], info.versionName, MOBILE_WEB_VERSION)
      const response = await withinLifetime(fetch(metadataUrl, {
        cache: 'no-store', credentials: 'omit', redirect: 'error', signal: request.signal,
      }), request.signal)
      const release = await readRelease(response, request.signal)
      if (!current() || request.signal.aborted) return
      if (info?.platform === 'android' && release.android && release.android.versionCode > info.versionCode) {
        const link = node('a', t.openDownloads)
        link.href = downloadPage
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        action.append(link)
        status.textContent = release.android.status === 'testing' ? t.testingAvailable : t.nativeAvailable
      } else if (release.webVersion !== MOBILE_WEB_VERSION) status.textContent = t.webAvailable
      else if (info?.platform === 'harmony' || (info?.platform === 'android' && !release.android)) status.textContent = t.nativePending
      else status.textContent = t.current
    } catch {
      if (current()) status.textContent = t.unavailable
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', cancel)
      request.abort()
      if (current()) check.disabled = false
    }
  }
  check.addEventListener('click', () => { void run() }, { signal })
  section.append(heading, version, autoLabel, check, status, action)
  if (auto.checked) queueMicrotask(() => { if (auto.checked) void run() })
  return section
}
