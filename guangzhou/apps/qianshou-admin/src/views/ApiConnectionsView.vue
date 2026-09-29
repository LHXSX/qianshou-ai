<script setup lang="ts">
/** Guangzhou's device directory, with durable controls through the existing admin confirmation flow. */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { session } from '@/session/store'
import { copyText, formatTime } from '@/utils/format'
import { downloadConnectionGuide, LOCAL_AI_DEPLOYMENT_GUIDE, NODE_AI_INSTRUCTIONS, NODE_CONNECTION_PROTOCOL, OFFICIAL_MEDIA_API_BASE } from '@/utils/api-connection-guide'
import ErrorAlert from '@/components/ErrorAlert.vue'
import ConfirmApplyDialog from '@/components/ConfirmApplyDialog.vue'
import { applyApiConnection, checkApiConnection, fetchApiConnection, fetchApiConnections, fetchApiConnectionGuide, preflightApiConnection, UNKNOWN_API_INTEGRATION } from '@/api/modules/api-connections'
import type { ApiConnection, ApiConnectionDetail, ApiConnectionGuide, ApiConnectionsList, ApiLocalService, ConnectionAction, ConnectionDraft } from '@/api/modules/api-connections'
import type { ApplyResult, ConfirmPreview } from '@/api/types'

const data = ref<ApiConnectionsList>()
const loading = ref(false)
const error = ref<Error>()
const query = ref('')
const filter = ref<'all' | 'online' | 'offline' | 'paused'>('all')
const detail = ref<ApiConnectionDetail>()
const detailOpen = ref(false)
const detailLoading = ref(false)
const detailError = ref<Error>()
const selectedId = ref<string>()
const dialogOpen = ref(false)
const draft = ref<ConnectionDraft>()
const pending = ref<ConnectionDraft>()
const checking = ref(false)
const checkMessage = ref('')
const copyMessage = ref('')
const externalGuideOpen = ref(false)
const guide = ref<ApiConnectionGuide>()
const guideLoading = ref(false)
const guideError = ref<Error>()
let listRequest: AbortController | undefined
let detailRequest: AbortController | undefined
let guideRequest: AbortController | undefined
let timer: ReturnType<typeof setInterval> | undefined
let checkGeneration = 0
const canManage = computed(() => session.permissions.includes('apiConnections.manage'))
const rows = computed(() => (data.value?.nodes ?? []).filter(node => {
  const matches = `${node.deviceId} ${node.ownerId} ${node.username ?? ''} ${node.deviceInfo?.deviceName ?? ''} ${node.deviceInfo?.os ?? ''} ${node.deviceInfo?.gpu ?? ''} ${node.localServices.map(service => service.model?.id ?? '').join(' ')}`
    .toLowerCase().includes(query.value.trim().toLowerCase())
  return matches && (filter.value === 'all' || filter.value === 'online' && node.online
    || filter.value === 'offline' && !node.online || filter.value === 'paused' && node.authorization === 'paused')
}))
const onlineCount = computed(() => data.value?.nodes.filter(node => node.online).length ?? 0)
const integration = computed(() => error.value || loading.value ? UNKNOWN_API_INTEGRATION : data.value?.integration ?? UNKNOWN_API_INTEGRATION)
const configurationTitles = { configured: '已配置，正式收费条件另行核验', unavailable: '尚未配置或不可用', unknown: '平台配置未提供' } as const
const readinessTitles = { ready: '平台门禁已就绪，每台设备仍需资格核验', unavailable: '正式执行尚未开放', unknown: '正式执行状态待确认' } as const
const platformStages = computed(() => [
  { title: '官方探测', status: integration.value.probe === 'reachable' ? '官方地址可达' : integration.value.probe === 'unavailable' ? '当前不可达' : '状态待确认',
    description: '仅验证公网 HTTPS 与挑战响应。', ready: integration.value.probe === 'reachable' },
  { title: '设备连接', status: configurationTitles[integration.value.deviceChannel],
    description: 'PC 自动登记、恢复通道并发送心跳。', ready: false },
  { title: '安装与资格', status: configurationTitles[integration.value.metadata],
    description: '官方安装包与设备资格以签名回执为准。', ready: false },
  { title: '媒体交换', status: configurationTitles[integration.value.exchange],
    description: '素材与成片交付独立于元数据服务。', ready: false },
])
const localServiceTitles = { ready: '本机 API 已上报可用', unavailable: '本机 API 不可用', auth_required: '需要本机授权',
  unsupported: '接口尚未匹配', unknown: '本机 API 状态待检测' } as const
