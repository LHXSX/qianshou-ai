import { createSessionCoordinator, SessionError, type LoginTicket, type Persistence, type RequestLease } from '../shared/session-coordinator'
import type { AuthUser } from './api'

export { SessionError }
export type { RequestLease }
export interface WebLoginAttempt { readonly ticket: LoginTicket; readonly mode: Persistence }
export interface AuthState { user: AuthUser | null; token: string | null; generation: string | null }
const SELECTOR = 'eco.web.selected.v1'
const IDENTITY = 'eco.web.identity.v1:'
const coordinators = {
  local: createSessionCoordinator({ namespace: 'web', persistence: 'local' }),
  session: createSessionCoordinator({ namespace: 'web', persistence: 'session' }),
}
const listeners = new Set<(state: AuthState) => void>()
let changing = 0
let migrationDone = false
let loginIntent = 0

function store(mode: Persistence) { return mode === 'local' ? localStorage : sessionStorage }
function selected(): Persistence | null {
  const tab = sessionStorage.getItem(SELECTOR)
  if (tab === 'session' || tab === 'local') return tab
  return localStorage.getItem(SELECTOR) === 'local' ? 'local' : null
}
function modeOf(lease: RequestLease): Persistence {
  if (lease.scope === 'web:local') return 'local'
  if (lease.scope === 'web:session') return 'session'
  throw new SessionError('SESSION_CHANGED')
}
function migrateLegacy() {
  if (migrationDone) return
  try {
    for (const storage of [localStorage, sessionStorage]) {
      for (const key of ['web_access_token', 'web_refresh_token', 'web_user', 'web_remember_me']) storage.removeItem(key)
    }
    migrationDone = true
  } catch { throw new SessionError('SESSION_STORAGE_UNAVAILABLE') }
}
function supported() { return coordinators.local.supported() }
function supportError(): string | null {
  try { migrateLegacy(); selected() } catch { return '浏览器会话存储不可用，请允许此站点使用本地存储后重新登录。' }
  if (!supported()) return '当前浏览器无法安全协调登录会话。请使用支持 Web Locks 的浏览器，通过站点的 HTTPS 地址登录。'
  return null
}
function capture(): RequestLease | null {
  migrateLegacy()
  if (changing || !supported()) return null
  const mode = selected()
  return mode ? coordinators[mode].capture() : null
}
function isCurrent(lease: RequestLease) {
  const current = capture()
  return Boolean(current && current.scope === lease.scope && current.generation === lease.generation && current.accountId === lease.accountId)
}
function getUser(): AuthUser | null {
  try {
    const lease = capture()
    if (!lease) return null
    const raw = store(modeOf(lease)).getItem(`${IDENTITY}${lease.generation}`)
    const identity = raw ? JSON.parse(raw) : null
    return identity?.accountId === lease.accountId && identity?.user?.id === lease.accountId ? identity.user : null
  } catch { return null }
}
function emit() {
  let lease: RequestLease | null = null
  try { lease = capture() } catch { /* Subscribers receive signed-out state on storage failure. */ }
  const state = { user: getUser(), token: lease?.accessToken ?? null, generation: lease?.generation ?? null }
  listeners.forEach(listener => { try { listener(state) } catch { /* Isolate view subscribers. */ } })
}
function assertLogin(attempt: WebLoginAttempt) {
  if (!attempt || selected() !== attempt.mode || !coordinators[attempt.mode].isLoginCurrent(attempt.ticket)) throw new SessionError('SESSION_CHANGED')
}
async function beginLogin(remember: boolean): Promise<WebLoginAttempt> {
  const unavailable = supportError()
  if (unavailable) {
    const error = new SessionError(supported() ? 'SESSION_STORAGE_UNAVAILABLE' : 'WEB_LOCKS_UNAVAILABLE')
    error.message = unavailable
    throw error
  }
  const mode: Persistence = remember ? 'local' : 'session'
  const previous = selected()
  const previousLease = capture()
  const intent = ++loginIntent
  ++changing
  emit()
  try {
    if (previous && previous !== mode) await coordinators[previous].clear()
    if (intent !== loginIntent) throw new SessionError('SESSION_CHANGED')
    sessionStorage.setItem(SELECTOR, mode)
    if (mode === 'local') localStorage.setItem(SELECTOR, mode)
    else localStorage.removeItem(SELECTOR)
    const ticket = await coordinators[mode].beginLogin()
    if (intent !== loginIntent || !coordinators[mode].isLoginCurrent(ticket)) throw new SessionError('SESSION_CHANGED')
    if (previousLease) store(modeOf(previousLease)).removeItem(`${IDENTITY}${previousLease.generation}`)
    return Object.freeze({ ticket, mode })
  } finally { --changing; emit() }
}
async function commitLogin(attempt: WebLoginAttempt, pair: { accessToken: string; refreshToken: string }, user: AuthUser) {
  assertLogin(attempt)
  const lease = await coordinators[attempt.mode].commitLogin(attempt.ticket, { ...pair, accountId: String(user.id) })
  if (!isCurrent(lease)) throw new SessionError('SESSION_CHANGED')
  store(attempt.mode).setItem(`${IDENTITY}${lease.generation}`, JSON.stringify({ accountId: lease.accountId, user }))
  emit()
  return lease
}
async function refresh(lease: RequestLease) {
  if (!isCurrent(lease)) throw new SessionError('SESSION_CHANGED')
  try {
    const rotated = await coordinators[modeOf(lease)].refresh(lease)
    if (!isCurrent(rotated)) throw new SessionError('SESSION_CHANGED')
    return rotated
  } finally { emit() }
}
async function clear(lease?: RequestLease) {
  const mode = lease ? modeOf(lease) : selected()
  if (!mode) return false
  if (lease && !isCurrent(lease)) return false
  ++loginIntent
  const before = lease ?? capture()
  ++changing
  emit()
  try {
    const cleared = await coordinators[mode].clear(lease)
    if (cleared && before) store(mode).removeItem(`${IDENTITY}${before.generation}`)
    return cleared
  } finally { --changing; emit() }
}
async function cancelLogin(attempt: WebLoginAttempt) {
  if (!attempt) return
  await coordinators[attempt.mode].cancelLogin(attempt.ticket)
  emit()
}
function getToken() { try { return capture()?.accessToken ?? null } catch { return null } }
function onStateChange(listener: (state: AuthState) => void) { listeners.add(listener); return () => { listeners.delete(listener) } }

window.addEventListener('storage', event => {
  if (event.key !== null && event.key !== SELECTOR && !event.key.startsWith('eco.session.v1:') && !event.key.startsWith(IDENTITY)) return
  if (!supported()) { emit(); return }
  // Read after all atomic session writes, without holding a network refresh lock.
  void navigator.locks.request('eco.session.v1:state', emit).catch(() => emit())
})

export const browserSession = { supported, supportError, capture, isCurrent, getUser, getToken,
  assertLogin, beginLogin, commitLogin, cancelLogin, refresh, clear, onStateChange }
