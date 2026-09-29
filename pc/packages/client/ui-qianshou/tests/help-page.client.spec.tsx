// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { HelpPage, type HelpPageProps } from '../src/client/help/HelpPage.tsx'
import { SharingController, createSharingInjection } from '../src/client/help/sharing-controller.ts'
import type { SharingSnapshot } from '../src/client/help/sharing-types.ts'
import type { SharingTransport } from '../src/client/help/sharing-transport.ts'
import { zh } from '../src/client/locales.ts'
import type { SharingModeState, SharingViewState } from '../src/client/help/sharing-types.ts'

afterEach(cleanup)
const scopeId = '10000000-0000-4000-8000-000000000001'
const mode = (name: 'image' | 'video', changes: Partial<SharingModeState> = {}): SharingModeState => ({
  mode: name, phase: 'idle', authorization: { connection: 'required', execution: 'disabled', deviceBound: false }, operationId: null, modelName: null, downloadedBytes: null,
  totalDownloadBytes: null, completedSteps: [], reason: null, completedCalls: null, settledYuan: null, ...changes,
})
function show(view: SharingViewState) {
  const confirmSharing = vi.fn(), cancelSharing = vi.fn()
  const command = vi.fn(), refresh = vi.fn(), openIntake = vi.fn(), openSkills = vi.fn(), openAccount = vi.fn()
  const props: HelpPageProps = { t: key => key in zh ? zh[key as keyof typeof zh] : key,
    useSharing: selector => selector(view), command, confirmSharing, cancelSharing, refresh, openIntake, openSkills, openAccount }
  return { ...render(<HelpPage {...props} />), command, confirmSharing, cancelSharing, refresh, openIntake, openSkills, openAccount }
}
function ready(rows = [mode('image'), mode('video')], authenticated = true): SharingViewState {
  return { phase: 'ready', readFailure: null, busyMode: null, actionFailed: false, confirmation: null, pendingOperation: null, snapshot: {
    schema: 'qianshou.compute-sharing.v1', authenticated, scopeId: authenticated ? scopeId : null, operation: null, hardware: null, modes: rows,
  } }
}
it('offers exactly image and video modes and requests confirmation through the controller', () => {
  const v = show(ready())
  expect(v.getByRole('heading', { name: '算力共享' })).toBeTruthy()
  expect(v.container.querySelectorAll('[data-sharing-mode]')).toHaveLength(2)
  expect(v.getByText(/图像、视频可分别授权闲时共享/)).toBeTruthy()
  fireEvent.click(v.getByRole('button', { name: /启用图像共享/ }))
  expect(v.command).toHaveBeenCalledExactlyOnceWith('image', 'enable')
  expect(v.container.querySelector('input')).toBeNull()
  expect(v.container.textContent).not.toMatch(/https?:\/\/|127\.0\.0\.1|159\.75\./u)
})
it('shows unknown income as unknown and uses only distinct settled receipts', () => {
  const loading = show({ phase: 'loading', readFailure: null, snapshot: null, busyMode: null, actionFailed: false, confirmation: null, pendingOperation: null })
  expect(loading.getAllByText('—')).toHaveLength(2)
  expect(loading.getByRole('button', { name: /启用图像共享/ }).hasAttribute('disabled')).toBe(true)
  cleanup()
  const v = show(ready([mode('image', { completedCalls: 3, settledYuan: '1.2345' }),
    mode('video', { completedCalls: 7, settledYuan: '2.1000' })]))
  expect(v.getByText('10')).toBeTruthy()
  expect(v.getByText('¥ 3.3345')).toBeTruthy()
})
it('shows gateway reachability separately from device authorization and refreshes without enabling sharing', () => {
  const view = ready(undefined, false)
  const v = show({ ...view, snapshot: { ...view.snapshot!, connection: { gateway: 'reachable',
    deviceAuthorization: 'unauthorized', channel: 'idle', heartbeat: 'unknown', checkedAt: 1, heartbeatAt: null } } })
  expect(v.getByText('广州已接通')).toBeTruthy()
  expect(v.getByText(/本机连接尚未授权/)).toBeTruthy()
  fireEvent.click(v.getByRole('button', { name: /重新探测/ }))
  expect(v.refresh).toHaveBeenCalledOnce()
  expect(v.command).not.toHaveBeenCalled()
})
it('never labels an older host snapshot or failed local read as connected', () => {
  const v = show(ready())
  expect(v.getByText('广州连接状态待确认')).toBeTruthy()
  expect(v.queryByText('广州已接通')).toBeNull()
  cleanup()
  const failed = show({ phase: 'unavailable', readFailure: 'host_missing', snapshot: null, busyMode: null, actionFailed: false, confirmation: null, pendingOperation: null })
  expect(failed.getByText('广州连接状态待确认')).toBeTruthy()
  expect(failed.getByText(/Host 缺少共享接口/)).toBeTruthy()
})
it('pauses active sharing, resumes paused sharing, and routes account and history actions', () => {
  const v = show(ready([mode('image', { phase: 'sharing' }), mode('video', { phase: 'paused' })]))
  fireEvent.click(v.getByRole('button', { name: '暂停图像共享' }))
  fireEvent.click(v.getByRole('button', { name: /继续共享/ }))
  expect(v.command.mock.calls).toEqual([['image', 'pause'], ['video', 'resume']])
  expect(v.queryByRole('button', { name: /查看接单记录/ })).toBeNull()
  expect(v.openIntake).not.toHaveBeenCalled()
  cleanup()
  const signedOut = show(ready(undefined, false))
  expect(signedOut.getByRole('button', { name: /启用视频共享/ }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(signedOut.getByRole('button', { name: '登录账号' }))
  expect(signedOut.openAccount).toHaveBeenCalledOnce()
})

const foundLocal: NonNullable<SharingModeState['local']> = { inventory: 'detected', modelCount: 4,
  runtime: 'ready', adapter: 'qianshou_image', adoption: 'verification_required', checkedAt: 1 }
it('preserves actual local discovery when a reviewed sharing configuration is missing', () => {
  const v = show(ready([mode('image', { phase: 'blocked', reason: 'catalog_unavailable', local: foundLocal }), mode('video')]))
  expect(v.getByText('已发现本机模型文件')).toBeTruthy()
  expect(v.getByText('API 与所需模型已核对')).toBeTruthy()
  expect(v.getByText('本机资源已发现，正式共享资格待确认')).toBeTruthy()
  expect(v.getAllByText('通用模型库存')).toHaveLength(2)
  expect(v.getByText(/这不表示本机没有模型/)).toBeTruthy()
  expect(v.queryByText(/首次启用需下载模型/)).toBeNull()
  expect(v.queryByText('共享中')).toBeNull()
  expect(v.command).not.toHaveBeenCalled()
  fireEvent.click(v.getByRole('button', { name: /启用图像共享/ }))
  expect(v.command).toHaveBeenCalledExactlyOnceWith('image', 'enable')
})
it('requires current task authorization and accepted connection before showing sharing as active', () => {
  const view = ready([mode('image', { phase: 'sharing', local: foundLocal }), mode('video')])
  const observed = { gateway: 'reachable' as const, deviceAuthorization: 'unauthorized' as const,
    channel: 'connected' as const, heartbeat: 'unknown' as const, checkedAt: 1, heartbeatAt: null }
  const unverified = show({ ...view, snapshot: { ...view.snapshot!, connection: observed } })
  expect(unverified.getByText('广州已接通')).toBeTruthy()
  expect(unverified.getByText('共享状态待确认')).toBeTruthy()
  expect(unverified.queryByText('共享中')).toBeNull()
  cleanup()
  const accepted = { ...observed, deviceAuthorization: 'authorized' as const, heartbeat: 'accepted' as const, heartbeatAt: 1 }
  const research = show({ ...view, snapshot: { ...view.snapshot!, connection: accepted } })
  expect(research.getByText('API 与所需模型已核对')).toBeTruthy()
  expect(research.getByText(/本机连接已获授权/)).toBeTruthy()
  expect(research.getByText('共享状态待确认')).toBeTruthy()
  expect(research.queryByText('共享中')).toBeNull()
  cleanup()
  const verified = show({ ...view, snapshot: { ...view.snapshot!, modes: [mode('image', {
    phase: 'sharing', authorization: { connection: 'granted', execution: 'idle_only', deviceBound: true }, local: { ...foundLocal, adoption: 'reused' } }), mode('video')],
  connection: accepted } })
  expect(verified.getByText('共享中')).toBeTruthy()
  expect(verified.getByText('已采用本机现有资源')).toBeTruthy()
  cleanup()
  const waiting = show({ ...view, snapshot: { ...view.snapshot!, modes: [mode('image', {
    phase: 'sharing', reason: 'idle_required', authorization: { connection: 'granted', execution: 'idle_only', deviceBound: true },
    local: { ...foundLocal, adoption: 'reused' } }), mode('video')], connection: accepted } })
  expect(waiting.queryByText('共享中')).toBeNull()
  expect(waiting.getByText(/等待电脑确认空闲/)).toBeTruthy()
})
it('shows absent local fields as unknown and withdraws stale service observations after a failed read', () => {
  const older = show(ready())
  expect(older.getAllByText('模型检测状态待确认')).toHaveLength(2)
  expect(older.queryByText('受支持服务的模型库存为空')).toBeNull()
  cleanup()
  const previous = ready([mode('image', { phase: 'sharing', local: foundLocal, completedCalls: 1, settledYuan: '1.0000' }),
    mode('video', { completedCalls: 0, settledYuan: '0.0000' })])
  const failed = show({ ...previous, phase: 'unavailable', snapshot: { ...previous.snapshot!,
    connection: { gateway: 'reachable', deviceAuthorization: 'authorized', channel: 'connected',
      heartbeat: 'accepted', checkedAt: 1, heartbeatAt: 1 } } })
  expect(failed.getAllByText('模型检测状态待确认')).toHaveLength(2)
  expect(failed.queryByText('API 与所需模型已核对')).toBeNull()
  expect(failed.queryByText('广州已接通')).toBeNull()
  expect(failed.queryByText('共享中')).toBeNull()
  expect(failed.queryByText('正在读取状态')).toBeNull()
  expect(failed.getAllByText('检测未完成')).toHaveLength(4)
  expect(failed.getAllByRole('button', { name: /重新检测/ })).toHaveLength(2)
  expect(failed.getByText('¥ 1.0000')).toBeTruthy()
  expect(failed.command).not.toHaveBeenCalled()
})

it('confirms the selected idle mode on this page once and keeps connection-only preparation distinct from sharing', async () => {
  const snapshot = ready().snapshot
  if (snapshot === null) throw new Error('Expected initial scoped receipt')
  let resolve!: (value: SharingSnapshot) => void
  const acknowledgement = new Promise<SharingSnapshot>((yes) => { resolve = yes })
  const command = vi.fn<SharingTransport['command']>(() => acknowledgement)
  const controller = new SharingController({ read: async () => snapshot, command })
  const injection = createSharingInjection(controller, vi.fn(), vi.fn(), vi.fn())
  function Mounted() {
    const state = useSyncExternalStore(listener => controller.store.subscribe(listener), () => controller.store.getSnapshot())
    return <HelpPage t={key => zh[key as keyof typeof zh]} useSharing={selector => selector(state)} {...injection} />
  }
  const v = render(<Mounted />)
  try {
    await act(async () => { await controller.refresh() })
    fireEvent.click(v.getByRole('button', { name: /启用视频共享/ }))
    const dialog = v.getByRole('dialog', { name: '确认视频闲时共享' })
    expect(within(dialog).getByText(/电脑确认空闲/)).toBeTruthy()
    expect(within(dialog).getByText(/已有模型与服务先核验复用/)).toBeTruthy()
    expect(within(dialog).getByText(/订单和收益不保证/)).toBeTruthy()
    expect(command).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '暂不开启' }))
    expect(v.queryByRole('dialog')).toBeNull()
    expect(command).not.toHaveBeenCalled()
    fireEvent.click(v.getByRole('button', { name: /启用图像共享/ }))
    const confirm = within(v.getByRole('dialog', { name: '确认图像闲时共享' })).getByRole('button', { name: '同意并继续' })
    fireEvent.click(confirm); fireEvent.click(confirm)
    expect(command).toHaveBeenCalledOnce()
    const intent = command.mock.calls[0]?.[0]
    if (intent === undefined) throw new Error('Expected scoped consent request')
    expect(intent).toMatchObject({ mode: 'image', action: 'enable', scopeId,
      consent: { connection: true, execution: 'idle_only' } })
    await act(async () => { resolve({ ...snapshot, operation: { requestId: intent.requestId, mode: 'image', action: 'enable', status: 'applied' } }) })
    await waitFor(() =>{  expect(controller.store.getSnapshot().busyMode).toBeNull() })
    expect(v.queryByText('共享中')).toBeNull()
    expect(v.container.textContent).not.toContain('供给设置')
    expect(command).toHaveBeenCalledOnce()
  } finally { controller.dispose() }
})
it('shows legacy local resources while refusing an unscoped grant and hides a stale confirmation after account change', () => {
  const initial = ready([mode('image', { local: foundLocal }), mode('video')])
  const older = show({ ...initial, snapshot: { ...initial.snapshot!, scopeId: null } })
  expect(older.getByText('API 与所需模型已核对')).toBeTruthy()
  expect(older.getByText(/授权接口尚未就绪/)).toBeTruthy()
  expect(older.getByRole('button', { name: /启用图像共享/ }).hasAttribute('disabled')).toBe(true)
  cleanup()
  const confirmation = { mode: 'image' as const, action: 'enable' as const, requestId: '20000000-0000-4000-8000-000000000001', scopeId }
  const nextOwner = show({ ...ready(), confirmation, snapshot: { ...ready().snapshot!,
    scopeId: '10000000-0000-4000-8000-000000000002' } })
  expect(nextOwner.queryByRole('dialog')).toBeNull()
  expect(nextOwner.confirmSharing).not.toHaveBeenCalled()
})

