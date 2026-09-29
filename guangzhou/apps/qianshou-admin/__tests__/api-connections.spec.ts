/** Actual API projection, session, dialog and mounted-view recovery; fixtures grant no live device authority. */
import { createApp, nextTick, type App } from 'vue'
import ElementPlus from 'element-plus'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ApiConnectionsView from '../src/views/ApiConnectionsView.vue'
import { clearSession, loadSession } from '../src/session/store'
import { ENDPOINTS } from '../src/api/endpoints'
import { router, ROUTE_NAMES } from '../src/router'
import { applyApiConnection, checkApiConnection, fetchApiConnection, fetchApiConnections, parseApiConnection,
  parseApiConnectionDetail, parseApiConnectionsList, parseApiConnectionGuide, preflightApiConnection } from '../src/api/modules/api-connections'
import { LOCAL_AI_DEPLOYMENT_GUIDE, NODE_AI_INSTRUCTIONS, OFFICIAL_MEDIA_API_BASE } from '../src/utils/api-connection-guide'
import type { ConnectionDraft } from '../src/api/modules/api-connections'

const DEVICE = '11111111-1111-4111-8111-111111111111'
const NEXT_DEVICE = '22222222-2222-4222-8222-222222222222'
const REF = '33333333-3333-4333-8333-333333333333'
const NEXT_REF = '44444444-4444-4444-8444-444444444444'
const TASK = '55555555-5555-4555-8555-555555555555'
const ATTEMPT = '66666666-6666-4666-8666-666666666666'
const ISO = '2026-09-29T12:00:00.000Z'
const PRIVATE = { deviceToken: 'fixture-private-device-token', upstream: 'http://10.7.8.9:8890',
  providerEndpoint: 'https://private.fixture.invalid', transport: { bearer: 'fixture-private-transport' } }
const node = (deviceId = DEVICE, ownerId = '167') => ({ deviceId, ownerId, online: true,
  authorization: 'active', modes: ['image', 'video'], lastHeartbeatAt: ISO, connectionEpoch: 3,
  activeTasks: 2, totalTasks: 17, settledTasks: 12, ...PRIVATE })
const list = (deviceId = DEVICE, ownerId = '167') => ({ ok: true, nodes: [node(deviceId, ownerId)],
  total: 1, truncated: false, generatedAt: ISO, ...PRIVATE })
const detail = (deviceId = DEVICE, ownerId = '167') => ({ ok: true, node: node(deviceId, ownerId),
  tasks: [{ taskId: TASK, attemptId: ATTEMPT, stage: 'awaiting_settlement', ...PRIVATE, prompt: 'fixture-private-prompt' }],
  audit: [{ ref: REF, action: 'pause', operatorAccountId: ownerId, reason: '虚构设备维护', occurredAt: ISO,
    before: PRIVATE, after: PRIVATE }], ...PRIVATE })
const integration = () => ({ schema: 'qianshou.api-platform-integration.v1', checkedAt: ISO,
  publicBaseUrl: OFFICIAL_MEDIA_API_BASE, probePath: '/v1/nodes/probe', probe: 'reachable',
  deviceChannel: 'configured', metadata: 'configured', exchange: 'unavailable', dispatch: 'unavailable',
  readiness: 'unavailable', code: 'MEDIA_EXCHANGE_UNAVAILABLE', ...PRIVATE })
const guide = () => ({ ok: true, guide: { schema: 'qianshou.external-node-guide.v1', version: '2026-09-29.1',
  publicBaseUrl: OFFICIAL_MEDIA_API_BASE, scope: 'all', routes: [], rules: [],
  markdown: '# 服务器公开协议\n官方地址 https://app.qianshousuanli.com\nPOST /v1/nodes/channel\n未知GPU POST只查原UUID。', ...PRIVATE }, ...PRIVATE })
const localApi = (state: 'pending' | 'confirmed' = 'confirmed') => ({ mode: 'image', adapter: 'qianshou_image', status: 'ready',
  model: { id: 'qwen-image-2.1-int8-convrot', sha256: null, version: '2.1', ...PRIVATE },
  workflow: { id: 'qianshou-qwen-image21-text-to-image', sha256: null, version: null }, observedAt: new Date().toISOString(),
  registration: 'reported', probe: { state, completedAt: state === 'confirmed' ? new Date().toISOString() : null }, ...PRIVATE })
const deviceInfo = () => ({ os: 'win32', osVersion: 'Windows 11', arch: 'x64', deviceName: '图像工作站',
  cpu: 'Intel Core Ultra 9', gpu: 'NVIDIA GeForce RTX 5080', memoryMb: 65536, vramMb: 16384 })

