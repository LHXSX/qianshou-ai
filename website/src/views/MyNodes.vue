<template>
  <div class="my-nodes-v2">
    <header class="page-head">
      <div>
        <h1>我的节点</h1>
        <p class="sub" v-if="loadError">节点统计暂不可用</p><p class="sub" v-else>{{ stats.total }} 台节点 · {{ stats.online }} 在线 · {{ stats.offline }} 离线</p>
      </div>
      <div class="head-actions">
        <button class="btn-ghost" @click="loadNodes" :disabled="loading">刷新数据</button>
        <router-link to="/downloads-center" class="btn-primary">+ 添加节点</router-link>
      </div>
    </header>

    <!-- 过滤 Tab -->
    <div class="filter-bar">
      <button
        v-for="t in tabs" :key="t.value"
        class="tab" :class="{ active: filter === t.value }"
        @click="filter = t.value"
      >
        {{ t.label }}
        <span class="tab-count">{{ countByStatus(t.value) }}</span>
      </button>
      <div class="search-input">
        <input v-model="searchText" placeholder="搜索节点名/ID..." />
      </div>
    </div>

    <!-- 节点卡片网格 -->
    <div v-if="loading" class="loading-state">数据加载中...</div>

    <div v-else-if="loadError" class="portal-error" role="alert">{{ loadError }}<button class="btn-ghost" @click="loadNodes">重新加载</button></div>

    <div v-else-if="!filteredNodes.length" class="empty-state">
      <div class="empty-icon">🖥</div>
      <h3>{{ searchText || filter !== 'all' ? '没有符合筛选条件的节点' : '暂无节点' }}</h3>
      <p>下载客户端,把闲置电脑变成赚 EDG 的算力节点</p>
      <router-link to="/downloads-center" class="btn-primary">下载客户端</router-link>
    </div>

    <div v-else class="nodes-grid">
      <article
        v-for="n in filteredNodes" :key="n.id"
        class="node-card" :class="[`status-${n.status}`, { paused: n.accepting_work === false }]"
        @click="openDetail(n)"
      >
        <header class="node-card-head">
          <span class="status-dot"></span>
          <h3 class="node-title">{{ n.name }}</h3>
          <span class="tier-badge">{{ n.hardware.tier }}</span>
        </header>

        <div class="hw-line">
          <span>💻 {{ n.hardware.cpu_cores }}C / {{ n.hardware.ram_gb }}GB</span>
          <span v-if="n.hardware.gpu">· {{ n.hardware.gpu }}</span>
          <span class="muted">· {{ n.hardware.os }}</span>
        </div>

        <div class="mode-row">
          <span class="mode-pill" :class="n.accepting_work === false ? 'is-paused' : 'is-active'">
            {{ n.accepting_work === false ? '已暂停接单' : '接单中' }}
          </span>
          <span class="conn-pill">{{ statusLabel(n.status) }}</span>
        </div>

        <div v-if="n.capabilities.specialty.length" class="specialty-row">
          🎯
          <span v-for="s in n.capabilities.specialty" :key="s" class="specialty-tag">
            {{ specialtyLabel(s) }}
          </span>
        </div>
        <div v-else class="specialty-row muted">🎯 未声明专长</div>

        <div class="models-row">
          <span>📦 装备:</span>
          <span v-if="(n.apps?.total ?? appCount(n)) === 0" class="muted">未装应用</span>
          <span v-else>
            <strong class="ready">{{ n.apps?.total ?? appCount(n) }}</strong> 个应用
          </span>
        </div>

        <div v-if="n.status === 'online' || n.status === 'busy'" class="load-bar">
          <div class="load-label">负载 {{ n.load_pct }}%</div>
          <div class="load-track">
            <div class="load-fill" :style="{ width: n.load_pct + '%' }"></div>
          </div>
        </div>

        <div class="card-footer">
          <span class="last-seen">{{ relativeTime(n.last_seen) }}</span>
          <span class="reputation">⭐ {{ (n.reputation * 5).toFixed(1) }}</span>
        </div>

        <div class="card-actions" @click.stop>
          <button class="btn-mini" @click="startRename(n)">重命名</button>
          <button
            class="btn-mini"
            :class="n.accepting_work === false ? 'btn-mini-primary' : 'btn-mini-warn'"
            :disabled="actionBusyId === n.id"
            @click="toggleAccepting(n)"
          >
            {{ actionBusyId === n.id ? '处理中…' : (n.accepting_work === false ? '恢复接单' : '暂停接单') }}
          </button>
        </div>
      </article>
    </div>

    <!-- 详情抽屉 -->
    <div v-if="detailOpen" class="drawer-mask" @click="closeDetail">
      <aside class="drawer" @click.stop>
        <header class="drawer-head">
          <div>
            <h2>{{ currentNode?.name }}</h2>
            <code class="muted small">{{ currentNode?.id }}</code>
          </div>
          <button class="btn-close" @click="closeDetail">✕</button>
        </header>

        <div v-if="detailLoading" class="loading-state">加载详情...</div>
        <div v-else-if="detailError" class="portal-error" role="alert">{{ detailError }}</div>

        <div v-else-if="detail" class="drawer-body">
          <section class="detail-section">
            <h3>节点管理</h3>
            <div class="manage-row">
              <label>显示名称</label>
              <div class="rename-inline">
                <input v-model="renameDraft" maxlength="120" placeholder="给这台设备起个名字" />
                <button
                  class="btn-mini btn-mini-primary"
                  :disabled="renameBusy || !renameDraft.trim()"
                  @click="saveRename(currentNode!)"
                >
                  {{ renameBusy ? '保存中…' : '保存' }}
                </button>
              </div>
            </div>
            <div class="manage-row">
              <label>接单状态</label>
              <div class="manage-toggle">
                <span>{{ detail.node.accepting_work === false ? '已暂停（不再派发新任务）' : '接单中（可参与调度）' }}</span>
                <button
                  class="btn-mini"
                  :class="detail.node.accepting_work === false ? 'btn-mini-primary' : 'btn-mini-warn'"
                  :disabled="actionBusyId === detail.node.id"
                  @click="toggleAccepting(detail.node)"
                >
                  {{ detail.node.accepting_work === false ? '恢复接单' : '暂停接单' }}
                </button>
              </div>
              <p class="manage-hint">连接状态由客户端心跳决定；暂停只会停止派单，不会强制关闭客户端。</p>
            </div>
            <div class="manage-row danger-row">
              <label>删除设备</label>
              <div class="manage-toggle">
                <span class="danger-text">从本账号移除该节点注册（在线也可删）</span>
                <button
                  class="btn-mini btn-mini-danger"
                  :disabled="actionBusyId === detail.node.id || deleteBusy"
                  @click="deleteNode(detail.node)"
                >
                  {{ deleteBusy ? '删除中…' : '删除设备' }}
                </button>
              </div>
              <p class="manage-hint">删除后客户端会被强制注销登录；历史任务与收益流水保留。</p>
            </div>
          </section>

          <section class="detail-section">
            <h3>硬件配置</h3>
            <ul class="kv-list">
              <li><span>CPU</span><strong>{{ detail.node.hardware.cpu_cores }} 核</strong></li>
              <li><span>内存</span><strong>{{ detail.node.hardware.ram_gb }} GB</strong></li>
              <li v-if="detail.node.hardware.gpu"><span>GPU</span><strong>{{ detail.node.hardware.gpu }}</strong></li>
              <li><span>系统</span><strong>{{ detail.node.hardware.os }}</strong></li>
              <li><span>等级</span><strong>{{ detail.node.hardware.tier }}</strong></li>
            </ul>
          </section>

          <section class="detail-section">
            <h3>能力广告</h3>
            <div v-if="detail.node.capabilities.specialty.length">
              <span v-for="s in detail.node.capabilities.specialty" :key="s" class="specialty-tag">
                {{ specialtyLabel(s) }}
              </span>
            </div>
            <p v-else class="muted">未声明专长</p>
          </section>

          <section class="detail-section">
            <h3>已装应用 ({{ detailApps.length }})</h3>
            <div v-if="!detailApps.length" class="muted">
              尚未安装任何应用
              <router-link to="/app-market" class="inline-link">去应用市场</router-link>
            </div>
            <ul v-else class="model-list">
              <li v-for="a in detailApps" :key="a.slug" class="status-ready">
                <div class="model-head">
                  <strong>{{ a.name }}</strong>
                  <span class="model-size">{{ a.version ? `v${a.version}` : a.slug }}</span>
                </div>
                <div class="model-status">
                  <span class="status-ready">✓ 已装</span>
                  <code class="muted small">{{ a.slug }}</code>
                </div>
              </li>
            </ul>
          </section>

          <section class="detail-section">
            <h3>7 天收益</h3>
            <ul class="trend-list">
              <li v-for="p in detail.earnings_trend" :key="p.date">
                <span>{{ p.date.slice(5) }}</span>
                <strong>{{ p.amount.toFixed(2) }} EDG</strong>
                <span class="muted small">{{ p.tasks }} 任务</span>
              </li>
            </ul>
          </section>

          <section class="detail-section">
            <h3>状态</h3>
            <ul class="kv-list">
              <li><span>当前负载</span><strong>{{ detail.node.load_pct }}%</strong></li>
              <li><span>活跃分片</span><strong>{{ detail.node.active_shards }}</strong></li>
              <li><span>信誉</span><strong>⭐ {{ (detail.node.reputation * 5).toFixed(1) }} / 5</strong></li>
              <li><span>能力得分</span><strong>{{ detail.node.capability_score.toFixed(1) }}</strong></li>
              <li><span>最后在线</span><strong>{{ relativeTime(detail.node.last_seen) }}</strong></li>
              <li><span>注册时间</span><strong>{{ detail.node.registered_at?.slice(0,10) }}</strong></li>
            </ul>
          </section>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { errorMessage } from '../services/identityContract'
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { myApi, type MyNode } from '../services/api'

