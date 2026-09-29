<script setup lang="ts">
/**
 * IP 白名单（契约 §7 + §9）。
 *
 * 白名单是**第一道门**，先于一切：不在名单内的来源连 SPA 的 index.html 都拿不到。
 * 本页做三件事：
 * 1. 高亮展示服务端看到的 `clientIp`（管理员据此确认自己是从哪个出口进来的）；
 * 2. 条目增删 —— 先填参数抽屉，再走两步确认（`whitelist/entries/preflight` → `apply`）；
 * 3. 展示逃生路径：本机回环永远放行，白名单被清空也能用 CLI 把自己加回来。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { copyText, formatTime } from '@/utils/format'
import { cidrContainsIp } from '@/utils/cidr'
import { applyWhitelistEntry, fetchWhitelistStatus, preflightWhitelistEntry } from '@/api/modules/whitelist'
import { useAsyncData } from '@/utils/async-state'
import type { WhitelistEntry, WhitelistOp } from '@/api/types'
import ErrorAlert from '@/components/ErrorAlert.vue'
import ConfirmApplyDialog from '@/components/ConfirmApplyDialog.vue'

const statusState = useAsyncData(fetchWhitelistStatus)

onMounted(() => {
  void statusState.run()
})

const entries = computed<readonly WhitelistEntry[]>(() => statusState.data.value?.entries ?? [])
const clientIp = computed(() => statusState.data.value?.clientIp ?? '')
const escapeHatch = computed(() => statusState.data.value?.escapeHatch)

// —— 表单抽屉 ——————————————————————————————————————————————

const formDrawerOpen = ref(false)
const pendingOp = ref<WhitelistOp>('add')
const cidr = ref('')
const note = ref('')

function openAdd(): void {
  pendingOp.value = 'add'
  cidr.value = ''
  note.value = ''
  formDrawerOpen.value = true
}

function openRemove(entry: WhitelistEntry): void {
  pendingOp.value = 'remove'
  cidr.value = entry.cidr
  note.value = entry.note
  formDrawerOpen.value = true
}

/** 一键把自己当前出口 /32 填进表单：最不容易出错的新增方式。 */
function fillSelf(): void {
  if (clientIp.value === '') {
    ElMessage.warning('服务端未返回 clientIp，无法自动填充')
    return
  }
  pendingOp.value = 'add'
  cidr.value = `${clientIp.value}/32`
  note.value = '当前出口（由页面一键填入）'
  formDrawerOpen.value = true
}

// —— 两步确认 ——————————————————————————————————————————————

const confirmOpen = ref(false)
const dialogTitle = computed(() => (pendingOp.value === 'add' ? '新增白名单条目（两步确认）' : '移除白名单条目（两步确认）'))
const dialogDescription = computed(() =>
  pendingOp.value === 'add'
    ? '服务端会把新增后的完整条目列表作为 before → after 返回。确认前请核对，别把自己锁在门外。'
    : '移除后该来源会立即失去访问能力（连前端资源都拿不到）。确认前请核对 CIDR。',
)

function proceedToConfirm(): void {
  if (cidr.value.trim() === '') {
    ElMessage.warning('请填写 CIDR，例如 203.0.113.7/32')
    return
  }
  formDrawerOpen.value = false
  confirmOpen.value = true
}

function requestPreview() {
  return preflightWhitelistEntry({
    op: pendingOp.value,
    cidr: cidr.value.trim(),
    ...(note.value.trim() === '' ? {} : { note: note.value.trim() }),
  })
}

async function refreshAfterApply(): Promise<void> {
  await statusState.run()
}

async function copyHint(text: string): Promise<void> {
  const ok = await copyText(text)
  ElMessage[ok ? 'success' : 'warning'](ok ? '已复制到剪贴板' : '复制失败，请手动选择文本复制')
}

// —— 纯展示用的 CIDR 覆盖判断（仅用于给当前出口打标记，不参与任何访问控制） ————

/** 该条目是否覆盖当前出口。无法判断（IPv6 等）时返回 false 而不是猜。 */
function coversCurrent(entry: WhitelistEntry): boolean {
  if (clientIp.value === '') return false
  return cidrContainsIp(entry.cidr, clientIp.value)
}
</script>