interface Call { readonly path: string; readonly body: Record<string, unknown>; readonly signal: AbortSignal | undefined }
let app: App | undefined
let account = '167'
let canManage = true
let listValue: unknown
let detailValue: unknown
let guideValue: unknown
let delayedList: Promise<Response> | undefined
let delayedDetail: Promise<Response> | undefined
let delayedGuide: Promise<Response> | undefined
let delayedApply: Promise<Response> | undefined
let delayedPreflight: Promise<Response> | undefined
let delayedCheck: Promise<Response> | undefined
let lostApply = false
let recorded = false
const calls: Call[] = []

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => { resolve = finish })
  return { promise, resolve }
}
const count = (path: string) => calls.filter(call => call.path === path).length
// Response.text() is asynchronous too: drain its completion before asserting a late response was discarded.
async function flushResponse(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0)); await nextTick()
}
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.trim() === label)
  if (found === undefined) throw new Error('Missing visible button: ' + label)
  return found
}
async function mount(): Promise<void> {
  await loadSession()
  app = createApp(ApiConnectionsView); app.use(ElementPlus); app.mount('#app')
  await nextTick()
}
async function openPause(): Promise<void> {
  await vi.waitFor(() => expect(document.body.textContent).toContain(DEVICE))
  button('暂停').click()
  await vi.waitFor(() => expect(count(ENDPOINTS.apiConnectionsPreflight)).toBe(1))
  await nextTick()
  const reason = document.querySelector<HTMLTextAreaElement>('textarea')
  if (reason === null) throw new Error('Missing real confirmation reason input')
  reason.value = '虚构维护原因'; reason.dispatchEvent(new Event('input', { bubbles: true })); await nextTick()
  await vi.waitFor(() => expect(button('确认执行').disabled).toBe(false))
}

