/** Mobile web entry reuses the native workspace and shared account client. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { createAccountClient, createTokenStore, type Account, type AccountWorker } from '@deepseek-ai/dsh-client-account'
import { IndexedDbWindowJournalStore } from '@deepseek-ai/dsh-client-pc-window-bridge'
import { IMAGE_FOLLOW_UP_TTL_MS, planImageIntent, readyImagePlan, type ImageIntentPlan } from '@deepseek-ai/dsh-client-compute-trigger'
import { startWindowEntry, type WindowEntryHandle } from './window/entry.ts'
import { createAccountPcDirectory } from './window/account-pc-directory.ts'
import { createMobilePcRelayPort } from './pc-relay-http.ts'
import type { WindowFrame } from './window/window.ts'
import type { MobileConversationTarget, MobileWorkspaceSnapshot } from './window/mobile-workspace-types.ts'
import { readDeviceId } from './device-id.ts'
import { decoratePcDirectory } from './pc-directory-view.ts'
import { materializeMobileFrame } from './dom-painter.ts'
import { createComposerSubmissions } from './composer-submissions.ts'
import { renderMobileSection, type MobileViewSection } from './mobile-render-boundary.ts'
import { installMobileViewportMetrics, shouldFollowViewportAfterResize } from './mobile-viewport.ts'
import { copy as t } from './copy.ts'
import { createMobileAgentHttpPort } from './agent-http.ts'
import { createImageGenerationClient, ImageGenerationError } from './image-client.ts'
import { isImageCancellation, resolveConversationIntent } from './conversation-intent.ts'
import { createImageConversations, type ImageConversation } from './image-conversation.ts'
import { createImageTurnController } from './image-turn.ts'
import { imageSourceDataUri, sameImageSource, type ImageSource } from './image-source.ts'
import { openImageAlbum, type ImageAlbumRecord } from './image-album.ts'
import { createAccountDialog, type AccountPage } from './components/account-dialog.ts'
import { createAccountReader } from './components/account-profile.ts'
import { createCommerceReader } from './components/account-commerce.ts'
import { accountCopy as a } from './components/account-copy.ts'
import { createWelcomeScreen } from './components/welcome.ts'
import { appendLocalConversation, decorateMessages, type GeneratedImageTurn, type PendingImageExchange } from './components/message-view.ts'
import { createBrowserVoiceInput } from './voice.ts'
import { bindHoldToTalk } from './hold-to-talk.ts'
import { createComposerModeController } from './composer-mode.ts'
import { createNativeVoiceInput, nativeVoiceBridge } from './native-voice.ts'
import { createInteractionFeedback, interactionPreference, setInteractionPreference } from './interaction-feedback.ts'
import { messageSpeech } from './message-speech.ts'
import './host.ts'
import './styles.css'
import './concept-skin.css'
import './mobile-navigation.css'

function required<T>(value: T | null): T {
  if (value === null) throw new Error('PREVIEW_OWNED_ELEMENT_MISSING')
  return value
}
const app = required(document.querySelector<HTMLDivElement>('#app'))
const requestedSkin = new URLSearchParams(window.location.search).get('skin')
const savedSkin = window.localStorage.getItem('qianshou.mobile.skin')
const selectedSkin = requestedSkin === 'dopamine' || savedSkin === 'dopamine' ? 'dopamine' : 'ios'
document.documentElement.dataset.skin = selectedSkin
if (requestedSkin === 'dopamine') window.localStorage.setItem('qianshou.mobile.skin', 'dopamine')
const host = window.qianshouMobileHost
const client = createAccountClient({ baseUrl: window.location.origin, prefix: '/account-api/api/v8', fetch: window.fetch.bind(window), tokens: createTokenStore({ cookiesAvailable: false }) })
let account: Account | null = null
function currentAccountId(): string | null { return account === null ? null : String(account.id) }
const imageAccess = async (signal: AbortSignal): Promise<string | null> => {
  signal.throwIfAborted()
  if (client.tokens.isAccessExpired()) await client.refresh()
  signal.throwIfAborted()
  return client.tokens.readAccess()
}
const imageClient = createImageGenerationClient({
  fetch: window.fetch.bind(window),
  accountId: () => account?.id == null ? null : String(account.id),
  access: imageAccess,
})
const imageConversations = createImageConversations()
let imageAlbum: Awaited<ReturnType<typeof openImageAlbum>> | null = null
let albumAccountId: string | null = null
let restoredAlbum: ImageAlbumRecord | null = null
let imageOwnerAccountId: string | null = null
const imageSession = createImageTurnController({ generate: imageClient.generate, edit: imageClient.edit })
let activeImage: { readonly state: ImageConversation; readonly exchange: PendingImageExchange } | null = null
interface ComposerAttachment extends ImageSource {
  readonly id: string
}
const composerAttachments: ComposerAttachment[] = []
const ACCEPT_IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp'])
const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024
const ATTACHMENT_MAX_COUNT = 1
let attachmentOwner: ImageConversation | null = null
const agent = host?.agent ?? (__MOBILE_AGENT_HTTP__ ? createMobileAgentHttpPort({
  accountId: () => account?.id == null ? null : String(account.id),
  access: async (signal) => {
    signal.throwIfAborted()
    if (client.tokens.isAccessExpired()) await client.refresh()
    signal.throwIfAborted()
    return client.tokens.readAccess()
  },
  fetch: window.fetch.bind(window), timeoutMs: 30000,
}) : undefined)
const authorizePc = host?.authorizePc ?? (async (worker: AccountWorker, accountId: string, _signal: AbortSignal) => {
  const token = async (owner: string, tokenSignal: AbortSignal): Promise<string | null> => {
    if (currentAccountId() !== owner) throw new Error('MOBILE_PC_RELAY_ACCOUNT_CHANGED')
    tokenSignal.throwIfAborted()
    if (client.tokens.isAccessExpired()) await client.refresh()
    tokenSignal.throwIfAborted()
    if (currentAccountId() !== owner) throw new Error('MOBILE_PC_RELAY_ACCOUNT_CHANGED')
    return client.tokens.readAccess()
  }
  return createMobilePcRelayPort({ workerId: worker.id, accountId, access: token, fetch: window.fetch.bind(window), timeoutMs: 30_000 })
})
const accountListeners = new Set<() => void>()
const interactionFeedback = createInteractionFeedback()
const unlockFeedback = (): void => { interactionFeedback.unlock() }
document.addEventListener('pointerdown', unlockFeedback, { passive: true })
document.addEventListener('keydown', unlockFeedback)
let entry: WindowEntryHandle | null = null
let frame: WindowFrame | null = null
let drawerOpen = false
let pcDrawerOpen = false
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node
}
const button = (text: string, action: () => void, className = ''): HTMLButtonElement => {
  const node = element('button', className, text); node.type = 'button'; node.addEventListener('click', action); return node
}
const SVG_NS = 'http://www.w3.org/2000/svg'
function composerIcon(kind: 'plus' | 'mic' | 'keyboard'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', kind === 'plus' ? '2.2' : '1.6')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.classList.add('composer-icon', `composer-icon-${kind}`)
  if (kind === 'plus') {
    const cross = document.createElementNS(SVG_NS, 'path')
    cross.setAttribute('d', 'M12 7.25v9.5M7.25 12h9.5')
    svg.append(cross)
  } else if (kind === 'mic') {
    // A compact speaker/wave mark reads as voice input without competing with
    // the message playback icon used on assistant responses.
    const speaker = document.createElementNS(SVG_NS, 'path')
    speaker.setAttribute('d', 'M4.8 10.1h3.1l4.15-3.25v10.3L7.9 13.9H4.8Z')
    const wave = document.createElementNS(SVG_NS, 'path')
    wave.setAttribute('d', 'M15.1 9.15a4.1 4.1 0 0 1 0 5.7M17.55 7.1a7.05 7.05 0 0 1 0 9.8')
    svg.append(speaker, wave)
  } else {
    const keys = document.createElementNS(SVG_NS, 'rect')
    keys.setAttribute('x', '4'); keys.setAttribute('y', '6'); keys.setAttribute('width', '16'); keys.setAttribute('height', '12'); keys.setAttribute('rx', '2')
    const line = document.createElementNS(SVG_NS, 'path'); line.setAttribute('d', 'M7 10h.01M10 10h.01M13 10h.01M16 10h.01M7 14h10')
    svg.append(keys, line)
  }
  return svg
}
function gearIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.6')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.classList.add('sidebar-settings-icon')
  const ring = document.createElementNS(SVG_NS, 'circle')
  ring.setAttribute('cx', '12')
  ring.setAttribute('cy', '12')
  ring.setAttribute('r', '3.1')
  const cog = document.createElementNS(SVG_NS, 'path')
  cog.setAttribute('d', 'M12 3.4v2.1M12 18.5v2.1M3.4 12h2.1M18.5 12h2.1M6.05 6.05l1.5 1.5M16.45 16.45l1.5 1.5M17.95 6.05l-1.5 1.5M7.55 16.45l-1.5 1.5')
  svg.append(ring, cog)
  return svg
}
function brandMark(className = 'brand-mark'): HTMLElement {
  const mark = element('span', className)
  for (const tone of ['violet', 'gold', 'pink']) mark.append(element('i', `brand-bar brand-bar-${tone}`))
  mark.setAttribute('aria-hidden', 'true')
  return mark
}
const overlay = element('button', 'drawer-overlay'); overlay.type = 'button'; overlay.ariaLabel = t.close
const shell = element('div', 'mobile-shell')
const disposeMobileViewportMetrics = installMobileViewportMetrics(shell, window.visualViewport, () => {
  // visualViewport resize/scroll is also emitted while the keyboard pans the
  // page. Preserve a deliberate reading position instead of forcing the
  // transcript to the bottom during that layout transition.
  if (shouldFollowViewportAfterResize(content, userScrolledAway)) {
    requestAnimationFrame(() => { followLatest() })
  }
})
const header = element('header', 'header')
const menu = button('☰', () => { setDrawer(!drawerOpen) }, 'icon-button'); menu.ariaLabel = t.menu
const brand = element('div', 'brand'); brand.append(brandMark(), element('span', 'brand-name', t.brand))
const headerSpacer = element('span', 'header-spacer')
headerSpacer.setAttribute('aria-hidden', 'true')
header.append(menu, brand, headerSpacer)
const sidebar = element('aside', 'sidebar'); sidebar.ariaLabel = t.menu
const sidebarTop = element('div', 'sidebar-top'); sidebarTop.append(brandMark('sidebar-brand-mark'), element('strong', '', t.brand), button('×', () => { setDrawer(false) }, 'icon-button'))
const sidebarContent = element('div', 'sidebar-content')
const sidebarTools = element('nav', 'sidebar-tools'); sidebarTools.setAttribute('aria-label', '账户与服务')
const accountCenterButton = button(t.accountCenter, () => { setDrawer(false); openAccount() }, 'sidebar-tool')
const billingButton = button(t.billing, () => { setDrawer(false); openAccount('commerce') }, 'sidebar-tool')
const promotionButton = button(t.promotion, () => { setDrawer(false); showPromotion() }, 'sidebar-tool')
sidebarTools.append(accountCenterButton, billingButton, promotionButton)
const sidebarAccountAvatar = element('span', 'sidebar-account-avatar')
const sidebarAccountName = element('strong', 'sidebar-account-name', t.login)
const sidebarAccountId = element('small', 'sidebar-account-id')
const sidebarAccountMeta = element('span', 'sidebar-account-meta')
sidebarAccountMeta.append(sidebarAccountName, sidebarAccountId)
const sidebarAccount = button('', () => { setDrawer(false); openAccount() }, 'sidebar-account')
sidebarAccount.append(sidebarAccountAvatar, sidebarAccountMeta)
const sidebarSettings = button('', () => { setDrawer(false); openAccount('settings') }, 'sidebar-settings')
sidebarSettings.ariaLabel = t.accountSettings
sidebarSettings.append(gearIcon())
const sidebarFooter = element('div', 'sidebar-footer')
sidebarFooter.append(sidebarAccount, sidebarSettings)
sidebar.append(sidebarTop, sidebarContent, sidebarTools, sidebarFooter)
const main = element('main', 'conversation')
const context = element('div', 'context-bar')
const content = element('div', 'conversation-content')
const hero = element('section', 'hero')
hero.append(brandMark('hero-mark'), element('h1', '', t.hello), element('p', 'subtitle', t.subtitle))
const suggestions = element('div', 'suggestions')
for (const [label, prompt] of [[t.image, t.imagePrompt], [t.video, t.videoPrompt], [t.sheet, t.sheetPrompt]] as const) {
  suggestions.append(button(label, () => { setInput(prompt) }, 'suggestion'))
}
// Capability shortcuts are shown from the composer instead of turning the
// conversation landing page into a tool catalogue.
hero.hidden = true
suggestions.hidden = true
const transcript = element('div', 'transcript')
content.append(hero, transcript)
// Keep the newest answer in view while the user is following the live turn.
// Once the user deliberately scrolls away, preserve that reading position until
// they return to the bottom; a background snapshot must never steal the scroll.
let userScrolledAway = false
let ignoreFollowScroll = false
content.addEventListener('scroll', () => {
  if (ignoreFollowScroll) return
  const distance = content.scrollHeight - content.scrollTop - content.clientHeight
  userScrolledAway = distance > 96
})
function followLatest(force = false): void {
  const typing = document.activeElement instanceof HTMLTextAreaElement && document.activeElement.closest('.composer') !== null
  if (typing && !force) return
  if (!force && userScrolledAway) return
  const move = (): void => {
    ignoreFollowScroll = true
    try {
      const scroll = (content as HTMLElement & { scrollTo?: (options: ScrollToOptions) => void }).scrollTo
      if (typeof scroll === 'function') scroll.call(content, { top: content.scrollHeight, behavior: 'auto' })
      else content.scrollTop = content.scrollHeight
    } finally {
      ignoreFollowScroll = false
    }
  }
  move()
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(move)
}
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => { followLatest() }).observe(transcript)
}
const bottom = element('div', 'composer-area')
const draft = element('div', 'draft'); draft.hidden = true
const feedback = element('div', 'feedback'); feedback.setAttribute('role', 'status')
const composer = element('div', 'composer composer-unified')
const composerToolbar = element('div', 'composer-toolbar')
const footnote = element('div', 'footnote', t.intro)
const quickMenu = element('div', 'composer-quick-menu'); quickMenu.hidden = true
for (const [label, prompt] of [[t.image, t.imagePrompt], [t.video, t.videoPrompt], [t.sheet, t.sheetPrompt]] as const) {
  quickMenu.append(button(label, () => { setInput(prompt); quickMenu.hidden = true }, 'suggestion'))
}
const attachmentRail = element('div', 'composer-attachments')
attachmentRail.hidden = true
attachmentRail.dataset.testid = 'composer-attachments'
const composerFile = document.createElement('input')
composerFile.type = 'file'
composerFile.accept = 'image/jpeg,image/png,image/webp'
composerFile.multiple = false
composerFile.className = 'composer-file'
composerFile.tabIndex = -1
composerFile.setAttribute('aria-hidden', 'true')
composerFile.setAttribute('aria-label', t.uploadImage)
composerFile.addEventListener('change', () => {
  attachComposerFiles(composerFile.files)
  composerFile.value = ''
})
bottom.append(draft, feedback, attachmentRail, composer, footnote)
composer.append(composerFile)
function paintComposerAttachments(): void {
  attachmentRail.replaceChildren()
  attachmentRail.hidden = composerAttachments.length === 0
  for (const item of composerAttachments) {
    const chip = element('div', 'composer-attachment')
    const img = document.createElement('img')
    img.src = item.url
    img.alt = item.name
    const remove = button('×', () => {
      const index = composerAttachments.findIndex(row => row.id === item.id)
      if (index >= 0) {
        const [removed] = composerAttachments.splice(index, 1)
        if (removed !== undefined && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(removed.url)
      }
      paintComposerAttachments()
    }, 'composer-attachment-remove')
    remove.setAttribute('aria-label', t.removeAttachment)
    const preview = button('', () => { openOriginalImage(item) }, 'composer-attachment-preview')
    preview.ariaLabel = `查看原图：${item.name}`
    preview.append(img)
    chip.append(preview, remove)
    attachmentRail.append(chip)
  }
  syncComposerControls()
}
function attachComposerFiles(list: FileList | null): void {
  if (list === null) return
  attachmentOwner = currentImageConversation()
  for (const file of Array.from(list)) {
    if (composerAttachments.length >= ATTACHMENT_MAX_COUNT) { feedback.textContent = '每次修改一张图片。可以先移除当前图片，再换一张。'; break }
    if (!ACCEPT_IMAGE.has(file.type)) { feedback.textContent = t.uploadUnsupported; continue }
    if (file.size > ATTACHMENT_MAX_BYTES) { feedback.textContent = t.uploadTooLarge; continue }
    const url = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : ''
    const id = `attachment-${randomUUID()}`
    composerAttachments.push({ id, ref: { kind: 'attachment', id }, name: file.name, url, file })
  }
  paintComposerAttachments()
}
function takeComposerAttachments(): ComposerAttachment[] {
  const items = composerAttachments.splice(0, composerAttachments.length)
  paintComposerAttachments()
  return items
}
main.append(context, content, bottom)
shell.append(header, sidebar, main, overlay)
app.append(shell)
let accountPageOpen = false
function gateShell(): void {
  const admitted = account !== null && !accountPageOpen
  shell.hidden = !admitted
  if (admitted) shell.removeAttribute('inert')
  else shell.setAttribute('inert', '')
}
gateShell()
const dialog = element('section', 'account-dialog'); dialog.hidden = true; app.append(dialog)

overlay.addEventListener('click', () => { setDrawer(false) })
function setDrawer(open: boolean): void {
  drawerOpen = open; shell.classList.toggle('drawer-open', open); menu.setAttribute('aria-expanded', String(open))
  sidebar.inert = !open && window.matchMedia('(max-width: 720px)').matches
  if (open) { sidebar.querySelector<HTMLButtonElement>('button')?.focus(); void refreshPcDirectory() }
  else if (window.matchMedia('(max-width: 720px)').matches) menu.focus()
}
let refreshingPcDirectory = false
async function refreshPcDirectory(): Promise<void> {
  if (refreshingPcDirectory || account === null || !entry?.mobile || document.visibilityState === 'hidden') return
  refreshingPcDirectory = true
  try { await entry.mobile.refreshDevices() } finally { refreshingPcDirectory = false }
}
setDrawer(false)
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && drawerOpen && !accountPageOpen) { event.preventDefault(); setDrawer(false) }
  if (event.key === 'Tab' && drawerOpen && window.matchMedia('(max-width: 720px)').matches) {
    const buttons = [...sidebar.querySelectorAll<HTMLButtonElement>('button')].filter(node => !node.disabled && !node.closest('[hidden]'))
    const first = buttons[0]; const last = buttons.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
})
window.matchMedia('(max-width: 720px)').addEventListener('change', () => { setDrawer(false) })
function setInput(text: string): void {
  const input = composer.querySelector('textarea')
  if (!input) return
  input.value = text; resizeInput(input); input.dispatchEvent(new Event('input', { bubbles: true })); input.focus()
}
function showPromotion(): void {
  openAccount('promotion')
}
function resizeInput(input: HTMLTextAreaElement): void {
  const shorter = input.value.length < Number(input.dataset.length ?? '0')
  input.dataset.length = String(input.value.length)
  if (!shorter && input.scrollHeight <= input.clientHeight + 2) return
  input.style.height = 'auto'
  input.style.height = `${input.scrollHeight}px`
}
function accountInitials(username: string): string {
  const first = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(username.trim())[Symbol.iterator]().next().value?.segment
  return first === undefined ? '' : first.toLocaleUpperCase('zh-CN')
}
function paintAccountFooter(): void {
  sidebarAccountAvatar.textContent = account ? accountInitials(account.username) : ''
  sidebarAccountName.textContent = account?.username || t.login
  sidebarAccountId.textContent = account ? `ID ${String(account.id)}` : ''
  sidebarAccountId.hidden = account === null
}
function pcOnlineLabel(title: string, devices: readonly { readonly online: boolean }[]): string {
  const online = devices.filter(device => device.online).length
  return `${String(online)}/${String(devices.length)} ${t.pcOnline} ${title}`
}
function paintPcStatus(devices: readonly { readonly online: boolean }[]): { readonly status: HTMLElement; readonly online: number } {
  const online = devices.filter(device => device.online).length
  const status = element('span', 'pc-toggle-status')
  const count = element('span', 'pc-toggle-count', `${String(online)}/${String(devices.length)} ${t.pcOnline}`)
  const dot = element('span', online > 0 ? 'pc-status-dot pc-status-dot-online' : 'pc-status-dot')
  dot.setAttribute('aria-hidden', 'true')
  status.append(count, dot)
  return { status, online }
}
const composerSubmissions = createComposerSubmissions()
function submissionScope(): string { return JSON.stringify([currentAccountId(), entry?.mobile?.snapshot().target ?? null]) }
function composerSubmitting(): boolean { return composerSubmissions.busy(submissionScope()) }
function currentImageConversation(): ImageConversation | null {
  const target = entry?.mobile?.snapshot().target
  if (!account || target?.kind !== 'agent' || String(account.id) !== target.binding.accountId) return null
  return imageConversations.get(String(account.id), target.binding.sessionId)
}
function nextExchangeId(): string { return `image-exchange-${randomUUID()}` }
function resultImageSource(turn: GeneratedImageTurn): ImageSource {
  return { ref: { kind: 'result', turnId: turn.id, imageIndex: 0 }, name: '对话中的图片', url: turn.dataUri, dataUri: turn.dataUri }
}
function resolveEditSource(state: ImageConversation, plan: ImageIntentPlan, sources: readonly ImageSource[]): ImageSource | null {
  if (plan.kind !== 'image.edit' || plan.source === undefined) return null
  const ref = plan.source
  const candidates = [...sources, ...state.exchanges.flatMap(exchange => exchange.sources ?? []), ...state.images.map(resultImageSource)]
  return candidates.find(source => sameImageSource(source.ref, ref)) ?? null
}
function persistAlbum(state: ImageConversation): void {
  if (imageAlbum === null || currentAccountId() !== state.accountId) return
  const current = imageConversations.forAccount(state.accountId)
  const loadedKeys = new Set(current.map(item => item.sessionKey))
  const preserved = restoredAlbum?.accountId === state.accountId
    ? restoredAlbum.images.filter(image => !image.sessionKey || !loadedKeys.has(image.sessionKey)) : []
  const record: ImageAlbumRecord = {
    accountId: state.accountId,
    images: [...preserved, ...current.flatMap(item => item.images.map(image => ({ ...image, sessionKey: item.sessionKey })))]
      .sort((left, right) => left.at - right.at).slice(-40),
    lastPrompt: '', userTurnsSinceImage: 0,
  }
  restoredAlbum = record
  void imageAlbum.save(record)
}
async function restoreAlbum(accountId: string): Promise<void> {
  if (imageAlbum === null || albumAccountId === accountId) return
  albumAccountId = accountId
  const record = await imageAlbum.load(accountId)
  if (currentAccountId() !== accountId || albumAccountId !== accountId) return
  restoredAlbum = record
  for (const image of record?.images ?? []) {
    // Older albums have no Session binding: keep them in storage, never inject
    // their prompt into a newly opened conversation.
    if (!image.sessionKey) continue
    const state = imageConversations.get(accountId, image.sessionKey)
    if (!state.images.some(item => item.id === image.id)) state.images.push(image)
  }
  if (frame) entry?.refresh()
}
async function submitComposer(): Promise<void> {
  cancelVoiceSend()
  if (composerSubmitting()) return
  const input = composer.querySelector('textarea')
  if (input === null || (input.value.trim() === '' && composerAttachments.length === 0)) return
  if (!account) { feedback.textContent = t.loginFirst; openAccount(); return }
  const text = input.value.trim() === '' ? '修改这张图片' : input.value
  const accountId = String(account.id)
  const submission = composerSubmissions.begin(submissionScope())
  if (submission === null) return
  interactionFeedback.unlock()
  syncComposerControls()
  userScrolledAway = false
  followLatest(true)
  try {
    const mobile = entry?.mobile
    if (mobile === undefined || mobile === null) { feedback.textContent = t.agentMissing; return }
    if (mobile.snapshot().target === null) {
      const opened = await mobile.openAgent()
      const selected = mobile.snapshot().target
      if (opened === null || selected?.kind !== 'agent'
        || opened.accountId !== selected.binding.accountId || opened.sessionId !== selected.binding.sessionId) return
    }
    if (currentAccountId() !== accountId || mobile.snapshot().target === null) return
    if (!submission.bind(submissionScope())) return
    const state = currentImageConversation()
    if (composerAttachments.length > 0 && attachmentOwner !== null && attachmentOwner !== state) {
      feedback.textContent = '请在当前会话重新选择图片。'
      return
    }
    for (const exchange of state?.exchanges ?? []) {
      if (exchange.phase === 'ask' && !exchange.settled && Date.now() - exchange.at >= IMAGE_FOLLOW_UP_TTL_MS) exchange.settled = true
    }
    const pending = state?.exchanges.find(item => item.phase === 'ask' && !item.settled)
    const recentImage = state?.images.at(-1)
    const decision = state === null ? { route: 'chat' as const, clearImageContext: false } : resolveConversationIntent(text, {
      ...(pending === undefined ? {} : { pending: pending.plan }),
      ...(state.lastPlan === null ? {} : { lastImage: state.lastPlan }),
      userTurnsSinceImage: state.userTurnsSinceImage, attachmentCount: composerAttachments.length,
      imageInFlight: activeImage?.state === state,
      imageElapsedMs: Date.now() - state.lastImageAt,
      attachments: composerAttachments.map(item => item.ref),
      ...(recentImage === undefined ? {} : { lastImageSource: resultImageSource(recentImage).ref }),
    })
    if (decision.route === 'unavailable') {
      if (state) {
        state.notices.push({ id: nextExchangeId(), text, reply: decision.message, at: Date.now() })
        state.lastPlan = null; state.lastImageAt = 0
        if (state.notices.length > 20) state.notices.shift()
      }
      if (pending) pending.settled = true
      input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }))
      if (frame) entry?.refresh()
      feedback.textContent = decision.message
      return
    }
    if (decision.route === 'cancel-image') {
      if (state) { state.lastPlan = null; state.lastImageAt = 0 }
      if (activeImage?.state === state) {
        activeImage.exchange.phase = 'cancelled'
        activeImage.exchange.settled = true
        activeImage.exchange.waitMessage = '已停止等待这张图片。'
        imageSession.abort()
      }
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true }))
      if (frame) entry?.refresh()
      return
    }
    if (decision.route === 'chat') {
      if (composerAttachments.length > 0 && isImageCancellation(text)) {
        for (const item of takeComposerAttachments()) if (item.url.startsWith('blob:')) URL.revokeObjectURL(item.url)
        if (pending) pending.settled = true
        if (state) { state.lastPlan = null; state.lastImageAt = 0 }
        input.value = ''
        input.dispatchEvent(new Event('input', { bubbles: true }))
        if (frame) entry?.refresh()
        feedback.textContent = '已取消修图。'
        return
      }
      if (composerAttachments.length > 0) {
        feedback.textContent = '图片已选好。请告诉我需要怎样修改，例如「把背景改成蓝色」。'
        return
      }
      if (decision.clearImageContext && state) { state.lastPlan = null; state.lastImageAt = 0 }
      if (pending) pending.settled = true
      input.dispatchEvent(new Event('input', { bubbles: true }))
      const targetAtSubmit = JSON.stringify(mobile.snapshot().target)
      const recorded = await mobile.send(text)
      if (recorded && currentAccountId() === accountId) {
        interactionFeedback.play('send')
        if (state?.lastPlan && imageConversations.get(state.accountId, state.sessionKey) === state) state.userTurnsSinceImage += 1
        if (input.value === text && JSON.stringify(mobile.snapshot().target) === targetAtSubmit) {
          input.value = ''
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
      }
      return
    }
    if (state === null) return
    if (activeImage !== null || imageSession.busy()) { feedback.textContent = t.imageBusy; return }
    if (pending) pending.settled = true
    const source = resolveEditSource(state, decision.plan, composerAttachments)
    if (decision.plan.kind === 'image.edit' && decision.plan.stage === 'confirm' && source === null) {
      feedback.textContent = '请先上传要修改的原图。'
      return
    }
    const selected = takeComposerAttachments()
    const attachments = selected.map(item => ({ url: item.url, name: item.name }))
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const exchange: PendingImageExchange = {
      id: nextExchangeId(), text, plan: decision.plan, at: Date.now(), attachments,
      sources: source === null ? selected : [source],
      phase: decision.plan.stage === 'clarify' ? 'ask' : 'wait', settled: false,
      waitMessage: decision.plan.stage === 'clarify' ? '' : t.imageThinking,
      waitStartedAt: decision.plan.stage === 'clarify' ? 0 : Date.now(),
    }
    state.exchanges.push(exchange)
    interactionFeedback.play('send')
    if (frame) entry?.refresh()
    if (decision.plan.stage === 'confirm') void runImageConfirm(state, exchange)
  } catch (error) {
    if (currentAccountId() === accountId) feedback.textContent = error instanceof ImageGenerationError ? error.message : '这条消息暂时没有发出，请稍后重试。'
  } finally {
    submission.finish()
    syncComposerControls()
  }
}
let waitProgressTimer = 0
function imageWaitLive(): boolean {
  return imageConversations.forAccount(currentAccountId() ?? '').some(state => state.exchanges.some(item => item.phase === 'wait' && !item.settled))
}
function ensureWaitProgressTimer(): void {
  if (!imageWaitLive()) {
    if (waitProgressTimer !== 0) { window.clearInterval(waitProgressTimer); waitProgressTimer = 0 }
    return
  }
  if (waitProgressTimer !== 0) return
  waitProgressTimer = window.setInterval(() => {
    if (!imageWaitLive()) { window.clearInterval(waitProgressTimer); waitProgressTimer = 0; return }
    if (frame) entry?.refresh()
  }, 400)
}
window.addEventListener('pagehide', () => {
  if (waitProgressTimer !== 0) { window.clearInterval(waitProgressTimer); waitProgressTimer = 0 }
})
async function runImageConfirm(state: ImageConversation, exchange: PendingImageExchange): Promise<void> {
  if (!account) { feedback.textContent = t.loginFirst; openAccount(); return }
  if (activeImage !== null || imageSession.busy()) { feedback.textContent = t.imageBusy; return }
  const active = { state, exchange }
  activeImage = active
  exchange.phase = 'wait'
  exchange.waitMessage = t.imageThinking
  exchange.waitStartedAt = exchange.waitStartedAt || Date.now()
  if (frame) entry?.refresh()
  ensureWaitProgressTimer()
  try {
    const prepared = readyImagePlan(exchange.plan)
    const source = resolveEditSource(state, prepared, exchange.sources ?? [])
    const original = source === null ? undefined : await imageSourceDataUri(source)
    if (currentAccountId() !== state.accountId || imageConversations.get(state.accountId, state.sessionKey) !== state
      || exchange.settled) return
    const record = await imageSession.confirm(prepared, (state) => {
      exchange.waitMessage = state.message
      if (frame) entry?.refresh()
    }, original)
    if (currentAccountId() !== state.accountId || imageConversations.get(state.accountId, state.sessionKey) !== state) return
    exchange.phase = 'done'
    exchange.settled = true
    state.lastPlan = prepared
    state.lastImageAt = record.at
    state.userTurnsSinceImage = 0
    if (currentImageConversation() === state) interactionFeedback.play('receive')
    for (const image of record.images) {
      state.images.push({
        id: `${record.id}-${String(state.images.length)}`,
        prompt: record.prompt, dataUri: image.dataUri, mimeType: image.mimeType, at: record.at,
        caption: prepared.kind === 'image.edit' ? '图片已修改' : t.imageDone,
        operation: prepared.kind === 'image.edit' ? 'edit' : 'generate',
        ...(prepared.kind === 'image.edit' && source !== null ? { editSource: source } : {}),
      })
    }
    persistAlbum(state)
    if (frame) entry?.refresh()
  } catch (error) {
    exchange.settled = true
    if (error instanceof DOMException && error.name === 'AbortError') {
      exchange.phase = 'cancelled'; exchange.waitMessage = '已停止等待这张图片。'
      if (frame) entry?.refresh()
      return
    }
    exchange.phase = 'failed'
    exchange.waitMessage = error instanceof ImageGenerationError ? error.message : '这一张没画成，稍后再试一次。'
    if (currentImageConversation() === state) feedback.textContent = exchange.waitMessage
    if (frame) entry?.refresh()
  } finally {
    if (activeImage === active) activeImage = null
    ensureWaitProgressTimer()
  }
}
const imageLightbox = document.createElement('dialog')
imageLightbox.className = 'image-lightbox'
imageLightbox.dataset.testid = 'image-lightbox'
function closeImageLightbox(): void {
  if (imageLightbox.open) imageLightbox.close()
}
function openOriginalImage(source: { readonly url: string; readonly name: string }): void {
  const body = element('div', 'image-lightbox-body')
  const head = element('div', 'image-lightbox-head')
  head.append(button(t.close, closeImageLightbox, 'icon-button'))
  const image = document.createElement('img')
  image.src = source.url
  image.alt = source.name
  body.append(head, image)
  imageLightbox.replaceChildren(body)
  if (!imageLightbox.open) imageLightbox.showModal()
}
function redoGeneratedImage(turn: GeneratedImageTurn): void {
  if (activeImage !== null || imageSession.busy()) { feedback.textContent = t.imageBusy; return }
  const state = currentImageConversation()
  if (state === null || !state.images.includes(turn)) return
  if (turn.operation === 'edit' && turn.editSource === undefined) {
    feedback.textContent = '重新修图需要原图，请重新上传；也可以选择「修改这张」继续修改当前结果。'
    return
  }
  const plan = planImageIntent('生成一张图片')
  if (plan === null) return
  const ready: ImageIntentPlan = {
    ...plan, stage: 'confirm' as const, prompt: turn.prompt,
    kind: turn.operation === 'edit' ? 'image.edit' : 'image.generate',
    ...(turn.editSource === undefined ? {} : { source: turn.editSource.ref }),
    draft: { ...plan.draft, intent: turn.operation === 'edit' ? 'edit' : 'create', clarification: null, mode: 'specified' as const },
  }
  const exchange: PendingImageExchange = {
    id: nextExchangeId(), text: t.imageRedo, plan: ready, at: Date.now(), attachments: [],
    sources: turn.editSource === undefined ? [] : [turn.editSource],
    phase: 'wait', settled: false, waitMessage: t.imageThinking, waitStartedAt: Date.now(),
  }
  state.exchanges.push(exchange)
  if (frame) entry?.refresh()
  ensureWaitProgressTimer()
  void runImageConfirm(state, exchange)
}
function openImageLightbox(turn: GeneratedImageTurn): void {
  const body = element('div', 'image-lightbox-body')
  const head = element('div', 'image-lightbox-head')
  const close = button(t.close, closeImageLightbox, 'icon-button')
  close.setAttribute('aria-label', t.close)
  head.append(close)
  const img = document.createElement('img')
  img.src = turn.dataUri
  img.alt = turn.prompt
  const actions = element('div', 'image-lightbox-actions')
  const download = button(t.imageDownload, () => {
    const link = document.createElement('a')
    link.href = turn.dataUri
    const subtype = turn.mimeType.split('/')[1] ?? 'jpeg'
    link.download = `qianshou-${turn.id}.${subtype}`
    link.rel = 'noopener'
    document.body.append(link)
    link.click()
    link.remove()
  })
  const redo = button(t.imageRedo, () => {
    closeImageLightbox()
    redoGeneratedImage(turn)
  })
  const edit = button('修改这张', () => {
    const state = currentImageConversation()
    if (state === null || !state.images.includes(turn)) return
    for (const item of takeComposerAttachments()) if (item.url.startsWith('blob:')) URL.revokeObjectURL(item.url)
    const source = resultImageSource(turn)
    composerAttachments.push({ ...source, id: turn.id })
    attachmentOwner = state
    paintComposerAttachments()
    closeImageLightbox()
    setInput('')
    feedback.textContent = '想怎么修改？直接告诉我。'
  })
  actions.append(download, edit, redo)
  body.append(head, img, actions)
  imageLightbox.replaceChildren(body)
  if (typeof imageLightbox.showModal === 'function') imageLightbox.showModal()
  else imageLightbox.setAttribute('open', '')
}
imageLightbox.addEventListener('cancel', (event) => { event.preventDefault(); closeImageLightbox() })
app.append(imageLightbox)
let composerSend: HTMLButtonElement | null = null
let composerInput: HTMLTextAreaElement | null = null
function syncComposerControls(): void {
  if (composerInput === null || composerSend === null) return
  const hasText = composerInput.value.trim().length > 0 || composerAttachments.length > 0
  composerSend.hidden = !hasText
  composerSend.setAttribute('aria-hidden', String(!hasText))
  composerSend.disabled = composerSubmitting()
}
const viewFailures = new Set<MobileViewSection>()
const viewNotice = element('div', 'feedback')
viewNotice.setAttribute('role', 'status')
viewNotice.dataset.testid = 'mobile-view-notice'
bottom.insertBefore(viewNotice, composer)
function reportViewFailure(section: MobileViewSection, failed: boolean): void {
  if (failed) viewFailures.add(section)
  else viewFailures.delete(section)
  viewNotice.textContent = [...viewFailures].map(item => t.viewFailure[item]).join(' ')
}
let soundedTarget = ''
let soundedStatus = ''
let paintedTranscriptKey = ''
let preserveComposerDraftAfterMissing = false
function sameConversation(selected: MobileConversationTarget | null, target: MobileConversationTarget | undefined): boolean {
  if (selected === null || target === undefined || selected.kind !== target.kind) return false
  if (selected.kind === 'pc' && target.kind === 'pc') return selected.binding.pcId === target.binding.pcId && selected.binding.sessionId === target.binding.sessionId
  return selected.binding.sessionId === target.binding.sessionId
}
function markSessionSelection(container: HTMLElement, snapshot: MobileWorkspaceSnapshot | undefined, kind: 'agent' | 'pc'): void {
  const targets = snapshot?.conversations.filter(item => item.kind === kind) ?? []
  const selector = kind === 'agent' ? 'button[data-testid^="mobile-conversation-"]' : 'button[data-testid^="mobile-pc-session-"]'
  const buttons = [...container.querySelectorAll<HTMLButtonElement>(selector)]
  buttons.forEach((item, index) => {
    const on = sameConversation(snapshot?.target ?? null, targets[index])
    item.classList.toggle('is-selected', on)
    if (on) item.setAttribute('aria-current', 'page')
    else item.removeAttribute('aria-current')
  })
}
function paint(next: WindowFrame): void {
  frame = next
  const snapshot = entry?.mobile?.snapshot()
  const nextVoiceTarget = JSON.stringify(snapshot?.target ?? null)
  if (soundedTarget === nextVoiceTarget && soundedStatus === 'running' && snapshot?.status === 'idle'
    && snapshot.turns.at(-1)?.role === 'assistant' && !voiceWasActive) interactionFeedback.play('receive')
  soundedTarget = nextVoiceTarget
  soundedStatus = snapshot?.status ?? ''
  const targetChanged = voiceTarget !== nextVoiceTarget
  if (targetChanged) {
    messageSpeech.stop()
    composerMode?.reset()
    cancelVoiceSend()
    voice.cancel(); closeImageLightbox(); voiceTarget = nextVoiceTarget
    if (attachmentOwner !== null && attachmentOwner !== currentImageConversation()) {
      for (const item of takeComposerAttachments()) if (item.url.startsWith('blob:')) URL.revokeObjectURL(item.url)
      attachmentOwner = null
    }
  }
  const root = materializeMobileFrame(next)
  const take = (id: string): HTMLElement => required(root.querySelector<HTMLElement>(`[data-testid="${id}"]`))
  renderMobileSection('navigation', () => {
    const projectedSidebar = take('mobile-sidebar')
    projectedSidebar.querySelector('[data-testid="mobile-new-agent"]')?.addEventListener('click', () => { setDrawer(false); if (!account) openAccount() })
    for (const choice of projectedSidebar.querySelectorAll<HTMLButtonElement>('button[data-testid]')) {
      const id = choice.dataset.testid ?? ''
      if (id.startsWith('mobile-conversation-') || id.startsWith('mobile-pc-')) choice.addEventListener('click', () => { setDrawer(false) })
    }
    const pcDrawer = required(takeFrom(projectedSidebar, 'mobile-pc-drawer'))
    const pcTitle = required(takeFrom(projectedSidebar, 'mobile-pc-drawer-title'))
    const pcContents = element('div', 'pc-contents')
    for (const child of [...pcDrawer.children]) if (child !== pcTitle) pcContents.append(child)
    const devices = snapshot?.devices ?? []
    decoratePcDirectory(pcContents, devices, snapshot?.directoryState === 'ready')
    const pcToggle = button('', () => {
      pcDrawerOpen = !pcDrawerOpen; pcContents.hidden = !pcDrawerOpen; pcToggle.setAttribute('aria-expanded', String(pcDrawerOpen))
    }, 'pc-toggle')
    const pcStatus = paintPcStatus(snapshot?.directoryState === 'ready' ? devices : [])
    pcToggle.append(pcStatus.status, element('span', 'pc-toggle-title', pcTitle.textContent))
    pcToggle.setAttribute('aria-label', pcOnlineLabel(pcTitle.textContent, devices))
    pcToggle.setAttribute('aria-expanded', String(pcDrawerOpen)); pcContents.hidden = !pcDrawerOpen
    pcDrawer.replaceChildren(pcToggle, pcContents)
    sidebarContent.replaceChildren(projectedSidebar)
    const pcState = takeFrom(projectedSidebar, 'mobile-pc-directory-state')
    if (!account && pcState) pcState.textContent = t.pcLogin
    main.querySelector('[data-testid="mobile-session-strip"]')?.remove()
    markSessionSelection(projectedSidebar, snapshot, 'agent')
    markSessionSelection(projectedSidebar, snapshot, 'pc')
  }, reportViewFailure)
  const target = take('mobile-target')
  const status = take('mobile-status')
  if (!entry?.mobile?.snapshot().target) status.textContent = account ? t.disconnected : t.signedOut
  else if (snapshot?.status === 'idle') status.textContent = ''
  const cancel = root.querySelector<HTMLElement>('[data-testid="mobile-cancel-agent"]')
  context.replaceChildren(target, status, ...(cancel ? [cancel] : []))
  main.classList.toggle('is-pc-session', snapshot?.target?.kind === 'pc')
  if (snapshot?.target?.kind === 'pc') context.append(element('span', 'pc-session-origin', t.pcSessionOrigin))
  const wasNearBottom = content.scrollHeight - content.scrollTop - content.clientHeight <= 96
  const imageState = currentImageConversation()
  const transcriptKey = JSON.stringify([
    snapshot?.target, snapshot?.status, snapshot?.draft,
    (snapshot?.turns ?? []).map(turn => [turn.id, turn.role, turn.text, turn.at]),
    imageState?.notices.map(notice => notice.id),
    imageState?.exchanges.map(exchange => [exchange.id, exchange.phase]),
    imageState?.images.map(image => image.id),
  ])
  const transcriptUnchanged = transcriptKey === paintedTranscriptKey && transcript.childElementCount > 0
  if (!transcriptUnchanged) {
    paintedTranscriptKey = transcriptKey
    renderMobileSection('transcript', () => {
      const streaming = snapshot?.status === 'running'
      const turns = take('mobile-transcript'); const admissions = take('mobile-admissions')
      // Render each authoritative stream snapshot immediately; do not replay it
      // through a second typewriter that delays content already received.
      decorateMessages(turns, snapshot?.turns ?? [], { streaming })
      for (const notice of currentImageConversation()?.notices ?? []) {
        const pair = element('section', 'capability-unavailable')
        pair.dataset.at = String(notice.at)
        pair.dataset.testid = `capability-unavailable-${notice.id}`
        pair.append(element('p', 'capability-request', notice.text), element('p', 'capability-explanation', notice.reply))
        const later = [...turns.children].find(node => Number((node as HTMLElement).dataset.at) > notice.at)
        turns.insertBefore(pair, later ?? null)
      }
      appendLocalConversation(turns, currentImageConversation()?.exchanges ?? [], currentImageConversation()?.images ?? [], {
        onImageReady: () => { followLatest() },
        onOpenImage: openImageLightbox,
        onOpenAttachment: openOriginalImage,
      })
      const requestDraft = root.querySelector<HTMLElement>('[data-testid="mobile-request-draft"]')
      const activity = root.querySelector<HTMLElement>('[data-testid="mobile-activity"]') ?? element('div')
      activity.dataset.testid = 'mobile-activity'
      transcript.replaceChildren(turns, activity, ...(requestDraft ? [requestDraft] : []), admissions)
    }, reportViewFailure)
  }
  // Opening the product is already the conversation surface. The capability
  // shortcuts live in the focused composer instead of a marketing landing view.
  hero.hidden = true
  const projectedInput = take('mobile-input') as HTMLTextAreaElement
  const priorInput = composer.querySelector('textarea')
  const input = priorInput ?? projectedInput
  // The entry callbacks resolve the current conversation at invocation time. Keep the
  // DOM editor mounted during background refreshes so IME composition remains intact.
  const preserveMissingDraft = preserveComposerDraftAfterMissing && snapshot?.target === null
  if ((targetChanged || document.activeElement !== input) && !preserveMissingDraft && input.value !== projectedInput.value) {
    input.value = projectedInput.value
  }
  preserveComposerDraftAfterMissing = false
  if (priorInput === null) {
    input.placeholder = t.inputHint; input.ariaLabel = t.inputHint
    composerInput = input
    const send = take('mobile-send') as HTMLButtonElement
    send.textContent = '↑'; send.ariaLabel = t.send
    composerSend = send
    input.addEventListener('input', () => {
      if (voiceSendTimer !== undefined) { cancelVoiceSend(); voicePanel.hidden = true }
      resizeInput(input)
      draft.hidden = true
      syncComposerControls()
    })
    input.addEventListener('focus', () => { quickMenu.hidden = false })
    input.addEventListener('blur', () => {
      window.setTimeout(() => { if (!composer.contains(document.activeElement)) quickMenu.hidden = true }, 120)
    })
    send.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      void submitComposer()
    }, true)
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send.click() } })
    const add = button('', () => { composerFile.click() }, 'composer-add')
    add.ariaLabel = t.uploadImage
    add.append(composerIcon('plus'))
    composerToolbar.append(quickMenu, add, voiceButton, keyboardModeButton, send)
    composer.append(input, voicePanel, composerToolbar)
    composerMode = createComposerModeController({
      input: () => composerInput,
      textToggle: voiceButton,
      voiceSurface: voiceHoldSurface,
      keyboardToggle: keyboardModeButton,
      panel: voicePanel,
      onMode: (mode) => {
        composer.dataset.mode = mode
        quickMenu.hidden = mode === 'voice' || document.activeElement !== composerInput
        syncComposerControls()
      },
    })
  }
  const sendButton = composer.querySelector<HTMLButtonElement>('[data-testid="mobile-send"]')
  if (sendButton) {
    sendButton.disabled = composerSubmitting() || (input.value.trim().length === 0 && composerAttachments.length === 0)
    sendButton.setAttribute('aria-busy', String(composerSubmitting()))
    sendButton.title = composerSubmitting() ? '正在发送' : t.send
  }
  const projectedError = root.querySelector('[data-testid="mobile-error"]')?.textContent ?? ''
  if (!(imageSession.busy() && feedback.textContent === t.imageBusy)) feedback.textContent = projectedError
  resizeInput(input); draft.hidden = true; syncComposerControls()
  const stickToLatest = wasNearBottom || !userScrolledAway
  if (stickToLatest) followLatest(true)
  renderMobileSection('account', paintAccountFooter, reportViewFailure)
}
function takeFrom(root: HTMLElement, id: string): HTMLElement | null { return root.querySelector(`[data-testid="${id}"]`) }
function notifyAccount(): void {
  messageSpeech.stop()
  composerMode?.reset()
  cancelVoiceSend()
  const nextAccountId = account === null ? null : String(account.id)
  if (nextAccountId !== imageOwnerAccountId) {
    composerSubmissions.clear()
    for (const state of imageConversations.forAccount(imageOwnerAccountId ?? '')) {
      for (const exchange of state.exchanges) for (const item of exchange.sources ?? []) {
        if (item.url.startsWith('blob:')) URL.revokeObjectURL(item.url)
      }
    }
    imageSession.abort(); imageConversations.clear(); restoredAlbum = null; albumAccountId = null
    closeImageLightbox(); imageLightbox.replaceChildren()
    for (const attachment of takeComposerAttachments()) URL.revokeObjectURL(attachment.url)
    imageOwnerAccountId = nextAccountId
    attachmentOwner = null
  }
  gateShell()
  voice.cancel(); accountDialog.sync()
  paintAccountFooter()
  for (const listener of accountListeners) listener()
  if (frame) entry?.refresh()
  accountCenterButton.textContent = account ? t.accountCenter : t.login
}
const unsubscribeAccount = client.subscribe((state) => { if (state !== 'authenticated') { account = null; notifyAccount() } })
const accountDialog = createAccountDialog({
  client, dialog,
  onOpen: () => { accountPageOpen = true; setDrawer(false); gateShell() },
  onClose: () => { accountPageOpen = false; gateShell(); composer.querySelector('textarea')?.focus() },
  reader: createAccountReader({
    client, accountId: () => account === null ? null : String(account.id),
    fetch: window.fetch.bind(window), origin: window.location.origin, timeoutMs: 15000,
  }),
  commerce: createCommerceReader({
    client, accountId: () => account === null ? null : String(account.id),
    fetch: window.fetch.bind(window), origin: window.location.origin, timeoutMs: 15000,
  }),
  currentAccount: () => account,
  requireAuthentication: () => account === null,
  onAuthenticated: (verified) => {
    account = verified; notifyAccount(); void entry?.mobile?.refreshDevices()
    void restoreAlbum(String(verified.id))
    if (agent?.list) void entry?.mobile?.restoreAgent(); else void entry?.mobile?.openAgent()
  },
  onSignedOut: () => { account = null; notifyAccount(); openAccount() },
  connections: () => [
    { label: t.accountService, value: account ? '已验证登录' : '未登录' },
    { label: t.cloudService, value: entry?.mobile?.snapshot().target?.kind === 'agent' ? '已打开云端会话' : agent ? '已配置' : '未配置' },
    { label: t.pcService, value: entry?.mobile?.snapshot().target?.kind === 'pc' ? '已打开电脑会话' : '尚未连接电脑' },
  ],
  onNotice: (text) => { feedback.textContent = text },
})
function openAccount(tab: AccountPage = 'home'): void { cancelVoiceSend(); welcome.close(); voice.cancel(); accountDialog.open(tab) }
const welcome = createWelcomeScreen({ onLogin: openAccount, onContinue: () => { composer.querySelector('textarea')?.focus() } })
app.append(welcome.element)
const nativeVoice = nativeVoiceBridge()
const voice = nativeVoice ? createNativeVoiceInput(nativeVoice) : createBrowserVoiceInput({ language: 'zh-CN', autoStopOnSilence: false })
let composerMode: ReturnType<typeof createComposerModeController> | null = null
let voiceTarget = ''
let voiceDraft = ''
let voiceShouldInsert = false
let voiceWasActive = false
let voiceCancelling = false
let voiceSendTimer: ReturnType<typeof setTimeout> | undefined
const cancelVoiceSend = (): void => { clearTimeout(voiceSendTimer); voiceSendTimer = undefined }
const voicePanel = element('div', 'composer-voice-panel')
voicePanel.hidden = true
const voiceWave = element('span', 'voice-wave')
voiceWave.setAttribute('aria-hidden', 'true')
for (let bar = 0; bar < 5; bar++) voiceWave.append(element('i'))
const voicePreview = element('span', 'voice-preview', a.voiceHoldHint)
voicePreview.setAttribute('aria-live', 'polite')
const voiceAutoLabel = element('label', 'voice-auto-label')
const voiceAuto = element('input'); voiceAuto.type = 'checkbox'; voiceAuto.checked = interactionPreference('voiceAutoSend')
voiceAuto.addEventListener('change', () => { setInteractionPreference('voiceAutoSend', voiceAuto.checked); if (!voiceAuto.checked) cancelVoiceSend() })
voiceAutoLabel.append(voiceAuto, a.voiceReleaseSend)
const voiceCancel = button('取消', () => { cancelVoiceSend(); voiceShouldInsert = false; voice.cancel(); if (composerMode?.mode() === 'voice') voicePanel.hidden = false }, 'voice-cancel')
voiceWave.hidden = true
voicePreview.hidden = true
voiceAutoLabel.hidden = true
voiceCancel.hidden = true
voicePanel.append(voiceWave, voicePreview, voiceAutoLabel, voiceCancel)
const startComposerVoice = (): void => {
  cancelVoiceSend(); interactionFeedback.play('record')
  voiceDraft = composer.querySelector('textarea')?.value ?? ''
  voiceShouldInsert = true
  const caps = voice.snapshot().capabilities
  void voice.start(caps.native ? { mode: 'native' } : caps.local ? { mode: 'local' } : { mode: 'browser-service', consent: true })
}
const voiceButton = element('button', 'voice-button')
voiceButton.type = 'button'
voiceButton.append(composerIcon('mic'))
voiceButton.ariaLabel = '切换语音输入'
voiceButton.dataset.testid = 'mobile-voice'
const voiceHoldSurface = element('button', 'voice-hold-surface', a.voiceStart)
voiceHoldSurface.type = 'button'
voiceHoldSurface.dataset.testid = 'mobile-voice-hold'
voiceHoldSurface.ariaLabel = a.voiceStart
const keyboardModeButton = element('button', 'voice-keyboard-toggle')
keyboardModeButton.type = 'button'
keyboardModeButton.append(composerIcon('keyboard'))
keyboardModeButton.ariaLabel = '切换文字输入'
keyboardModeButton.dataset.testid = 'mobile-keyboard-mode'
voicePanel.append(voiceHoldSurface)
const releaseHoldToTalk = bindHoldToTalk(voiceHoldSurface, {
  start: startComposerVoice,
  active: () => !['idle', 'error'].includes(voice.snapshot().phase),
  finish: () => { voice.stop() },
  cancel: () => { cancelVoiceSend(); voiceShouldInsert = false; voice.cancel(); if (composerMode?.mode() === 'voice') voicePanel.hidden = false },
  cancelling: (value) => {
    voiceCancelling = value
    voicePanel.classList.toggle('is-cancelling', value)
    voicePreview.textContent = value ? a.voiceCancelHint : a.voiceHoldHint
  },
})
const unsubscribeVoice = voice.subscribe((state) => {
  const active = state.phase !== 'idle' && state.phase !== 'error'
  const completed = voiceWasActive && state.phase === 'idle'
  voiceWasActive = active
  if (composerMode?.mode() === 'voice') voicePanel.hidden = false
  voiceWave.hidden = !active
  voicePreview.hidden = !active
  voiceAutoLabel.hidden = !active
  voiceCancel.hidden = !active
  voicePanel.classList.toggle('is-listening', state.phase === 'listening')
  voiceAuto.checked = interactionPreference('voiceAutoSend')
  voicePreview.textContent = voiceCancelling ? a.voiceCancelHint : [state.finalText, state.interimText].filter(Boolean).join('')
    || (state.phase === 'stopping' ? a.voiceStopping : state.phase === 'checking' || state.phase === 'starting' ? a.voiceStarting : a.voiceHoldHint)
  voiceHoldSurface.setAttribute('aria-pressed', String(active))
  voiceHoldSurface.ariaLabel = active ? a.voiceStop : a.voiceStart
  voiceHoldSurface.textContent = active ? a.voiceActive : a.voiceStart
  if (state.error) feedback.textContent = a.voiceErrors[state.error]
  if (completed && voiceShouldInsert) {
    voiceShouldInsert = false
    if (state.finalText) {
      const current = composer.querySelector('textarea')?.value ?? voiceDraft
      composerMode?.setMode('text')
      setInput([current, state.finalText].filter(Boolean).join(' '))
      feedback.textContent = a.voiceReady
      if (interactionPreference('voiceAutoSend')) {
        const target = voiceTarget
        const text = composer.querySelector('textarea')?.value ?? ''
        feedback.textContent = a.voiceAutoSending
        voiceSendTimer = setTimeout(() => {
          voiceSendTimer = undefined
          if (target === voiceTarget && !composerSubmitting() && document.visibilityState === 'visible'
            && composer.querySelector('textarea')?.value === text) void submitComposer()
        }, 1500)
      }
    }
  }
})
async function boot(): Promise<void> {
  const deviceId = readDeviceId(localStorage, randomUUID)
  imageAlbum = await openImageAlbum(indexedDB)
  const store = await IndexedDbWindowJournalStore.open(indexedDB, 'qianshou-mobile-preview-v1')
  const directory = createAccountPcDirectory({ account: client, now: Date.now, onlineWithinMs: 120_000,
    authorize: authorizePc })
  entry = startWindowEntry({ platform: 'ios', mobile: {
    account: () => account === null ? null : String(account.id),
    subscribeAccount: (listener) => { accountListeners.add(listener); return () => { accountListeners.delete(listener) } },
    deviceId, requestId: () => randomUUID() as import('@deepseek-ai/dsh-api-session-controller/types').SessionRequestId, now: Date.now,
    commandTtlMs: 120_000, foregroundRefreshMs: 500, foregroundRefreshWindowMs: 60_000,
    pcStore: store, directory, ...(agent ? { agent } : {}), locale: 'zh-CN',
    onConversationArchived: (target) => {
      if (target.kind !== 'agent' || target.binding.accountId !== currentAccountId()) return
      const { accountId, sessionId } = target.binding
      composerSubmissions.forget(JSON.stringify([accountId, target]))
      if (activeImage?.state.accountId === accountId && activeImage.state.sessionKey === sessionId) {
        imageSession.abort(); activeImage = null
      }
      if (attachmentOwner?.accountId === accountId && attachmentOwner.sessionKey === sessionId) {
        for (const item of takeComposerAttachments()) if (item.url.startsWith('blob:')) URL.revokeObjectURL(item.url)
        attachmentOwner = null
      }
      const state = imageConversations.forAccount(accountId).find(item => item.sessionKey === sessionId)
      if (state) {
        for (const exchange of state.exchanges) for (const source of exchange.sources ?? []) {
          if (source.url.startsWith('blob:')) URL.revokeObjectURL(source.url)
        }
        state.images.splice(0); state.exchanges.splice(0); state.notices.splice(0)
        state.lastPlan = null; state.lastImageAt = 0
        persistAlbum(state)
      }
      imageConversations.remove(accountId, sessionId)
      closeImageLightbox()
    },
    onConversationMissing: (target) => {
      if (target.kind === 'agent' && target.binding.accountId === currentAccountId()) preserveComposerDraftAfterMissing = true
    },
  } }, paint)
  const visibility = (): void => {
    const visible = document.visibilityState === 'visible'
    if (!visible) { cancelVoiceSend(); voiceShouldInsert = false; voice.cancel(); messageSpeech.stop() }
    entry?.mobile?.setForeground(visible)
    if (visible) void refreshPcDirectory()
  }
  const directoryTimer = window.setInterval(() => { void refreshPcDirectory() }, 30_000)
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('pageshow', (event) => { if (event.persisted) window.location.reload() })
  const dispose = (): void => {
    cancelVoiceSend(); interactionFeedback.close()
    document.removeEventListener('pointerdown', unlockFeedback)
    document.removeEventListener('keydown', unlockFeedback)
    disposeMobileViewportMetrics()
    window.clearInterval(directoryTimer)
    releaseHoldToTalk(); unsubscribeVoice(); voice.dispose(); messageSpeech.stop(); accountDialog.dispose()
    unsubscribeAccount(); entry?.dispose(); store.close()
    imageAlbum?.close()
    document.removeEventListener('visibilitychange', visibility)
  }
  window.addEventListener('pagehide', dispose, { once: true })
  const hot = (import.meta as ImportMeta & { readonly hot?: { readonly dispose: (cleanup: () => void) => void } }).hot
  hot?.dispose(dispose)
  welcome.open()
}
void boot().catch(() => { feedback.textContent = t.storageFailed })
