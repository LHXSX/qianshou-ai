/** Isolated text-only browser page; no owner UI, global Remote, files or tool endpoints. */
import { viewerCopy } from './locales.ts'
import { page, presentableDevice, receipt, request, ViewerFailure } from './protocol.ts'

const copy = viewerCopy(navigator.language)
document.documentElement.lang = navigator.language.startsWith('zh') ? 'zh' : 'en'
document.title = copy.title
const root = document.getElementById('app')
if (!root) throw new Error('Session connection page root is missing')
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node
}
const header = element('header'), title = element('h1', copy.title), forget = element('button', copy.forget)
header.append(title, forget)
const explanation = element('p', copy.explanation, 'hint'), storage = element('p', copy.storage, 'hint')
const deviceField = element('label'), deviceInput = element('input')
deviceField.textContent = copy.device; deviceInput.type = 'text'; deviceInput.maxLength = 256
deviceInput.setAttribute('aria-label', copy.device); deviceInput.autocomplete = 'off'
deviceField.append(deviceInput)
const deviceHint = element('p', copy.deviceHint, 'hint')
const metadata = element('p', copy.local, 'badge'), status = element('div', copy.loading, 'status')
status.setAttribute('role', 'status')
const omitted = element('p', copy.omitted, 'hint'), turns = element('section')
omitted.hidden = true; turns.setAttribute('aria-label', copy.session)
const form = element('form'), input = element('textarea'), limits = element('p', copy.bounded, 'hint')
input.placeholder = copy.placeholder; input.setAttribute('aria-label', copy.placeholder); input.maxLength = 4096
const send = element('button', copy.send, 'primary'), outcome = element('p', '', 'receipt'), check = element('button', copy.check), retry = element('button', copy.retry)
send.type = 'submit'; check.type = 'button'; retry.type = 'button'
const actions = element('div', '', 'actions'); actions.append(send, check, retry)
form.append(input, limits, actions, outcome); form.hidden = true; check.hidden = true; retry.hidden = true
root.append(header, explanation, metadata, storage, deviceField, deviceHint, status, omitted, turns, form)