it('explains a missing reviewed sharing plan before the idle gate on an already authorized device', () => {
  const v = show(ready([mode('image', { phase: 'blocked', reason: 'idle_required', local: foundLocal,
    authorization: { connection: 'granted', execution: 'idle_only', deviceBound: true } }), mode('video')]))
  expect(v.getByText(/尚未取得可核验的正式共享方案/)).toBeTruthy()
  expect(v.getByText(/已有模型与 API 保留/)).toBeTruthy()
  expect(v.queryByText(/等待电脑确认空闲后再接新任务/)).toBeNull()
  expect(v.command).not.toHaveBeenCalled()
})

it.each([
  { phase: 'blocked', adoption: 'unmatched' },
  { phase: 'failed', adoption: 'verification_required' },
  { phase: 'idle', adoption: 'verification_required' },
] as const)('continues preparation on an authorized $phase card when local adoption is $adoption', ({ phase, adoption }) => {
  const v = show(ready([mode('image', { phase, local: { ...foundLocal, adoption },
    authorization: { connection: 'granted', execution: 'idle_only', deviceBound: true } }), mode('video')]))
  const card = v.container.querySelector('[data-sharing-mode="image"]')
  if (card === null) throw new Error('Expected image sharing card')
  const buttons = within(card as HTMLElement)
  fireEvent.click(buttons.getByRole('button', { name: /继续启动图像共享/ }))
  expect(v.refresh).not.toHaveBeenCalled()
  expect(v.command).toHaveBeenCalledExactlyOnceWith('image', 'enable')
  expect(v.confirmSharing).not.toHaveBeenCalled()
  expect(v.queryByRole('dialog')).toBeNull()
  expect(buttons.getByRole('button', { name: /撤销本项授权/ })).toBeTruthy()
  expect(v.queryByText('共享中')).toBeNull()
})