const apiProbeTitles = { pending: '广州正在确认 API', confirmed: '广州已确认 API', failed: '广州 API 确认失败', expired: 'API 确认已过期' } as const
const observationsCurrent = computed(() => !loading.value && !error.value)
const mediaModes = ['image', 'video'] as const
const serviceOf = (node: ApiConnection, mode: 'image' | 'video'): ApiLocalService | undefined => node.localServices.find(service => service.mode === mode)
const osNames = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' } as const
function deviceSystem(node: ApiConnection): string {
  const info = node.deviceInfo
  return info === null ? '操作系统待检测' : `${osNames[info.os]} · ${info.arch}`
}
function memorySize(value: number | null | undefined): string {
  return value == null ? '待检测' : `${value / 1024} GB`
}
function deviceConfiguration(node: ApiConnection): string {
  const info = node.deviceInfo
  if (info === null) return '设备配置待检测'
  return `${info.gpu ?? 'GPU 待检测'} · 内存 ${memorySize(info.memoryMb)}`
}
function serviceTitle(node: ApiConnection, mode: 'image' | 'video'): string {
  if (!observationsCurrent.value) return '状态待刷新'
  const service = serviceOf(node, mode)
  if (!service) return '待检测'
  return service.status === 'ready' ? apiProbeTitles[service.probe.state] : localServiceTitles[service.status]
}
function serviceHint(node: ApiConnection, mode: 'image' | 'video'): string {
  if (!observationsCurrent.value) return '广州 API 确认状态待检测'
  const service = serviceOf(node, mode)
  return service?.status === 'ready' ? '本机 API 可用' : service ? '待本机 API 就绪' : '等待设备检测'
}
const actionTitles = { pause: '暂停接单', resume: '恢复接单', revoke: '撤销设备授权' } as const
const authorizationTitles = { active: '连接已授权', paused: '已暂停', revoked: '已撤销' } as const
const taskTitles: Readonly<Record<string, string>> = { leased: '已派发', accepted: '已接收', downloading_assets: '准备素材', running: '执行中', uploading: '上传结果', awaiting_settlement: '等待结算', completed: '已结算', cancelled: '已取消', failed: '失败' }
const connectionTime = (value: string | null): string => formatTime(value === null ? null : Date.parse(value))
const pendingKey = computed(() => `qianshou.admin.api-pending.${session.admin?.accountId ?? 'none'}`)

async function copyPublicInstructions(kind: 'base' | 'ai'): Promise<void> {
  if (kind === 'ai' && !guide.value) return
  const text = kind === 'base' ? OFFICIAL_MEDIA_API_BASE : `${NODE_AI_INSTRUCTIONS}\n\n服务器公开协议版本：${guide.value!.version}\n${guide.value!.markdown}`
  const copied = await copyText(text)
  copyMessage.value = copied ? kind === 'base' ? '官方接入地址已复制。' : '公开接入说明已复制，未包含任何凭据。'
    : '浏览器未允许复制，请展开下方说明并手动选择文字。'
  if (!copied) externalGuideOpen.value = true
}
async function readGuide(): Promise<void> {
  if (guideLoading.value) return
  const request = new AbortController()
  guideRequest = request
  guideLoading.value = true
  guide.value = undefined
  guideError.value = undefined
  try {
    const result = await fetchApiConnectionGuide(request.signal)
    if (guideRequest === request && !request.signal.aborted) guide.value = result
  } catch (caught) {
    if (!request.signal.aborted) guideError.value = caught instanceof Error ? caught : new Error('服务器协议说明读取失败。')
  } finally { if (guideRequest === request) guideLoading.value = false }
}
function toggleGuide(event: Event): void {
  externalGuideOpen.value = (event.target as HTMLDetailsElement).open
  if (externalGuideOpen.value && !guide.value && !guideLoading.value) void readGuide()
}

