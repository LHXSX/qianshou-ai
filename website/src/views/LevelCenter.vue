<template>
  <div class="level-center">
    <header class="page-head">
      <div>
        <h1>等级中心</h1>
        <p class="sub">查看当前等级、余额门槛和服务器返回的收益倍率。</p>
      </div>
    </header>

    <div v-if="loading" class="loading-state">加载中...</div>

    <div v-else-if="loadError" class="portal-error" role="alert">{{ loadError }}<button class="btn-ghost" @click="loadData">重新加载</button></div>

    <template v-else-if="wallet">
      <!-- 当前等级大卡 -->
      <section class="level-hero">
        <div class="hero-left">
          <div class="hero-icon">{{ tierIcon(wallet.level.tier) }}</div>
          <div>
            <div class="hero-tier">{{ tierLabel(wallet.level.tier) }}</div>
            <h2 class="hero-lv">Lv.{{ wallet.level.current }}</h2>
            <p class="hero-multiplier">当前收益加成 ×{{ wallet.level.tier_multiplier }}</p>
          </div>
        </div>
        <div class="hero-right" v-if="wallet.level.next_threshold.threshold">
          <div class="next-label">距离下一级</div>
          <div class="next-remaining">
            还差 <strong>{{ wallet.level.next_threshold.remaining.toFixed(2) }}</strong> EDG
          </div>
          <div class="progress-track">
            <div
              class="progress-fill"
              :style="{ width: progressPct + '%' }"
            ></div>
          </div>
          <div class="next-info">
            升到 Lv.{{ wallet.level.next_threshold.level }}
            ({{ tierLabel(wallet.level.next_threshold.tier) }})
          </div>
        </div>
        <div v-else class="hero-right max-level">
          <div class="max-icon">👑</div>
          <h3>已达最高等级</h3>
        </div>
      </section>

      <!-- 等级对照表 -->
      <section class="panel">
        <header class="panel-head">
          <h3>等级门槛与倍率</h3>
        </header>
        <p class="sub">门槛按当前余额计算；实际收益以任务结算记录为准。</p>
        <ul class="ladder">
          <li
            v-for="lv in levels" :key="lv.level"
            :class="{ current: lv.level === wallet.level.current, achieved: lv.level <= wallet.level.current }"
          >
            <div class="ladder-icon">{{ tierIcon(lv.tier) }}</div>
            <div class="ladder-main">
              <strong>Lv.{{ lv.level }} · {{ tierLabel(lv.tier) }}</strong>
              <small>{{ lv.threshold === null ? '入门' : `余额 ${lv.threshold} EDG` }}</small>
            </div>
            <div class="ladder-mult">×{{ lv.multiplier }}</div>
            <div class="ladder-perk">{{ lv.perk }}</div>
            <div class="ladder-status">
              <span v-if="lv.level === wallet.level.current" class="badge-current">当前</span>
              <span v-else-if="lv.level < wallet.level.current" class="badge-achieved">✓</span>
              <span v-else class="badge-locked">🔒</span>
            </div>
          </li>
        </ul>
      </section>

      <!-- 节点使用建议 -->
      <section class="panel">
        <header class="panel-head">
          <h3>节点使用建议</h3>
        </header>
        <ul class="tips-list">
          <li>
            <span class="tip-icon">📦</span>
            <div>
              <strong>装更多应用</strong>
              <p>把热门应用装到在线设备，能接的任务类型更多</p>
            </div>
            <router-link to="/app-market" class="btn-mini">去应用市场</router-link>
          </li>
          <li>
            <span class="tip-icon">⏱️</span>
            <div>
              <strong>保持节点 24h 稳定</strong>
              <p>在线越稳，被派单机会越多</p>
            </div>
            <router-link to="/my-nodes" class="btn-mini">看节点</router-link>
          </li>
          <li>
            <span class="tip-icon">🎯</span>
            <div>
              <strong>专精领域</strong>
              <p>声明 specialty 后系统优先派对口任务</p>
            </div>
            <router-link to="/my-nodes" class="btn-mini">看节点</router-link>
          </li>
          <li>
            <span class="tip-icon">🚀</span>
            <div>
              <strong>升级硬件</strong>
              <p>更高配设备可承接更重的应用任务</p>
            </div>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { errorMessage } from '../services/identityContract'
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { myApi, type MyWallet } from '../services/api'

const wallet = ref<MyWallet | null>(null)
const loading = ref(false)
const loadError = ref('')

const levels = [
  { level: 1, tier: 'basic', threshold: null, multiplier: 1.0, perk: '基础派单' },
  { level: 2, tier: 'bronze', threshold: 100, multiplier: 1.1, perk: '倍率 1.1' },
  { level: 3, tier: 'silver', threshold: 500, multiplier: 1.2, perk: '倍率 1.2' },
  { level: 4, tier: 'gold', threshold: 2000, multiplier: 1.3, perk: '倍率 1.3' },
  { level: 5, tier: 'diamond', threshold: 10000, multiplier: 1.5, perk: '倍率 1.5' },
]

const progressPct = computed(() => {
  if (!wallet.value?.level.next_threshold.threshold) return 100
  const cur = wallet.value.wallet.balance
  const total = wallet.value.level.next_threshold.threshold
  // 上一级的门槛
  const prev = levels.find(l => l.level === wallet.value!.level.current)?.threshold || 0
  return Math.max(0, Math.min(100, ((cur - prev) / (total - prev)) * 100))
})