const key = 'qianshou-session-connect-tab-v1'
const deviceKey = 'qianshou-session-connect-device-v1'
interface TabState { token: string; pending?: { requestId: string; text: string } }
let state: TabState = { token: '' }
try {
  const saved: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null')
  if (saved && typeof saved === 'object' && 'token' in saved && typeof saved.token === 'string' && saved.token.length < 100) {
    state.token = saved.token
    if ('pending' in saved && saved.pending && typeof saved.pending === 'object' && 'requestId' in saved.pending && 'text' in saved.pending
      && typeof saved.pending.requestId === 'string' && /^[a-zA-Z0-9_-]{8,96}$/u.test(saved.pending.requestId)
      && typeof saved.pending.text === 'string' && saved.pending.text.length <= 4096) state.pending = { requestId: saved.pending.requestId, text: saved.pending.text }
  }
} catch (_error) { /* Restricted tab storage leaves this page usable until reload. */ }
try {
  const savedDevice = sessionStorage.getItem(deviceKey)
  const device = presentableDevice(savedDevice)
  if (device !== undefined) deviceInput.value = device
} catch (_error) { /* Restricted tab storage leaves the device field empty until typed. */ }
const fragment = location.hash.slice(1)
if (fragment) {
  if (/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u.test(fragment)) { if (state.token !== fragment) state = { token: fragment } }
  else state = { token: '' }
  history.replaceState(null, '', location.pathname)
}
function save(): void {
  try {
    if (state.token) sessionStorage.setItem(key, JSON.stringify(state))
    else sessionStorage.removeItem(key)
  } catch (_error) { /* Tab storage is optional; no broader persistence fallback. */ }
}
function saveDevice(): void {
  try {
    const device = presentableDevice(deviceInput.value.trim())
    if (device !== undefined) sessionStorage.setItem(deviceKey, device)
    else sessionStorage.removeItem(deviceKey)
  } catch (_error) { /* Tab storage is optional; requests still use the live field value. */ }
}
function deviceId(): string | undefined { return presentableDevice(deviceInput.value.trim()) }
save()
let lifetime = new AbortController(), timer: ReturnType<typeof setTimeout> | undefined, cursor: string | null = null
let generation = 0, polling = false, busy = false, allowed = false, retryAllowed = false
function controls(): void {
  form.hidden = !allowed
  send.disabled = busy || !allowed || !!state.pending
  input.disabled = busy || !allowed || !!state.pending
  check.hidden = !state.pending; check.disabled = busy || !allowed
  retry.hidden = !state.pending || !retryAllowed; retry.disabled = busy || !allowed
}
function showFailure(error: unknown): void {
  if (error instanceof ViewerFailure && (error.status === 401 || error.status === 403)) {
    status.textContent = copy.denied; state.token = ''; save(); lifetime.abort(); allowed = false; controls()
  } else status.textContent = copy.offline
}
async function poll(): Promise<void> {
  if (!state.token || document.hidden || polling) return
  polling = true
  const owner = generation
  let more = false
  try {
    const value = page(await request(state.token, 'read', { cursor }, lifetime.signal, deviceId()))
    if (generation !== owner || lifetime.signal.aborted) return
    if (value.reset) turns.replaceChildren()
    for (const turn of value.turns) {
      const article = element('article'); article.dataset.role = turn.role
      article.append(element('strong', turn.role === 'user' ? copy.user : copy.assistant), document.createTextNode(turn.text))
      if (turn.truncated) article.append(element('p', copy.truncated, 'hint'))
      turns.append(article)
    }
    while (turns.children.length > 200) { turns.firstChild?.remove(); omitted.hidden = false }
    if (value.earlierOmitted) omitted.hidden = false
    cursor = value.cursor; more = value.hasMore; allowed = value.mode === 'text'; form.hidden = !allowed
    metadata.textContent = `${value.label} · ${allowed ? copy.text : copy.read} · ${copy.expires} ${new Date(value.expiresAt).toLocaleString()}`
    status.textContent = value.running ? copy.running : copy.ready; controls()
  } catch (error) { if (generation === owner && !lifetime.signal.aborted) showFailure(error) }
  finally {
    polling = false
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- A denied response clears the mutable tab credential in showFailure.
    if (state.token && !document.hidden && generation === owner) timer = setTimeout(() => { void poll() }, more ? 150 : 2500)
  }
}
async function deliver(action: 'send' | 'receipt'): Promise<void> {
  const pending = state.pending
  if (!pending || busy || !state.token) return
  const owner = generation
  busy = true; controls()
  try {
    const value = receipt(await request(state.token, action, action === 'send' ? pending : { requestId: pending.requestId }, lifetime.signal, deviceId()), pending.requestId)
    if (generation !== owner || lifetime.signal.aborted) return
    retryAllowed = value.state === 'rejected'
    outcome.textContent = value.state === 'received' ? copy.queued : value.state === 'uncertain' ? copy.uncertain : copy.rejected
    if (value.state === 'received') { delete state.pending; input.value = ''; save() }
  } catch (error) {
    if (generation === owner && !lifetime.signal.aborted) { outcome.textContent = copy.uncertain; showFailure(error) }
  } finally { if (generation === owner) { busy = false; controls() } }
}
deviceInput.addEventListener('change', () => { saveDevice() })
deviceInput.addEventListener('blur', () => { saveDevice() })
form.addEventListener('submit', (event) => {
  event.preventDefault()
  if (busy || !allowed || state.pending) return
  const text = input.value.trim()
  if (!text || text.length > 4096 || new TextEncoder().encode(text).byteLength > 12000) { outcome.textContent = copy.invalid; return }
  // oxlint-disable-next-line no-restricted-properties -- This standalone route permits only HTTPS or loopback, both secure contexts.
  state.pending = { requestId: crypto.randomUUID(), text }; retryAllowed = false; save(); void deliver('send')
})
check.addEventListener('click', () => { void deliver('receipt') })
retry.addEventListener('click', () => { if (retryAllowed) { retryAllowed = false; void deliver('send') } })
forget.addEventListener('click', () => {
  generation++; lifetime.abort(); clearTimeout(timer); state = { token: '' }; save(); turns.replaceChildren(); form.hidden = true; metadata.textContent = copy.local; status.textContent = copy.missing
})
document.addEventListener('visibilitychange', () => {
  clearTimeout(timer)
  if (document.hidden) { generation++; lifetime.abort(); busy = false; polling = false; controls() }
  else { lifetime = new AbortController(); void poll() }
})
window.addEventListener('pagehide', () => { generation++; lifetime.abort(); clearTimeout(timer) })
// A second grant link opened in the same tab navigates by fragment only, so the
// browser reuses this document and the module-scope initialization above never
// runs again. Without this, the page keeps the previous grant's denied state and
// never loads the new one. Reset rather than reload: the tab already owns the
// lifecycle for a replaced credential, and reloading would re-send the fragment.
window.addEventListener('hashchange', () => {
  const next = location.hash.slice(1)
  if (!/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u.test(next) || next === state.token) return
  generation++; lifetime.abort(); clearTimeout(timer)
  lifetime = new AbortController(); busy = false; polling = false; retryAllowed = false
  cursor = null; allowed = false; state = { token: next }; save()
  history.replaceState(null, '', location.pathname)
  turns.replaceChildren(); omitted.hidden = true; outcome.textContent = ''
  metadata.textContent = copy.local; status.textContent = copy.loading
  input.value = ''; input.disabled = true; send.disabled = true; form.hidden = true
  check.hidden = true; retry.hidden = true
  void poll()
})
if (state.pending) { input.value = state.pending.text; outcome.textContent = copy.uncertain; controls() }
if (state.token) void poll()
else status.textContent = copy.missing