beforeEach(() => {
  clearSession(); sessionStorage.clear(); calls.length = 0; account = '167'; canManage = true
  listValue = list(); detailValue = detail(); guideValue = guide(); delayedList = undefined; delayedDetail = undefined; delayedGuide = undefined
  delayedApply = undefined; delayedPreflight = undefined; delayedCheck = undefined; lostApply = false; recorded = false
  document.body.innerHTML = '<div id="app"></div>'
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (typeof init?.body !== 'string') throw new Error('Expected explicit JSON body')
    expect(init.method).toBe('POST'); expect(init.credentials).toBe('same-origin')
    const body = JSON.parse(init.body) as Record<string, unknown>
    calls.push({ path, body, signal: init.signal ?? undefined })
    if (path.endsWith('/session/me')) return Response.json({ ok: true,
      admin: { accountId: account, displayName: 'fixture', roleId: 'fixture-admin', roleName: 'fixture',
        roleKind: 'custom', scope: 'all', surface: 'ai-admin' },
      permissions: canManage ? ['apiConnections.read', 'apiConnections.manage'] : ['apiConnections.read'],
      menu: [], readiness: [], clientIp: '' })
    if (path === ENDPOINTS.apiConnectionsList) {
      if (delayedList !== undefined) { const pending = delayedList; delayedList = undefined; return pending }
      return Response.json(listValue)
    }
    if (path === ENDPOINTS.apiConnectionsDetail) {
      if (delayedDetail !== undefined) { const pending = delayedDetail; delayedDetail = undefined; return pending }
      return Response.json(detailValue)
    }
    if (path === ENDPOINTS.apiConnectionsGuide) {
      if (delayedGuide !== undefined) { const pending = delayedGuide; delayedGuide = undefined; return pending }
      return Response.json(guideValue)
    }
    if (path === ENDPOINTS.apiConnectionsPreflight) {
      if (delayedPreflight !== undefined) { const pending = delayedPreflight; delayedPreflight = undefined; return pending }
      return Response.json({ ok: true, confirm: { token: 'fixture-confirm-once', expiresAt: Date.now() + 60_000, diff: {
        before: { deviceId: body.deviceId, authorization: 'active' }, after: { deviceId: body.deviceId, authorization: 'paused' } } } })
    }
    if (path === ENDPOINTS.apiConnectionsApply) {
      if (delayedApply !== undefined) { const pending = delayedApply; delayedApply = undefined; return pending }
      if (lostApply) throw new TypeError('fictional lost response after submission')
      return Response.json({ ok: true, auditId: 'fixture-audit', result: {} })
    }
    if (path === ENDPOINTS.apiConnectionsCheck) {
      if (delayedCheck !== undefined) { const pending = delayedCheck; delayedCheck = undefined; return pending }
      return Response.json({ ok: true, recorded, ref: body.ref, result: PRIVATE })
    }
    throw new Error('Unexpected admin endpoint: ' + path)
  }))
})
afterEach(() => {
  app?.unmount(); app = undefined; clearSession(); sessionStorage.clear()
  document.body.innerHTML = ''; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

it('projects only public fields from list/detail and rejects incomplete task counts instead of inventing zero', () => {
  const parsed = { list: parseApiConnectionsList(list()), detail: parseApiConnectionDetail(detail()) }
  expect(JSON.stringify(parsed)).not.toMatch(/fixture-private|10\.7\.8\.9|private\.fixture|deviceToken|providerEndpoint|prompt|transport/u)
  expect(parsed.list.nodes[0]).toMatchObject({ activeTasks: 2, totalTasks: 17, settledTasks: 12 })
  expect(parsed.detail.tasks).toEqual([{ taskId: TASK, attemptId: ATTEMPT, stage: 'awaiting_settlement' }])
  expect(parseApiConnection(node('media-node:fixture-1')).deviceId).toBe('media-node:fixture-1')
  expect(parseApiConnectionDetail({ ...detail('media-node:fixture-1'), tasks: [{ taskId: 'media-task-1',
    attemptId: 'media-attempt:1', stage: 'running' }] }).tasks).toEqual([{ taskId: 'media-task-1', attemptId: 'media-attempt:1', stage: 'running' }])
  for (const unsafeId of ['10.7.8.9', 'node-10.7.8.9', 'https://device.fixture.invalid', '私有设备']) {
    expect(() => parseApiConnection(node(unsafeId))).toThrow('设备状态不完整')
  }
  for (const field of ['activeTasks', 'totalTasks', 'settledTasks', 'connectionEpoch']) {
    const row: Record<string, unknown> = node(); delete row[field]
    expect(() => parseApiConnection(row)).toThrow('设备状态不完整')
  }
  for (const changed of [{ totalTasks: -1 }, { settledTasks: null }, { activeTasks: '0' }, { modes: ['image', 'image'] }]) {
    expect(() => parseApiConnection({ ...node(), ...changed })).toThrow('设备状态不完整')
  }
})

it('projects account and observed hardware while leaving missing legacy observations unknown', () => {
  expect(parseApiConnection(node())).toMatchObject({ username: null, deviceInfo: null })
  const projected = parseApiConnection({ ...node(), username: '222222', deviceInfo: { ...deviceInfo(), ...PRIVATE } })
  expect(projected).toMatchObject({ username: '222222', deviceInfo: deviceInfo() })
  expect(JSON.stringify(projected)).not.toMatch(/fixture-private|deviceToken|10\.7\.8\.9/u)
  for (const changed of [{ os: ['win32'] }, { arch: ['x64'] }, { memoryMb: '65536' }, { vramMb: -1 },
    { deviceName: 'D:\\private\\token.txt' }, { gpu: 'http://10.7.8.9' }, { cpu: 'Bearer private' }]) {
    expect(() => parseApiConnection({ ...node(), deviceInfo: { ...deviceInfo(), ...changed } })).toThrow('设备状态不完整')
  }
  expect(() => parseApiConnection({ ...node(), username: 'http://private.fixture.invalid' })).toThrow('设备状态不完整')
  expect(parseApiConnection({ ...node(), deviceInfo: { ...deviceInfo(), os: 'darwin', arch: 'arm64', vramMb: null } }).deviceInfo?.vramMb).toBeNull()
})

it('shows account, operating system, hardware and models, with full configuration in details and searchable labels', async () => {
  const observed = { ...node(), username: '222222', deviceInfo: deviceInfo(), localServices: [localApi()] }
  listValue = { ...list(), nodes: [observed] }; detailValue = { ...detail(), node: observed }
  await mount(); await vi.waitFor(() => expect(document.querySelector('.device-table')?.textContent).toContain('222222'))
  const table = document.querySelector('.device-table')!
  expect(table.textContent).toContain('Windows · x64')
  expect(table.textContent).toContain('NVIDIA GeForce RTX 5080 · 内存 64 GB')
  expect(table.textContent).toContain('图像工作站')
  expect(table.textContent).toContain('qwen-image-2.1-int8-convrot')
  const search = document.querySelector<HTMLInputElement>('input[placeholder="搜索账号、设备或模型"]')!
  search.value = '不存在的模型'; search.dispatchEvent(new Event('input', { bubbles: true })); await nextTick()
  expect(table.textContent).not.toContain('图像工作站')
  search.value = '5080'; search.dispatchEvent(new Event('input', { bubbles: true })); await nextTick()
  expect(table.textContent).toContain('图像工作站')
  button('详情').click()
  await vi.waitFor(() => expect(document.body.textContent).toContain('Intel Core Ultra 9'))
  expect(document.body.textContent).toContain('Windows 11')
  expect(document.body.textContent).toContain('16 GB')
  expect(document.body.textContent).toContain('qianshou-qwen-image21-text-to-image')
  expect(document.querySelector('.el-drawer')?.textContent).not.toMatch(/fixture-private|10\.7\.8\.9|Bearer/u)
  expect(count(ENDPOINTS.apiConnectionsApply)).toBe(0)
})

it('keeps absent platform observations unknown and treats configuration separately from formal readiness', () => {
  expect(parseApiConnectionsList(list()).integration).toMatchObject({ checkedAt: null, probe: 'unknown', metadata: 'unknown', readiness: 'unknown' })
  const parsed = parseApiConnectionsList({ ...list(), integration: integration() })
  expect(parsed.integration).toMatchObject({ probe: 'reachable', metadata: 'configured', exchange: 'unavailable', readiness: 'unavailable' })
  expect(JSON.stringify(parsed.integration)).not.toMatch(/fixture-private|deviceToken|10\.7\.8\.9/u)
  for (const changed of [{ metadata: 'ready' }, { deviceChannel: true }, { readiness: 'configured' },
    { publicBaseUrl: 'https://private.fixture.invalid' }, { probePath: '/guess' }, { code: 'Bearer private' }]) {
    expect(() => parseApiConnectionsList({ ...list(), integration: { ...integration(), ...changed } })).toThrow('设备状态不完整')
  }
  expect(parseApiConnectionGuide(guide())).toEqual({ version: '2026-09-29.1', scope: 'all', markdown: guide().guide.markdown })
  for (const changed of [{ publicBaseUrl: 'https://private.fixture.invalid' }, { scope: 'owner' },
    { markdown: 'Bearer fixture-private-device-token' }, { markdown: 'https://private.fixture.invalid' }]) {
    expect(() => parseApiConnectionGuide({ ...guide(), guide: { ...guide().guide, ...changed } })).toThrow('设备状态不完整')
  }
})

it('guides automatic PC registration first and copies/downloads public external instructions without registering or executing', async () => {
  listValue = { ok: true, nodes: [], total: 0, truncated: false, generatedAt: ISO, integration: integration() }
  const writeText = vi.fn<Clipboard['writeText']>().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { userAgent: navigator.userAgent, language: navigator.language, clipboard: { writeText } })
  const downloads: Blob[] = []
  const OriginalURL = URL
  const revoke = vi.fn()
  vi.stubGlobal('URL', class extends OriginalURL {
    static override createObjectURL(blob: Blob | MediaSource): string { downloads.push(blob as Blob); return 'blob:public-guide' }
    static override revokeObjectURL = revoke
  })
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  await mount(); await vi.waitFor(() => expect(document.body.textContent).toContain('尚未收到 PC 的自动登记'))
  const folded = document.querySelector<HTMLDetailsElement>('.external-guide')!
  expect(folded.open).toBe(false)
  expect(document.body.textContent).toContain('客户端自动检测本机模型与 API')
  expect(folded.querySelector('summary')?.textContent).toBe('开发者接入资料（可选）')
  expect(folded.textContent).toContain('普通 PC 用户无需复制提示词或下载协议')
  expect(document.body.textContent).toContain('正式执行尚未开放')
  expect(document.body.textContent).not.toContain('平台门禁已就绪')
  button('复制地址').click(); await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(OFFICIAL_MEDIA_API_BASE))
  folded.open = true; folded.dispatchEvent(new Event('toggle'))
  await vi.waitFor(() => expect(document.body.textContent).toContain('服务器协议版本：2026-09-29.1'))
  button('复制给节点 AI 的说明').click(); await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(`${NODE_AI_INSTRUCTIONS}\n\n服务器公开协议版本：2026-09-29.1\n${guide().guide.markdown}`))
  expect(writeText.mock.calls.flat().join('\n')).not.toMatch(/fixture-private|10\.7\.8\.9|167/u)
  button('下载节点接入协议').click(); expect(download).toHaveBeenCalledTimes(1)
  button('下载本地 AI 部署指引').click(); expect(download).toHaveBeenCalledTimes(2)
  const readBlob = (blob: Blob): Promise<string> => new Promise(resolve => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob)
  })
  expect(await readBlob(downloads[0]!)).toBe(guide().guide.markdown)
  expect(await readBlob(downloads[1]!)).toBe(LOCAL_AI_DEPLOYMENT_GUIDE)
  expect(calls.map(call => call.path)).toEqual([ENDPOINTS.sessionMe, ENDPOINTS.apiConnectionsList, ENDPOINTS.apiConnectionsGuide])
  expect(calls.at(-1)?.body).toEqual({})
  expect(count(ENDPOINTS.apiConnectionsApply)).toBe(0)
})

