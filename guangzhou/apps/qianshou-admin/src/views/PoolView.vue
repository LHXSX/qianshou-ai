<script setup lang="ts">
/**
 * 上游号池（契约 §8.8）。
 *
 * ## 页面要回答的唯一问题
 *
 * **"怎么在不登服务器的前提下往号池里加一个号"** —— 运营贴一枚 Cursor 凭据、
 * 看清这次操作会把池子变成什么样、填一个原因，号池 +1。所以这一页刻意做成
 * 「把危险与后果讲清楚」而不是「让按钮好点」：
 *
 * 1. **列表永不回显明文**（服务端也不回）：只有标签、ref、指纹、身份、状态、时间；
 * 2. 加号走两步确认：第一步 `pool/preflight` 会**真打一次上游**并把差异摆出来，
 *    第二步带令牌 + 原因（≥4 字）执行。`action === 'duplicate'` 时执行按钮**被封住**
 *    （`duplicate` 对服务端也只是"记一条审计、不写盘"）—— 运营的意图已经达成，
 *    让人再贴一次才是折磨；
 * 3. **指纹只从"将要落盘的那把值"算**：会话形态在预览阶段还没有落盘值，服务端用
 *    `fingerprint: null` + `fingerprintSubject: null` + `valueKnown: false` 标注，
 *    界面如实说"指纹要落盘后才产生"，不显示空白、不显示 0、更不拿贴进来那一串顶替；
 * 4. **移除是高危操作**：走同一个两步协议（`op: 'remove'` 分支预览 → `pool/remove`），
 *    撤销按钮与平常按钮**长得不一样**（红色实心 + 独立的危险确认弹窗）；
 * 5. **写操作需要 super-admin**（服务端硬判定）：非 super-admin 看不到写入口，
 *    但**能看见列表与"为什么不能改"** —— 菜单 key `pool` 由服务端 `session/me` 下发，
 *    前端不自己维护菜单表（再加一条同 key 的会让侧栏出现两个入口）。
 *
 * ## 明文纪律
 *
 * 粘贴进来的凭据只活在 `credential` 这一个 ref 里，并且**只在一次请求的 body 里出现**：
 * 不写 localStorage、不进 URL、不进日志、不进错误上报。输入框是 `type=password`。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { formatTime } from '@/utils/format'
import {
  actionLabel,
  applyPoolAdd,
  duplicateBasisLabel,
  fetchPool,
  fingerprintCell,
  preflightPoolAdd,
  preflightPoolRemove,
  probeText,
  shapeLabel,
  shapeMissing,
  statusMeta,
  applyPoolRemove,
} from '@/api/modules/pool'
import type { PoolApplyResult, PoolDiff, PoolKeyRow, PoolPreview } from '@/api/modules/pool'
import type { ConfirmPreview } from '@/api/types'
import { useAsyncData } from '@/utils/async-state'
import { session } from '@/session/store'
import ErrorAlert from '@/components/ErrorAlert.vue'
import ConfirmApplyDialog from '@/components/ConfirmApplyDialog.vue'
import DangerConfirmDialog from '@/components/DangerConfirmDialog.vue'

const state = useAsyncData(fetchPool)

onMounted(() => {
  void state.run()
})

const error = computed(() => state.error.value)
const loading = computed(() => state.loading.value)
const data = computed(() => state.data.value)
const keys = computed<readonly PoolKeyRow[]>(() => state.data.value?.keys ?? [])
/** `fileError` 非空 = 凭据文件读不懂，列表是降级展示（服务端仍然拒绝写入）。 */
const fileError = computed(() => state.data.value?.fileError ?? null)

/**
 * 能不能改：服务端要求「有 `credential.manage` **且** 角色是 `super-admin`」，
 * 两条都在这里如实核对（缺哪条说哪条）。
 *
 * 注意：这只是**隐藏写入口**，不是安全边界 —— 服务端仍会对越权请求回 403 并留痕。
 */
const hasManagePermission = computed(() => session.permissions.includes('credential.manage'))
const isSuperAdmin = computed(() => session.admin?.roleId === 'super-admin')
const canWrite = computed(() => hasManagePermission.value && isSuperAdmin.value)

