<template>
  <div class="app-market">
    <header class="page-head">
      <div>
        <h1>平台应用库</h1>
        <p class="sub">历史平台应用目录 · {{ apps.length }} 个条目。它与千手 PC 的新插件市场分开；安装结果以对应设备与服务端的实际回执为准。</p>
      </div>
      <router-link to="/my-nodes" class="btn-ghost">我的节点</router-link>
    </header>

    <div class="filter-bar">
      <button
        v-for="c in categories"
        :key="c.value"
        class="cat-btn"
        :class="{ active: category === c.value }"
        @click="category = c.value"
      >
        {{ c.label }}
      </button>
    </div>

    <div v-if="loading" class="loading-state">加载应用市场...</div>

    <div v-else-if="loadError" class="portal-error" role="alert">{{ loadError }}<button class="btn-ghost" @click="loadData">重新加载</button></div>

    <div v-else-if="!filteredApps.length" class="empty-state">
      <div class="empty-icon">🔍</div>
      <h3>暂无符合的应用</h3>
    </div>

    <div v-else class="market-grid">
      <article v-for="app in filteredApps" :key="app.slug" class="market-card">
        <header class="card-head">
          <div class="app-icon">{{ categoryIcon(app.category) }}</div>
          <div class="head-info">
            <h3>{{ app.name }}</h3>
            <p class="muted">{{ app.tagline || app.description || app.slug }}</p>
          </div>
          <div v-if="app.coming_soon" class="soon-tag">即将上线</div>
          <div v-else-if="app.requires_gpu" class="gpu-tag">GPU</div>
        </header>

        <div class="card-meta">
          <span>{{ app.category || 'other' }}</span>
          <span>·</span>
          <span>v{{ app.version || '1.0.0' }}</span>
          <span v-if="app.install_count != null">·</span>
          <span v-if="app.install_count != null">{{ app.install_count }} 次安装</span>
        </div>

        <div class="card-tags">
          <span v-for="t in (app.capability_tags || []).slice(0, 4)" :key="t" class="tag">{{ t }}</span>
        </div>

        <div class="card-footer">
          <div v-if="deviceCount(app.slug) > 0" class="installed-status">
            已装在 {{ deviceCount(app.slug) }} 台设备
            <span v-if="librarySlugs.has(app.slug)" class="lib-hint">· 库中已有</span>
          </div>
          <div v-else-if="librarySlugs.has(app.slug)" class="installed-status">
            已在应用库
          </div>
          <div v-else class="not-installed muted">尚未安装</div>

          <div class="footer-actions">
            <button
              v-if="librarySlugs.has(app.slug) || deviceCount(app.slug) > 0"
              class="btn-ghost-sm"
              :disabled="busySlug === app.slug"
              @click="openUninstall(app)"
            >
              卸载
            </button>
            <button
              class="btn-install"
              :disabled="Boolean(app.coming_soon) || busySlug === app.slug"
              @click="openInstall(app)"
            >
              {{ app.coming_soon ? '即将上线' : (deviceCount(app.slug) > 0 || librarySlugs.has(app.slug) ? '管理安装' : '安装') }}
            </button>
          </div>
        </div>
      </article>
    </div>

    <!-- 安装对话框 -->
    <div v-if="installDialog" class="dialog-mask" @click="installDialog = false">
      <div class="dialog" @click.stop>
        <h3>安装 {{ currentApp?.name }}</h3>

        <template v-if="onlineNodes.length">
          <p class="muted">选择账号下的在线设备进行远程安装：</p>
          <ul class="node-pick-list">
            <li v-for="n in onlineNodes" :key="n.id">
              <div>
                <strong>{{ n.name }}</strong>
                <span class="node-pill status-online">{{ n.status }}</span>
                <span v-if="nodeHasApp(n, currentApp?.slug)" class="node-pill already">已装</span>
              </div>
              <small>{{ n.hardware.cpu_cores }}C / {{ n.hardware.ram_gb }}GB</small>
              <button class="btn-pick" :disabled="busySlug === currentApp?.slug" @click="installToNode(n.id)">
                {{ nodeHasApp(n, currentApp?.slug) ? '再装一次' : '安装' }}
              </button>
            </li>
          </ul>
          <p class="muted fallback-hint">也可只写入账户应用库（不推送到设备）：</p>
          <button class="btn-library" :disabled="busySlug === currentApp?.slug" @click="installToLibrary">
            安装到应用库
          </button>
        </template>

        <template v-else>
          <div class="empty-mini">
            当前没有在线设备。可先将应用安装到账户应用库，设备上线后再远程安装。
          </div>
          <button class="btn-library" :disabled="busySlug === currentApp?.slug" @click="installToLibrary">
            安装到应用库
          </button>
        </template>

        <button class="btn-ghost" @click="installDialog = false">取消</button>
      </div>
    </div>

    <!-- 卸载对话框 -->
    <div v-if="uninstallDialog" class="dialog-mask" @click="uninstallDialog = false">
      <div class="dialog" @click.stop>
        <h3>卸载 {{ currentApp?.name }}</h3>
        <ul class="node-pick-list" v-if="devicesWithApp.length">
          <li v-for="n in devicesWithApp" :key="n.id">
            <div>
              <strong>{{ n.name }}</strong>
              <span :class="`node-pill status-${n.status}`">{{ n.status }}</span>
            </div>
            <small>{{ n.status === 'online' || n.status === 'busy' ? '可远程卸载' : '设备离线' }}</small>
            <button
              class="btn-pick danger"
              :disabled="(n.status !== 'online' && n.status !== 'busy') || busySlug === currentApp?.slug"
              @click="uninstallFromNode(n.id)"
            >
              从设备卸载
            </button>
          </li>
        </ul>
        <button
          v-if="currentApp && librarySlugs.has(currentApp.slug)"
          class="btn-library danger"
          :disabled="busySlug === currentApp?.slug"
          @click="uninstallFromLibrary"
        >
          从应用库卸载
        </button>
        <button class="btn-ghost" @click="uninstallDialog = false">取消</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { errorMessage } from '../services/identityContract'
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { marketplaceApi, myApi, type EcoMarketApp, type MyNode } from '../services/api'