it('keeps online zero-capability devices visible while detecting local APIs and folds formal configuration separately', async () => {
  listValue = { ...list(), nodes: [{ ...node(), modes: [] }], integration: integration() }
  await mount(); await vi.waitFor(() => expect(document.querySelector('.device-table')?.textContent).toContain('等待设备检测'))
  expect(document.body.textContent).toContain('设备已连接，正在检测本机 API')
  expect(document.body.textContent).not.toContain('设备已连接，正式能力待验证')
  expect(document.body.textContent).not.toContain('不能据此派发新任务')
  const formal = [...document.querySelectorAll<HTMLDetailsElement>('details')].find(el => el.querySelector('summary')?.textContent === '平台配置与正式收费说明')!
  expect(formal.open).toBe(false)
  expect(document.body.textContent).toContain(DEVICE)
  expect(document.body.textContent).not.toContain('声明：图像')
  expect(document.body.textContent).toContain('正式执行尚未开放')
  expect(document.body.textContent).toContain('官方地址可达')
  listValue = { ok: true, nodes: [], total: null }
  button('刷新连接').click()
  await vi.waitFor(() => expect(document.body.textContent).toContain('设备状态不完整'))
  expect(document.body.textContent).not.toContain('官方地址可达')
  expect(document.body.textContent).toContain('正式执行状态待确认')
  expect(document.body.textContent).toContain(DEVICE)
})

