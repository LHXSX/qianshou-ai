<script setup lang="ts">
/**
 * 上游密钥（契约 §9）。
 *
 * 这一页要回答的问题只有一个：**"后期能改吗"** —— 在那之前，换一把上游密钥是
 * 登服务器手改文件 + 重启工作台。现在它是一个受控操作，所以这一页刻意做成
 * 「把危险讲清楚」而不是「让按钮好点」：
 *
 * 1. 列表里**永远不会出现密钥明文**（服务端根本不回），只有指纹、是否已配置、
 *    谁在什么时候改的；
 * 2. 更新走两步确认：第一步会**真打一次上游**，把连通性结论摆在确认按钮之前 ——
 *    免得管理员在按下确认之后才知道密钥是错的；
 * 3. 「需要重启才生效」如实展示，并给出命令。管理台**不代执行重启**
 *    （重启工作台会断开全部在线会话，那是运维决定，不该躲在管理界面里）。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { copyText, formatTime } from '@/utils/format'
import {
  applyUpstreamKey,
  fetchUpstreamKeys,
  preflightUpstreamKey,
  probeOf,
} from '@/api/modules/upstream-keys'
import { useAsyncData } from '@/utils/async-state'
import type { UpstreamKeyRow, UpstreamProbeOutcome } from '@/api/types'
import ErrorAlert from '@/components/ErrorAlert.vue'
import ConfirmApplyDialog from '@/components/ConfirmApplyDialog.vue'

const state = useAsyncData(fetchUpstreamKeys)

onMounted(() => {
  void state.run()
})

const keys = computed<readonly UpstreamKeyRow[]>(() => state.data.value?.keys ?? [])
const activation = computed(() => state.data.value?.activation)
/**
 * 模板里**只读这几个 computed**，不在模板里穿 `state.data.value…`。
 *
 * 原因是踩过的坑：`useAsyncData` 返回的是普通 ref（不是 reactive 对象），
 * Vue 在模板里会自动解包顶层 ref，于是 `state.data` 已经是**数据本身** ——
 * 写 `state.data.value.backups` 会在运行时抛「读不到 undefined 的属性」，
 * 而模板错误在类型检查阶段抓不到，只有真挂载才能发现。
 * 收口成 computed 之后，模板里不再出现 `.value`。
 */
const error = computed(() => state.error.value)
const loading = computed(() => state.loading.value)
const data = computed(() => state.data.value)
const fileExists = computed(() => state.data.value?.fileExists === true)
const fileMode = computed(() => state.data.value?.fileMode ?? null)

/** 凭据文件读不懂时，列表是降级展示 —— 用显眼的告警说明，别让人以为"没有密钥"。 */
const documentErrors = computed(() => keys.value.filter(row => row.documentError !== undefined))

// —— 更新表单 ——————————————————————————————————————————————
const formOpen = ref(false)
/** 正在编辑的引用名。 */
const targetRef = ref('DEEPSEEK_API_KEY')
/** 新密钥值：**只在这个 ref 里活着**，不写 storage、不进 URL、不落日志。 */
const newValue = ref('')
const submitting = ref(false)

/** 只走一次 preflight 的结果（连通性结论）。 */
const probe = ref<UpstreamProbeOutcome | undefined>(undefined)
const preflightError = ref<Error | undefined>(undefined)
const showConfirm = ref(false)
/** 已通过连通性测试的那把值：与即将 apply 的值必须完全一致。 */
const verifiedValue = ref('')

const canSubmit = computed(() => newValue.value.trim().length > 0 && !submitting.value)

function openFor(row: UpstreamKeyRow): void {
  targetRef.value = row.ref
  newValue.value = ''
  probe.value = undefined
  preflightError.value = undefined
  verifiedValue.value = ''
  formOpen.value = true
}

/**
 * 第一步：把值交给服务端做一次真实连通性测试，并拿到确认令牌。
 *
 * **值在这里离开浏览器**（HTTPS + 同源），此后前端不再持有它的任何副本 ——
 * 除了 `verifiedValue` 这一份用于第二步回传（服务端要重算载荷哈希）。
 */
async function runPreflight(): Promise<void> {
  if (newValue.value.trim().length === 0) {
    ElMessage.warning('请先填写新的上游密钥')
    return
  }
  submitting.value = true
  preflightError.value = undefined
  probe.value = undefined
  try {
    // 值不做 trim：密钥里的首尾空白是服务端要拒绝的输入，前端悄悄改掉会让
    // "预览的和提交的不一致"，反而更难排查。
    const preview = await preflightUpstreamKey(targetRef.value, newValue.value)
    probe.value = probeOf(preview.diff as { readonly before: unknown; readonly after: unknown })
    verifiedValue.value = newValue.value
    formOpen.value = false
    showConfirm.value = true
  } catch (error) {
    preflightError.value = error instanceof Error ? error : new Error(String(error))
  } finally {
    submitting.value = false
  }
}