/** 缺哪一条就写哪一条，别把两种原因混成一句"没权限"。 */
const writeBlockedReason = computed(() => {
  if (canWrite.value) return ''
  if (!hasManagePermission.value && !isSuperAdmin.value) {
    return '不满足两个条件：缺少权限键 credential.manage，且当前角色不是 super-admin。'
  }
  if (!hasManagePermission.value) return '缺少权限键 credential.manage。'
  return `当前角色是「${session.admin?.roleName ?? '未知角色'}」，号池的写操作只有 super-admin 可以执行。`
})

// —— 列表展示：把服务端没给的字段如实标出来，不编 ————————————————————

/** 指纹单元格：`null` 有几种不同成因，收口到 `fingerprintCell()` 里判断。 */
function rowFingerprint(row: PoolKeyRow): string {
  return fingerprintCell({ fingerprint: row.fingerprint }).text
}

function rowFingerprintHint(row: PoolKeyRow): string {
  const cell = fingerprintCell({ fingerprint: row.fingerprint })
  if (!cell.unknown) return ''
  // 列表里的 `null` 与预览阶段不同：服务端会返回 `status`，所以能说清是哪一种。
  return row.status === 'missing'
    ? '这个号只剩元数据，凭据文件里已经没有值了，所以没有指纹。'
    : ''
}

function rowPreviousFingerprint(row: PoolKeyRow): string | null {
  return row.previousFingerprint ?? null
}

function rowStatus(row: PoolKeyRow) {
  return statusMeta(String(row.status))
}

function rowShape(row: PoolKeyRow): string {
  if (shapeMissing(row.shape)) return '（服务端未返回形态）'
  return shapeLabel(row.shape)
}

// —— 加号：两步确认 ——————————————————————————————————————————

const addOpen = ref(false)
const confirmOpen = ref(false)
/** 粘贴进来的凭据：**只在这个 ref 里活着**。 */
const credential = ref('')
const label = ref('')
const addError = ref<Error | undefined>(undefined)
/** 已固定下来的那一份载荷（与即将 apply 的必须完全一致）。 */
const verifiedCredential = ref('')
const verifiedLabel = ref('')
const addDiff = ref<PoolDiff | undefined>(undefined)

/** 抽屉里的"下一步"按钮：只看有没有粘贴东西（真实校验在服务端，别在前端假装校验）。 */
const canPreview = computed(() => credential.value.trim().length > 0)

const addProbe = computed(() => probeText(addDiff.value?.probe ?? null))
/** `duplicate`：这个号已经在池子里了 —— 最容易让人误解"我加了两个号"的地方。 */
const isDuplicate = computed(() => addDiff.value?.action === 'duplicate')
/** `replace`：同一个账号换了一枚新凭据 —— 会把旧的**替换**掉，不是再加一个。 */
const isReplace = computed(() => addDiff.value?.action === 'replace')
/**
 * 能不能真的执行写入。
 *
 * `duplicate` 由服务端在预览里就判出来了（判据写在 `duplicateBasis` 里），
 * 而运营的意图"让这个号在池子里"**已经达成** —— 所以这里不发 `pool/apply`：
 * 那不是"少写一次盘"，是"不要去碰一份不需要改的凭据文件"。
 * 服务端对重复入库本来就只记审计、不写盘（`written: false`），这里只是把同一个
 * 结论提前说清楚，并让运营一眼看到"不会变成两个号"。
 */
const addWritable = computed(() => !isDuplicate.value)
/** `fingerprint: null` 时的渲染：说"落盘后才产生"，不显示空白或 0。 */
const addFingerprint = computed(() => fingerprintCell({
  fingerprint: addDiff.value?.fingerprint,
  fingerprintSubject: addDiff.value?.fingerprintSubject,
  valueKnown: addDiff.value?.valueKnown,
}))

/** 差异里认不出来的动作：如实显示原始值，而不是当成"新增"。 */
const addActionLabel = computed(() => actionLabel(addDiff.value?.action))