it('projects local API roundtrip results separately from paid profiles and expires stale or disconnected confirmation', () => {
  expect(parseApiConnection(node()).localServices).toEqual([])
  const confirmed = localApi()
  const current = parseApiConnection({ ...node(), modes: [], localServices: [confirmed] })
  expect(current.modes).toEqual([])
  expect(current.localServices[0]).toMatchObject({ status: 'ready', registration: 'reported', probe: { state: 'confirmed' } })
  expect(JSON.stringify(current)).not.toMatch(/fixture-private|deviceToken|10\.7\.8\.9|providerEndpoint/u)
  expect(parseApiConnection({ ...node(), localServices: [localApi('pending')] }).localServices[0]?.probe.state).toBe('pending')
  expect(parseApiConnection({ ...node(), online: false, localServices: [confirmed] }).localServices[0])
    .toMatchObject({ status: 'unknown', probe: { state: 'expired' } })
  expect(parseApiConnection({ ...node(), localServices: [{ ...confirmed, probe: { state: 'confirmed', completedAt: new Date(Date.now() - 120001).toISOString() } }] })
    .localServices[0]?.probe.state).toBe('expired')
  for (const bad of [{ adapter: '127.0.0.1' }, { model: { id: '../private', sha256: null, version: null } },
    { workflow: null }, { probe: { state: 'confirmed', completedAt: null } }, { registration: 'qualified' }]) {
    expect(() => parseApiConnection({ ...node(), localServices: [{ ...confirmed, ...bad }] })).toThrow('设备状态不完整')
  }
})

it('shows actual confirmed API metadata on a zero-capability device and withdraws the confirmation after a failed refresh', async () => {
  listValue = { ...list(), nodes: [{ ...node(), modes: [], localServices: [localApi()] }] }
  detailValue = { ...detail(), node: { ...node(), modes: [], localServices: [localApi()] } }
  await mount(); await vi.waitFor(() => expect(document.body.textContent).toContain('广州已确认 API'))
  expect(document.body.textContent).toContain('图像模型 / API')
  expect(document.body.textContent).toContain('视频模型 / API')
  expect(document.body.textContent).toContain('本机 API 可用')
  expect(document.querySelector('.device-table')?.textContent).toContain('qwen-image-2.1-int8-convrot')
  button('详情').click()
  await vi.waitFor(() => expect(document.querySelector('.service-details')?.textContent).toContain('qwen-image-2.1-int8-convrot'))
  expect(document.querySelector('.service-details')?.textContent).toContain('qianshou-qwen-image21-text-to-image')
  expect(document.body.textContent).not.toContain('设备已连接，正式能力待验证')
  expect(document.body.textContent).not.toContain('声明：图像')
  expect(document.body.textContent).toContain('平台配置未提供')
  listValue = { ok: true, nodes: [], total: null }
  button('刷新连接').click()
  await vi.waitFor(() => expect(document.body.textContent).toContain('设备状态不完整'))
  expect(document.body.textContent).not.toContain('广州已确认 API')
  expect(document.body.textContent).toContain('广州 API 确认状态待检测')
  expect(document.body.textContent).toContain(DEVICE)
  expect(count(ENDPOINTS.apiConnectionsApply)).toBe(0)
})