function rememberPending(value: ConnectionDraft | undefined): void {
  pending.value = value
  try {
    if (value) sessionStorage.setItem(pendingKey.value, JSON.stringify(value))
    else sessionStorage.removeItem(pendingKey.value)
  } catch { /* The server still retains the operation under its original reference. */ }
}
function restorePending(): void {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingKey.value) ?? 'null') as Partial<ConnectionDraft> | null
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
    if (value && typeof value.ref === 'string' && uuid.test(value.ref) && typeof value.deviceId === 'string'
      && /^[A-Za-z0-9._:-]{1,128}$/u.test(value.deviceId) && !/(?:\d{1,3}\.){3}\d{1,3}/u.test(value.deviceId)
      && (value.action === 'pause' || value.action === 'resume' || value.action === 'revoke')) {
      pending.value = { ref: value.ref, deviceId: value.deviceId, action: value.action }
    }
  } catch { /* An invalid observation is never submitted. */ }
}
async function refresh(): Promise<void> {
  if (loading.value) return
  const request = new AbortController()
  listRequest = request
  loading.value = true
  try {
    const result = await fetchApiConnections(request.signal)
    if (listRequest !== request || request.signal.aborted) return
    data.value = result
    error.value = undefined
  } catch (caught) {
    if (!request.signal.aborted) error.value = caught instanceof Error ? caught : new Error('设备状态读取失败。')
  } finally {
    if (listRequest === request) loading.value = false
  }
}
async function inspect(node: ApiConnection): Promise<void> {
  detailRequest?.abort()
  const request = new AbortController()
  detailRequest = request
  selectedId.value = node.deviceId
  detail.value = undefined
  detailError.value = undefined
  detailOpen.value = true
  detailLoading.value = true
  try {
    const result = await fetchApiConnection(node.deviceId, request.signal)
    if (detailRequest === request && !request.signal.aborted && result.node.deviceId === node.deviceId) detail.value = result
  } catch (caught) {
    if (!request.signal.aborted) detailError.value = caught instanceof Error ? caught : new Error('设备详情读取失败。')
  } finally {
    if (detailRequest === request) detailLoading.value = false
  }
}
function openAction(node: ApiConnection, action: ConnectionAction): void {
  if (!canManage.value || pending.value) return
  draft.value = { deviceId: node.deviceId, action, ref: crypto.randomUUID() }
  dialogOpen.value = true
}
function preview(): Promise<ConfirmPreview> {
  if (!draft.value) return Promise.reject(new Error('请先选择设备。'))
  return preflightApiConnection(draft.value)
}
async function execute(token: string, reason: string): Promise<ApplyResult> {
  const operation = draft.value
  const owner = pendingKey.value
  if (!operation || pending.value) throw new Error('请先核查原操作的结果。')
  rememberPending(operation)
  checkMessage.value = ''
  copyMessage.value = ''
  try {
    const result = await applyApiConnection(operation, token, reason)
    if (pendingKey.value !== owner) throw new Error('管理员会话已切换，请查询当前账号状态。')
    rememberPending(undefined)
    return result
  } catch (caught) {
    if (pendingKey.value === owner) checkMessage.value = '提交结果尚未确认，请核查原操作。'
    throw caught
  }
}
async function checkOriginal(): Promise<void> {
  const operation = pending.value
  const owner = pendingKey.value
  if (!operation || checking.value) return
  const generation = ++checkGeneration
  checking.value = true
  try {
    const result = await checkApiConnection(operation.ref)
    if (generation !== checkGeneration || pendingKey.value !== owner || pending.value?.ref !== operation.ref) return
    if (result.recorded) {
      rememberPending(undefined)
      checkMessage.value = '广州已确认原操作。'
      dialogOpen.value = false
      await refresh()
    } else checkMessage.value = '广州尚未确认原操作，操作号已保留；请稍后继续核查。'
  } catch (caught) {
    if (generation === checkGeneration && pendingKey.value === owner) checkMessage.value = caught instanceof Error ? caught.message : '原操作查询失败，请稍后核查。'
  } finally { if (generation === checkGeneration) checking.value = false }
}
function applied(): void {
  ElMessage.success('设备状态已更新')
  void refresh()
  if (selectedId.value && detail.value) void inspect(detail.value.node)
}
function becameVisible(): void {
  if (document.visibilityState === 'visible') void refresh()
}
watch(() => [session.admin?.accountId, session.admin?.scope, session.permissions.join(',')], () => {
  listRequest?.abort()
  detailRequest?.abort()
  guideRequest?.abort()
  listRequest = undefined
  detailRequest = undefined
  guideRequest = undefined
  guide.value = undefined
  guideLoading.value = false
  guideError.value = undefined
  externalGuideOpen.value = false
  copyMessage.value = ''
  loading.value = false
  data.value = undefined
  error.value = undefined
  detail.value = undefined
  detailOpen.value = false
  dialogOpen.value = false
  draft.value = undefined
  pending.value = undefined
  checkGeneration++
  checking.value = false
  checkMessage.value = ''
  restorePending()
  void refresh()
})
onMounted(() => {
  restorePending()
  void refresh()
  timer = setInterval(becameVisible, 15000)
  document.addEventListener('visibilitychange', becameVisible)
})
onBeforeUnmount(() => {
  checkGeneration++
  if (timer) clearInterval(timer)
  listRequest?.abort()
  detailRequest?.abort()
  guideRequest?.abort()
  document.removeEventListener('visibilitychange', becameVisible)
})
</script>

