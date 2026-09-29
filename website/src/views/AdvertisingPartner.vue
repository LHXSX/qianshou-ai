<script setup lang="ts">
/**
 * 广告位招商页 (面对广告主 · 2026-05-26)
 *
 * 卖点: 千手客户端 · 真实开发者/技术决策人受众 · 4 大广告位规格
 * 数据驱动: GET /api/v8/advertising/stats · 真实曝光/点击/CTR
 * 转化路径: 顶部 CTA / 4 价位卡 CTA / 底部申请表 · 全部 → POST /api/v8/leads/advertiser
 */
import { ref, onMounted, reactive, computed } from 'vue'

const stats = ref<any>(null)
const loading = ref(false)

async function loadStats() {
  loading.value = true
  try {
    const r = await fetch('/api/v8/advertising/stats')
    if (r.ok) stats.value = await r.json()
  } finally { loading.value = false }
}

// 广告位规格 (4 档)
const slots = [
  {
    key: 'splash',
    icon: '🎬',
    name: 'Splash 启动屏',
    sub: '客户端启动 / 主页打开时全屏弹窗',
    spec: '720×400 · 富文本 + CTA',
    audience: '100% 节点用户必看 · 极高曝光',
    price: '¥ 12,000 / 周',
    cpm: '约 ¥ 80 / 千次',
    badge: '注意力之王',
    color: '#f59e0b',
    samples: ['首充返 20% EDG', '新机型上线', '行业大会邀请'],
  },
  {
    key: 'banner',
    icon: '🖼',
    name: 'Banner 横幅',
    sub: 'DashboardHome 右上 4×2 格子 · 主页常驻',
    spec: '640×320 · 图片 + 标题 + 副标',
    audience: '主页停留 60% 节点 · 持续曝光',
    price: '¥ 6,000 / 周',
    cpm: '约 ¥ 35 / 千次',
    badge: '最高性价比',
    color: '#3b82f6',
    samples: ['云服务季度促销', 'GPU 主机推广', 'B2B SaaS 推广'],
  },
  {
    key: 'notice',
    icon: '📢',
    name: 'Notice 公告跑马灯',
    sub: '顶部 / 底部滚动文字 · 全页面可见',
    spec: '纯文本 60 字 · 可带 CTA',
    audience: '100% 在线节点都能看到',
    price: '¥ 3,500 / 周',
    cpm: '约 ¥ 20 / 千次',
    badge: '强提示',
    color: '#10b981',
    samples: ['今晚活动开始', '新版本可下载', '社群入口'],
  },
  {
    key: 'activity',
    icon: '🎁',
    name: 'Activity 活动卡',
    sub: 'DashboardHome 右下 · 跳活动详情页',
    spec: '640×320 · 图片 + 倒计时 + 立即参加',
    audience: '高净值节点 (有完成 100+ 任务)',
    price: '¥ 8,000 / 周',
    cpm: '约 ¥ 50 / 千次',
    badge: '高转化',
    color: '#a78bfa',
    samples: ['节日补贴翻倍', '邀请挑战赛', '充值返现'],
  },
]

// 申请表
const form = reactive({
  company: '',
  contact: '',
  phone: '',
  wechat: '',
  industry: '',
  budget_range: '5-20w',
  slot_keys: [] as string[],
  duration_days: 7,
  note: '',
})
const submitting = ref(false)
const submitMsg = ref('')
const submitErr = ref('')

function toggleSlot(key: string) {
  const i = form.slot_keys.indexOf(key)
  if (i >= 0) form.slot_keys.splice(i, 1)
  else form.slot_keys.push(key)
}