it('keeps an unavailable video API separate from a confirmed image API without suggesting a queued probe', async () => {
  const unavailable = { ...localApi('pending'), mode: 'video', status: 'unavailable', model: null, workflow: null }
  listValue = { ...list(), nodes: [{ ...node(), modes: [], localServices: [localApi(), unavailable] }] }
  await mount()
  await vi.waitFor(() => expect(document.body.textContent).toContain('广州已确认 API'))
  expect(document.querySelector('.device-table')?.textContent).toContain('本机 API 不可用')
  expect(document.querySelector('.device-table')?.textContent).toContain('待本机 API 就绪')
  expect(document.querySelector('.device-table')?.textContent).not.toContain('广州正在确认 API')
  expect(count(ENDPOINTS.apiConnectionsApply)).toBe(0)
})

it('discards an old-account guide response and only enables downloads for the current session document', async () => {
  const delayed = deferred<Response>(); delayedGuide = delayed.promise
  await mount(); await vi.waitFor(() => expect(document.body.textContent).toContain(DEVICE))
  const folded = document.querySelector<HTMLDetailsElement>('.external-guide')!
  folded.open = true; folded.dispatchEvent(new Event('toggle'))
  await vi.waitFor(() => expect(count(ENDPOINTS.apiConnectionsGuide)).toBe(1))
  const original = calls.find(call => call.path === ENDPOINTS.apiConnectionsGuide)!
  account = '168'; listValue = list(NEXT_DEVICE, '168'); await loadSession(); await nextTick()
  await vi.waitFor(() => expect(document.body.textContent).toContain(NEXT_DEVICE))
  expect(original.signal?.aborted).toBe(true)
  delayed.resolve(Response.json({ ...guide(), guide: { ...guide().guide, markdown: '旧账号公开说明' } })); await flushResponse()
  expect(document.body.textContent).not.toContain('旧账号公开说明')
  expect(button('下载节点接入协议').disabled).toBe(true)
  folded.open = true; folded.dispatchEvent(new Event('toggle'))
  await vi.waitFor(() => expect(button('下载节点接入协议').disabled).toBe(false))
  expect(count(ENDPOINTS.apiConnectionsGuide)).toBe(2)
  expect(count(ENDPOINTS.apiConnectionsApply)).toBe(0)
})

it('uses the declared endpoints and exact original reference for preflight, apply and check without forwarding transport secrets', async () => {
  const draft: ConnectionDraft = { deviceId: DEVICE, action: 'pause', ref: REF }
  await fetchApiConnections(); await fetchApiConnection(DEVICE)
  await preflightApiConnection(draft); await applyApiConnection(draft, 'fixture-confirm-once', '  虚构维护原因  ')
  recorded = true; expect(await checkApiConnection(REF)).toEqual({ ref: REF, recorded: true })
  expect(calls.map(call => [call.path, call.body])).toEqual([
    [ENDPOINTS.apiConnectionsList, {}], [ENDPOINTS.apiConnectionsDetail, { deviceId: DEVICE }],
    [ENDPOINTS.apiConnectionsPreflight, draft], [ENDPOINTS.apiConnectionsApply, { ...draft, token: 'fixture-confirm-once', reason: '虚构维护原因' }],
    [ENDPOINTS.apiConnectionsCheck, { ref: REF }],
  ])
  expect(router.resolve('/api-connections').name).toBe(ROUTE_NAMES.apiConnections)
})

it('shows incomplete-count reads as an error without rendering fabricated summary numbers', async () => {
  const row: Record<string, unknown> = node(); delete row.totalTasks
  listValue = { ...list(), nodes: [row] }; await mount()
  await vi.waitFor(() => expect(document.body.textContent).toContain('设备状态不完整'))
  expect(document.querySelector('.api-summary')).toBeNull()
  expect(count(ENDPOINTS.apiConnectionsApply)).toBe(0)
})

it('refreshes and inspects only read endpoints; management permission comes from the actual session', async () => {
  canManage = false; await mount(); await vi.waitFor(() => expect(document.body.textContent).toContain(DEVICE))
  expect(button('暂停').disabled).toBe(true); expect(button('撤销授权').disabled).toBe(true)
  button('刷新连接').click(); await vi.waitFor(() => expect(count(ENDPOINTS.apiConnectionsList)).toBe(2))
  button(DEVICE).click(); await vi.waitFor(() => expect(document.body.textContent).toContain(TASK))
  expect(count(ENDPOINTS.apiConnectionsDetail)).toBe(1)
  expect(calls.every(call => call.path.endsWith('/session/me') || call.path === ENDPOINTS.apiConnectionsList
    || call.path === ENDPOINTS.apiConnectionsDetail)).toBe(true)
  expect(document.body.textContent).not.toMatch(/fixture-private|10\.7\.8\.9|private\.fixture/u)
})

