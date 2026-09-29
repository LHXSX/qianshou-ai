<template>
  <div class="my-equipment">
    <header class="page-head">
      <div>
        <h1>我的装备</h1>
        <p class="sub" v-if="loadError">设备应用统计暂不可用</p>
        <p class="sub" v-else>
          {{ apps.length }} 个应用 · 分布在 {{ nodesWithApps }} / {{ totalNodes }} 台设备
        </p>
      </div>
      <div class="head-actions">
        <button class="btn-ghost" @click="loadData" :disabled="loading">刷新数据</button>
        <router-link to="/app-market" class="btn-primary">浏览应用市场</router-link>
      </div>
    </header>

    <div v-if="loading" class="loading-state">加载中...</div>

    <div v-else-if="loadError" class="portal-error" role="alert">{{ loadError }}<button class="btn-ghost" @click="loadData">重新加载</button></div>

    <div v-else-if="!apps.length" class="empty-state">
      <div class="empty-icon">📦</div>
      <h3>还没装任何应用</h3>
      <p>把应用装到在线设备后，这里会汇总展示</p>
      <router-link to="/app-market" class="btn-primary">去应用市场</router-link>
    </div>

    <div v-else class="apps-grid">
      <article v-for="a in apps" :key="a.slug" class="app-card">
        <header class="app-card-head">
          <div class="app-icon">{{ categoryIcon(a.category) }}</div>
          <div class="app-info">
            <h3>{{ a.name }}</h3>
            <p class="muted">{{ a.description || a.slug }}</p>
          </div>
          <div class="app-badge">装在 {{ a.node_count }} 台</div>
        </header>

        <div class="app-stats">
          <div class="stat">
            <span class="stat-label">版本</span>
            <span class="stat-val">{{ a.version ? `v${a.version}` : '—' }}</span>
          </div>
          <div class="stat">
            <span class="stat-label">分类</span>
            <span class="stat-val">{{ a.category || 'other' }}</span>
          </div>
          <div class="stat">
            <span class="stat-label">设备</span>
            <span class="stat-val">{{ a.node_count }} 台</span>
          </div>
        </div>

        <div v-if="a.nodes?.length" class="node-chips">
          <span
            v-for="n in a.nodes.slice(0, 6)"
            :key="n.id"
            class="node-chip"
            :class="n.status"
            :title="n.id"
          >
            {{ n.name }}
            <small v-if="n.version">v{{ n.version }}</small>
          </span>
          <span v-if="a.nodes.length > 6" class="node-chip more">+{{ a.nodes.length - 6 }}</span>
        </div>

        <div class="card-footer">
          <div class="app-tags">
            <span v-for="t in (a.capability_tags || []).slice(0, 4)" :key="t" class="tag">{{ t }}</span>
          </div>
          <router-link class="link-market" :to="{ path: '/app-market' }">去应用市场管理</router-link>
        </div>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
import { errorMessage } from '../services/identityContract'
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { myApi, type MyEquipmentApp } from '../services/api'

const apps = ref<MyEquipmentApp[]>([])
const nodesWithApps = ref(0)
const totalNodes = ref(0)
const loading = ref(false)
const loadError = ref('')

const loadData = async () => {
  if (loading.value) return
  loading.value = true
  loadError.value = ''
  try {
    const data = await myApi.getMyEquipment()
    apps.value = data.apps
    nodesWithApps.value = data.nodes_with_apps
    totalNodes.value = data.total_nodes
  } catch (e: any) {
    loadError.value = '暂时无法读取已装应用，请重试。'
    ElMessage.error(errorMessage(e, '装备加载失败，请稍后重试。'))
  } finally {
    loading.value = false
  }
}

function categoryIcon(cat?: string | null): string {
  const c = String(cat || '').toLowerCase()
  if (/law|legal|法律/.test(c)) return '⚖️'
  if (/ocr/.test(c)) return '🔤'
  if (/voice|speech|audio/.test(c)) return '🎤'
  if (/data|数据/.test(c)) return '📊'
  if (/ai|llm/.test(c)) return '🤖'
  return '📦'
}

onMounted(loadData)
</script>

<style scoped>
.my-equipment {
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
}
.btn-primary:hover { background: #2563eb; }

.loading-state, .empty-state {
  text-align: center;
  padding: 60px 20px;
  background: #fff;
  border-radius: 12px;
  border: 1px solid #e2e8f0;
}
.empty-icon { font-size: 48px; margin-bottom: 12px; }
.empty-state h3 { margin: 0 0 8px; }
.empty-state p { color: #64748b; margin: 0 0 16px; }

.apps-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 14px;
}

.app-card {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 16px;
}
.app-card:hover { border-color: #3b82f6; }

.app-card-head {
  display: flex;
  align-items: start;
  gap: 12px;
  margin-bottom: 12px;
}
.app-icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: #f1f5f9;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  flex-shrink: 0;
}
.app-info { flex: 1; min-width: 0; }
.app-info h3 { margin: 0 0 4px; font-size: 16px; color: #0f172a; }
.muted { color: #64748b; font-size: 12px; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.app-badge {
  background: #eff6ff;
  color: #1d4ed8;
  font-size: 12px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 999px;
  white-space: nowrap;
}

.app-stats {
  display: flex;
  gap: 16px;
  margin-bottom: 12px;
  padding: 10px 0;
  border-top: 1px solid #f1f5f9;
  border-bottom: 1px solid #f1f5f9;
}
.stat { display: flex; flex-direction: column; gap: 2px; }
.stat-label { font-size: 11px; color: #64748b; }
.stat-val { font-size: 13px; font-weight: 600; color: #0f172a; }

.node-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}
.node-chip {
  font-size: 11px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 3px 8px;
  color: #334155;
}
.node-chip.online, .node-chip.busy { border-color: #86efac; background: #f0fdf4; }
.node-chip.offline { opacity: 0.75; }
.node-chip.more { color: #64748b; }
.node-chip small { margin-left: 4px; color: #64748b; }

.card-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.app-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.tag {
  font-size: 11px;
  background: #f1f5f9;
  color: #475569;
  padding: 2px 8px;
  border-radius: 4px;
}
.link-market {
  font-size: 12px;
  color: #2563eb;
  text-decoration: none;
  white-space: nowrap;
}
.link-market:hover { text-decoration: underline; }
</style>