it('shows a local trial connection without a reviewed paid plan and keeps absent local video services unavailable', () => {
  const view = ready([mode('image', { phase: 'blocked', reason: 'idle_required', local: foundLocal,
    authorization: { connection: 'granted', execution: 'idle_only', deviceBound: true } }),
  mode('video', { phase: 'blocked', local: { ...foundLocal, runtime: 'unavailable', adapter: null },
    authorization: { connection: 'granted', execution: 'idle_only', deviceBound: true } })])
  const v = show({ ...view, snapshot: { ...view.snapshot!, connection: { gateway: 'reachable', deviceAuthorization: 'authorized',
    channel: 'connected', heartbeat: 'accepted', checkedAt: 1, heartbeatAt: 1 } } })
  const image = v.container.querySelector<HTMLElement>('[data-sharing-mode="image"]')
  const video = v.container.querySelector<HTMLElement>('[data-sharing-mode="video"]')
  if (image === null || video === null) throw new Error('Expected both local API cards')
  expect(within(image).getByText('免费试运行连接就绪')).toBeTruthy()
  expect(within(image).getByText(/本机 API 已就绪、广州已连接/)).toBeTruthy()
  const formal = image.querySelector('details')
  if (formal === null) throw new Error('Expected separate paid sharing details')
  expect(formal.open).toBe(false)
  expect(within(formal).getByText(/尚未取得可核验的正式共享方案/)).toBeTruthy()
  expect(within(video).getAllByText('暂未核对到可用服务')).toHaveLength(2)
  expect(within(video).queryByText('免费试运行连接就绪')).toBeNull()
  expect(within(video).getByText(/受控适配程序的自动生成仍需接入/)).toBeTruthy()
  expect(v.queryByText('共享中')).toBeNull()
  expect(v.command).not.toHaveBeenCalled()
  expect(v.confirmSharing).not.toHaveBeenCalled()
})