const nodes = ref<MyNode[]>([])
const loading = ref(false)
const loadError = ref('')
const filter = ref<'all' | 'online' | 'offline' | 'busy'>('all')
const searchText = ref('')
const actionBusyId = ref('')
const renameBusy = ref(false)
const renameDraft = ref('')
const deleteBusy = ref(false)

let detailRequest = 0
const detailError = ref('')
const detailOpen = ref(false)
const detailLoading = ref(false)
const currentNode = ref<MyNode | null>(null)
const detail = ref<any>(null)

const detailApps = computed(() => {
  const fromApi = detail.value?.apps
  if (Array.isArray(fromApi) && fromApi.length) return fromApi
  const raw = detail.value?.node?.capabilities?.installed_apps || []
  return raw.map((a: any) =>
    typeof a === 'string'
      ? { slug: a, name: a, version: '' }
      : { slug: a.slug || a.id || '', name: a.name || a.slug || '', version: a.version || '' },
  ).filter((a: any) => a.slug)
})

function appCount(n: MyNode): number {
  if (n.apps?.total != null) return n.apps.total
  const list = n.capabilities?.installed_apps || []
  return list.length
}

let disposed = false
let pollTimer: ReturnType<typeof setInterval> | null = null

const tabs = [
  { label: '全部', value: 'all' as const },
  { label: '在线', value: 'online' as const },
  { label: '工作中', value: 'busy' as const },
  { label: '离线', value: 'offline' as const },
]