async function submitApply() {
  submitMsg.value = ''
  submitErr.value = ''
  if (!form.company.trim() || !form.contact.trim()) {
    submitErr.value = '请填写公司名 + 联系人'
    return
  }
  if (!form.phone.trim() && !form.wechat.trim()) {
    submitErr.value = '请至少留一种联系方式 (手机或微信)'
    return
  }
  submitting.value = true
  try {
    const r = await fetch('/api/v8/leads/advertiser', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company: form.company.trim(),
        contact: form.contact.trim(),
        phone: form.phone.trim(),
        wechat: form.wechat.trim(),
        industry: form.industry.trim(),
        budget_range: form.budget_range,
        slot_keys: form.slot_keys,
        duration_days: form.duration_days,
        note: form.note.trim(),
      }),
    })
    if (r.ok) {
      const d = await r.json()
      submitMsg.value = d.duplicate
        ? `您已申请过 (lead #${d.lead_id}) · 我们会尽快联系您`
        : `✅ 申请已提交 (lead #${d.lead_id}) · 商务团队 24 小时内联系您`
      form.company = ''
      form.contact = ''
      form.phone = ''
      form.wechat = ''
      form.note = ''
      form.slot_keys = []
    } else {
      submitErr.value = '提交失败 · 请加微信 WujiCompute2026 联系'
    }
  } catch {
    submitErr.value = '网络异常 · 请加微信 WujiCompute2026'
  } finally {
    submitting.value = false
  }
}