const apps = ref<EcoMarketApp[]>([])
const myNodes = ref<MyNode[]>([])
const librarySlugs = ref<Set<string>>(new Set())
const loading = ref(false)
const loadError = ref('')
const category = ref('all')
const busySlug = ref('')

const installDialog = ref(false)
const uninstallDialog = ref(false)
const currentApp = ref<EcoMarketApp | null>(null)

const categories = [
  { value: 'all', label: '全部' },
  { value: 'legal', label: '法律' },
  { value: 'ocr', label: 'OCR' },
  { value: 'data', label: '数据' },
  { value: 'ai', label: 'AI' },
  { value: 'soon', label: '即将上线' },
]

const onlineNodes = computed(() =>
  myNodes.value.filter(n => n.status === 'online' || n.status === 'busy'),
)

const filteredApps = computed(() => {
  if (category.value === 'all') return apps.value
  if (category.value === 'soon') return apps.value.filter(a => a.coming_soon)
  return apps.value.filter(a => String(a.category || '').toLowerCase() === category.value)
})

const devicesWithApp = computed(() => {
  const slug = currentApp.value?.slug
  if (!slug) return []
  return myNodes.value.filter(n => nodeHasApp(n, slug))
})

function nodeHasApp(n: MyNode, slug?: string | null): boolean {
  if (!slug) return false
  const list = n.capabilities?.installed_apps || []
  return list.some(a => typeof a === 'string' ? a === slug : a.slug === slug)
}

