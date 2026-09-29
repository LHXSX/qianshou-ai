<template>
  <div class="rm-page">
    <!-- ════════ 顶栏 ════════ -->
    <header class="topbar">
      <router-link to="/" class="brand">
        <span class="brand-mark">⚡</span>
        <span class="brand-name">千手算力</span>
      </router-link>
      <nav class="topnav">
        <router-link to="/downloads-center">下载</router-link>
        <router-link to="/runtime-mirrors" class="active">镜像中心</router-link>
        <router-link to="/about">关于</router-link>
        <router-link to="/" class="topnav-back">← 首页</router-link>
      </nav>
    </header>

    <main class="main" v-if="manifest">
      <!-- ════════ Hero ════════ -->
      <section class="hero">
        <div class="hero-meta">
          <span class="ver-tag">runtime mirrors</span>
          <span class="ver-dot">·</span>
          <span class="ver-date">{{ formatTime(manifest.updated_at) }}</span>
          <span class="ver-dot">·</span>
          <span class="ver-stat">{{ totalSources }} 个源 · {{ domesticPercent }}% 国内加速</span>
        </div>
        <h1 class="hero-title">一行命令<br>装好节点跑任务的全部环境</h1>
        <p class="hero-sub">{{ manifest.tip || manifest.intro }}</p>

        <div class="plat-tabs" role="tablist">
          <button
            v-for="p in platforms"
            :key="p.id"
            :class="{ active: activePlatform === p.id }"
            @click="activePlatform = p.id"
          >
            <span>{{ p.icon }}</span> {{ p.name }}
          </button>
        </div>
        <div class="plat-hint">
          当前显示: <strong>{{ effectivePlatformLabel }}</strong>
        </div>
      </section>

      <!-- ════════ 快速跳转 chips ════════ -->
      <section class="quick-jump" v-if="manifest.categories.length">
        <h2 class="sec-title">
          <span>所有类别</span>
          <span class="sec-sub">{{ manifest.categories.length }} 类 · 点跳转</span>
        </h2>
        <div class="chips-row">
          <button
            v-for="c in manifest.categories"
            :key="c.id"
            class="cat-chip"
            @click="jumpToCategory(c.id)"
          >
            <span>{{ categoryIcon(c.icon) }}</span>
            <span>{{ shortCatName(c.name) }}</span>
            <span class="chip-count">{{ c.sources?.length || 0 }}</span>
          </button>
        </div>
      </section>

      <!-- ════════ 第一次用 · 折叠教程 ════════ -->
      <section class="howto-section">
        <details>
          <summary>
            <span class="sec-title-inline">第一次用? 看 30 秒怎么跑命令</span>
            <span class="caret">▾</span>
          </summary>
          <div class="howto-body">
            <ol class="howto-list">
              <li v-if="effectivePlatform === 'windows'">
                <strong>开 PowerShell</strong> · 按 <kbd>Win</kbd>+<kbd>X</kbd> · 选「终端 (管理员)」
              </li>
              <li v-else-if="effectivePlatform === 'macos'">
                <strong>开终端</strong> · <kbd>Cmd</kbd>+<kbd>Space</kbd> → 输 <code>terminal</code> → 回车
              </li>
              <li v-else>
                <strong>开终端</strong> · <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>T</kbd>
              </li>
              <li>从下面任意一张源卡 · 点 <strong>复制</strong> · 终端粘贴 · 回车</li>
              <li>装完跑「验证」命令 (如 <code>python --version</code>) · 看到版本号就成功</li>
            </ol>
          </div>
        </details>
      </section>

      <!-- ════════ 分类内容 · 单列 · 折叠 ════════ -->
      <section
        v-for="c in manifest.categories"
        :key="c.id"
        :id="'cat-' + c.id"
        class="cat-block"
      >
        <div class="cat-head">
          <span class="cat-icon">{{ categoryIcon(c.icon) }}</span>
          <div class="cat-meta">
            <h3 class="cat-title">{{ c.name }}</h3>
            <p class="cat-tagline">{{ c.tagline }}</p>
          </div>
          <span class="cat-counter">{{ visibleSources(c).length }} 个源</span>
        </div>

        <div v-if="c.why_needed || c.version_hint" class="cat-info">
          <p v-if="c.why_needed"><strong>为啥要装:</strong> {{ c.why_needed }}</p>
          <p v-if="c.version_hint"><strong>前置:</strong> {{ c.version_hint }}</p>
        </div>

        <ul class="src-list">
          <li
            v-for="(s, idx) in visibleSources(c)"
            :key="s.name + idx"
            class="src-row"
          >
            <div class="src-head">
              <div class="src-info">
                <div class="src-name">{{ s.name }}</div>
                <div class="src-meta">
                  <span
                    class="region-tag"
                    :style="{ background: regionColor(s.region) + '14', color: regionColor(s.region) }"
                  >{{ regionLabel(s.region) }}</span>
                  <span v-if="s.speed_hint" class="src-hint">{{ s.speed_hint }}</span>
                  <a v-if="s.homepage" :href="s.homepage" target="_blank" rel="noopener" class="src-link">官网 ↗</a>
                </div>
              </div>
            </div>

            <div
              v-for="(blk, key) in pickPlatformBlocks(s)"
              :key="key"
              class="cmd-block"
            >
              <div class="cmd-bar">
                <span class="cmd-tag">{{ platformIcon(key) }} {{ platformName(key) }}</span>
                <span v-if="blk.title" class="cmd-title">{{ blk.title }}</span>
              </div>
              <div v-if="blk.cmd" class="cmd-wrap">
                <pre><code>{{ blk.cmd }}</code></pre>
                <button class="cmd-copy" @click="copy(blk.cmd, $event)">复制</button>
              </div>
              <div v-else-if="blk.url" class="cmd-wrap">
                <a :href="blk.url" target="_blank" rel="noopener" class="cmd-link">{{ blk.url }} ↗</a>
              </div>
            </div>
          </li>
        </ul>

        <div v-if="c.verify_cmd" class="verify-row">
          <span class="verify-label">装完验证:</span>
          <code>{{ c.verify_cmd }}</code>
          <button @click="copy(c.verify_cmd!, $event)">复制</button>
        </div>
      </section>

      <!-- ════════ 缺源反馈 ════════ -->
      <section class="feedback">
        <p>
          缺源 / 链接失效 / 想加新 runtime?
          <a href="mailto:contact@qianshousuanli.com">contact@qianshousuanli.com</a>
          · 后端 JSON 改完立即生效
        </p>
      </section>
    </main>

    <!-- 加载失败 -->
    <main class="main" v-else-if="loadError">
      <div class="error-box">
        <h2>加载失败</h2>
        <p>{{ loadError }}</p>
        <button @click="loadManifest" class="retry-btn">重试</button>
      </div>
    </main>

    <!-- 加载中 -->
    <main class="main" v-else>
      <div class="loading-box">加载中…</div>
    </main>

    <!-- ════════ 页脚 ════════ -->
    <footer class="footer">
      <div class="ft-inner">
        <div class="ft-left">
          <span class="ft-logo">⚡</span>
          <div>
            <div class="ft-name">千手算力 EdgeCompute</div>
            <div class="ft-tag">环境镜像中心 · 一行命令搞定 runtime</div>
          </div>
        </div>
        <div class="ft-right">
          <router-link to="/downloads-center">客户端下载</router-link>
          <router-link to="/about">关于我们</router-link>
          <a href="mailto:contact@qianshousuanli.com">合作联系</a>
        </div>
      </div>
      <!-- 公司主体单一信源见 platform_v8/core/company.py / src/config/site.ts -->
      <div class="ft-copy">© 2026 千手算力 · 沈阳千手执棋网络科技有限公司 · <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener" style="color:inherit">辽ICP备2026012682号</a></div>
    </footer>

    <!-- 回顶 -->
    <button v-if="showBackTop" class="back-top" @click="scrollToTop">↑</button>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()