<template>
  <div class="api-page">
    <header class="api-header">
      <div><h1>API 管理</h1><p>客户端自动检测本机模型与 API，在“算力共享”启用后接入广州。这里查看账号、设备配置、模型与任务状态。</p></div>
      <el-button :loading="loading" @click="refresh">刷新连接</el-button>
    </header>
    <ErrorAlert v-if="error" :error="error" />
    <el-alert v-if="error && data" title="刷新失败，下方保留上次读取的状态。" type="warning" :closable="false" />
    <el-card shadow="never" class="platform-card">
      <div class="platform-head"><div><h2>官方接入地址</h2><p class="hint">客户端主动出站，无需公网 IP 或端口映射。PC 用户无需复制说明、填写 token 或手动配置地址。</p></div><el-button @click="copyPublicInstructions('base')">复制地址</el-button></div>
      <a class="public-base qs-mono" :href="OFFICIAL_MEDIA_API_BASE" target="_blank" rel="noopener noreferrer">{{ OFFICIAL_MEDIA_API_BASE }}</a>
      <p class="hint" role="status">{{ integration.probe === 'reachable' ? '官方地址可达' : integration.probe === 'unavailable' ? '官方地址当前不可达' : '官方地址探测状态待确认' }}。设备是否在线以实际登记与心跳为准。</p>
      <details class="platform-detail"><summary>平台配置与正式收费说明</summary><p class="hint">本机 API 接入与不计费试运行独立于正式收费资格。下方是平台配置投影，缺少配置字段不表示在线设备已断开；连接和探测不会自动产生收费。</p>
      <div class="platform-stages">
        <article v-for="stage in platformStages" :key="stage.title"><h3>{{ stage.title }}</h3><el-tag :type="stage.ready ? 'success' : 'info'" size="small">{{ stage.status }}</el-tag><p>{{ stage.description }}</p></article>
      </div>
      <div class="execution-status" role="status"><strong>{{ readinessTitles[integration.readiness] }}</strong><span>调度授权：{{ configurationTitles[integration.dispatch] }}</span><small>后端检查时间：{{ connectionTime(integration.checkedAt) }}。连接在线与正式接单资格分别核验。</small></div>
      </details>
      <details :open="externalGuideOpen" class="external-guide" @toggle="toggleGuide">
        <summary>开发者接入资料（可选）</summary>
        <p class="hint">普通 PC 用户无需复制提示词或下载协议，确认启用后由客户端自动完成接入。以下资料仅供开发外部节点程序使用；不包含设备密钥或本机上游 token。</p>
        <div class="guide-actions"><el-button :disabled="!guide || guideLoading" @click="copyPublicInstructions('ai')">复制给节点 AI 的说明</el-button><el-button :disabled="!guide || guideLoading" @click="downloadConnectionGuide('protocol', guide?.markdown)">下载节点接入协议</el-button><el-button @click="downloadConnectionGuide('deployment')">下载本地 AI 部署指引</el-button></div>
        <p v-if="guide" class="hint">服务器协议版本：{{ guide.version }}。文档可读取不等于接口已开放。</p><p v-if="guideLoading" class="hint">正在读取服务器协议版本…</p>
        <ErrorAlert v-if="guideError" :error="guideError" /><el-button v-if="guideError" link :loading="guideLoading" @click="readGuide">重新读取协议</el-button>
        <pre class="guide-text">{{ NODE_AI_INSTRUCTIONS }}</pre>
        <details class="protocol-detail"><summary>查看完整协议与本地部署指引</summary><p v-if="!guide" class="hint">下方为本页公开候选说明，服务器协议尚未确认。</p><pre class="guide-text">{{ guide?.markdown ?? NODE_CONNECTION_PROTOCOL }}</pre><pre class="guide-text">{{ LOCAL_AI_DEPLOYMENT_GUIDE }}</pre></details>
      </details>
      <p v-if="copyMessage" class="hint" role="status">{{ copyMessage }}</p>
    </el-card>
    <section v-if="data" class="api-summary">
      <div><span>已登记设备</span><strong>{{ data.total }}</strong></div>
      <div><span>{{ data.truncated ? '本页在线设备' : '在线设备' }}</span><strong>{{ onlineCount }}</strong></div>
      <div class="updated"><span>广州状态更新时间</span><strong>{{ connectionTime(data.generatedAt) }}</strong></div>
    </section>
    <div v-if="pending || checkMessage" class="pending" role="status">
      <div><strong>{{ checkMessage || '有一项设备操作等待核查。' }}</strong><p v-if="pending">操作号：{{ pending.ref }}</p></div>
      <el-button v-if="pending" :loading="checking" @click="checkOriginal">核查原操作</el-button>
    </div>
    <el-card shadow="never">
      <el-alert v-if="data && data.total === 0" title="尚未收到 PC 的自动登记" description="请在千手 PC 的“算力共享”选择图像或视频，点击启用并确认。客户端会自动登记并发送心跳，本页刷新后显示设备和本机 API 的确认状态，无需手填地址或密钥。" type="info" :closable="false" class="empty-connection" />
      <el-alert v-else-if="data?.nodes.some(node => node.online && !node.localServices.some(service => service.probe.state === 'confirmed'))" title="设备已连接，正在检测本机 API" description="广州已收到设备心跳。本机 API 上报与广州确认结果在下表分别显示；免费试运行不以正式收费方案或设备资格为前提，实际调用结果另行核对。" type="info" :closable="false" class="empty-connection" />
      <div class="filters">
        <el-input v-model="query" placeholder="搜索账号、设备或模型" clearable aria-label="搜索设备" />
        <el-select v-model="filter" aria-label="连接状态筛选"><el-option label="全部连接" value="all" /><el-option label="在线" value="online" /><el-option label="离线" value="offline" /><el-option label="已暂停" value="paused" /></el-select>
      </div>
      <el-alert v-if="data?.truncated" title="当前展示前 1000 台设备，请使用后台范围限制或查询设备详情。" type="info" :closable="false" />
      <el-table v-loading="loading" :data="rows" empty-text="尚无匹配的设备连接" class="device-table" @row-click="inspect">
        <el-table-column label="账号 / 设备" min-width="220"><template #default="{ row }"><div class="identity-cell"><strong>{{ row.username ?? '账号名称待同步' }}</strong><small>用户 {{ row.ownerId }}</small><button class="device-link" :title="row.deviceId" @click.stop="inspect(row)">{{ row.deviceInfo?.deviceName ?? row.deviceId }}</button></div></template></el-table-column>
        <el-table-column label="系统 / 配置" min-width="235"><template #default="{ row }"><div class="configuration-cell"><strong>{{ deviceSystem(row) }}</strong><small :title="deviceConfiguration(row)">{{ deviceConfiguration(row) }}</small></div></template></el-table-column>
        <el-table-column label="连接状态" width="120"><template #default="{ row }"><div class="connection-cell"><el-tag :type="row.online ? 'success' : 'info'" size="small">{{ row.online ? '在线' : '离线' }}</el-tag><small>{{ authorizationTitles[row.authorization as keyof typeof authorizationTitles] }}</small></div></template></el-table-column>
        <el-table-column v-for="mode in mediaModes" :key="mode" :label="mode === 'image' ? '图像模型 / API' : '视频模型 / API'" min-width="205"><template #default="{ row }"><div class="api-cell"><strong class="model-name" :title="serviceOf(row, mode)?.model?.id">{{ serviceOf(row, mode)?.model?.id ?? '模型待识别' }}</strong><small :class="{ confirmed: observationsCurrent && serviceOf(row, mode)?.status === 'ready' && serviceOf(row, mode)?.probe.state === 'confirmed' }">{{ serviceTitle(row, mode) }} · {{ serviceHint(row, mode) }}</small></div></template></el-table-column>
        <el-table-column label="最近心跳" width="178"><template #default="{ row }"><time class="heartbeat">{{ row.lastHeartbeatAt ? connectionTime(row.lastHeartbeatAt) : '尚未收到' }}</time></template></el-table-column>
        <el-table-column label="任务" width="130"><template #default="{ row }"><div class="task-cell"><span>进行中 {{ row.activeTasks }}</span><small>任务 {{ row.totalTasks }} · 已结算 {{ row.settledTasks }}</small></div></template></el-table-column>
        <el-table-column label="操作" width="180" fixed="right"><template #default="{ row }"><div class="row-actions">
          <el-button link @click.stop="inspect(row)">详情</el-button>
          <el-button v-if="row.authorization === 'active'" link :disabled="!canManage || !!pending" @click.stop="openAction(row, 'pause')">暂停</el-button>
          <el-button v-if="row.authorization === 'paused'" link :disabled="!canManage || !!pending" @click.stop="openAction(row, 'resume')">恢复</el-button>
          <el-button v-if="row.authorization !== 'revoked'" link type="danger" :disabled="!canManage || !!pending" @click.stop="openAction(row, 'revoke')">撤销授权</el-button>
          <span v-if="row.authorization === 'revoked'">需要设备重新授权</span>
        </div></template></el-table-column>
      </el-table>
      <p class="hint">在线表示广州收到了有效心跳。API 上报不等于广州已确认，广州确认也不等于实际生成已成功；免费试运行与正式收费记录分开。</p>
      <p v-if="!canManage" class="hint">当前账号仅可查看设备状态。</p>
    </el-card>
    <el-drawer v-model="detailOpen" title="设备连接详情" size="min(820px, 94vw)" @closed="detailRequest?.abort()">
      <ErrorAlert v-if="detailError" :error="detailError" />
      <el-skeleton v-if="detailLoading" :rows="6" animated />
      <template v-if="detail">
        <el-descriptions :column="1" border><el-descriptions-item label="登录账号">{{ detail.node.username ?? '账号名称待同步' }} · 用户 {{ detail.node.ownerId }}</el-descriptions-item><el-descriptions-item label="设备名称">{{ detail.node.deviceInfo?.deviceName ?? '设备名称待检测' }}</el-descriptions-item><el-descriptions-item label="设备编号">{{ detail.node.deviceId }}</el-descriptions-item><el-descriptions-item label="连接">{{ detail.node.online ? '在线' : '离线' }}</el-descriptions-item><el-descriptions-item label="授权">{{ authorizationTitles[detail.node.authorization] }}</el-descriptions-item><el-descriptions-item label="连接代次">{{ detail.node.connectionEpoch }}</el-descriptions-item></el-descriptions>
        <h2>设备配置</h2><el-descriptions :column="1" border><el-descriptions-item label="操作系统">{{ deviceSystem(detail.node) }}</el-descriptions-item><el-descriptions-item label="系统版本">{{ detail.node.deviceInfo?.osVersion ?? '待检测' }}</el-descriptions-item><el-descriptions-item label="CPU">{{ detail.node.deviceInfo?.cpu ?? '待检测' }}</el-descriptions-item><el-descriptions-item label="GPU">{{ detail.node.deviceInfo?.gpu ?? '待检测' }}</el-descriptions-item><el-descriptions-item label="内存">{{ memorySize(detail.node.deviceInfo?.memoryMb) }}</el-descriptions-item><el-descriptions-item label="显存">{{ memorySize(detail.node.deviceInfo?.vramMb) }}</el-descriptions-item></el-descriptions>
        <p class="hint">配置由已连接的设备检测并上报；未上报字段显示待检测，不代表没有模型或硬件。</p>
        <h2>本机 API</h2><div class="service-details"><article v-for="mode in mediaModes" :key="mode"><h3>{{ mode === 'image' ? '图像' : '视频' }}</h3><strong>{{ serviceTitle(detail.node, mode) }}</strong><p class="hint">{{ serviceHint(detail.node, mode) }}</p><dl v-if="serviceOf(detail.node, mode)"><dt>模型</dt><dd>{{ serviceOf(detail.node, mode)?.model?.id ?? '尚未识别' }}</dd><dt>工作流</dt><dd>{{ serviceOf(detail.node, mode)?.workflow?.id ?? '尚未识别' }}</dd></dl></article></div>
        <details class="formal-declaration"><summary>正式收费声明</summary><p v-if="!detail.node.modes.length">尚无正式收费能力声明</p><p v-else>声明：{{ detail.node.modes.map((mode: string) => mode === 'image' ? '图像' : '视频').join(' / ') }}</p><p class="hint">档位、设备资格与收费条件独立核验。</p></details>
        <h2>最近任务</h2><el-table :data="detail.tasks" empty-text="尚无任务记录"><el-table-column prop="taskId" label="任务编号" min-width="215" /><el-table-column label="状态" width="120"><template #default="{ row }">{{ taskTitles[row.stage] || '状态待确认' }}</template></el-table-column></el-table>
        <h2>管理记录</h2><div v-if="!detail.audit.length" class="hint">尚无管理记录。</div><article v-for="entry in detail.audit" :key="entry.ref" class="audit-row"><strong>{{ actionTitles[entry.action] }}</strong><span>{{ connectionTime(entry.occurredAt) }} · 管理员 {{ entry.operatorAccountId }}</span><p>{{ entry.reason }}</p></article>
      </template>
    </el-drawer>
    <ConfirmApplyDialog v-model="dialogOpen" :title="draft ? actionTitles[draft.action] : '管理设备'"
      :description="draft?.action === 'revoke' ? '撤销后该设备不能继续建立已授权连接；在途任务按平台原任务状态处理。' : '广州会记录本次操作，并向设备同步接单状态。'"
      :preflight-request="preview" :apply-request="execute" :disabled="!!pending"
      disabled-reason="请先核查原操作结果。" @applied="applied" />
  </div>