it('shows actual API model and workflow labels and confirms Guangzhou only from the fresh roundtrip receipt', () => {
  const api: NonNullable<SharingModeState['api']> = { status: 'ready', adapter: 'qianshou_image',
    modelName: 'Qwen Image 2.1 (INT8 ConvRot)', workflowName: 'Qwen Image 2.1 text-to-image',
    registration: 'registered', probeStatus: 'passed', lastProbedAt: new Date().toISOString() }
  const authorized = { connection: 'granted' as const, execution: 'idle_only' as const, deviceBound: true }
  const view = ready([mode('image', { phase: 'connecting', local: foundLocal, authorization: authorized, api }), mode('video')])
  const snapshot = { ...view.snapshot!, connection: { gateway: 'reachable' as const, deviceAuthorization: 'authorized' as const,
    channel: 'connected' as const, heartbeat: 'accepted' as const, checkedAt: 1, heartbeatAt: 1 } }
  const confirmed = show({ ...view, snapshot })
  expect(confirmed.getByText('广州已确认 API')).toBeTruthy()
  expect(confirmed.getByText('免费试运行连接就绪')).toBeTruthy()
  expect(confirmed.getByText(api.modelName!)).toBeTruthy()
  expect(confirmed.getByText(api.workflowName!)).toBeTruthy()
  fireEvent.click(confirmed.getByRole('button', { name: '暂停图像共享' }))
  expect(confirmed.refresh).not.toHaveBeenCalled()
  expect(confirmed.command).toHaveBeenCalledExactlyOnceWith('image', 'pause')
  expect(confirmed.confirmSharing).not.toHaveBeenCalled()
  cleanup()
  const expired = show({ ...view, snapshot: { ...snapshot, modes: [mode('image', { phase: 'blocked', local: foundLocal,
    authorization: authorized, api: { ...api, lastProbedAt: new Date(Date.now() - 120001).toISOString() } }), mode('video')] } })
  expect(expired.queryByText('广州已确认 API')).toBeNull()
  expect(expired.getAllByText('广州尚未确认 API')).toHaveLength(1)
  expect(expired.getByText('免费试运行连接就绪')).toBeTruthy()
  expect(expired.getByRole('button', { name: /继续启动图像共享/ })).toBeTruthy()
})