interface PlatformBlock { title?: string; url?: string; cmd?: string }
interface Source {
  name: string
  region?: string
  speed_hint?: string
  homepage?: string
  platforms?: Record<string, PlatformBlock>
}
interface Category {
  id: string
  name: string
  icon?: string
  tagline?: string
  version_hint?: string
  why_needed?: string
  verify_cmd?: string
  sources: Source[]
}
interface Manifest {
  schema_version: string
  updated_at: string
  intro: string
  tip?: string
  regions: Record<string, { label: string; color: string }>
  categories: Category[]
}

const manifest = ref<Manifest | null>(null)
const loadError = ref('')
const showBackTop = ref(false)

type PlatformKey = 'auto' | 'windows' | 'macos' | 'linux'
const platforms: { id: PlatformKey; name: string; icon: string }[] = [
  { id: 'auto',    name: '自动识别', icon: '✨' },
  { id: 'macos',   name: 'macOS',    icon: '🍎' },
  { id: 'windows', name: 'Windows',  icon: '🪟' },
  { id: 'linux',   name: 'Linux',    icon: '🐧' },
]
const activePlatform = ref<PlatformKey>('auto')

function detectPlatform(): 'windows' | 'macos' | 'linux' {
  if (typeof navigator === 'undefined') return 'macos'
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('mac')) return 'macos'
  if (ua.includes('win')) return 'windows'
  return 'linux'
}
const effectivePlatform = computed<'windows' | 'macos' | 'linux'>(() => {
  if (activePlatform.value === 'auto') return detectPlatform()
  return activePlatform.value
})
const effectivePlatformLabel = computed(() => {
  if (effectivePlatform.value === 'windows') return '🪟 Windows'
  if (effectivePlatform.value === 'macos')   return '🍎 macOS'
  return '🐧 Linux'
})

