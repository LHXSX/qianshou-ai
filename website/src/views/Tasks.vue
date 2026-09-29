<template>
  <div class="tasks-v2">
    <header class="page-head">
      <div>
        <h1>任务记录</h1>
        <p class="sub">你的节点跑过的 AI 任务全记录</p>
      </div>
      <button class="btn-ghost" @click="loadData">刷新数据</button>
    </header>

    <!-- KPI 4 卡 -->
    <section class="kpi-row" v-if="stats && !loading">
      <div class="kpi-box">
        <div class="kpi-icon">📅</div>
        <div class="kpi-body">
          <div class="kpi-label">今日</div>
          <div class="kpi-val">{{ stats.today }}</div>
          <div class="kpi-meta">+{{ stats.today_reward.toFixed(2) }} EDG</div>
        </div>
      </div>
      <div class="kpi-box">
        <div class="kpi-icon">📊</div>
        <div class="kpi-body">
          <div class="kpi-label">本月</div>
          <div class="kpi-val">{{ stats.this_month }}</div>
          <div class="kpi-meta">{{ stats.this_month > 0 ? '近 30 天' : '暂无数据' }}</div>
        </div>
      </div>
      <div class="kpi-box">
        <div class="kpi-icon">📈</div>
        <div class="kpi-body">
          <div class="kpi-label">累计任务</div>
          <div class="kpi-val">{{ stats.total }}</div>
          <div class="kpi-meta">单均 {{ stats.avg_reward.toFixed(2) }} EDG</div>
        </div>
      </div>
      <div class="kpi-box">
        <div class="kpi-icon">💰</div>
        <div class="kpi-body">
          <div class="kpi-label">累计 EDG</div>
          <div class="kpi-val income">{{ stats.total_reward.toFixed(2) }}</div>
          <div class="kpi-meta">
            成功率 {{ Number(stats.success_rate).toFixed(1) }}%
            <span v-if="stats.success_done != null || stats.success_failed != null" class="kpi-sub">
              （{{ stats.success_done || 0 }}/{{ (stats.success_done || 0) + (stats.success_failed || 0) }}）
            </span>
          </div>
        </div>
      </div>
    </section>

    <!-- 过滤 Tab -->
    <div class="filter-bar">
      <button
        v-for="t in tabs" :key="t.value"
        class="tab" :class="{ active: statusFilter === t.value }"
        @click="changeStatus(t.value)"
      >
        {{ t.icon }} {{ t.label }}
      </button>
      <div class="search-input">
        <input v-model="search" placeholder="搜索本页技能 / 节点…" />
      </div>
    </div>

    <!-- 任务列表 -->
    <section class="panel">
      <div v-if="loading" class="loading-state">加载任务...</div>

      <div v-else-if="loadError" class="portal-error" role="alert">{{ loadError }}<button class="btn-ghost" @click="loadData">重新加载</button></div>

      <div v-else-if="!filteredTasks.length" class="empty-state">
        <div class="empty-icon">📋</div>
        <h3>{{ search ? '没有匹配的任务' : '还没有任务记录' }}</h3>
        <p v-if="!search">开启节点共享并安装应用后，可在这里查看实际任务记录。</p>
        <router-link v-if="!search" to="/my-nodes" class="btn-primary">去看节点</router-link>
      </div>

      <div v-else class="portal-table-scroll"><table class="task-table">
        <thead>
          <tr>
            <th>状态</th>
            <th>技能/模型</th>
            <th>节点</th>
            <th>耗时</th>
            <th class="right">收益</th>
            <th>完成时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in filteredTasks" :key="t.id">
            <td>
              <span class="status-pill" :class="`status-${t.status}`">
                <span class="status-dot"></span>
                {{ statusLabel(t.status) }}
              </span>
            </td>
            <td>
              <div class="skill-cell">
                <span class="skill-icon">{{ getSkillIcon(t.skill) }}</span>
                <div>
                  <strong>{{ skillLabel(t.skill) }}</strong>
                  <small v-if="t.model" class="muted">model: {{ t.model }}</small>
                  <small v-if="t.error" class="task-error">{{ t.error }}</small>
                  <small v-else-if="t.note" class="muted">{{ t.note }}</small>
                </div>
              </div>
            </td>
            <td>
              <div v-if="t.node_name && t.node_name !== '—'">
                <strong>{{ t.node_name }}</strong>
              </div>
              <span v-else class="muted">—</span>
            </td>
            <td>
              <span v-if="t.elapsed_ms > 0" class="elapsed">
                {{ formatElapsed(t.elapsed_ms) }}
              </span>
              <span v-else class="muted">—</span>
            </td>
            <td class="right">
              <strong class="reward">+{{ t.reward.toFixed(4) }}</strong>
              <small class="muted unit">EDG</small>
            </td>
            <td>
              <code class="small muted">{{ formatTime(t.completed_at) }}</code>
            </td>
          </tr>
        </tbody>
      </table></div>

      <!-- 分页 -->
      <div v-if="total > pageSize" class="pagination">
        <button :disabled="loading || page <= 1" @click="changePage(page - 1)">‹ 上一页</button>
        <span>{{ page }} / {{ Math.ceil(total / pageSize) }} 页 · 共 {{ total }} 条</span>
        <button :disabled="loading || page >= Math.ceil(total / pageSize)" @click="changePage(page + 1)">下一页 ›</button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { errorMessage } from '../services/identityContract'
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { myApi } from '../services/api'