const confirmDescription = computed(() => {
  const base = `更换上游密钥「${targetRef.value}」：改完会**影响所有用户的上游调用**。`
  if (probe.value === undefined) return `${base} 请先核对下方差异。`
  return probe.value.ok
    ? `${base} 连通性测试已通过（上游 ${probe.value.model ?? '已响应'}，往返约 ${probe.value.latencyMs ?? '—'} 毫秒）。`
    : `${base} ⚠️ 连通性测试未通过：${probe.value.message ?? '原因未知'}`
})

function makeApplyRequest(): (token: string, reason: string) => ReturnType<ReturnType<typeof applyUpstreamKey>> {
  // 闭包捕获已校验的值：弹窗只拿得到 (token, reason)，明文不经由通用组件流转。
  return applyUpstreamKey(targetRef.value, verifiedValue.value)
}

async function refreshAfterApply(): Promise<void> {
  newValue.value = ''
  verifiedValue.value = ''
  probe.value = undefined
  await state.run()
}

async function copyHint(text: string): Promise<void> {
  const ok = await copyText(text)
  ElMessage[ok ? 'success' : 'warning'](ok ? '已复制到剪贴板' : '复制失败，请手动选择文本复制')
}

/** 指纹展示：不存在时给一个明确的词，而不是空白。 */
function fingerprintText(value: string | null): string {
  return value ?? '（未配置）'
}
</script>