const stats = computed(() => ({
  total: nodes.value.length,
  online: nodes.value.filter(n => n.status === 'online').length,
  busy: nodes.value.filter(n => n.status === 'busy').length,
  offline: nodes.value.filter(n => n.status === 'offline').length,
}))

const filteredNodes = computed(() => {
  let arr = nodes.value
  if (filter.value !== 'all') {
    arr = arr.filter(n => n.status === filter.value)
  }
  if (searchText.value.trim()) {
    const q = searchText.value.toLowerCase()
    arr = arr.filter(n =>
      n.name.toLowerCase().includes(q) ||
      n.id.toLowerCase().includes(q)
    )
  }
  return arr
})

const countByStatus = (s: string) =>
  s === 'all' ? nodes.value.length : nodes.value.filter(n => n.status === s).length

const applyNodePatch = (updated: MyNode) => {
  const idx = nodes.value.findIndex(n => n.id === updated.id)
  if (idx >= 0) nodes.value[idx] = { ...nodes.value[idx], ...updated }
  if (currentNode.value?.id === updated.id) {
    currentNode.value = { ...currentNode.value, ...updated }
  }
  if (detail.value?.node?.id === updated.id) {
    detail.value = {
      ...detail.value,
      node: { ...detail.value.node, ...updated },
    }
  }
}