it('sends a scoped preparation command from an authorized video button without reopening its consent dialog', async () => {
  const initial = ready([mode('image'), mode('video', { phase: 'blocked', reason: 'runtime_unavailable',
    local: { ...foundLocal, runtime: 'unavailable', adapter: null },
    authorization: { connection: 'granted', execution: 'idle_only', deviceBound: true } })]).snapshot
  if (initial === null) throw new Error('Expected existing video consent')
  let finish!: (value: SharingSnapshot) => void
  const acknowledgement = new Promise<SharingSnapshot>((resolve) => { finish = resolve })
  const transportCommand = vi.fn<SharingTransport['command']>(() => acknowledgement)
  const controller = new SharingController({ read: async () => initial, command: transportCommand })
  const injection = createSharingInjection(controller, vi.fn(), vi.fn(), vi.fn())
  function Mounted() {
    const state = useSyncExternalStore(listener => controller.store.subscribe(listener), () => controller.store.getSnapshot())
    return <HelpPage t={key => zh[key as keyof typeof zh]} useSharing={selector => selector(state)} {...injection} />
  }
  const v = render(<Mounted />)
  try {
    await act(async () => { await controller.refresh() })
    const start = v.getByRole('button', { name: /继续启动视频共享/ })
    fireEvent.click(start); fireEvent.click(start)
    expect(transportCommand).toHaveBeenCalledOnce()
    expect(v.getAllByRole('button', { name: '正在处理…' })).toHaveLength(1)
    expect(v.queryByRole('dialog')).toBeNull()
    const intent = transportCommand.mock.calls[0]?.[0]
    if (intent === undefined) throw new Error('Expected actual video preparation POST')
    expect(intent).toMatchObject({ mode: 'video', action: 'enable', scopeId,
      consent: { connection: true, execution: 'idle_only' } })
    await act(async () => { finish({ ...initial,
      operation: { requestId: intent.requestId, status: 'applied', mode: 'video', action: 'enable' } }) })
    await waitFor(() => expect(controller.store.getSnapshot().pendingOperation).toBeNull())
    expect(transportCommand).toHaveBeenCalledOnce()
  } finally { controller.dispose() }
})