<template>
  <div class="qs-page">
    <div class="qs-page__head">
      <div>
        <h2 class="qs-page__title">上游密钥</h2>
        <p class="qs-page__desc">
          模型网关向上游发请求时用的密钥。列表里**从不显示明文**，只有指纹、是否已配置与更新记录。
          更换需要 super-admin 权限，并会先做一次真实连通性测试 —— 测试不通过就不会写入。
        </p>
      </div>
      <div class="actions">
        <el-button :loading="loading" @click="state.run">刷新状态</el-button>
      </div>
    </div>

    <ErrorAlert v-if="error" :error="error" />

    <!-- 文件读不懂是最需要说清楚的情形：降级展示，但绝不假装"没有密钥"。 -->
    <el-alert v-for="row in documentErrors" :key="row.ref" type="error" :closable="false" show-icon
      :title="'凭据文件当前读不懂，列表是降级展示，且写入会被拒绝'" :description="row.documentError?.message" />

    <el-card class="qs-card" shadow="never">
      <template #header>
        <div class="card-head">
          <span>密钥状态（{{ keys.length }} 项）</span>
          <el-tag v-if="data" :type="fileExists ? 'success' : 'warning'" size="small">
            凭据文件{{ fileExists ? '已存在' : '不存在' }}
            <template v-if="fileMode"> · {{ fileMode }}</template>
          </el-tag>
        </div>
      </template>

      <el-table :data="[...keys]" border size="small">
        <el-table-column label="键名" min-width="220">
          <template #default="{ row }">
            <span class="qs-mono">{{ row.ref }}</span>
            <el-tag v-if="row.shadowedByEnvironment" size="small" type="warning" class="hit-tag">
              环境变量已提供，写文件不生效
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="是否已配置" width="120">
          <template #default="{ row }">
            <el-tag :type="row.configured ? 'success' : 'info'" size="small">
              {{ row.configured ? '已配置' : '未配置' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="指纹（sha256 前 8 位）" min-width="200">
          <template #default="{ row }">
            <span class="qs-mono">{{ fingerprintText(row.fingerprint) }}</span>
            <div v-if="row.previousFingerprint" class="fingerprint-prev">
              上次：<span class="qs-mono">{{ row.previousFingerprint }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" min-width="170">
          <template #default="{ row }">{{ formatTime(row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="更新人" min-width="110">
          <template #default="{ row }">
            <span class="qs-mono">{{ row.updatedBy ?? '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="生效方式" width="150">
          <template #default="{ row }">
            <el-tag v-if="row.restartRequired" size="small" type="warning">需重启才生效</el-tag>
            <el-tag v-else size="small" type="success">自动加载</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openFor(row)">更换</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-empty v-if="keys.length === 0 && !loading" description="凭据文件里没有任何引用" />

      <p class="qs-empty-hint">
        指纹是密钥的 sha256 前 8 位 —— 它只能回答「这次改的和上次是不是同一把」，
        无法反推出密钥本身。**服务端在任何响应、日志与审计里都不写明文。**
      </p>
    </el-card>

    <el-card v-if="activation" class="qs-card" shadow="never">
      <template #header>
        <div class="card-head">
          <span>生效机制（为什么改完还要重启）</span>
          <el-tag :type="activation.restartRequired ? 'warning' : 'success'" size="small">
            {{ activation.restartRequired ? '需要重启工作台' : '无需重启' }}
          </el-tag>
        </div>
      </template>
      <p class="hint-line">文件层：{{ activation.fileWatcher }}</p>
      <p class="hint-line">网关层：{{ activation.gatewayCache }}</p>
      <el-alert v-if="activation.restartRequired" type="warning" :closable="false" show-icon
        :title="activation.note" />
      <template v-if="activation.restartRequired && activation.restartCommand">
        <pre class="cli">{{ activation.restartCommand }}</pre>
        <el-button size="small" @click="copyHint(activation.restartCommand as string)">复制命令</el-button>
        <p class="qs-empty-hint">
          管理台不代执行这条命令：重启工作台会断开全部在线会话，这应当是一次显式的运维决定。
        </p>
      </template>
    </el-card>

    <el-card v-if="data" class="qs-card" shadow="never">
      <template #header>回滚点</template>
      <p class="hint-line">
        每次更换前都会把**改之前**的完整凭据文件备份到
        <span class="qs-mono">{{ data?.backups.dir }}</span>（权限 0600）。
        要回滚就把对应备份覆盖回
        <span class="qs-mono">{{ data?.credentialsPath }}</span>。
      </p>
      <p class="qs-empty-hint">
        管理台不提供"一键回滚"接口：回滚同样是在改上游密钥，必须有它自己的连通性判断，
        不该成为一条绕过测试的旁路。
      </p>
    </el-card>

    <!-- 第一步：填写新密钥（输入框 type=password、不回显、可清空） -->
    <el-drawer v-model="formOpen" title="更换上游密钥" size="520px">
      <el-alert type="warning" :closable="false" show-icon
        title="改完会影响所有用户的上游调用"
        description="下一步会先用这把密钥向真实上游发一次最小请求；测试不通过就不会写入。" />
      <el-form label-position="top" class="key-form">
        <el-form-item label="键名">
          <el-input v-model="targetRef" class="qs-mono" disabled />
        </el-form-item>
        <el-form-item label="新的密钥值">
          <el-input v-model="newValue" type="password" show-password clearable class="qs-mono"
            placeholder="粘贴新的上游密钥" autocomplete="off" />
        </el-form-item>
      </el-form>
      <p class="qs-empty-hint">
        值只会向服务端发送一次（同源 HTTPS），随后不再回显、不写日志、不进审计。
        填写后请自行清空输入框，或直接关闭抽屉。
      </p>
      <ErrorAlert v-if="preflightError" :error="preflightError" />
      <template #footer>
        <el-button @click="formOpen = false">取消</el-button>
        <el-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="runPreflight">
          下一步：连通性测试并预览
        </el-button>
      </template>
    </el-drawer>

    <ConfirmApplyDialog v-model="showConfirm" title="确认更换上游密钥（两步确认）"
      :description="confirmDescription" :apply-request="makeApplyRequest()" confirm-button-text="确认写入"
      @applied="refreshAfterApply">
      <!-- 连通性结论放在差异上方：这是管理员按下确认前最需要看到的一件事。 -->
      <el-alert v-if="probe" :type="probe.ok ? 'success' : 'error'" :closable="false" show-icon
        :title="probe.ok
          ? `连通性测试通过（上游 ${probe.model ?? '已响应'}，往返约 ${probe.latencyMs ?? '—'} 毫秒）`
          : `连通性测试未通过：${probe.message ?? '原因未知'}`"
        :description="probe.ok
          ? '差异里只有指纹，没有明文。确认后仍需重启工作台才会生效。'
          : '服务端在预览阶段就拒绝了这次探测；确认执行仍会再测一次，不通过则不写入。'" />
      <p v-else class="qs-empty-hint">
        预览响应里没有连通性结论（服务端未返回或格式不认识）—— 这不代表测试通过，
        执行时服务端仍会强制再测一次。
      </p>
    </ConfirmApplyDialog>
  </div>
</template>

<style scoped>
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.hit-tag {
  margin-left: 6px;
}

.fingerprint-prev {
  color: #909399;
  font-size: 12px;
  margin-top: 2px;
}

.hint-line {
  margin: 0 0 8px;
  line-height: 1.7;
  color: #606266;
}

.key-form {
  margin-top: 12px;
}

.cli {
  margin: 8px 0;
  padding: 10px 12px;
  background: #f5f7fa;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