<template>
  <div class="qs-page">
    <div class="qs-page__head">
      <div>
        <h2 class="qs-page__title">白名单</h2>
        <p class="qs-page__desc">
          管理台默认拒绝一切来源。不在白名单内的访问连前端页面都不会下发（403 ip_not_allowed）。
          前端不做白名单判断，这里只展示服务端看到的事实与负责人的操作入口。
        </p>
      </div>
      <div class="actions">
        <el-button :loading="statusState.loading.value" @click="statusState.run">刷新状态</el-button>
        <el-button type="primary" @click="openAdd">新增条目</el-button>
      </div>
    </div>

    <ErrorAlert v-if="statusState.error.value" :error="statusState.error.value" />

    <el-card class="qs-card" shadow="never">
      <template #header>
        <div class="card-head">
          <span>服务端看到的来源 IP（clientIp）</span>
          <el-tag :type="statusState.data.value?.enabled ? 'success' : 'warning'" size="small">
            白名单{{ statusState.data.value?.enabled ? '已启用' : '未启用' }}
          </el-tag>
        </div>
      </template>
      <div class="ip-hl">
        <span class="ip-hl__value qs-mono">{{ clientIp || '（服务端未返回 clientIp）' }}</span>
        <el-button size="small" @click="fillSelf">用它填入「新增条目」</el-button>
      </div>
      <p class="qs-empty-hint">
        如果当前正被白名单拒绝，那么你看到的不会是这一页，而是服务端返回的 403 说明。
        请在服务器本机（回环地址）按下方逃生路径操作。
      </p>
    </el-card>

    <el-card class="qs-card" shadow="never">
      <template #header>条目列表（{{ entries.length }} 条）</template>
      <el-table :data="[...entries]" border size="small">
        <el-table-column label="CIDR" min-width="220">
          <template #default="{ row }">
            <span class="qs-mono">{{ row.cidr }}</span>
            <el-tag v-if="coversCurrent(row)" size="small" type="success" class="hit-tag">覆盖当前出口</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="note" label="备注" min-width="200" />
        <el-table-column label="添加人" min-width="110">
          <template #default="{ row }">
            <span class="qs-mono">{{ row.addedBy }}</span>
          </template>
        </el-table-column>
        <el-table-column label="添加时间" min-width="170">
          <template #default="{ row }">{{ formatTime(row.addedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="{ row }">
            <el-button link type="danger" @click="openRemove(row)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="entries.length === 0 && !statusState.loading.value"
        description="白名单条目为空 —— 此时只有本机回环可以访问" />
    </el-card>

    <el-card class="qs-card" shadow="never">
      <template #header>逃生路径（白名单清空也不会锁死）</template>
      <template v-if="escapeHatch">
        <p class="hint-line">
          本机回环永远放行：
          <el-tag :type="escapeHatch.loopbackAlwaysAllowed ? 'success' : 'danger'" size="small">
            {{ escapeHatch.loopbackAlwaysAllowed ? '已开启' : '未开启（当前没有逃生路径，请立即核对服务端配置）' }}
          </el-tag>
        </p>
        <p class="hint-line">服务端给出的 CLI 提示（原样展示，未做改写）：</p>
        <pre class="cli">{{ escapeHatch.cliHint }}</pre>
        <el-button size="small" @click="copyHint(escapeHatch.cliHint)">复制命令</el-button>
        <p class="qs-empty-hint">
          推荐顺序：SSH 到服务器 → 执行上面的命令把自己当前的出口 IP 加回白名单 → 回到本页刷新确认。
          也可以用 <span class="qs-mono">curl 127.0.0.1:7090</span> 从本机回环验证服务是否存活。
        </p>
      </template>
      <el-empty v-else description="尚未取得白名单状态" />
    </el-card>

    <el-drawer v-model="formDrawerOpen" :title="pendingOp === 'add' ? '新增白名单条目' : '移除白名单条目'" size="480px">
      <el-form label-position="top">
        <el-form-item label="CIDR">
          <el-input v-model="cidr" class="qs-mono" placeholder="203.0.113.7/32" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="note" placeholder="例如：办公出口" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formDrawerOpen = false">取消</el-button>
        <el-button type="primary" @click="proceedToConfirm">下一步：预览差异</el-button>
      </template>
    </el-drawer>

    <ConfirmApplyDialog v-model="confirmOpen" :title="dialogTitle" :description="dialogDescription"
      :preflight-request="requestPreview" :apply-request="applyWhitelistEntry" confirm-button-text="确认执行"
      @applied="refreshAfterApply" />
  </div>
</template>

<style scoped>
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.ip-hl {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: #ecf5ff;
  border-left: 4px solid #409eff;
  border-radius: 4px;
}

.ip-hl__value {
  color: #1f2d3d;
  font-size: 18px;
  font-weight: 700;
}

.hit-tag {
  margin-left: 8px;
}

.hint-line {
  margin: 0 0 8px;
  line-height: 1.7;
}

.cli {
  padding: 10px 12px;
  overflow-x: auto;
  background: #1f2d3d;
  border-radius: 4px;
  color: #e6e8eb;
  font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}

.actions {
  display: flex;
  gap: 8px;
}
</style>