it('shows preparation progress directly on the selected card instead of hiding it in paid setup details', () => {
  const v = show(ready([mode('image'), mode('video', { phase: 'detecting',
    authorization: { connection: 'granted', execution: 'idle_only', deviceBound: true } })]))
  const card = v.container.querySelector<HTMLElement>('[data-sharing-mode="video"]')
  if (card === null) throw new Error('Expected video preparation card')
  expect(within(card).getAllByText(zh.sharingDetecting)).toHaveLength(2)
  expect(within(card).getByRole('status').textContent).toMatch(/正在检测本机模型与工作流/)
  expect(within(card).getByRole('button', { name: '暂停视频共享' })).toBeTruthy()
})

it('waits for an unavailable local API instead of implying a Guangzhou challenge is queued', () => {
  const api: NonNullable<SharingModeState['api']> = { status: 'unavailable', adapter: 'comfyui', modelName: null, workflowName: null,
    registration: 'registered', probeStatus: 'unknown', lastProbedAt: null }
  const v = show(ready([mode('image'), mode('video', { api })]))
  const card = v.container.querySelector('[data-sharing-mode="video"]')!
  expect(within(card as HTMLElement).getByText('待本机 API 就绪')).toBeTruthy()
  expect(within(card as HTMLElement).queryByText('广州 API 确认待刷新')).toBeNull()
  expect(v.command).not.toHaveBeenCalled()
})