function deviceCount(slug: string): number {
  return myNodes.value.filter(n => nodeHasApp(n, slug)).length
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

async function loadData() {
  if (loading.value) return
  loading.value = true
  loadError.value = ''
  try {
    const [appList, nodes, lib] = await Promise.all([
      marketplaceApi.listApps({ sort: 'popular', page_size: 100 }),
      myApi.getMyNodes(),
      marketplaceApi.myLibrary(),
    ])
    apps.value = appList
    myNodes.value = nodes
    librarySlugs.value = new Set(lib.map(i => i.slug).filter(Boolean))
  } catch (e: any) {
    loadError.value = '暂时无法读取应用市场，请重试。'
    ElMessage.error(errorMessage(e, '应用市场加载失败，请稍后重试。'))
  } finally {
    loading.value = false
  }
}

function openInstall(app: EcoMarketApp) {
  if (app.coming_soon) return
  currentApp.value = app
  installDialog.value = true
}

function openUninstall(app: EcoMarketApp) {
  currentApp.value = app
  uninstallDialog.value = true
}

async function installToNode(nodeId: string) {
  if (!currentApp.value) return
  busySlug.value = currentApp.value.slug
  try {
    const out = await marketplaceApi.provisionApp(currentApp.value.slug, nodeId)
    if (out.delivered) {
      ElMessage.success(`已向「${out.worker_name || '设备'}」下发安装指令`)
    } else {
      ElMessage.warning('已写入应用库，但设备暂时未收到指令（可能刚断线），请稍后重试')
    }
    installDialog.value = false
    await loadData()
  } catch (e: any) {
    ElMessage.error(errorMessage(e, '远程安装失败，请稍后重试。'))
  } finally {
    busySlug.value = ''
  }
}

async function installToLibrary() {
  if (!currentApp.value) return
  busySlug.value = currentApp.value.slug
  try {
    await marketplaceApi.installApp(currentApp.value.slug)
    ElMessage.success(`已安装到应用库：${currentApp.value.name}`)
    installDialog.value = false
    await loadData()
  } catch (e: any) {
    ElMessage.error(errorMessage(e, '安装失败，请稍后重试。'))
  } finally {
    busySlug.value = ''
  }
}

async function uninstallFromNode(nodeId: string) {
  if (!currentApp.value) return
  busySlug.value = currentApp.value.slug
  try {
    const out = await marketplaceApi.deprovisionApp(currentApp.value.slug, nodeId)
    if (out.delivered) {
      ElMessage.success(`已向设备下发卸载指令`)
    } else {
      ElMessage.warning('卸载指令未能送达设备，请确认设备在线后重试')
    }
    await loadData()
  } catch (e: any) {
    ElMessage.error(errorMessage(e, '远程卸载失败，请稍后重试。'))
  } finally {
    busySlug.value = ''
  }
}

async function uninstallFromLibrary() {
  if (!currentApp.value) return
  busySlug.value = currentApp.value.slug
  try {
    await marketplaceApi.uninstallApp(currentApp.value.slug)
    ElMessage.success(`已从应用库卸载：${currentApp.value.name}`)
    uninstallDialog.value = false
    await loadData()
  } catch (e: any) {
    ElMessage.error(errorMessage(e, '卸载失败，请稍后重试。'))
  } finally {
    busySlug.value = ''
  }
}

onMounted(loadData)
</script>

<style scoped>
.app-market {
  padding: 20px 24px;
  background: linear-gradient(180deg, #d8dfeb 0%, #c8d2e0 100%);
  color: #000;
  min-height: 100vh;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 18px;
}
.page-head h1 { margin: 0; font-size: 24px; font-weight: 900; }
.sub { color: #1e293b; margin: 4px 0 0; font-size: 13px; }
.btn-ghost {
  background: transparent;
  color: #1e293b;
  border: 1px solid #e2e8f0;
  padding: 8px 18px;
  border-radius: 8px;
  text-decoration: none;
  font-size: 13px;
  cursor: pointer;
}
.btn-ghost:hover { border-color: #3b82f6; color: #3b82f6; }
.filter-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 18px;
  flex-wrap: wrap;
  background: #fff;
  padding: 12px;
  border-radius: 10px;
  border: 1px solid #e2e8f0;
}
.cat-btn {
  background: transparent;
  border: 1px solid transparent;
  color: #1e293b;
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.cat-btn.active { background: #3b82f6; color: #fff; }
.cat-btn:hover:not(.active) { border-color: #3b82f6; color: #3b82f6; }
.market-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 14px;
}
.market-card {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  box-shadow:
    0 1px 2px rgba(15, 23, 42, 0.04),
    0 4px 16px rgba(15, 23, 42, 0.06);
}
.market-card:hover {
  border-color: #3b82f6;
  transform: translateY(-2px);
  transition: all 0.2s;
}
.card-head {
  display: flex;
  align-items: start;
  gap: 12px;
  margin-bottom: 12px;
}
.app-icon {
  font-size: 28px;
  width: 52px;
  height: 52px;
  background: rgba(59, 130, 246, 0.12);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.head-info { flex: 1; min-width: 0; }
.head-info h3 { margin: 0; font-size: 15px; }
.head-info p {
  margin: 4px 0 0;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.muted { color: #1e293b; }
.gpu-tag, .soon-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 8px;
  white-space: nowrap;
  height: 20px;
}
.gpu-tag { background: rgba(168, 85, 247, 0.15); color: #a855f7; }
.soon-tag { background: rgba(245, 158, 11, 0.15); color: #d97706; }
.card-meta {
  display: flex;
  gap: 4px;
  font-size: 12px;
  color: #1e293b;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.card-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.tag {
  background: #f1f5f9;
  color: #1e293b;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 6px;
}
.card-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid #f1f5f9;
  gap: 8px;
}
.installed-status { color: #22c55e; font-size: 12px; }
.lib-hint { color: #64748b; }
.not-installed { font-size: 12px; }
.footer-actions { display: flex; gap: 8px; flex-shrink: 0; }
.btn-install {
  background: #3b82f6;
  color: #fff;
  border: none;
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}
.btn-install:hover:not(:disabled) { background: #2563eb; }
.btn-install:disabled { opacity: 0.55; cursor: not-allowed; }
.btn-ghost-sm {
  background: transparent;
  color: #64748b;
  border: 1px solid #e2e8f0;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}
.dialog-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
}
.dialog {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 24px;
  width: 460px;
  max-width: 90vw;
  max-height: 80vh;
  overflow: auto;
}
.dialog h3 { margin: 0 0 6px; }
.dialog p { margin: 0 0 14px; font-size: 13px; }
.fallback-hint { margin-top: 8px !important; }
.node-pick-list { list-style: none; padding: 0; margin: 0 0 14px; }
.node-pick-list li {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 10px;
  align-items: center;
  background: #fff;
  padding: 10px 14px;
  border-radius: 8px;
  margin-bottom: 8px;
}
.node-pick-list li strong { margin-right: 8px; }
.node-pill {
  font-size: 10px;
  padding: 1px 8px;
  border-radius: 6px;
  background: #f1f5f9;
  color: #1e293b;
}
.node-pill.status-online, .node-pill.status-busy {
  background: rgba(34, 197, 94, 0.15);
  color: #22c55e;
}
.node-pill.already {
  background: rgba(59, 130, 246, 0.12);
  color: #2563eb;
}
.node-pick-list small {
  color: #1e293b;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
}
.btn-pick {
  background: #3b82f6;
  color: #fff;
  border: none;
  padding: 5px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 11px;
}
.btn-pick:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-pick.danger, .btn-library.danger { background: #ef4444; }
.btn-library {
  display: block;
  width: 100%;
  background: #0f172a;
  color: #fff;
  border: none;
  padding: 10px 14px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  margin-bottom: 10px;
}
.btn-library:disabled { opacity: 0.55; cursor: not-allowed; }
.empty-mini { text-align: center; padding: 24px 0; color: #334155; font-size: 13px; }
.empty-state { text-align: center; padding: 60px 20px; color: #334155; }
.empty-icon { font-size: 60px; margin-bottom: 14px; }
.empty-state h3 { color: #0f172a; margin: 0 0 8px; }
.loading-state { text-align: center; padding: 40px; color: #334155; }
</style>