const tasks = ref<any[]>([])
const stats = ref<any>(null)
const total = ref(0)
const loading = ref(false)
const loadError = ref('')
let requestId = 0
onBeforeUnmount(() => { requestId++ })
const page = ref(1)
const pageSize = 20
const statusFilter = ref('all')
const search = ref('')

const tabs = [
  { label: '全部', value: 'all', icon: '📋' },
  { label: '已完成', value: 'done', icon: '✓' },
  { label: '运行中', value: 'running', icon: '⚡' },
  { label: '失败', value: 'failed', icon: '✗' },
]

const filteredTasks = computed(() => {
  let arr = tasks.value
  if (search.value.trim()) {
    const q = search.value.toLowerCase()
    arr = arr.filter(t =>
      (t.skill || '').toLowerCase().includes(q) ||
      (t.node_name || '').toLowerCase().includes(q) ||
      (t.model || '').toLowerCase().includes(q)
    )
  }
  return arr
})

const loadData = async () => {
  const currentRequest = ++requestId
  loading.value = true
  loadError.value = ''
  try {
    const r = await myApi.getMyTasks({
      status: statusFilter.value,
      page: page.value,
      size: pageSize,
    })
    if (currentRequest !== requestId) return
    if (!r.ok || !Array.isArray(r.tasks) || !r.stats) throw new Error('任务数据格式不完整')
    tasks.value = r.tasks
    stats.value = r.stats
    total.value = r.total
  } catch (e: any) {
    if (currentRequest !== requestId) return
    tasks.value = []
    stats.value = null
    total.value = 0
    loadError.value = '暂时无法读取任务记录，请重试。'
    ElMessage.error(errorMessage(e, '任务加载失败，请稍后重试。'))
  } finally {
    if (currentRequest === requestId) loading.value = false
  }
}

const changeStatus = (s: string) => {
  statusFilter.value = s
  page.value = 1
  loadData()
}

const changePage = (p: number) => {
  page.value = p
  loadData()
}

const statusLabel = (s: string) => {
  const map: any = {
    done: '已完成', completed: '已完成',
    running: '运行中', pending: '排队中',
    failed: '失败', error: '失败',
  }
  return map[s.toLowerCase()] || s
}

const skillLabel = (s: string) => {
  const map: any = {
    'sd-txt2img': 'SD 文生图',
    'sd-img2img': 'SD 图生图',
    'sam-segment': '智能抠图',
    'gfpgan-restore': '人像修复',
    'lama-erase': '物体擦除',
    'esrgan-upscale': '图片超分',
    'whisper-stt': '语音转文字',
  }
  return map[s] || s
}