</template>

<style scoped>
.api-page { display: grid; gap: 24px; padding: 24px; }
.api-header { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
h1 { font-size: 24px; margin: 0 0 10px; } h2 { font-size: 16px; margin-top: 28px; }
.api-header p, .hint, .owner, .updated, .audit-row span { color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.6; }
.api-header p { margin: 0; }
.api-summary { display: grid; grid-template-columns: 1fr 1fr 2fr; border: 1px solid var(--el-border-color-light); border-radius: 12px; background: var(--el-bg-color); padding: 22px; gap: 24px; }
.api-summary div { display: grid; gap: 9px; }.api-summary span { font-size: 12px; color: var(--el-text-color-secondary); }.api-summary strong { font-size: 26px; }.api-summary .updated strong { font-size: 14px; font-weight: 500; }
.filters { display: flex; gap: 12px; margin-bottom: 20px; }.filters .el-input { max-width: 420px; }.filters .el-select { width: 145px; }
.device-link { display: block; width: 100%; background: transparent; color: var(--el-color-primary); padding: 0; border: 0; font: inherit; font-size: 13px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }.owner { display: block; margin-top: 8px; }
.identity-cell, .configuration-cell { display: grid; justify-items: start; gap: 9px; min-width: 0; }.identity-cell strong, .configuration-cell strong { font-size: 13px; font-weight: 500; }.identity-cell small, .configuration-cell small { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }.configuration-cell small, .model-name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.device-table :deep(td.el-table__cell) { padding: 22px 0; vertical-align: top; }.device-table :deep(th.el-table__cell) { padding: 12px 0 16px; }.device-table :deep(.cell) { padding-inline: 16px; }.connection-cell, .api-cell, .task-cell { display: grid; justify-items: start; gap: 10px; }.connection-cell small, .api-cell small, .task-cell small { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.5; }.api-cell strong { font-size: 13px; font-weight: 500; line-height: 1.5; }.api-cell .confirmed { color: var(--el-color-success); }.heartbeat { white-space: nowrap; font-size: 13px; }.row-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }.row-actions :deep(.el-button + .el-button) { margin-left: 0; }
.service-details { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }.service-details article { padding: 22px; border: 1px solid var(--el-border-color-light); border-radius: 10px; min-width: 0; }.service-details h3 { margin: 0 0 16px; font-size: 15px; }.service-details strong { font-size: 13px; }.service-details dl { display: grid; gap: 8px; padding-top: 16px; border-top: 1px solid var(--el-border-color-light); font-size: 13px; }.service-details dt { color: var(--el-text-color-secondary); }.service-details dd { margin: 0 0 12px; overflow-wrap: anywhere; line-height: 1.7; }
.local-service { margin-block: 8px; overflow-wrap: anywhere; }.local-service strong { font-size: 12px; font-weight: 500; }.formal-declaration { margin-top: 10px; font-size: 12px; }.formal-declaration summary { cursor: pointer; color: var(--el-text-color-secondary); }
.pending { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 16px 20px; background: var(--el-color-warning-light-9); border-radius: 10px; font-size: 13px; }.pending p { margin: 7px 0 0; font-size: 12px; }
.audit-row { display: grid; gap: 7px; padding: 14px 0; border-bottom: 1px solid var(--el-border-color-light); font-size: 13px; }.audit-row p { margin: 0; }
.platform-head { display: flex; justify-content: space-between; align-items: start; gap: 16px; }.platform-head h2 { margin: 0; }.platform-head .hint { margin: 7px 0 14px; }
.public-base { display: inline-block; font-size: 16px; color: var(--el-color-primary); overflow-wrap: anywhere; }
.platform-stages { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; margin-top: 20px; }.platform-stages article { min-width: 0; padding: 14px; background: var(--el-fill-color-lighter); border-radius: 8px; }.platform-stages h3 { font-size: 14px; margin: 0 0 9px; }.platform-stages .el-tag { height: auto; white-space: normal; padding-block: 5px; line-height: 1.4; }.platform-stages p { margin: 10px 0 0; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
.execution-status { display: grid; gap: 8px; margin-top: 18px; font-size: 13px; }.execution-status small { color: var(--el-text-color-secondary); }
.external-guide, .platform-detail { margin-top: 20px; border-top: 1px solid var(--el-border-color-light); padding-top: 16px; }.external-guide summary, .platform-detail summary, .protocol-detail summary { cursor: pointer; font-size: 13px; color: var(--el-text-color-regular); }.guide-actions { display: flex; flex-wrap: wrap; gap: 10px; }.guide-actions .el-button + .el-button { margin-left: 0; }.guide-text { max-height: 420px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 15px; background: var(--el-fill-color-lighter); border: 1px solid var(--el-border-color-light); border-radius: 8px; line-height: 1.7; font-size: 12px; }.empty-connection { margin-bottom: 18px; }
@media (max-width: 900px) { .api-page { padding: 16px; gap: 18px; }.api-summary { grid-template-columns: 1fr 1fr; }.api-summary .updated { grid-column: 1 / -1; }.api-header { align-items: flex-start; }.filters { flex-wrap: wrap; } }
@media (max-width: 1100px) { .platform-stages { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 580px) { .platform-stages, .service-details { grid-template-columns: 1fr; }.platform-head { flex-direction: column; } }
</style>