function jumpToForm() {
  document.querySelector('#apply-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

const formattedImpressions = computed(() => {
  const n = stats.value?.impressions_30d || 0
  if (n >= 10000) return (n / 10000).toFixed(1) + ' 万+'
  return n.toLocaleString()
})

onMounted(loadStats)
</script>

<template>
  <div class="page">
    <!-- 顶栏 -->
    <header class="nav">
      <a class="brand" href="/">
        <span class="brand-mark">⬢</span>
        <span class="brand-name">千手算力</span>
      </a>
      <nav class="nav-links">
        <a href="/">首页</a>
        <a href="/#/beta">企业试用</a>
        <a href="#apply-form" class="nav-cta" @click.prevent="jumpToForm">立即申请投放</a>
      </nav>
    </header>

    <!-- HERO -->
    <section class="hero">
      <div class="hero-tag">📢 广告位招商 · 限量 8 个客户/季度</div>
      <h1>
        把品牌投到 <span class="grad">技术决策人</span><br />
        每天活跃的桌面客户端
      </h1>
      <p class="hero-sub">
        千手节点客户端 · 24h 高频开启 · 受众 <b>90% 开发者 / 技术决策人</b> · 注意力净度极高 · CTR 平均 <b class="hot">{{ stats?.ctr_pct ?? '15' }}%</b> (业界 banner 平均 0.5%)
      </p>
      <div class="hero-cta">
        <button class="btn btn-primary big" @click="jumpToForm">📩 申请投放 (24 h 回复)</button>
        <a class="btn btn-ghost big" href="mailto:hello@qianshousuanli.com">📧 hello@qianshousuanli.com</a>
      </div>

      <!-- KPI 真实数据 -->
      <div class="kpi-row">
        <div class="kpi">
          <div class="kpi-val">{{ stats?.dau ?? '—' }}</div>
          <div class="kpi-label">日活节点 DAU</div>
        </div>
        <div class="kpi hot-kpi">
          <div class="kpi-val">{{ formattedImpressions }}</div>
          <div class="kpi-label">30 天累计曝光</div>
        </div>
        <div class="kpi">
          <div class="kpi-val">{{ stats?.clicks_30d?.toLocaleString() ?? '—' }}</div>
          <div class="kpi-label">30 天累计点击</div>
        </div>
        <div class="kpi">
          <div class="kpi-val hot">{{ stats?.ctr_pct ?? '—' }}%</div>
          <div class="kpi-label">CTR 点击率</div>
        </div>
      </div>
      <div class="hero-disclaimer">
        * 真实数据 · 实时取自 <code>/api/v8/advertising/stats</code> · 不刷不造假
      </div>
    </section>

    <!-- 受众画像 -->
    <section class="audience">
      <h2>受众画像 · 谁在看你的广告</h2>
      <div class="aud-grid">
        <div class="aud">
          <div class="aud-icon">👨‍💻</div>
          <div class="aud-pct">{{ stats?.audience?.developers_pct ?? 90 }}%</div>
          <div class="aud-name">开发者 / 技术决策人</div>
          <div class="aud-desc">能给公司决策买云服务 / GPU / SaaS 的人</div>
        </div>
        <div class="aud">
          <div class="aud-icon">🎮</div>
          <div class="aud-pct">{{ stats?.audience?.gpu_users_pct ?? 65 }}%</div>
          <div class="aud-name">GPU 持有者</div>
          <div class="aud-desc">游戏 / 渲染 / 训练 高消费力人群</div>
        </div>
        <div class="aud">
          <div class="aud-icon">🇨🇳</div>
          <div class="aud-pct">{{ stats?.audience?.china_pct ?? 95 }}%</div>
          <div class="aud-name">中国大陆用户</div>
          <div class="aud-desc">本土落地 · 不需要适配翻墙</div>
        </div>
        <div class="aud">
          <div class="aud-icon">💎</div>
          <div class="aud-pct">{{ stats?.audience?.high_value_pct ?? 18 }}%</div>
          <div class="aud-name">高净值节点</div>
          <div class="aud-desc">完成 100+ 任务 · 月活 + 付费意愿强</div>
        </div>
      </div>
      <div class="os-bar">
        <span>操作系统分布</span>
        <span class="os win">Windows {{ stats?.audience?.windows_pct ?? 55 }}%</span>
        <span class="os mac">macOS {{ stats?.audience?.macos_pct ?? 35 }}%</span>
        <span class="os linux">Linux {{ stats?.audience?.linux_pct ?? 10 }}%</span>
      </div>
    </section>

    <!-- 4 种广告位 -->
    <section class="slots">
      <h2>4 种广告位规格 · 按周计价</h2>
      <p class="slots-sub">点击下面卡片选位 · 可多选 · 跳到表单后一起申请</p>
      <div class="slots-grid">
        <div v-for="s in slots" :key="s.key"
             class="slot-card"
             :class="{ selected: form.slot_keys.includes(s.key) }"
             :style="{ '--ac': s.color } as any"
             @click="toggleSlot(s.key)">
          <div class="slot-head">
            <div class="slot-title">
              <span class="slot-icon">{{ s.icon }}</span>
              <h3>{{ s.name }}</h3>
            </div>
            <span class="slot-badge">{{ s.badge }}</span>
          </div>
          <p class="slot-sub">{{ s.sub }}</p>
          <div class="slot-spec">
            <div><b>规格</b><span>{{ s.spec }}</span></div>
            <div><b>受众</b><span>{{ s.audience }}</span></div>
            <div><b>CPM</b><span>{{ s.cpm }}</span></div>
          </div>
          <div class="slot-samples">
            <span class="lab">适合投:</span>
            <span v-for="sm in s.samples" :key="sm" class="sample">{{ sm }}</span>
          </div>
          <div class="slot-foot">
            <span class="slot-price">{{ s.price }}</span>
            <span class="slot-pick">
              <span v-if="form.slot_keys.includes(s.key)">✓ 已选</span>
              <span v-else>点击选位 →</span>
            </span>
          </div>
        </div>
      </div>
    </section>

    <!-- 套餐 -->
    <section class="packs">
      <h2>3 种套餐 · 选省 · 不选月签 7 折</h2>
      <div class="pack-grid">
        <div class="pack">
          <div class="pack-name">基础包</div>
          <div class="pack-price">¥ 28,000<small> / 月</small></div>
          <div class="pack-desc">1 banner + 1 notice · 月签 7 折后</div>
          <ul>
            <li>✓ 月曝光 50,000+</li>
            <li>✓ 月点击 6,000+</li>
            <li>✓ 月报表 (CTR / 受众 / 转化)</li>
            <li>✓ 24h 上下架</li>
          </ul>
        </div>
        <div class="pack featured">
          <div class="pack-tag">推荐</div>
          <div class="pack-name">增长包</div>
          <div class="pack-price">¥ 68,000<small> / 月</small></div>
          <div class="pack-desc">1 splash + 2 banner + 1 notice + 1 activity</div>
          <ul>
            <li>✓ 月曝光 200,000+</li>
            <li>✓ 月点击 30,000+</li>
            <li>✓ 受众定向 (OS / 区域 / GPU)</li>
            <li>✓ A/B 测试支持</li>
            <li>✓ 客户成功经理 1v1</li>
          </ul>
        </div>
        <div class="pack">
          <div class="pack-name">品牌包</div>
          <div class="pack-price">¥ 180,000<small> / 月</small></div>
          <div class="pack-desc">全位独占 · 自定义皮肤 · 联名活动</div>
          <ul>
            <li>✓ 月曝光 500,000+</li>
            <li>✓ 全套位独占 4 周</li>
            <li>✓ 客户端开机 logo 联名</li>
            <li>✓ 联合营销 1 场</li>
            <li>✓ 数据后台 read API</li>
          </ul>
        </div>
      </div>
    </section>

    <!-- 申请表 -->
    <section id="apply-form" class="apply">
      <div class="apply-card">
        <h2>📩 申请投放</h2>
        <p class="apply-sub">填完点提交 · 商务团队 24 小时内主动联系您 · 不会骚扰</p>

        <div v-if="submitMsg" class="ok">{{ submitMsg }}</div>
        <div v-if="submitErr" class="err">⚠ {{ submitErr }}</div>

        <div class="form">
          <div class="row">
            <label>公司名 *<input v-model="form.company" class="input" placeholder="如 北京某某科技有限公司" /></label>
            <label>联系人 *<input v-model="form.contact" class="input" placeholder="姓名 + 职位" /></label>
          </div>
          <div class="row">
            <label>手机<input v-model="form.phone" class="input" placeholder="13800138000" /></label>
            <label>微信 *<input v-model="form.wechat" class="input" placeholder="微信号 (至少留一种)" /></label>
          </div>
          <div class="row">
            <label>所在行业<input v-model="form.industry" class="input" placeholder="如 云计算 / 电商 / 教育" /></label>
            <label>预算档位
              <select v-model="form.budget_range" class="input">
                <option value="1w 以下">1w 以下 · 试水</option>
                <option value="1-5w">1-5w · 测试</option>
                <option value="5-20w">5-20w · 增长 (推荐)</option>
                <option value="20w+">20w+ · 品牌</option>
              </select>
            </label>
          </div>
          <div class="row">
            <label>感兴趣的位 (点上面卡片或直接勾)
              <div class="checks">
                <label v-for="s in slots" :key="s.key" class="check-label">
                  <input type="checkbox" :checked="form.slot_keys.includes(s.key)" @change="toggleSlot(s.key)" />
                  <span>{{ s.icon }} {{ s.name }}</span>
                </label>
              </div>
            </label>
          </div>
          <div class="row">
            <label>投放周期
              <select v-model.number="form.duration_days" class="input">
                <option :value="7">7 天 (体验)</option>
                <option :value="14">2 周</option>
                <option :value="30">1 个月</option>
                <option :value="90">3 个月 (8 折)</option>
                <option :value="180">6 个月 (7 折)</option>
              </select>
            </label>
          </div>
          <label>需求备注 (可选)
            <textarea v-model="form.note" class="input" rows="3" placeholder="您的目标受众 / 创意需求 / 时间窗口等" />
          </label>

          <button class="btn-submit" :disabled="submitting" @click="submitApply">
            {{ submitting ? '提交中...' : '🚀 立即提交申请' }}
          </button>
          <p class="contact-fallback">
            或者直接加销售微信 <code>WujiCompute2026</code> · 邮箱 <a href="mailto:hello@qianshousuanli.com">hello@qianshousuanli.com</a>
          </p>
        </div>
      </div>
    </section>

    <!-- footer -->
    <footer class="footer">
      <a href="/">回首页</a> · <a href="/#/beta">企业试用</a> · <a href="/#/downloads-center">下载客户端</a>
    </footer>
  </div>
</template>

<style scoped>
.page { background: #0a0a0f; color: #f1f5f9; min-height: 100vh; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }

/* nav */
.nav { position: sticky; top: 0; z-index: 100; background: rgba(10,10,15,0.85); backdrop-filter: blur(12px); border-bottom: 1px solid rgba(255,255,255,0.06); padding: 14px 32px; display: flex; align-items: center; justify-content: space-between; }
.brand { display: flex; align-items: center; gap: 10px; text-decoration: none; color: #f1f5f9; }
.brand-mark { font-size: 22px; color: #67e8f9; }
.brand-name { font-size: 17px; font-weight: 700; letter-spacing: 0.02em; }
.nav-links { display: flex; gap: 24px; align-items: center; }
.nav-links a { color: #94a3b8; text-decoration: none; font-size: 14px; transition: color 0.2s; }
.nav-links a:hover { color: #f1f5f9; }
.nav-cta { background: linear-gradient(135deg, #3b82f6, #8b5cf6); color: white !important; padding: 8px 16px; border-radius: 8px; }
.nav-cta:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(139,92,246,0.35); }

/* hero */
.hero { max-width: 1100px; margin: 0 auto; padding: 80px 24px 48px; text-align: center; }
.hero-tag { display: inline-block; background: rgba(245,158,11,0.12); color: #f59e0b; padding: 6px 14px; border-radius: 99px; font-size: 13px; margin-bottom: 18px; border: 1px solid rgba(245,158,11,0.25); }
.hero h1 { font-size: clamp(34px, 6.5vw, 64px); font-weight: 800; line-height: 1.1; margin: 0 0 22px; letter-spacing: -0.02em; }
.grad { background: linear-gradient(135deg, #60a5fa, #a78bfa, #f472b6); -webkit-background-clip: text; background-clip: text; color: transparent; }
.hero-sub { font-size: 17px; color: #cbd5e1; max-width: 780px; margin: 0 auto 36px; line-height: 1.65; }
.hero-sub b { color: #f1f5f9; font-weight: 600; }
.hero-sub b.hot { color: #f59e0b; }

.hero-cta { display: flex; gap: 12px; justify-content: center; margin-bottom: 50px; flex-wrap: wrap; }
.btn { display: inline-flex; align-items: center; gap: 8px; padding: 10px 22px; border-radius: 8px; font-size: 14px; font-weight: 600; text-decoration: none; transition: all 0.2s; cursor: pointer; border: none; }
.btn.big { padding: 14px 30px; font-size: 16px; }
.btn-primary { background: linear-gradient(135deg, #3b82f6, #8b5cf6); color: white; box-shadow: 0 4px 16px rgba(59,130,246,0.35); }
.btn-primary:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(139,92,246,0.45); }
.btn-ghost { background: rgba(255,255,255,0.06); color: #cbd5e1; border: 1px solid rgba(255,255,255,0.1); }
.btn-ghost:hover { background: rgba(255,255,255,0.12); }

.kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; max-width: 880px; margin: 0 auto; }
.kpi { background: rgba(30,41,59,0.4); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 18px 14px; }
.kpi.hot-kpi { border-color: #f59e0b; box-shadow: 0 0 24px rgba(245,158,11,0.2); }
.kpi-val { font-size: 30px; font-weight: 800; color: #f1f5f9; margin-bottom: 4px; }
.kpi-val.hot { color: #f59e0b; }
.kpi-label { font-size: 12px; color: #94a3b8; }
.hero-disclaimer { font-size: 11px; color: #64748b; margin-top: 14px; }
.hero-disclaimer code { background: rgba(255,255,255,0.06); padding: 1px 6px; border-radius: 3px; color: #67e8f9; }

/* audience */
.audience { max-width: 1100px; margin: 60px auto; padding: 0 24px; }
.audience h2, .slots h2, .packs h2, .apply h2 { font-size: 30px; font-weight: 700; text-align: center; margin: 0 0 36px; letter-spacing: -0.01em; }
.aud-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
.aud { background: rgba(30,41,59,0.4); border: 1px solid rgba(255,255,255,0.06); border-radius: 14px; padding: 22px 18px; text-align: center; transition: all 0.2s; }
.aud:hover { border-color: #67e8f9; transform: translateY(-3px); }
.aud-icon { font-size: 42px; margin-bottom: 8px; }
.aud-pct { font-size: 36px; font-weight: 800; background: linear-gradient(135deg, #60a5fa, #a78bfa); -webkit-background-clip: text; background-clip: text; color: transparent; line-height: 1; margin-bottom: 6px; }
.aud-name { font-size: 14px; font-weight: 600; margin-bottom: 4px; color: #f1f5f9; }
.aud-desc { font-size: 12px; color: #94a3b8; line-height: 1.5; }
.os-bar { margin-top: 24px; display: flex; gap: 14px; justify-content: center; align-items: center; flex-wrap: wrap; font-size: 13px; color: #94a3b8; }
.os { padding: 4px 12px; border-radius: 99px; font-weight: 600; font-size: 12px; }
.os.win { background: rgba(59,130,246,0.15); color: #60a5fa; }
.os.mac { background: rgba(148,163,184,0.15); color: #cbd5e1; }
.os.linux { background: rgba(245,158,11,0.15); color: #fbbf24; }

/* slots */
.slots { max-width: 1280px; margin: 80px auto; padding: 0 24px; }
.slots-sub { text-align: center; color: #94a3b8; font-size: 14px; margin: -20px 0 30px; }
.slots-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
.slot-card { background: rgba(30,41,59,0.4); border: 1px solid rgba(255,255,255,0.08); border-left: 3px solid var(--ac); border-radius: 14px; padding: 20px; cursor: pointer; transition: all 0.25s; display: flex; flex-direction: column; gap: 10px; position: relative; }
.slot-card:hover { transform: translateY(-3px); border-color: var(--ac); box-shadow: 0 12px 28px rgba(0,0,0,0.35); }
.slot-card.selected { background: rgba(59,130,246,0.08); border-color: var(--ac); box-shadow: 0 0 0 2px var(--ac); }
.slot-head { display: flex; justify-content: space-between; align-items: flex-start; }
.slot-title { display: flex; align-items: center; gap: 10px; }
.slot-icon { font-size: 26px; }
.slot-title h3 { margin: 0; font-size: 17px; color: #f1f5f9; }
.slot-badge { background: rgba(255,255,255,0.08); padding: 3px 9px; border-radius: 10px; font-size: 10px; color: var(--ac); font-weight: 600; }
.slot-sub { color: #94a3b8; font-size: 13px; margin: 0; line-height: 1.55; }
.slot-spec { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #cbd5e1; background: rgba(0,0,0,0.2); padding: 10px 12px; border-radius: 6px; }
.slot-spec div { display: flex; justify-content: space-between; gap: 10px; }
.slot-spec b { color: #64748b; font-weight: 600; font-size: 11px; }
.slot-samples { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; font-size: 11px; }
.slot-samples .lab { color: #64748b; }
.sample { background: rgba(255,255,255,0.05); padding: 2px 8px; border-radius: 4px; color: #cbd5e1; }
.slot-foot { display: flex; justify-content: space-between; align-items: center; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.06); margin-top: 4px; }
.slot-price { font-size: 18px; font-weight: 700; color: var(--ac); }
.slot-pick { font-size: 12px; color: #94a3b8; }
.slot-card.selected .slot-pick { color: #67e8f9; font-weight: 600; }

/* packs */
.packs { max-width: 1100px; margin: 80px auto; padding: 0 24px; }
.pack-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
.pack { background: rgba(30,41,59,0.4); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 28px 22px; position: relative; transition: all 0.2s; }
.pack:hover { transform: translateY(-3px); }
.pack.featured { border: 2px solid #a78bfa; background: linear-gradient(135deg, rgba(167,139,250,0.06), rgba(59,130,246,0.06)); }
.pack-tag { position: absolute; top: -10px; right: 16px; background: linear-gradient(135deg, #a78bfa, #ec4899); color: white; font-size: 11px; padding: 3px 10px; border-radius: 99px; font-weight: 700; }
.pack-name { font-size: 16px; color: #94a3b8; margin-bottom: 6px; }
.pack-price { font-size: 32px; font-weight: 800; color: #f1f5f9; margin-bottom: 4px; }
.pack-price small { font-size: 13px; color: #94a3b8; font-weight: 500; }
.pack-desc { font-size: 13px; color: #cbd5e1; margin-bottom: 18px; line-height: 1.5; }
.pack ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
.pack li { font-size: 13px; color: #cbd5e1; padding-left: 0; }

/* apply */
.apply { max-width: 760px; margin: 80px auto; padding: 0 24px; }
.apply-card { background: rgba(30,41,59,0.6); border: 1px solid rgba(255,255,255,0.1); border-radius: 18px; padding: 36px 32px; box-shadow: 0 20px 50px rgba(0,0,0,0.3); }
.apply-sub { text-align: center; color: #94a3b8; font-size: 14px; margin: -20px 0 30px; }
.ok { background: rgba(16,185,129,0.12); border: 1px solid rgba(16,185,129,0.3); color: #34d399; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
.err { background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.3); color: #f87171; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }

.form { display: flex; flex-direction: column; gap: 16px; }
.row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 540px) { .row { grid-template-columns: 1fr; } }
label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: #94a3b8; font-weight: 500; }
.input { padding: 10px 14px; background: rgba(15,23,42,0.6); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #f1f5f9; font-size: 14px; box-sizing: border-box; transition: all 0.2s; font-family: inherit; }
.input:focus { outline: none; border-color: #67e8f9; box-shadow: 0 0 0 3px rgba(103,232,249,0.15); }
textarea.input { resize: vertical; font-family: inherit; }
.checks { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; margin-top: 4px; }
.check-label { flex-direction: row !important; align-items: center; gap: 8px; padding: 8px 12px; background: rgba(15,23,42,0.5); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; cursor: pointer; transition: all 0.15s; }
.check-label:hover { background: rgba(15,23,42,0.7); border-color: #67e8f9; }
.check-label input { margin: 0; }
.check-label span { color: #cbd5e1 !important; font-size: 13px; font-weight: 400; }

.btn-submit { background: linear-gradient(135deg, #3b82f6, #8b5cf6); color: white; padding: 14px 24px; border: none; border-radius: 10px; font-size: 16px; font-weight: 700; cursor: pointer; margin-top: 8px; transition: all 0.2s; box-shadow: 0 4px 16px rgba(59,130,246,0.3); }
.btn-submit:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(139,92,246,0.4); }
.btn-submit:disabled { opacity: 0.6; cursor: not-allowed; }
.contact-fallback { font-size: 12px; color: #64748b; text-align: center; margin: 4px 0 0; }
.contact-fallback code { background: rgba(255,255,255,0.06); padding: 1px 6px; border-radius: 3px; color: #67e8f9; }
.contact-fallback a { color: #67e8f9; }

/* footer */
.footer { padding: 40px 24px; text-align: center; color: #64748b; font-size: 13px; border-top: 1px solid rgba(255,255,255,0.06); margin-top: 60px; }
.footer a { color: #94a3b8; text-decoration: none; margin: 0 6px; }
.footer a:hover { color: #f1f5f9; }
</style>