const getSkillIcon = (s: string) => {
  if (/sd|diffus|kolors|flux|gen/i.test(s)) return '🎨'
  if (/sam|seg|mask/i.test(s)) return '✂️'
  if (/lama|inpaint|erase/i.test(s)) return '🩹'
  if (/gfpgan|face|restore/i.test(s)) return '👤'
  if (/super|upscale|esrgan/i.test(s)) return '🔍'
  if (/whisper|audio|speech/i.test(s)) return '🎤'
  if (/llm|chat/i.test(s)) return '💬'
  return '⚡'
}

const formatElapsed = (ms: number) => {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
}

const formatTime = (iso: string | null) => {
  if (!iso) return '—'
  return iso.replace('T', ' ').slice(0, 19)
}

onMounted(loadData)
</script>

<style scoped>
.tasks-v2 {
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
}
.btn-primary:hover { background: #2563eb; }

.kpi-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
  margin-bottom: 18px;
}
.kpi-box {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 16px;
  display: flex;
  gap: 14px;
}
.kpi-icon {
  font-size: 26px;
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(59,130,246,0.12);
  border-radius: 10px;
}
.kpi-body { flex: 1; }
.kpi-label { color: #1e293b; font-size: 12px; }
.kpi-val {
  font-size: 22px;
  font-weight: 700;
  color: #000000;
  margin: 2px 0;
  font-family: 'JetBrains Mono', monospace;
}
.kpi-val.income { color: #22c55e; }
.kpi-meta { color: #334155; font-size: 11px; }

.filter-bar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 14px;
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
.tab:hover:not(.active) { color: #3b82f6; }

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

.panel {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  padding: 16px;
}

.task-table {
  width: 100%;
  border-collapse: collapse;
}
.task-table th {
  text-align: left;
  font-size: 12px;
  color: #1e293b;
  font-weight: 500;
  padding: 10px 12px;
  border-bottom: 1px solid #f1f5f9;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.task-table th.right, .task-table td.right { text-align: right; }
.task-table td {
  padding: 14px 12px;
  border-bottom: 1px solid #f1f5f9;
  font-size: 13px;
  vertical-align: middle;
}
.task-table tr:hover { background: rgba(59,130,246,0.04); }

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: #f1f5f9;
  color: #1e293b;
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 8px;
}
.status-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: #94a3b8;
}
.status-done .status-dot,
.status-completed .status-dot { background: #22c55e; }
.status-done, .status-completed {
  background: rgba(34,197,94,0.12);
  color: #22c55e;
}
.status-running .status-dot {
  background: #3b82f6;
  animation: pulse 1.5s ease-in-out infinite;
}
.status-running {
  background: rgba(59,130,246,0.12);
  color: #3b82f6;
}
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
.status-failed .status-dot,
.status-error .status-dot { background: #ef4444; }
.status-failed, .status-error {
  background: rgba(239,68,68,0.12);
  color: #ef4444;
}

.skill-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}
.skill-icon {
  font-size: 22px;
  width: 36px;
  height: 36px;
  background: rgba(168,85,247,0.12);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.skill-cell strong { display: block; color: #000000; font-size: 13px; }
.skill-cell small { font-size: 11px; }
.muted { color: #334155; }
.unit { font-size: 11px; margin-left: 3px; }

.elapsed {
  font-family: 'JetBrains Mono', monospace;
  color: #0f172a;
  font-size: 12px;
}

.reward {
  color: #22c55e;
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
}

code.small {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
}

.pagination {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 14px;
  padding: 16px 0 4px;
  font-size: 13px;
  color: #1e293b;
}
.pagination button {
  background: transparent;
  border: 1px solid #e2e8f0;
  color: #1e293b;
  padding: 5px 14px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}
.pagination button:disabled { opacity: 0.4; cursor: not-allowed; }
.pagination button:not(:disabled):hover { border-color: #3b82f6; color: #3b82f6; }

.empty-state {
  text-align: center;
  padding: 60px 20px;
  color: #334155;
}
.empty-icon { font-size: 60px; margin-bottom: 14px; }
.empty-state h3 { color: #0f172a; margin: 0 0 8px 0; }
.empty-state p { margin: 0 0 20px 0; }
.loading-state { text-align: center; padding: 40px; color: #334155; }

@media (max-width: 768px) {
  .kpi-row { grid-template-columns: repeat(2, 1fr); }
  .task-table { font-size: 11px; }
}

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