/**
 * 第一步：`ConfirmApplyDialog` 在打开时自己调这一步（两步确认的通用协议）。
 *
 * 为什么预检放在弹窗里而不是抽屉里：这样"预览差异 → 填原因 → 执行"与其它页面
 * （功能开关、白名单、RBAC）走的是**同一条**交互链路，也不会出现"预览了两个号"
 * 这种中间状态。代价是差异要等弹窗打开后才拿到，所以 `addWritable` 也是那时才定。
 *
 * **不做任何加工**：粘贴进来的是哪一串就提交哪一串 —— 剥包装是服务端的事，
 * 前端"顺手规范化"会让"预览看到的"和"执行提交的"变成两份值。
 */
function requestAddPreview(): Promise<PoolPreview> {
  return preflightPoolAdd(verifiedCredential.value, verifiedLabel.value)
}

function openAdd(): void {
  credential.value = ''
  label.value = ''
  verifiedCredential.value = ''
  verifiedLabel.value = ''
  addDiff.value = undefined
  addError.value = undefined
  addOpen.value = true
}

/**
 * 第一步在抽屉里做的事：把载荷固定下来，然后打开两步确认弹窗。
 *
 * 真正打上游的那一次 `pool/preflight` 由弹窗发起（同一条通用链路）；
 * 这里只负责"不要再让人改动已经看过的载荷"。
 */
function openAddConfirm(): void {
  if (credential.value.trim().length === 0) {
    ElMessage.warning('请先粘贴 Cursor 凭据')
    return
  }
  addError.value = undefined
  addDiff.value = undefined
  verifiedCredential.value = credential.value
  verifiedLabel.value = label.value.trim()
  addOpen.value = false
  confirmOpen.value = true
}

/**
 * 弹窗拿到预览了：把差异留在这一层。
 *
 * 有了它，`isDuplicate` / `addWritable` / 指纹单元格才是**从服务端的答复算出来的**，
 * 而不是前端猜的："这个号已经在池子里"这句话必须由 `action: 'duplicate'` 支撑。
 *
 * 类型说明：号池的 `diff` **不是** `before → after` 那种通用形状（§8.8 把它定义成
 * 一个带 `action` / `identity` / `probe` 的对象），所以这里做一次有边界的收口转换；
 * 认不出来的字段由 `addDiff` 的展示层逐个"缺什么说什么"。
 * @param preview - 弹窗刚拿到的预览（含令牌与差异）。
 */
function handleAddPreviewed(preview: ConfirmPreview): void {
  addDiff.value = preview.diff as PoolDiff
}

/**
 * 闭包捕获已预览的载荷：弹窗只拿得到 `(token, reason)`，明文不经由通用组件流转。
 *
 * `duplicate` 时按钮由 `:disabled` 封住，函数**仍然照常提供**：执行步骤是"存在"的，
 * 只是这次不需要执行 —— 把它抹成 `undefined` 会让弹窗误报"本操作没有第二步"，
 * 那是把"不需要"说成了"不支持"。
 */
function makeAddApplyRequest(): (token: string, reason: string) => Promise<PoolApplyResult> {
  return applyPoolAdd(verifiedCredential.value, verifiedLabel.value)
}

function handleAddApplied(): void {
  // 无论结果如何都要清掉本地那两份副本；下一步刷新列表由服务端事实说话。
  credential.value = ''
  verifiedCredential.value = ''
  addDiff.value = undefined
  void state.run()
}

function handleAddConfirmClosed(): void {
  credential.value = ''
  verifiedCredential.value = ''
  addDiff.value = undefined
}

// —— 移除：高危，两步确认 ————————————————————————————————————

const removeOpen = ref(false)
const removingRow = ref<PoolKeyRow | undefined>(undefined)

function openRemove(row: PoolKeyRow): void {
  removingRow.value = row
  removeOpen.value = true
}

function requestRemovePreview(): Promise<PoolPreview> {
  const row = removingRow.value
  if (row === undefined) return Promise.reject(new Error('没有选中要移除的号。'))
  return preflightPoolRemove(row.ref)
}

function makeRemoveApplyRequest(): (token: string, reason: string) => Promise<PoolApplyResult> {
  const row = removingRow.value
  if (row === undefined) return async () => { throw new Error('没有选中要移除的号。') }
  return applyPoolRemove(row.ref)
}

function handleRemoveApplied(): void {
  removingRow.value = undefined
  void state.run()
}
</script>