const tierIcon = (tier: string) => {
  const map: any = { basic: '🥉', bronze: '🥈', silver: '🥇', gold: '💎', diamond: '👑' }
  return map[tier] || '🥉'
}
const tierLabel = (tier: string) => {
  const map: any = { basic: '入门', bronze: '青铜', silver: '白银', gold: '黄金', diamond: '钻石' }
  return map[tier] || '入门'
}

const loadData = async () => {
  if (loading.value) return
  loading.value = true
  loadError.value = ''
  try {
    wallet.value = await myApi.getMyWallet()
  } catch (e: any) {
    loadError.value = '暂时无法读取等级，请重试。'
    ElMessage.error(errorMessage(e, '等级信息加载失败，请稍后重试。'))
  } finally {
    loading.value = false
  }
}
onMounted(loadData)
</script>

<style scoped>
.level-center {
  padding: 20px 24px;
  background: linear-gradient(180deg, #d8dfeb 0%, #c8d2e0 100%);
  color: #000000;
  min-height: 100vh;
}

.page-head { margin-bottom: 18px; }
.page-head h1 { margin: 0; font-size: 24px; font-weight: 900; color: #000; }
.sub { color: #1e293b; margin: 4px 0 0; font-size: 13px; }

.level-hero {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
  border: 1px solid #fcd34d;
  color: #ffffff;
  border-radius: 16px;
  padding: 28px;
  margin-bottom: 18px;
  position: relative;
  overflow: hidden;
}
.level-hero::before {
  content: '';
  position: absolute;
  top: -50%; right: -10%;
  width: 300px; height: 300px;
  background: radial-gradient(circle, rgba(251,191,36,0.15), transparent);
  border-radius: 50%;
  pointer-events: none;
}

.hero-left { display: flex; align-items: center; gap: 20px; position: relative; }
.hero-icon { font-size: 76px; }
.hero-tier { color: #fef3c7; font-size: 14px; font-weight: 600; letter-spacing: 1px; }
.hero-lv {
  margin: 4px 0;
  font-size: 42px;
  font-family: 'JetBrains Mono', monospace;
  color: #ffffff;
}
.hero-multiplier { color: rgba(255,255,255,0.95); margin: 0; font-size: 14px; }

.hero-right { min-width: 340px; position: relative; }
.next-label { color: rgba(255,255,255,0.85); font-size: 13px; }
.next-remaining {
  font-size: 16px;
  color: #ffffff;
  margin: 6px 0 10px;
}
.next-remaining strong {
  color: #ffffff;
  font-size: 24px;
  font-family: 'JetBrains Mono', monospace;
}
.progress-track {
  height: 10px;
  background: rgba(255,255,255,0.25);
  border-radius: 5px;
  overflow: hidden;
  margin-bottom: 8px;
}
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #ffffff, #fef3c7);
  border-radius: 5px;
  transition: width 0.8s;
}
.next-info { color: rgba(255,255,255,0.85); font-size: 12px; }

.max-level { text-align: center; }
.max-icon { font-size: 50px; }
.max-level h3 { margin: 6px 0 0; color: #fbbf24; }

.panel {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  padding: 20px;
  margin-bottom: 18px;
}
.panel-head h3 { margin: 0 0 14px 0; font-size: 15px; color: #000000; }

.ladder { list-style: none; padding: 0; margin: 0; }
.ladder li {
  display: grid;
  grid-template-columns: 50px 1fr 60px 1fr 60px;
  gap: 14px;
  align-items: center;
  padding: 12px;
  border-radius: 8px;
  background: #f8fafc;
  margin-bottom: 8px;
  border-left: 3px solid #2a3548;
  transition: all 0.2s;
}
.ladder li.achieved { border-left-color: #22c55e; opacity: 1; }
.ladder li.current {
  border-left-color: #fbbf24;
  background: rgba(251,191,36,0.05);
  transform: scale(1.02);
}
.ladder li:not(.achieved):not(.current) { opacity: 0.5; }

.ladder-icon { font-size: 26px; text-align: center; }
.ladder-main strong { color: #000000; display: block; }
.ladder-main small { color: #1e293b; font-size: 11px; }
.ladder-mult {
  font-size: 18px;
  color: #fbbf24;
  font-family: 'JetBrains Mono', monospace;
  font-weight: 700;
  text-align: center;
}
.ladder-perk { font-size: 12px; color: #0f172a; }
.ladder-status { text-align: center; }
.badge-current {
  background: #fbbf24;
  color: #000000;
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 12px;
  font-weight: 700;
}
.badge-achieved { color: #22c55e; font-size: 18px; }
.badge-locked { font-size: 16px; }

.tips-list { list-style: none; padding: 0; margin: 0; }
.tips-list li {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px;
  background: #f8fafc;
  border-radius: 10px;
  margin-bottom: 10px;
  border-left: 3px solid #3b82f6;
}
.tip-icon { font-size: 24px; }
.tips-list li > div { flex: 1; }
.tips-list li strong { color: #000000; display: block; margin-bottom: 2px; }
.tips-list li p { margin: 0; font-size: 12px; color: #1e293b; }
.btn-mini {
  background: transparent;
  border: 1px solid #3b82f6;
  color: #3b82f6;
  padding: 6px 14px;
  border-radius: 6px;
  text-decoration: none;
  font-size: 12px;
}
.btn-mini:hover { background: #3b82f6; color: #fff; }

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