const totalSources = computed(() => {
  if (!manifest.value) return 0
  return manifest.value.categories.reduce((s, c) => s + (c.sources?.length || 0), 0)
})
const domesticPercent = computed(() => {
  if (!manifest.value) return 0
  let dom = 0, total = 0
  for (const c of manifest.value.categories) {
    for (const s of c.sources || []) {
      total++
      if (s.region === 'domestic_recommended' || s.region === 'domestic_backup' || s.region === 'package_manager') dom++
    }
  }
  return total > 0 ? Math.round(dom / total * 100) : 0
})

function visibleSources(c: Category): Source[] {
  return (c.sources || []).filter((s) => sourceMatchesPlatform(s))
}
function sourceMatchesPlatform(s: Source): boolean {
  if (!s.platforms) return true
  if (s.platforms['all']) return true
  return Boolean(s.platforms[effectivePlatform.value])
}
function pickPlatformBlocks(s: Source): Record<string, PlatformBlock> {
  if (!s.platforms) return {}
  const out: Record<string, PlatformBlock> = {}
  if (s.platforms['all']) out['all'] = s.platforms['all']
  const cur = effectivePlatform.value
  if (s.platforms[cur]) out[cur] = s.platforms[cur]
  return out
}

function platformIcon(k: string): string {
  if (k === 'all')     return '✦'
  if (k === 'windows') return '🪟'
  if (k === 'macos')   return '🍎'
  if (k === 'linux')   return '🐧'
  return '·'
}
function platformName(k: string): string {
  if (k === 'all')     return '全平台'
  if (k === 'windows') return 'Windows'
  if (k === 'macos')   return 'macOS'
  if (k === 'linux')   return 'Linux'
  return k
}
function regionLabel(r?: string): string {
  if (!r || !manifest.value) return '其他'
  return manifest.value.regions?.[r]?.label || r
}
function regionColor(r?: string): string {
  if (!r || !manifest.value) return '#71717a'
  return manifest.value.regions?.[r]?.color || '#71717a'
}
function categoryIcon(name?: string): string {
  const map: Record<string, string> = {
    package: '📦', python: '🐍', node: '⬡', ffmpeg: '🎬', cuda: '⚡',
    pytorch: '🔥', git: '🔱', uv: '🦄', ollama: '🦙',
  }
  return name ? (map[name] || '📦') : '📦'
}
function shortCatName(name: string): string {
  const cut = name.split(/[(（]/)[0].trim()
  return cut.length > 20 ? cut.slice(0, 18) + '…' : cut
}
function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch { return iso }
}