const loadNodes = async () => {
  if (loading.value) return
  loading.value = true
  loadError.value = ''
  try {
    nodes.value = await myApi.getMyNodes()
  } catch (e: any) {
    loadError.value = '暂时无法读取节点，请重试。'
    ElMessage.error(errorMessage(e, '节点加载失败，请稍后重试。'))
  } finally {
    loading.value = false
  }
}

const openDetail = async (n: MyNode) => {
  const request = ++detailRequest
  detail.value = null
  detailError.value = ''
  currentNode.value = n
  renameDraft.value = n.name
  detailOpen.value = true
  detailLoading.value = true
  try {
    const result = await myApi.getMyNodeDetail(n.id)
    if (request !== detailRequest) return
    detail.value = result
    renameDraft.value = detail.value?.node?.name || n.name
  } catch (e: any) {
    if (request !== detailRequest) return
    detailError.value = '无法读取该节点详情，请关闭后重试。'
    ElMessage.error(errorMessage(e, '详情加载失败，请稍后重试。'))
  } finally {
    if (request === detailRequest) detailLoading.value = false
  }
}

const closeDetail = () => {
  detailRequest++
  detailOpen.value = false
  currentNode.value = null
  detail.value = null
  renameDraft.value = ''
}

const startRename = async (n: MyNode) => {
  try {
    const { value } = await ElMessageBox.prompt('给这台设备起一个好认的名字', '重命名节点', {
      inputValue: n.name,
      inputPlaceholder: '例如：书房 Mac / 客厅 Windows',
      confirmButtonText: '保存',
      cancelButtonText: '取消',
      inputValidator: (v) => {
        const name = (v || '').trim()
        if (!name) return '名称不能为空'
        if (name.length > 120) return '名称过长'
        return true
      },
    })
    renameBusy.value = true
    const updated = await myApi.updateMyNode(n.id, { name: String(value).trim() })
    applyNodePatch(updated)
    ElMessage.success('节点已重命名')
  } catch (e: any) {
    if (e === 'cancel' || e === 'close') return
    ElMessage.error(errorMessage(e, '重命名失败，请稍后重试。'))
  } finally {
    renameBusy.value = false
  }
}

const saveRename = async (n: MyNode) => {
  const name = renameDraft.value.trim()
  if (!name) {
    ElMessage.warning('名称不能为空')
    return
  }
  renameBusy.value = true
  try {
    const updated = await myApi.updateMyNode(n.id, { name })
    applyNodePatch(updated)
    renameDraft.value = updated.name
    ElMessage.success('节点已重命名')
  } catch (e: any) {
    ElMessage.error(errorMessage(e, '重命名失败，请稍后重试。'))
  } finally {
    renameBusy.value = false
  }
}