it('preserves an uncertain apply under its original reference and only checks it until Guangzhou records the result', async () => {
  lostApply = true; await mount(); await openPause(); button('确认执行').click()
  await vi.waitFor(() => expect(document.body.textContent).toContain('提交结果尚未确认'))
  const submitted = calls.find(call => call.path === ENDPOINTS.apiConnectionsApply)!
  expect(submitted.body).toMatchObject({ deviceId: DEVICE, action: 'pause', token: 'fixture-confirm-once', reason: '虚构维护原因' })
  const ref = submitted.body.ref
  expect(typeof ref).toBe('string'); expect(ref).toMatch(/^[0-9a-f-]{36}$/u)
  expect(JSON.parse(sessionStorage.getItem('qianshou.admin.api-pending.167')!)).toEqual({ deviceId: DEVICE, action: 'pause', ref })
  expect(button('暂停').disabled).toBe(true)
  button('核查原操作').click(); await vi.waitFor(() => expect(document.body.textContent).toContain('广州尚未确认原操作'))
  button('刷新连接').click(); await vi.waitFor(() => expect(count(ENDPOINTS.apiConnectionsList)).toBe(2))
  expect(count(ENDPOINTS.apiConnectionsApply)).toBe(1); expect(count(ENDPOINTS.apiConnectionsPreflight)).toBe(1)
  recorded = true; button('核查原操作').click()
  await vi.waitFor(() => expect(document.body.textContent).toContain('广州已确认原操作'))
  expect(sessionStorage.getItem('qianshou.admin.api-pending.167')).toBeNull()
  expect(calls.filter(call => call.path === ENDPOINTS.apiConnectionsCheck).map(call => call.body)).toEqual([{ ref }, { ref }])
  expect(count(ENDPOINTS.apiConnectionsApply)).toBe(1)
})

it('restores cold pending operations only for the same account and ignores the old account check receipt', async () => {
  sessionStorage.setItem('qianshou.admin.api-pending.167', JSON.stringify({ deviceId: DEVICE, action: 'pause', ref: REF }))
  sessionStorage.setItem('qianshou.admin.api-pending.168', JSON.stringify({ deviceId: NEXT_DEVICE, action: 'resume', ref: NEXT_REF }))
  await mount(); await vi.waitFor(() => expect(document.body.textContent).toContain(REF))
  expect(document.body.textContent).not.toContain(NEXT_REF); expect(count(ENDPOINTS.apiConnectionsCheck)).toBe(0)
  const pending = deferred<Response>(); delayedCheck = pending.promise; button('核查原操作').click()
  await vi.waitFor(() => expect(count(ENDPOINTS.apiConnectionsCheck)).toBe(1))
  account = '168'; listValue = list(NEXT_DEVICE, '168'); await loadSession(); await nextTick()
  await vi.waitFor(() => expect(document.body.textContent).toContain(NEXT_REF))
  expect(button('核查原操作').disabled).toBe(false)
  const current = deferred<Response>(); delayedCheck = current.promise; button('核查原操作').click()
  await vi.waitFor(() => expect(count(ENDPOINTS.apiConnectionsCheck)).toBe(2))
  pending.resolve(Response.json({ ok: true, recorded: true, ref: REF })); await flushResponse()
  expect(button('核查原操作').disabled).toBe(true)
  button('核查原操作').click(); expect(count(ENDPOINTS.apiConnectionsCheck)).toBe(2)
  expect(document.body.textContent).toContain(NEXT_REF)
  current.resolve(Response.json({ ok: true, recorded: true, ref: NEXT_REF }))
  await vi.waitFor(() => expect(sessionStorage.getItem('qianshou.admin.api-pending.168')).toBeNull())
  expect(document.body.textContent).not.toContain(REF)
  expect(sessionStorage.getItem('qianshou.admin.api-pending.168')).toBeNull()
  expect((JSON.parse(sessionStorage.getItem('qianshou.admin.api-pending.167')!) as ConnectionDraft).ref).toBe(REF)
  expect(calls.filter(call => call.path === ENDPOINTS.apiConnectionsCheck).map(call => call.body)).toEqual([{ ref: REF }, { ref: NEXT_REF }])
  expect(count(ENDPOINTS.apiConnectionsApply)).toBe(0); expect(count(ENDPOINTS.apiConnectionsPreflight)).toBe(0)
})