async function copy(text: string, evt?: MouseEvent) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta); ta.select()
    try { document.execCommand('copy') } catch {}
    document.body.removeChild(ta)
  }
  if (evt?.target instanceof HTMLElement) {
    const btn = evt.target as HTMLButtonElement
    const orig = btn.textContent
    btn.textContent = '✓ 已复制'
    btn.classList.add('copied')
    setTimeout(() => {
      btn.textContent = orig || '复制'
      btn.classList.remove('copied')
    }, 1500)
  }
}

function jumpToCategory(id: string) {
  setTimeout(() => {
    const el = document.getElementById('cat-' + id)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, 30)
}
function scrollToTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function onScroll() {
  showBackTop.value = window.scrollY > 400
}

async function loadManifest() {
  loadError.value = ''
  try {
    const r = await fetch('/downloads/latest/runtime-mirrors.json', { cache: 'no-cache' })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const data = await r.json() as Manifest
    if (!data || !Array.isArray(data.categories)) throw new Error('数据结构不合法')
    manifest.value = data
    setTimeout(() => {
      const hash = (route.hash || '').replace('#', '')
      if (hash) jumpToCategory(hash)
    }, 80)
  } catch (e: any) {
    loadError.value = e?.message || '加载失败'
  }
}

onMounted(() => {
  loadManifest()
  window.addEventListener('scroll', onScroll, { passive: true })
})
onUnmounted(() => {
  window.removeEventListener('scroll', onScroll)
})
</script>

<style scoped>
/* ════════ 基础 ════════ */
.rm-page {
  min-height: 100vh;
  background: #fafafa;
  color: #18181b;
  font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* ════════ 顶栏 ════════ */
.topbar {
  position: sticky; top: 0; z-index: 50;
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: saturate(180%) blur(16px);
  border-bottom: 1px solid #e4e4e7;
  padding: 14px 32px;
  display: flex; justify-content: space-between; align-items: center;
}
.brand { display: inline-flex; align-items: center; gap: 10px; text-decoration: none; }
.brand-mark {
  display: inline-grid; place-items: center;
  width: 28px; height: 28px; background: #18181b; color: #fff;
  border-radius: 6px; font-size: 14px;
}
.brand-name {
  font-size: 15px; font-weight: 600; color: #18181b;
  letter-spacing: -0.01em;
}
.topnav { display: flex; gap: 28px; align-items: center; }
.topnav a {
  font-size: 14px; color: #52525b; text-decoration: none;
  font-weight: 500; transition: color 0.15s;
}
.topnav a:hover, .topnav a.active { color: #18181b; }
.topnav a.active {
  font-weight: 600;
  position: relative;
}
.topnav a.active::after {
  content: ''; position: absolute; bottom: -18px; left: 0; right: 0;
  height: 2px; background: #18181b;
}
.topnav-back { color: #71717a; font-size: 13px; }

/* ════════ Main ════════ */
.main {
  max-width: 760px;
  margin: 0 auto;
  padding: 56px 32px 24px;
}

/* ════════ Hero ════════ */
.hero { margin-bottom: 40px; }
.hero-meta {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  font-size: 13px; color: #71717a;
  margin-bottom: 16px;
}
.ver-tag {
  background: #18181b; color: #fff;
  padding: 3px 10px; border-radius: 4px;
  font-weight: 600; font-size: 12px;
  letter-spacing: 0.02em; text-transform: lowercase;
}
.ver-dot { color: #d4d4d8; }
.ver-date { font-variant-numeric: tabular-nums; }
.ver-stat { font-weight: 500; color: #3f3f46; }

.hero-title {
  font-size: 38px; font-weight: 700;
  letter-spacing: -0.025em; line-height: 1.15;
  margin: 0 0 12px; color: #09090b;
}
.hero-sub {
  font-size: 16px; color: #52525b;
  line-height: 1.6; margin: 0 0 24px;
  max-width: 620px;
}

/* ════════ 平台 tabs ════════ */
.plat-tabs {
  display: inline-flex;
  background: #f4f4f5; border: 1px solid #e4e4e7;
  border-radius: 8px; padding: 4px; gap: 2px;
  margin-bottom: 8px;
}
.plat-tabs button {
  padding: 7px 14px;
  background: transparent; border: none; border-radius: 6px;
  font-family: inherit; font-size: 13px; font-weight: 600;
  color: #52525b; cursor: pointer;
  transition: all 0.15s;
  display: inline-flex; align-items: center; gap: 5px;
}
.plat-tabs button:hover:not(.active) { color: #18181b; }
.plat-tabs button.active {
  background: #fff; color: #18181b;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04);
}
.plat-hint { font-size: 12.5px; color: #a1a1aa; }
.plat-hint strong { color: #3f3f46; font-weight: 600; }

/* ════════ sec-title ════════ */
.sec-title {
  display: flex; align-items: baseline; gap: 10px;
  font-size: 15px; font-weight: 600; color: #09090b;
  margin: 0 0 16px; letter-spacing: -0.005em;
}
.sec-sub {
  font-size: 12.5px; font-weight: 400; color: #a1a1aa;
}

/* ════════ 快速跳转 chips ════════ */
.quick-jump { margin-bottom: 32px; }
.chips-row {
  display: flex; flex-wrap: wrap; gap: 8px;
}
.cat-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 14px;
  background: #fff; border: 1px solid #e4e4e7;
  border-radius: 999px;
  font-size: 13px; color: #52525b; font-weight: 500;
  cursor: pointer; font-family: inherit;
  transition: all 0.15s;
}
.cat-chip:hover {
  background: #18181b; color: #fff; border-color: #18181b;
}
.cat-chip:hover .chip-count {
  background: rgba(255,255,255,0.2); color: #fff;
}
.chip-count {
  background: #f4f4f5; color: #71717a;
  font-size: 11px; padding: 1px 7px; border-radius: 999px;
  font-weight: 600; font-variant-numeric: tabular-nums;
}

/* ════════ howto · 折叠 ════════ */
.howto-section {
  margin-bottom: 32px;
  background: #fff; border: 1px solid #e4e4e7;
  border-radius: 10px;
}
.howto-section summary {
  list-style: none; cursor: pointer;
  padding: 14px 20px;
  display: flex; justify-content: space-between; align-items: center;
  user-select: none;
}
.howto-section summary::-webkit-details-marker { display: none; }
.howto-section summary:hover { background: #fafafa; }
.howto-section[open] summary { border-bottom: 1px solid #f4f4f5; }
.sec-title-inline {
  font-size: 14px; font-weight: 600; color: #18181b;
}
.caret { color: #a1a1aa; font-size: 12px; transition: transform 0.2s; }
.howto-section details[open] .caret,
.howto-section[open] .caret { transform: rotate(180deg); }

.howto-body { padding: 8px 22px 18px; }
.howto-list {
  margin: 0; padding-left: 22px;
  font-size: 13.5px; color: #3f3f46; line-height: 1.7;
}
.howto-list li { padding: 4px 0; }
.howto-list strong { color: #18181b; font-weight: 600; }
.howto-list code, .howto-list kbd {
  background: #f4f4f5; color: #18181b;
  font-family: ui-monospace, monospace;
  font-size: 12px; padding: 1px 6px;
  border-radius: 4px;
}
.howto-list kbd { border: 1px solid #d4d4d8; box-shadow: 0 1px 0 #d4d4d8; }

/* ════════ 分类 block ════════ */
.cat-block {
  margin-bottom: 36px;
  scroll-margin-top: 80px;
}
.cat-head {
  display: flex; align-items: flex-start; gap: 12px;
  padding: 0 0 14px;
  border-bottom: 1px solid #e4e4e7;
  margin-bottom: 16px;
}
.cat-icon {
  font-size: 24px; line-height: 1; padding-top: 2px;
}
.cat-meta { flex: 1; min-width: 0; }
.cat-title {
  font-size: 18px; font-weight: 700;
  color: #09090b; margin: 0; letter-spacing: -0.01em;
}
.cat-tagline {
  font-size: 13px; color: #71717a;
  margin: 4px 0 0; line-height: 1.5;
}
.cat-counter {
  flex-shrink: 0;
  background: #f4f4f5; color: #52525b;
  font-size: 12px; font-weight: 600;
  padding: 4px 10px; border-radius: 999px;
}

.cat-info {
  background: #fafafa;
  border: 1px solid #f4f4f5;
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 14px;
  font-size: 12.5px;
  color: #52525b;
  line-height: 1.6;
}
.cat-info p { margin: 0; }
.cat-info p + p { margin-top: 4px; }
.cat-info strong { color: #18181b; font-weight: 600; }

/* ════════ source list (单列) ════════ */
.src-list {
  list-style: none; padding: 0; margin: 0;
  display: flex; flex-direction: column; gap: 12px;
}
.src-row {
  background: #fff; border: 1px solid #e4e4e7;
  border-radius: 10px; padding: 14px 18px;
  transition: border-color 0.15s;
}
.src-row:hover { border-color: #d4d4d8; }
.src-head { margin-bottom: 10px; }
.src-info { display: flex; flex-direction: column; gap: 6px; }
.src-name {
  font-size: 14px; font-weight: 600; color: #18181b;
}
.src-meta {
  display: flex; align-items: center; gap: 10px;
  flex-wrap: wrap;
  font-size: 12px; color: #71717a;
}
.region-tag {
  padding: 2px 9px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.01em;
}
.src-hint { color: #a1a1aa; }
.src-link {
  color: #52525b; text-decoration: none;
  font-weight: 500;
}
.src-link:hover { color: #18181b; }

/* ════════ 命令块 ════════ */
.cmd-block {
  margin-top: 10px;
}
.cmd-bar {
  display: flex; align-items: center; gap: 10px;
  font-size: 11.5px;
  color: #71717a;
  margin-bottom: 4px;
}
.cmd-tag {
  background: #f4f4f5; color: #52525b;
  padding: 2px 8px; border-radius: 4px;
  font-weight: 600; font-size: 11px;
}
.cmd-title {
  color: #3f3f46;
  font-weight: 500;
  font-size: 12px;
}
.cmd-wrap {
  position: relative;
  background: #18181b;
  border-radius: 8px;
  padding: 12px 80px 12px 16px;
}
.cmd-wrap pre {
  margin: 0;
  font-family: ui-monospace, 'SF Mono', 'JetBrains Mono', monospace;
  font-size: 12.5px;
  color: #e4e4e7;
  overflow-x: auto;
  white-space: pre;
  line-height: 1.5;
}
.cmd-wrap code { font-family: inherit; }
.cmd-link {
  font-family: ui-monospace, monospace;
  font-size: 12.5px;
  color: #93c5fd;
  text-decoration: none;
  word-break: break-all;
}
.cmd-link:hover { color: #bfdbfe; }
.cmd-copy {
  position: absolute; top: 50%; right: 10px;
  transform: translateY(-50%);
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.15);
  color: #e4e4e7;
  padding: 5px 12px; border-radius: 6px;
  font-size: 12px; cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}
.cmd-copy:hover { background: rgba(255,255,255,0.14); }
.cmd-copy.copied {
  background: #10b981; border-color: #10b981; color: #fff;
}

/* ════════ verify ════════ */
.verify-row {
  margin-top: 14px;
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px;
  background: #fafafa; border: 1px solid #e4e4e7;
  border-radius: 8px;
  font-size: 12.5px;
}
.verify-label {
  color: #71717a; font-weight: 600;
  flex-shrink: 0;
}
.verify-row code {
  flex: 1;
  font-family: ui-monospace, 'SF Mono', monospace;
  font-size: 12px;
  color: #18181b;
  word-break: break-all;
}
.verify-row button {
  background: #fff; border: 1px solid #d4d4d8;
  color: #52525b;
  padding: 4px 12px; border-radius: 6px;
  font-size: 11.5px; cursor: pointer;
  font-family: inherit;
  flex-shrink: 0;
}
.verify-row button:hover { color: #18181b; }
.verify-row button.copied { background: #10b981; color: #fff; border-color: #10b981; }

/* ════════ feedback ════════ */
.feedback {
  margin-top: 40px;
  padding: 16px 20px;
  background: #fafafa;
  border: 1px solid #e4e4e7;
  border-radius: 10px;
  text-align: center;
}
.feedback p {
  margin: 0; font-size: 13px;
  color: #71717a; line-height: 1.6;
}
.feedback a {
  color: #18181b; font-weight: 600;
  text-decoration: none;
}
.feedback a:hover { text-decoration: underline; }

/* ════════ error / loading ════════ */
.error-box, .loading-box {
  margin: 80px auto; text-align: center;
  padding: 40px 32px;
  background: #fff; border: 1px solid #e4e4e7;
  border-radius: 12px;
}
.error-box h2 {
  font-size: 18px; color: #18181b; margin: 0 0 8px;
}
.error-box p {
  font-size: 13px; color: #71717a; margin: 0 0 16px;
}
.retry-btn {
  background: #18181b; color: #fff; border: none;
  padding: 8px 22px; border-radius: 8px;
  font-size: 13px; font-weight: 600;
  cursor: pointer; font-family: inherit;
}
.loading-box {
  font-size: 14px; color: #71717a;
}

/* ════════ footer ════════ */
.footer {
  max-width: 760px; margin: 60px auto 0;
  padding: 28px 32px 32px;
  border-top: 1px solid #e4e4e7;
}
.ft-inner {
  display: flex; justify-content: space-between; align-items: center;
  gap: 24px; flex-wrap: wrap;
}
.ft-left { display: flex; align-items: center; gap: 12px; }
.ft-logo {
  display: grid; place-items: center;
  width: 32px; height: 32px;
  background: #18181b; color: #fff;
  border-radius: 7px; font-size: 15px;
}
.ft-name { font-size: 14px; font-weight: 600; color: #18181b; }
.ft-tag { font-size: 12px; color: #71717a; margin-top: 2px; }
.ft-right { display: flex; gap: 20px; flex-wrap: wrap; }
.ft-right a {
  font-size: 13px; color: #71717a; text-decoration: none;
}
.ft-right a:hover { color: #18181b; }
.ft-copy {
  margin-top: 20px; padding-top: 16px;
  border-top: 1px solid #f4f4f5;
  font-size: 12px; color: #a1a1aa; text-align: center;
}

/* ════════ 回顶 ════════ */
.back-top {
  position: fixed; bottom: 32px; right: 32px;
  width: 40px; height: 40px;
  background: #18181b; color: #fff;
  border: none; border-radius: 999px;
  font-size: 18px; cursor: pointer;
  box-shadow: 0 4px 16px rgba(0,0,0,0.15);
  z-index: 40;
  transition: all 0.2s;
}
.back-top:hover { transform: translateY(-2px); }

/* ════════ 响应式 ════════ */
@media (max-width: 640px) {
  .main { padding: 32px 18px 18px; }
  .hero-title { font-size: 28px; }
  .hero-sub { font-size: 14.5px; }
  .topnav { gap: 16px; }
  .footer { padding: 24px 18px; }
  .ft-inner { flex-direction: column; align-items: flex-start; }
  .cmd-wrap { padding: 10px 68px 10px 12px; }
  .cmd-wrap pre { font-size: 11.5px; }
  .back-top { right: 18px; bottom: 18px; }
}
</style>