const toggleAccepting = async (n: MyNode) => {
  const next = n.accepting_work === false
  const tip = next
    ? `确认恢复「${n.name}」接单？恢复后可继续参与任务调度。`
    : `确认暂停「${n.name}」接单？暂停后不再派发新任务（客户端可保持连接）。`
  try {
    await ElMessageBox.confirm(tip, next ? '恢复接单' : '暂停接单', {
      type: 'warning',
      confirmButtonText: next ? '恢复' : '暂停',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  actionBusyId.value = n.id
  try {
    const updated = next
      ? await myApi.resumeMyNode(n.id)
      : await myApi.pauseMyNode(n.id)
    applyNodePatch(updated)
    ElMessage.success(next ? '已恢复接单' : '已暂停接单')
  } catch (e: any) {
    ElMessage.error(errorMessage(e, '操作失败，请稍后重试。'))
  } finally {
    actionBusyId.value = ''
  }
}

const deleteNode = async (n: MyNode) => {
  try {
    await ElMessageBox.confirm(
      `确认删除设备「${n.name}」？将从本账号移除该节点，并强制客户端注销登录。历史任务与收益会保留。`,
      '删除设备',
      {
        type: 'warning',
        confirmButtonText: '确认删除',
        cancelButtonText: '取消',
        confirmButtonClass: 'el-button--danger',
      },
    )
  } catch {
    return
  }
  deleteBusy.value = true
  actionBusyId.value = n.id
  try {
    await myApi.deleteMyNode(n.id)
    nodes.value = nodes.value.filter((x) => x.id !== n.id)
    closeDetail()
    ElMessage.success('设备已删除；若客户端仍在线，将被强制注销')
  } catch (e: any) {
    ElMessage.error(errorMessage(e, '删除失败，请稍后重试。'))
  } finally {
    deleteBusy.value = false
    actionBusyId.value = ''
  }
}

const statusLabel = (status: string) => {
  const map: Record<string, string> = {
    online: '连接在线',
    busy: '工作中',
    offline: '连接离线',
  }
  return map[status] || status
}

const specialtyLabel = (s: string) => {
  const map: any = {
    photography: '人像/产品图',
    ecommerce: '电商图',
    'ai-generation': 'AI 生图',
    ocr: '文字识别',
    speech: '语音处理',
  }
  return map[s] || s
}

const relativeTime = (iso: string | null) => {
  if (!iso) return '从未上线'
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 60) return '刚刚在线'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  return `${Math.floor(diff / 86400)} 天前`
}

onMounted(async () => {
  await loadNodes()
  if (disposed) return
  pollTimer = setInterval(() => { if (!document.hidden) loadNodes() }, 20000)
})

onBeforeUnmount(() => {
  disposed = true
  detailRequest++
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<style scoped>
.my-nodes-v2 {
  padding: 20px 24px;
  background: linear-gradient(180deg, #d8dfeb 0%, #c8d2e0 100%);
  color: #000000;
  min-height: 100vh;
}

.page-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 18px;
}
.page-head h1 { margin: 0; font-size: 24px; font-weight: 900; color: #000; }
.sub { color: #1e293b; margin: 4px 0 0; font-size: 13px; }
.head-actions { display: flex; gap: 10px; }
.btn-ghost {
  background: transparent;
  color: #1e293b;
  border: 1px solid #e2e8f0;
  padding: 8px 18px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}
.btn-ghost:hover { border-color: #3b82f6; color: #3b82f6; }
.btn-primary {
  background: #3b82f6;
  color: #fff;
  padding: 8px 18px;
  border-radius: 8px;
  text-decoration: none;
  font-size: 13px;
  font-weight: 500;
  display: inline-block;
}
.btn-primary:hover { background: #2563eb; }

.filter-bar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 18px;
  background: #ffffff;
  padding: 10px;
  border-radius: 10px;
  border: 1px solid #e2e8f0;
}
.tab {
  background: transparent;
  border: none;
  color: #1e293b;
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.tab.active { background: #3b82f6; color: #fff; }
.tab-count {
  margin-left: 4px;
  background: rgba(255,255,255,0.15);
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 11px;
}
.search-input { margin-left: auto; }
.search-input input {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  color: #000000;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 13px;
  width: 220px;
  outline: none;
}
.search-input input:focus { border-color: #3b82f6; }

.nodes-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 14px;
}

.node-card {
  background: #ffffff;
  border: 1px solid #e6eaf0;
  border-left: 4px solid #94a3b8;
  border-radius: 14px;
  padding: 18px;
  cursor: pointer;
  transition: all 0.25s;
  position: relative;
  overflow: hidden;
}
.node-card::before {
  content: '';
  position: absolute;
  inset: 0;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.25s;
}
.node-card.status-online::before {
  background: linear-gradient(135deg, rgba(16,185,129,0.10), rgba(16,185,129,0.02));
  opacity: 1;
}
.node-card.status-busy::before {
  background: linear-gradient(135deg, rgba(245,158,11,0.10), rgba(245,158,11,0.02));
  opacity: 1;
}
.node-card > * { position: relative; }
.node-card:hover {
  border-color: #3b82f6;
  border-left-color: #3b82f6;
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(59,130,246,0.15);
}
.node-card.status-online { border-left-color: #10b981; box-shadow: 0 0 0 1px rgba(16,185,129,0.08); }
.node-card.status-busy { border-left-color: #f59e0b; box-shadow: 0 0 0 1px rgba(245,158,11,0.08); }
.node-card.status-offline { opacity: 0.85; background: #f1f5f9; }
.node-card.paused { border-left-color: #f59e0b; }

.mode-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 8px 0 4px;
}
.mode-pill, .conn-pill {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid #e2e8f0;
  color: #334155;
  background: #f8fafc;
}
.mode-pill.is-active {
  color: #047857;
  border-color: #a7f3d0;
  background: #ecfdf5;
}
.mode-pill.is-paused {
  color: #b45309;
  border-color: #fde68a;
  background: #fffbeb;
}

.card-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #f1f5f9;
}
.btn-mini {
  border: 1px solid #e2e8f0;
  background: #fff;
  color: #0f172a;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
}
.btn-mini:hover:not(:disabled) { border-color: #3b82f6; color: #2563eb; }
.btn-mini:disabled { opacity: 0.6; cursor: not-allowed; }
.btn-mini-primary {
  background: #3b82f6;
  border-color: #3b82f6;
  color: #fff;
}
.btn-mini-primary:hover:not(:disabled) { background: #2563eb; color: #fff; }
.btn-mini-warn {
  background: #fff7ed;
  border-color: #fdba74;
  color: #c2410c;
}
.btn-mini-danger {
  background: #fef2f2;
  border-color: #fca5a5;
  color: #b91c1c;
}
.btn-mini-danger:hover:not(:disabled) {
  background: #ef4444;
  border-color: #ef4444;
  color: #fff;
}
.danger-row .danger-text { color: #b91c1c; font-size: 13px; }

.manage-row { margin-bottom: 14px; }
.manage-row > label {
  display: block;
  font-size: 12px;
  color: #64748b;
  margin-bottom: 6px;
}
.rename-inline, .manage-toggle {
  display: flex;
  gap: 8px;
  align-items: center;
}
.rename-inline input {
  flex: 1;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
  outline: none;
}
.rename-inline input:focus { border-color: #3b82f6; }
.manage-toggle {
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}
.manage-hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: #64748b;
  line-height: 1.45;
}

.node-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.status-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: #64748b;
}
.status-online .status-dot {
  background: #22c55e;
  box-shadow: 0 0 8px #22c55e;
  animation: pulse 1.5s ease-in-out infinite;
}
.status-busy .status-dot { background: #fbbf24; }
@keyframes pulse {
  0%,100% { opacity: 1; }
  50% { opacity: 0.5; }
}
.node-title {
  flex: 1;
  margin: 0;
  font-size: 15px;
  color: #000000;
}
.tier-badge {
  background: rgba(59,130,246,0.15);
  color: #3b82f6;
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 8px;
  text-transform: uppercase;
  font-weight: 600;
}

.hw-line {
  font-size: 12px;
  color: #0f172a;
  margin-bottom: 8px;
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.muted { color: #334155; }
.inline-link {
  margin-left: 8px;
  color: #2563eb;
  text-decoration: none;
  font-size: 12px;
}
.inline-link:hover { text-decoration: underline; }

.specialty-row {
  margin: 8px 0;
  font-size: 12px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}
.specialty-tag {
  background: rgba(34,197,94,0.12);
  color: #22c55e;
  padding: 2px 8px;
  border-radius: 8px;
  font-size: 11px;
}

.models-row {
  margin: 8px 0;
  font-size: 12px;
  color: #0f172a;
  display: flex;
  gap: 6px;
  align-items: center;
}
.ready { color: #22c55e; }
.downloading { color: #fbbf24; }

.load-bar {
  margin: 10px 0;
}
.load-label {
  font-size: 11px;
  color: #1e293b;
  margin-bottom: 4px;
}
.load-track {
  height: 6px;
  background: #f1f5f9;
  border-radius: 3px;
  overflow: hidden;
}
.load-fill {
  height: 100%;
  background: linear-gradient(90deg, #22c55e, #fbbf24, #ef4444);
  transition: width 0.5s;
}

.card-footer {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: #334155;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid #f1f5f9;
}
.reputation { color: #fbbf24; }

/* ─── 抽屉 ──────────────────────────────── */
.drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  z-index: 9999;
  backdrop-filter: blur(4px);
}
.drawer {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 440px;
  max-width: 90vw;
  background: #f8fafc;
  border-left: 1px solid #f1f5f9;
  overflow-y: auto;
  animation: slideIn 0.25s ease;
}
@keyframes slideIn { from { transform: translateX(100%); } }
.drawer-head {
  position: sticky;
  top: 0;
  background: #f8fafc;
  display: flex;
  justify-content: space-between;
  align-items: start;
  padding: 18px 20px;
  border-bottom: 1px solid #f1f5f9;
  z-index: 1;
}
.drawer-head h2 { margin: 0; font-size: 17px; color: #000000; }
.drawer-head code.small { font-size: 10px; }
.btn-close {
  background: transparent;
  border: 1px solid #e2e8f0;
  color: #1e293b;
  width: 30px;
  height: 30px;
  border-radius: 6px;
  cursor: pointer;
}
.btn-close:hover { border-color: #ef4444; color: #ef4444; }

.drawer-body { padding: 18px 20px; }

.detail-section {
  margin-bottom: 24px;
}
.detail-section h3 {
  font-size: 13px;
  color: #1e293b;
  margin: 0 0 10px 0;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.kv-list { list-style: none; padding: 0; margin: 0; }
.kv-list li {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px dashed #f1f5f9;
  font-size: 13px;
}
.kv-list li:last-child { border-bottom: none; }
.kv-list li span { color: #1e293b; }
.kv-list li strong { color: #000000; font-family: 'JetBrains Mono', monospace; }

.model-list { list-style: none; padding: 0; margin: 0; }
.model-list li {
  background: #ffffff;
  padding: 10px;
  border-radius: 8px;
  margin-bottom: 8px;
  border-left: 3px solid #64748b;
}
.model-list li.status-ready { border-left-color: #22c55e; }
.model-list li.status-downloading { border-left-color: #fbbf24; }
.model-list li.status-failed { border-left-color: #ef4444; }

.model-head {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4px;
  font-size: 13px;
}
.model-size { color: #1e293b; font-size: 11px; }
.model-status { font-size: 11px; color: #1e293b; }
.status-ready { color: #22c55e; }
.status-downloading { color: #fbbf24; }
.status-failed { color: #ef4444; }
.mini-progress {
  height: 4px;
  background: #f1f5f9;
  border-radius: 2px;
  margin-top: 4px;
  overflow: hidden;
}
.mini-progress > div {
  height: 100%;
  background: #fbbf24;
  transition: width 0.3s;
}

.trend-list { list-style: none; padding: 0; margin: 0; }
.trend-list li {
  display: grid;
  grid-template-columns: 50px 1fr auto;
  gap: 8px;
  padding: 4px 0;
  font-size: 12px;
}
.trend-list li strong { font-family: 'JetBrains Mono', monospace; color: #22c55e; }
.small { font-size: 11px; }

.empty-state {
  text-align: center;
  padding: 60px 20px;
  color: #334155;
}
.empty-icon { font-size: 60px; margin-bottom: 14px; }
.empty-state h3 { color: #0f172a; margin: 0 0 8px 0; }
.empty-state p { margin: 0 0 20px 0; }
.loading-state { text-align: center; padding: 40px; color: #334155; }

/* ─── 浅色主题阴影增强 v2 (立体感) ─── */
.kpi-card, .kpi-box, .panel, .node-card, .market-card, .model-card,
.balance-hero, .level-hero, .welcome-bar, .filter-bar, .nodes-grid > article {
  box-shadow:
    0 1px 2px rgba(15, 23, 42, 0.04),
    0 4px 16px rgba(15, 23, 42, 0.06),
    0 1px 0 rgba(255, 255, 255, 0.9) inset;
  transition: box-shadow 0.25s, transform 0.25s;
}
.kpi-card:hover, .node-card:hover, .market-card:hover, .model-card:hover {
  box-shadow: 0 6px 20px rgba(59, 130, 246, 0.12), 0 2px 6px rgba(15, 23, 42, 0.04);
}

</style>