it('does not let a late previous-account preflight replace the new account confirmation preview', async () => {
  await mount(); await vi.waitFor(() => expect(document.body.textContent).toContain(DEVICE))
  const pending = deferred<Response>(); delayedPreflight = pending.promise; button('暂停').click()
  await vi.waitFor(() => expect(count(ENDPOINTS.apiConnectionsPreflight)).toBe(1))
  account = '168'; listValue = list(NEXT_DEVICE, '168'); await loadSession(); await nextTick()
  await vi.waitFor(() => expect(document.body.textContent).toContain(NEXT_DEVICE)); button('暂停').click()
  await vi.waitFor(() => expect(count(ENDPOINTS.apiConnectionsPreflight)).toBe(2))
  await vi.waitFor(() => expect(document.querySelector('.el-dialog')?.textContent).toContain(NEXT_DEVICE))
  pending.resolve(Response.json({ ok: true, confirm: { token: 'fixture-old-owner-token', expiresAt: Date.now() + 60_000,
    diff: { before: { deviceId: DEVICE, authorization: 'active' }, after: { deviceId: DEVICE, authorization: 'paused' } } } }))
  await flushResponse()
  expect(document.querySelector('.el-dialog')?.textContent).not.toContain(DEVICE)
  expect(document.querySelector('.el-dialog')?.textContent).toContain(NEXT_DEVICE)
  expect(count(ENDPOINTS.apiConnectionsApply)).toBe(0)
})

it('discards a late previous-account list and aborts its read without changing the current account rows', async () => {
  const pending = deferred<Response>(); delayedList = pending.promise; await mount()
  await vi.waitFor(() => expect(count(ENDPOINTS.apiConnectionsList)).toBe(1))
  const old = calls.find(call => call.path === ENDPOINTS.apiConnectionsList)!
  account = '168'; listValue = list(NEXT_DEVICE, '168'); await loadSession(); await nextTick()
  await vi.waitFor(() => expect(document.body.textContent).toContain(NEXT_DEVICE))
  expect(old.signal?.aborted).toBe(true)
  pending.resolve(Response.json(list())); await flushResponse()
  expect(document.body.textContent).not.toContain(DEVICE); expect(document.body.textContent).toContain(NEXT_DEVICE)
  expect(count(ENDPOINTS.apiConnectionsList)).toBe(2); expect(count(ENDPOINTS.apiConnectionsApply)).toBe(0)
})

it('discards previous-account device detail and a late successful apply while retaining the original owner recovery reference', async () => {
  await mount(); await vi.waitFor(() => expect(document.body.textContent).toContain(DEVICE))
  const pendingDetail = deferred<Response>(); delayedDetail = pendingDetail.promise; button(DEVICE).click()
  await vi.waitFor(() => expect(count(ENDPOINTS.apiConnectionsDetail)).toBe(1))
  await openPause(); const pendingApply = deferred<Response>(); delayedApply = pendingApply.promise; button('确认执行').click()
  await vi.waitFor(() => expect(count(ENDPOINTS.apiConnectionsApply)).toBe(1))
  const submitted = calls.find(call => call.path === ENDPOINTS.apiConnectionsApply)!
  account = '168'; listValue = list(NEXT_DEVICE, '168'); await loadSession(); await nextTick()
  await vi.waitFor(() => expect(document.body.textContent).toContain(NEXT_DEVICE))
  expect(calls.find(call => call.path === ENDPOINTS.apiConnectionsDetail)?.signal?.aborted).toBe(true)
  pendingDetail.resolve(Response.json(detail())); pendingApply.resolve(Response.json({ ok: true, auditId: 'old-owner-audit', result: {} }))
  await flushResponse()
  expect(document.body.textContent).not.toContain(TASK); expect(document.body.textContent).not.toContain(DEVICE)
  expect(sessionStorage.getItem('qianshou.admin.api-pending.168')).toBeNull()
  expect((JSON.parse(sessionStorage.getItem('qianshou.admin.api-pending.167')!) as ConnectionDraft).ref).toBe(submitted.body.ref)
  expect(count(ENDPOINTS.apiConnectionsApply)).toBe(1); expect(count(ENDPOINTS.apiConnectionsList)).toBe(2)
})

it('pauses automatic reads while hidden, never overlaps pending reads, and stops polling after unmount', async () => {
  vi.useFakeTimers(); await mount(); await vi.waitFor(() => expect(document.body.textContent).toContain(DEVICE))
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(60_000)
  expect(count(ENDPOINTS.apiConnectionsList)).toBe(1)
  const pending = deferred<Response>(); delayedList = pending.promise
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  document.dispatchEvent(new Event('visibilitychange')); await nextTick()
  expect(count(ENDPOINTS.apiConnectionsList)).toBe(2)
  for (let i = 0; i < 3; i++) document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(60_000); expect(count(ENDPOINTS.apiConnectionsList)).toBe(2)
  const active = calls.filter(call => call.path === ENDPOINTS.apiConnectionsList).at(-1)!
  app?.unmount(); app = undefined; expect(active.signal?.aborted).toBe(true)
  pending.resolve(Response.json(list())); await vi.advanceTimersByTimeAsync(60_000)
  expect(count(ENDPOINTS.apiConnectionsList)).toBe(2)
  expect(count(ENDPOINTS.apiConnectionsApply)).toBe(0); expect(count(ENDPOINTS.apiConnectionsPreflight)).toBe(0)
})