<template>
  <div class="qs-page">
    <div class="qs-page__head">
      <div>
        <h2 class="qs-page__title">上游号池</h2>
        <p class="qs-page__desc">
          贴一枚 Cursor 凭据就能往号池加一个号：<strong>先预览</strong>（服务端会真打一次上游，不会铸新 key）→
          <strong>填原因</strong>（写入审计）→ <strong>执行</strong>。列表里**从不显示明文凭据**，只有指纹、身份与状态。
        </p>
      </div>
      <div class="actions">
        <el-button :loading="loading" @click="state.run">刷新状态</el-button>
        <!-- 写入口在只读角色下**不渲染**（点不通的按钮才是真折磨）；原因由上面的提示条说清。 -->
        <el-button v-if="canWrite" type="primary" @click="openAdd">加号（粘贴 CK）</el-button>
      </div>
    </div>

    <ErrorAlert v-if="error" :error="error" />

    <!-- 只读角色：把"为什么不能改"说清楚，写入口本身不出现（点不通的按钮才是真折磨）。 -->
    <el-alert v-if="!canWrite" type="info" :closable="false" show-icon class="qs-alert"
      title="当前身份只能查看号池，不能修改"
      :description="`${writeBlockedReason} 你可以看到池子里有哪些号、指纹与状态；写入口已隐藏（服务端同样会拒绝越权请求并写入审计）。`" />

    <!-- 凭据文件读不懂：降级展示，但绝不假装"池子是空的"。 -->
    <el-alert v-if="fileError" type="error" :closable="false" show-icon class="qs-alert"
      title="凭据文件当前读不懂，列表是降级展示，且写入会被拒绝"
      :description="`${fileError.code}：${fileError.message}`" />

    <el-card class="qs-card" shadow="never">
      <template #header>
        <div class="card-head">
          <span>号池（{{ keys.length }} 个号）</span>
          <el-tag size="small" type="info">元数据：<span class="qs-mono">{{ data?.metadataPath ?? '—' }}</span></el-tag>
        </div>
      </template>

      <el-table :data="[...keys]" border size="small">
        <el-table-column label="标签 / ref" min-width="240">
          <template #default="{ row }">
            <div>{{ row.label === '' ? '（未起名）' : row.label }}</div>
            <div class="qs-mono sub">{{ row.ref }}</div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="130">
          <template #default="{ row }">
            <el-tooltip :content="rowStatus(row).description" placement="top">
              <el-tag :type="rowStatus(row).tagType" size="small">{{ rowStatus(row).text }}</el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="指纹（sha256 前 8 位）" min-width="160">
          <template #default="{ row }">
            <span class="qs-mono">{{ rowFingerprint(row) }}</span>
            <div v-if="rowPreviousFingerprint(row)" class="sub">
              上次：<span class="qs-mono">{{ rowPreviousFingerprint(row) }}</span>
            </div>
            <div v-if="rowFingerprintHint(row)" class="sub">{{ rowFingerprintHint(row) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="身份（authId / 邮箱）" min-width="220">
          <template #default="{ row }">
            <div class="qs-mono">{{ row.authId ?? '（服务端未返回 authId）' }}</div>
            <div class="sub">{{ row.email ?? '（服务端未返回邮箱）' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="输入形态" min-width="180">
          <template #default="{ row }">{{ rowShape(row) }}</template>
        </el-table-column>
        <el-table-column label="最后验证" min-width="170">
          <template #default="{ row }">{{ formatTime(row.lastVerifiedAt) }}</template>
        </el-table-column>
        <el-table-column label="添加人 / 时间" min-width="190">
          <template #default="{ row }">
            <div class="qs-mono">{{ row.addedBy ?? '（服务端未返回）' }}</div>
            <div class="sub">{{ formatTime(row.addedAt) }}</div>
          </template>
        </el-table-column>
        <el-table-column v-if="canWrite" label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button link type="danger" @click="openRemove(row)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-empty v-if="keys.length === 0 && !loading" description="号池里还没有任何号" />

      <p class="qs-empty-hint">
        指纹是落盘凭据的 sha256 前 8 位 —— 它只能回答「这次的和上次的是不是同一把」，无法反推出凭据本身。
        **服务端在任何响应、日志与审计里都不写明文**，所以这里也没有"查看"按钮。
      </p>
    </el-card>

    <el-card v-if="data" class="qs-card" shadow="never">
      <template #header>
        <div class="card-head">
          <span>生效机制（消费方还没接）</span>
          <el-tag :type="data.activation.restartRequired ? 'warning' : 'info'" size="small">
            {{ data.activation.restartRequired ? '需要重启' : '不声称已生效' }}
          </el-tag>
        </div>
      </template>
      <p class="hint-line">文件层：{{ data.activation.fileWatcher }}</p>
      <p class="hint-line">消费方：{{ data.activation.consumer }}</p>
      <el-alert type="info" :closable="false" show-icon :title="data.activation.note" />
    </el-card>

    <!-- 第一步：粘贴凭据（type=password，不进任何持久位置） -->
    <el-drawer v-model="addOpen" title="加号：粘贴 Cursor 凭据" size="560px">
      <el-alert type="warning" :closable="false" show-icon
        title="号池里的凭据会被拿去给用户发请求"
        description="下一步会先做一次真实探测并把差异摆出来；在池子里已经有这个号时不会重复写入。" />
      <el-form label-position="top" class="key-form">
        <el-form-item label="Cursor 凭据">
          <el-input v-model="credential" type="password" show-password clearable class="qs-mono"
            placeholder="粘贴 Cursor 凭据（三种形态都可以）" autocomplete="off" />
        </el-form-item>
        <el-form-item label="标签（可选，给人看的备注）">
          <el-input v-model="label" maxlength="64" show-word-limit placeholder="例如：客服号-1" />
        </el-form-item>
      </el-form>

      <el-alert type="info" :closable="false" show-icon class="qs-alert"
        title="三种可粘贴的形态（服务端会自己识别；认不出来会明确拒绝并说明理由）"
        description="" />
      <ul class="shapes">
        <li><span class="qs-mono">crsr_…</span>：已经归一化后的 API key（长期有效，落盘的就是它）</li>
        <li><span class="qs-mono">userId::eyJ…</span>：包装过的会话凭据（<span class="qs-mono">::</span> 也可能写成 <span class="qs-mono">%3A%3A</span>）</li>
        <li>裸 JWT：会话凭据本身（写入时会先归一化成一把 <span class="qs-mono">crsr_…</span> 再落盘）</li>
      </ul>

      <p class="qs-empty-hint">
        值只会向服务端发送一次（同源 HTTPS），随后不再回显、不写日志、不进审计、不进 localStorage 与 URL。
        预览阶段服务端**不会**在 Cursor 账号里铸新 key；归一化只发生在执行那一步。
      </p>
      <ErrorAlert v-if="addError" :error="addError" />
      <template #footer>
        <el-button @click="addOpen = false">取消</el-button>
        <el-button type="primary" :disabled="!canPreview" @click="openAddConfirm">
          下一步：预览（真实探测）
        </el-button>
      </template>
    </el-drawer>

    <ConfirmApplyDialog v-model="confirmOpen" title="确认加号（两步确认）"
      description="下面这几个值只从将要落盘的那把凭据算出来 —— 它们就是这次操作的后果。"
      :preflight-request="requestAddPreview" :apply-request="makeAddApplyRequest()"
      :confirm-button-text="addWritable ? '确认写入号池' : '已在池中，无需写入'"
      :disabled="!addWritable"
      :disabled-reason="isDuplicate ? '这个号已经在池子里了：不会重复添加，也不需要再写一次。' : ''"
      @previewed="handleAddPreviewed" @applied="handleAddApplied" @closed="handleAddConfirmClosed">
      <!-- `duplicate` 是最容易让人误解"我加了两个号"的地方：放在最上面、最显眼。 -->
      <el-alert v-if="isDuplicate" type="warning" :closable="false" show-icon class="qs-alert"
        title="这个号已经在池子里了，不会重复添加"
        :description="`判据：${duplicateBasisLabel(addDiff?.duplicateBasis ?? null)}${addDiff?.existingRef ? `；命中的是 ${addDiff.existingRef}` : ''}。
          这里不会调用写入接口 —— 你不需要再贴一次，也不用担心变成两个号。`" />

      <!-- 替换是"同一个账号换了一枚新凭据"：旧的那把会被换掉，这一点必须说出来。 -->
      <el-alert v-else-if="isReplace" type="warning" :closable="false" show-icon class="qs-alert"
        title="这是同一个 Cursor 账号换了一枚新凭据，会把池子里那把替换掉"
        :description="`判据：${duplicateBasisLabel(addDiff?.duplicateBasis ?? null)}${addDiff?.existingRef ? `；命中的是 ${addDiff.existingRef}` : ''}。
          替换之后旧凭据不再被使用（改前指纹见下）。`" />

      <div v-if="addDiff" class="facts">
        <div class="facts__row">
          <span class="facts__key">这次的动作</span>
          <span class="facts__value">{{ addActionLabel }}</span>
        </div>
        <div class="facts__row">
          <span class="facts__key">ref</span>
          <span class="facts__value qs-mono">{{ addDiff.ref }}</span>
        </div>
        <div class="facts__row">
          <span class="facts__key">身份</span>
          <span class="facts__value">
            <span class="qs-mono">{{ addDiff.identity?.authId ?? '（服务端未返回 authId）' }}</span>
            <span class="sub"> / {{ addDiff.identity?.email ?? '（服务端未返回邮箱）' }}</span>
          </span>
        </div>
        <div class="facts__row">
          <span class="facts__key">输入形态</span>
          <span class="facts__value">{{ shapeMissing(addDiff.shape) ? '（服务端未返回形态）' : shapeLabel(addDiff.shape) }}</span>
        </div>
        <div class="facts__row">
          <span class="facts__key">落盘指纹</span>
          <span class="facts__value">
            <span class="qs-mono">{{ addFingerprint.text }}</span>
            <span v-if="addDiff.previousFingerprint" class="sub">（原指纹 {{ addDiff.previousFingerprint }}）</span>
          </span>
        </div>
      </div>

      <el-alert v-if="addFingerprint.hint" type="info" :closable="false" show-icon class="qs-alert"
        title="这枚凭据还没有落盘指纹" :description="addFingerprint.hint" />

      <el-alert v-if="addProbe" :type="addProbe.ok ? 'success' : 'error'" :closable="false" show-icon class="qs-alert"
        :title="addProbe.title" :description="addProbe.detail" />
      <p v-else class="qs-empty-hint">
        预览响应里没有探测结论（服务端未返回或格式不认识）—— 这不代表通过，执行前服务端仍会强制再测一次。
      </p>
    </ConfirmApplyDialog>

    <!-- 移除：红色实心 + 独立弹窗，与平常按钮明显不同 -->
    <DangerConfirmDialog v-model="removeOpen" title="移除号池成员（高危操作）"
      :target="removingRow?.ref ?? ''" confirm-button-text="确认移除"
      :description="removingRow === undefined
        ? ''
        : `这会真的把 ${removingRow.ref} 从凭据文件里删掉，并清掉管理台元数据 —— 只删元数据会留下一个还能被网关取到的凭据，那是最坏的一种&quot;删成功&quot;。没有探测步骤：没有新凭据要验。`"
      :preflight-request="requestRemovePreview" :apply-request="makeRemoveApplyRequest()"
      @applied="handleRemoveApplied" @closed="removingRow = undefined" />
  </div>
</template>

<style scoped>
.actions {
  display: flex;
  gap: 8px;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.qs-alert {
  margin-bottom: 16px;
}

.sub {
  margin-top: 2px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.hint-line {
  margin: 0 0 8px;
  line-height: 1.7;
  color: var(--el-text-color-regular);
}

.key-form {
  margin-top: 16px;
}

.shapes {
  margin: 0 0 8px;
  padding-left: 20px;
  line-height: 1.9;
  color: var(--el-text-color-regular);
}

.facts {
  margin-bottom: 16px;
}

.facts__row {
  display: flex;
  gap: 16px;
  padding: 8px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.facts__key {
  flex: 0 0 96px;
  color: var(--el-text-color-secondary);
}

.facts__value {
  flex: 1;
  word-break: break-all;
}
</style>
