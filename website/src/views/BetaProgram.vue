<template>
  <main class="beta-page">
    <!-- ── 顶导（与首页一致的 Apple 风格）── -->
    <header class="nav-bar">
      <div class="nav-inner">
        <router-link :to="links.home" class="logo">千手算力</router-link>
        <nav class="nav-links">
          <router-link :to="links.home">首页</router-link>
          <a :href="links.downloadCenter">下载</a>
          <router-link :to="links.docs">文档</router-link>
          <a href="#/beta" class="active" @click.prevent="scrollToSection('apply')">合作咨询</a>
        </nav>
        <div class="nav-actions">
          <a class="cta-pill" href="#/beta" @click.prevent="scrollToSection('apply')">提交需求</a>
        </div>
      </div>
    </header>

    <!-- ── Hero 区 ── -->
    <section class="hero">
      <div class="hero-inner">
        <span class="kicker">QIANSHOU FOR BUSINESS · 企业合作咨询</span>
        <h1>
          从你的任务出发，<br />
          <span class="grad">找到合适的算力。</span>
        </h1>
        <p class="hero-sub">
          千手正在建设连接设备、任务与结果的分布式算力网络。<br />
          告诉我们你的场景，我们会核对可用能力、数据要求与合作条件，再讨论试跑方案。
        </p>
        <div class="hero-stats">
          <div><b>描述任务</b><span>说清输入与期望结果</span></div>
          <div><b>核对能力</b><span>确认设备、权限与时效</span></div>
          <div><b>讨论试跑</b><span>明确费用和交付范围</span></div>
        </div>
        <div class="hero-cta">
          <a href="#/beta" class="btn-primary" @click.prevent="scrollToSection('apply')">提交合作需求</a>
          <a href="#/beta" class="btn-ghost" @click.prevent="scrollToSection('what')">先了解我们做什么 →</a>
          <a :href="`mailto:${links.contactEmail}`" class="btn-ghost">邮件咨询 →</a>
        </div>
      </div>
    </section>

    <!-- ── 我们做什么 ── -->
    <section id="what" class="section section-light">
      <div class="container">
        <h2 class="sec-title">从实际任务出发</h2>
        <p class="sec-sub">以下是可以一起评估的方向。是否可执行、所需设备与费用，以具体任务核对结果为准。</p>

        <div class="four-grid">
          <article class="bento">
            <div class="bento-icon" style="background: linear-gradient(135deg,#0071e3,#5ac8fa);">🎬</div>
            <h3>3D 渲染 / 视频转码</h3>
            <p>说明所用软件、素材规模与交付时间，我们再确认可用执行环境和处理方式。</p>
          </article>
          <article class="bento">
            <div class="bento-icon" style="background: linear-gradient(135deg,#34c759,#30d158);">🤖</div>
            <h3>AI 推理 / 数据标注</h3>
            <p>按模型、输入格式、数据范围和结果要求，评估批量处理的可行性。</p>
          </article>
          <article class="bento">
            <div class="bento-icon" style="background: linear-gradient(135deg,#ff9500,#ffcc00);">📊</div>
            <h3>数据清洗 / ETL</h3>
            <p>围绕数据清洗、格式转换与结构化处理，先确认数据来源和处理边界。</p>
          </article>
          <article class="bento">
            <div class="bento-icon" style="background: linear-gradient(135deg,#af52de,#5856d6);">🔬</div>
            <h3>科研 / 学术计算</h3>
            <p>请提供所需工具、计算资源和成果格式；我们会逐项评估能否支持。</p>
          </article>
        </div>
      </div>
    </section>

    <!-- ── 我们的优势 ── -->
    <section class="section section-dark">
      <div class="container">
        <h2 class="sec-title white">合作时，我们先对齐什么</h2>
        <p class="sec-sub white-soft">任务能否交付，取决于能力、设备、数据边界和实际可用状态。</p>

        <div class="advantage-grid">
          <div class="adv-card">
            <div class="adv-num">01</div>
            <h3>按任务核对</h3>
            <p>先明确输入、输出和验收标准，再讨论适合的执行方式与报价。</p>
          </div>
          <div class="adv-card">
            <div class="adv-num">02</div>
            <h3>看实际设备</h3>
            <p>根据当前在线设备、所需软件和资源条件判断是否有合适的执行节点。</p>
          </div>
          <div class="adv-card">
            <div class="adv-num">03</div>
            <h3>明确数据边界</h3>
            <p>在试跑前确认会传输哪些材料、由谁访问、结果如何交付与保存。</p>
          </div>
          <div class="adv-card">
            <div class="adv-num">04</div>
            <h3>结果有据可查</h3>
            <p>以任务状态和可核对的交付记录说明处理进度与结果。</p>
          </div>
          <div class="adv-card">
            <div class="adv-num">05</div>
            <h3>讨论接入方式</h3>
            <p>可以从工作台和现有接口了解接入路径，再按实际场景确认可用范围。</p>
          </div>
          <div class="adv-card">
            <div class="adv-num">06</div>
            <h3>先确认费用</h3>
            <p>试跑条件、预计费用和失败处理在执行前说明，以实际报价和订单为准。</p>
          </div>
        </div>
      </div>
    </section>

    <!-- ── 设备方向 ── -->
    <section class="section section-light">
      <div class="container">
        <h2 class="sec-title">可以一起评估的设备方向</h2>
        <p class="sec-sub">不同设备的工具、权限和可用状态不同。页面列出的类型不代表现在都能接单。</p>

        <div class="device-grid">
          <article class="device-card">
            <div class="device-emoji">💻</div>
            <h4>Windows / Mac</h4>
            <p>桌面客户端可提供本机工作能力；跨设备执行需机主授权并通过节点核验。</p>
          </article>
          <article class="device-card">
            <div class="device-emoji">🐧</div>
            <h4>Linux 服务器</h4>
            <p>服务器类任务需要核对运行环境、数据访问范围与当前可用性。</p>
          </article>
          <article class="device-card">
            <div class="device-emoji">🥧</div>
            <h4>树莓派 / ARM</h4>
            <p>低功耗设备是否适合任务，以具体软件与资源要求为准。</p>
          </article>
          <article class="device-card">
            <div class="device-emoji">📱</div>
            <h4>Android 手机</h4>
            <p>移动端以对话和任务查看为入口，设备接单能力仍需单独验证。</p>
          </article>
          <article class="device-card">
            <div class="device-emoji">⚙️</div>
            <h4>Python Agent</h4>
            <p>Agent 接入方式与可运行任务，需按现有接口和环境逐项确认。</p>
          </article>
        </div>
      </div>
    </section>

    <!-- ── 合作流程 ── -->
    <section id="benefit" class="section section-gradient">
      <div class="container">
        <h2 class="sec-title white">提交需求后，一起确认这些事</h2>
        <p class="sec-sub white-soft">每个试跑方案都会根据任务、设备和合作条件单独确认。</p>

        <div class="benefit-grid">
          <article class="ben-card highlight">
            <div class="ben-tag">场景</div>
            <h3>梳理任务目标</h3>
            <p>确认输入材料、使用工具、期望结果和验收方式。</p>
          </article>
          <article class="ben-card">
            <div class="ben-tag">能力</div>
            <h3>核对可用资源</h3>
            <p>检查当前能力、设备条件与任务需要的执行环境。</p>
          </article>
          <article class="ben-card">
            <div class="ben-tag">接入</div>
            <h3>讨论使用方式</h3>
            <p>按实际接口和工作台能力，确认适合你的接入路径。</p>
          </article>
          <article class="ben-card">
            <div class="ben-tag">边界</div>
            <h3>确认数据与权限</h3>
            <p>说明材料会发往哪里、谁能处理，以及结果如何保存。</p>
          </article>
          <article class="ben-card">
            <div class="ben-tag">报价</div>
            <h3>确认试跑条件</h3>
            <p>费用、预计时间和失败处理，以双方确认的实际方案为准。</p>
          </article>
          <article class="ben-card">
            <div class="ben-tag">结果</div>
            <h3>核对交付记录</h3>
            <p>试跑后查看任务状态、结果与需要继续解决的问题。</p>
          </article>
        </div>
      </div>
    </section>

    <!-- ── 适合谁 ── -->
    <section class="section section-light">
      <div class="container">
        <h2 class="sec-title">这一轮我们最想合作的</h2>

        <div class="fit-grid">
          <article class="fit-card good">
            <h4>适合先来聊聊</h4>
            <ul>
              <li><strong>3D 渲染</strong> 工作室 / 影视后期</li>
              <li><strong>AI 数据标注</strong> / 模型推理批处理</li>
              <li><strong>短视频 MCN</strong> / 抖音直播切片</li>
              <li><strong>科研院所</strong> / 高校实验室的批处理需求</li>
              <li><strong>大数据 ETL</strong> / 数据清洗团队</li>
            </ul>
          </article>
          <article class="fit-card neutral">
            <h4>需要逐项评估</h4>
            <ul>
              <li>分布式爬虫 / 数据采集（合规为前提）</li>
              <li>Stable Diffusion / 文生图批量</li>
              <li>OCR / 文档解析 / 翻译</li>
              <li>压力测试 / 性能基准</li>
            </ul>
          </article>
          <article class="fit-card bad">
            <h4>当前无法承诺</h4>
            <ul>
              <li>需要毫秒级响应的实时推理</li>
              <li>大规模模型训练</li>
              <li>虚拟币挖矿（PoW / PoS）</li>
              <li>违法 / 违规 / 涉黄涉赌内容</li>
            </ul>
          </article>
        </div>
      </div>
    </section>

    <!-- ── 申请表单 ── -->
    <section id="apply" class="section section-cta">
      <div class="container">
        <h2 class="sec-title white">提交企业合作需求</h2>
        <p class="sec-sub white-soft">留下场景与联系方式，我们会按实际能力和资源情况回复。</p>

        <form class="apply-form" @submit.prevent="submitApply">
          <div class="form-row">
            <div class="form-field">
              <label>公司名称 <span class="req">*</span></label>
              <input v-model="form.company" required minlength="2" maxlength="120" placeholder="如：上海星河影视后期" />
            </div>
            <div class="form-field">
              <label>联系人 <span class="req">*</span></label>
              <input v-model="form.contact" required maxlength="60" placeholder="姓名 / 称呼" />
            </div>
          </div>
          <div class="form-row">
            <div class="form-field">
              <label>联系方式 <span class="req">*</span></label>
              <input v-model="form.phone" required minlength="3" maxlength="120" placeholder="手机 / 微信 / 邮箱" />
            </div>
            <div class="form-field">
              <label>公司规模</label>
              <select v-model="form.size">
                <option value="">请选择</option>
                <option value="1-10">1-10 人</option>
                <option value="11-50">11-50 人</option>
                <option value="51-200">51-200 人</option>
                <option value="200+">200+ 人</option>
              </select>
            </div>
          </div>
          <div class="form-field">
            <label>主要用途 <span class="req">*</span></label>
            <select v-model="form.use_case" required>
              <option value="">请选择</option>
              <option value="3d-render">3D 渲染 / 视频转码</option>
              <option value="ai-inference">AI 推理 / 数据标注</option>
              <option value="data-eng">数据 ETL / 清洗</option>
              <option value="research">科研 / 学术计算</option>
              <option value="other">其他（请在备注说明）</option>
            </select>
          </div>
          <div class="form-field">
            <label>预估月算力需求</label>
            <select v-model="form.budget">
              <option value="">请选择</option>
              <option value="lt-1k">小于 ¥1,000 / 月</option>
              <option value="1k-5k">¥1,000 - ¥5,000 / 月</option>
              <option value="5k-30k">¥5,000 - ¥30,000 / 月</option>
              <option value="30k+">¥30,000+ / 月</option>
            </select>
          </div>
          <div class="form-field">
            <label>具体需求 / 备注</label>
            <textarea v-model="form.note" rows="4" maxlength="2000" placeholder="比如：每月需要渲染 5000 帧 Blender 4K 动画；现在用瑞云成本 ¥xxx ..."></textarea>
          </div>

          <div v-if="msg.text" :class="['msg', msg.type]" :role="msg.type === 'err' ? 'alert' : 'status'">
            {{ msg.text }}
            <a v-if="msg.showEmail" :href="`mailto:${links.contactEmail}`">改用邮件联系 →</a>
          </div>

          <button class="btn-primary submit-btn" :disabled="loading">
            {{ loading ? '提交中…' : '提交合作需求' }}
          </button>
        </form>

        <p class="trust-note">
          🔒 你提交的信息用于处理本次合作咨询。了解处理方式，请阅读
          <router-link :to="links.privacy">隐私政策</router-link>。提交服务暂不可用时，也可联系
          <a :href="`mailto:${links.contactEmail}`">{{ links.contactEmail }}</a>。
        </p>
      </div>
    </section>

    <!-- ── FAQ ── -->
    <section class="section section-light">
      <div class="container narrow">
        <h2 class="sec-title">常见问题</h2>

        <details class="faq" v-for="(q, i) in faqs" :key="i" :open="i === 0">
          <summary>{{ q.q }}</summary>
          <p>{{ q.a }}</p>
        </details>
        <p class="faq-links">继续了解：<router-link :to="links.docs">开发文档</router-link> · <a :href="links.enterprise">企业工作台</a></p>
      </div>
    </section>

    <footer class="footer">
      <div class="container footer-inner">
        <div>
          <strong>千手算力</strong>
          <span> · 分布式边缘算力平台</span>
        </div>
        <div class="footer-links">
          <router-link :to="links.home">首页</router-link>
          <a :href="links.downloadCenter">下载客户端</a>
          <router-link :to="links.docs">文档</router-link>
          <a href="#/beta" @click.prevent="scrollToSection('apply')">合作咨询</a>
        </div>
      </div>
    </footer>
  </main>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue'
import { OFFICIAL_LINKS } from '../config/site'
import { submitEnterpriseInquiry } from '../services/enterprise-lead'

const links = OFFICIAL_LINKS

const form = reactive({
  company: '',
  contact: '',
  phone: '',
  size: '',
  use_case: '',
  budget: '',
  note: '',
})

const loading = ref(false)
const msg = reactive({ text: '', type: 'ok' as 'ok' | 'err', showEmail: false })

function scrollToSection(id: 'apply' | 'what') {
  const target = document.getElementById(id)
  if (!target) return
  const navHeight = document.querySelector<HTMLElement>('.beta-page .nav-bar')?.getBoundingClientRect().height ?? 0
  const top = target.getBoundingClientRect().top + window.scrollY - navHeight - 16
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  window.scrollTo({ top: Math.max(0, top), behavior: reducedMotion ? 'auto' : 'smooth' })
}

const faqs = [
  {
    q: '可以申请试跑吗？费用怎么算？',
    a: '可以提交任务场景。是否可试跑、可用额度及费用，以平台当时的正式报价和双方确认的合作条件为准；提交申请不会自动创建付费订单。',
  },
  {
    q: '我的数据会发到哪里？',
    a: '这取决于具体任务与执行方式。试跑前应确认输入范围、执行位置、访问权限和保存期限；在未确定这些条件前，请勿提交敏感原始数据。',
  },
  {
    q: '如果任务失败/超时怎么办？',
    a: '重试、取消、退款和交付时间应在正式试跑方案与订单条款中说明。实际状态以任务和账单回执为准。',
  },
  {
    q: '如何了解价格？',
    a: '价格会受任务类型、资源要求、数量、等待时间和交付条件影响。请提供实际需求，我们会在确认可执行后给出对应报价。',
  },
  {
    q: '怎么接入？有 SDK 吗？',
    a: '可先查看本站开发文档和企业工作台。具体接口、身份权限和可用能力，以当前版本提供的实际功能为准。',
  },
  {
    q: '这是不是 Web3 / 加密货币项目？',
    a: '千手面向可交付的真实任务。账户余额、充值、收益与提现分别以平台实际规则和账单记录为准；页面不承诺固定兑换比例。',
  },
  {
    q: '什么时候可以开始使用？',
    a: '先提交实际场景。我们会核对当前可用能力、接入条件和交付范围，再告知是否适合安排试跑。',
  },
]

async function submitApply() {
  if (loading.value) return
  msg.text = ''
  msg.showEmail = false

  loading.value = true
  try {
    const outcome = await submitEnterpriseInquiry(form)
    if (outcome.kind === 'accepted') {
      msg.text = '申请已收悉。近期同公司和联系方式的重复提交会合并为一条，后续安排以正式回复为准。'
      msg.type = 'ok'
      form.company = ''
      form.contact = ''
      form.phone = ''
      form.size = ''
      form.use_case = ''
      form.budget = ''
      form.note = ''
    } else if (outcome.kind === 'invalid') {
      msg.text = '请检查公司名称、联系人、联系方式和主要用途，并确认备注不超过 2000 字。'
      msg.type = 'err'
    } else if (outcome.kind === 'rate_limited') {
      msg.text = outcome.retryAfter ? `提交太频繁，请在 ${outcome.retryAfter} 秒后重试。` : '提交太频繁，请稍后再试。'
      msg.type = 'err'
      msg.showEmail = true
    } else {
      msg.text = outcome.kind === 'network' ? '网络未能连接到提交服务。请稍后重试，或通过邮件发送合作需求。' : '提交服务暂不可用。请稍后重试，或通过邮件发送合作需求。'
      msg.type = 'err'
      msg.showEmail = true
    }
  } finally {
    loading.value = false
  }
}

</script>

<style scoped>
.beta-page {
  background: #fff;
  color: #1d1d1f;
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  min-height: 100vh;
  font-size: 15px;
  line-height: 1.6;
}

/* ── 顶导 ── */
.nav-bar {
  position: sticky; top: 0; z-index: 100;
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: saturate(180%) blur(20px);
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}
.nav-inner {
  max-width: 1200px; margin: 0 auto;
  padding: 14px 22px;
  display: flex; align-items: center; gap: 28px;
}
.logo {
  font-size: 20px; font-weight: 700; color: #0071e3; text-decoration: none;
}
.nav-links { flex: 1; display: flex; gap: 22px; }
.nav-links a {
  color: #1d1d1f; text-decoration: none; font-size: 14px;
}
.nav-links a:hover, .nav-links a.active {
  color: #0071e3;
}
.cta-pill {
  background: #0071e3; color: #fff; padding: 8px 18px; border-radius: 99px;
  text-decoration: none; font-size: 13px; font-weight: 600;
  transition: opacity 0.2s;
}
.cta-pill:hover { opacity: 0.85; }

/* ── 通用 section ── */
.section { padding: 90px 22px; }
.container { max-width: 1100px; margin: 0 auto; }
.container.narrow { max-width: 800px; }
.section-light { background: #f8fafc; }
.section-dark { background: #0a0a0f; color: #fff; }
.section-gradient {
  background: linear-gradient(135deg, #0071e3 0%, #5856d6 50%, #af52de 100%);
  color: #fff;
}
.section-cta {
  background: linear-gradient(180deg, #1d1d1f 0%, #0a0a0f 100%);
  color: #fff;
}

.sec-title {
  font-size: 40px; font-weight: 700; text-align: center; margin: 0 0 14px; letter-spacing: -0.5px;
}
.sec-title.white { color: #fff; }
.sec-sub {
  text-align: center; color: #6e6e73; font-size: 17px;
  max-width: 700px; margin: 0 auto 50px;
}
.sec-sub.white-soft { color: rgba(255, 255, 255, 0.8); }
.sec-sub strong { color: #1d1d1f; }
.section-dark .sec-sub strong, .section-gradient .sec-sub strong, .section-cta .sec-sub strong { color: #fff; }

/* ── Hero ── */
.hero {
  padding: 100px 22px 80px;
  background:
    radial-gradient(ellipse 80% 60% at 50% 0%, rgba(0,113,227,0.08), transparent 70%),
    linear-gradient(180deg, #fff 0%, #f8fafc 100%);
}
.hero-inner { max-width: 900px; margin: 0 auto; text-align: center; }
.kicker {
  display: inline-block;
  font-size: 12px; letter-spacing: 0.15em; color: #0071e3;
  background: rgba(0,113,227,0.08); padding: 6px 14px; border-radius: 99px;
  margin-bottom: 24px; font-weight: 600;
}
.hero h1 {
  font-size: clamp(40px, 6vw, 64px);
  font-weight: 800; line-height: 1.1; margin: 0 0 20px;
  letter-spacing: -1px;
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
.grad {
  background: linear-gradient(135deg, #ec4899, #ef4444);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  font-family: inherit; font-feature-settings: normal;
}
.hero-sub {
  font-size: 18px; color: #4b5563; line-height: 1.7;
  max-width: 700px; margin: 0 auto 36px;
}
.hero-stats {
  display: flex; justify-content: center; gap: 50px;
  margin: 36px 0 40px; flex-wrap: wrap;
}
.hero-stats > div {
  display: flex; flex-direction: column; align-items: center;
}
.hero-stats b {
  font-size: 24px; font-weight: 750;
  background: linear-gradient(135deg, #0071e3, #5856d6);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.hero-stats span { color: #6e6e73; font-size: 13px; margin-top: 4px; }

.hero-cta { display: flex; justify-content: center; gap: 14px; flex-wrap: wrap; }
.btn-primary {
  display: inline-block;
  background: #0071e3; color: #fff;
  padding: 14px 32px; border-radius: 99px;
  font-size: 16px; font-weight: 600;
  text-decoration: none; border: none; cursor: pointer;
  transition: all 0.2s;
  box-shadow: 0 8px 24px rgba(0,113,227,0.25);
}
.btn-primary:hover { transform: translateY(-2px); box-shadow: 0 12px 30px rgba(0,113,227,0.35); }
.btn-primary:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
.btn-ghost {
  display: inline-block;
  padding: 14px 24px; border-radius: 99px;
  color: #0071e3; text-decoration: none; font-size: 16px; font-weight: 500;
  transition: opacity 0.2s;
}
.btn-ghost:hover { opacity: 0.7; }

/* ── 我们做什么 4 卡 ── */
.four-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 20px;
}
.bento {
  background: #fff; padding: 32px; border-radius: 18px;
  border: 1px solid #e5e7eb;
  transition: all 0.2s;
}
.bento:hover { transform: translateY(-3px); box-shadow: 0 12px 30px rgba(0,0,0,0.08); }
.bento-icon {
  width: 56px; height: 56px; border-radius: 16px;
  display: grid; place-items: center;
  font-size: 28px; margin-bottom: 18px;
  color: #fff;
}
.bento h3 { font-size: 20px; margin: 0 0 8px; }
.bento p { color: #4b5563; margin: 0; }
.bento strong { color: #0071e3; }

/* ── 我们的优势 6 卡 ── */
.advantage-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
}
.adv-card {
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 16px; padding: 28px;
  transition: all 0.2s;
}
.adv-card:hover { background: rgba(255,255,255,0.08); transform: translateY(-3px); }
.adv-num {
  font-size: 36px; font-weight: 800;
  background: linear-gradient(135deg, #22d3ee, #818cf8);
  -webkit-background-clip: text; background-clip: text; color: transparent;
  margin-bottom: 12px;
}
.adv-card h3 { font-size: 18px; margin: 0 0 8px; color: #fff; }
.adv-card p { color: rgba(255,255,255,0.7); margin: 0; line-height: 1.7; }
.adv-card strong { color: #5ac8fa; }

/* ── 客户端 5 卡 ── */
.device-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 16px;
}
.device-card {
  background: #fff; padding: 28px 18px; border-radius: 14px;
  border: 1px solid #e5e7eb;
  text-align: center;
  transition: all 0.2s;
}
.device-card:hover { transform: translateY(-3px); box-shadow: 0 8px 20px rgba(0,0,0,0.06); }
.device-emoji { font-size: 42px; margin-bottom: 12px; }
.device-card h4 { margin: 0 0 6px; font-size: 15px; }
.device-card p { font-size: 12px; color: #6e6e73; margin: 0; line-height: 1.6; }

/* ── 种子企业权益 ── */
.benefit-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
}
.ben-card {
  background: rgba(255,255,255,0.12);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(255,255,255,0.18);
  border-radius: 16px; padding: 28px;
  position: relative; overflow: hidden;
  color: #fff;
}
.ben-card.highlight {
  background: rgba(255,255,255,0.95);
  color: #1d1d1f;
}
.ben-card.highlight h3 { color: #0071e3; }
.ben-card.highlight p { color: #4b5563; }
.ben-card.highlight strong { color: #0071e3; }
.ben-tag {
  display: inline-block;
  background: rgba(255,255,255,0.2);
  padding: 4px 12px; border-radius: 99px;
  font-size: 11px; font-weight: 600; letter-spacing: 0.05em;
  margin-bottom: 12px;
}
.ben-card.highlight .ben-tag { background: #0071e3; color: #fff; }
.ben-card h3 { font-size: 19px; margin: 0 0 10px; }
.ben-card p { font-size: 14px; line-height: 1.6; margin: 0; opacity: 0.9; }

/* ── 适合谁 3 卡 ── */
.fit-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
}
.fit-card {
  background: #fff; border-radius: 16px; padding: 28px;
  border: 2px solid;
}
.fit-card.good { border-color: #34c759; }
.fit-card.neutral { border-color: #ff9500; }
.fit-card.bad { border-color: #ef4444; opacity: 0.85; }
.fit-card h4 { margin: 0 0 16px; font-size: 16px; font-weight: 700; }
.fit-card.good h4 { color: #16a34a; }
.fit-card.neutral h4 { color: #d97706; }
.fit-card.bad h4 { color: #dc2626; }
.fit-card ul { margin: 0; padding-left: 20px; color: #374151; }
.fit-card li { margin-bottom: 8px; line-height: 1.6; }

/* ── 申请表单 ── */
.apply-form {
  max-width: 640px; margin: 40px auto 24px;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 20px; padding: 36px;
  backdrop-filter: blur(20px);
}
.form-row {
  display: grid; grid-template-columns: 1fr 1fr; gap: 16px;
  margin-bottom: 18px;
}
.form-field { margin-bottom: 18px; }
.form-field label {
  display: block; font-size: 13px; color: rgba(255,255,255,0.85);
  margin-bottom: 8px; font-weight: 500;
}
.req { color: #ef4444; }
.form-field input, .form-field select, .form-field textarea {
  width: 100%; box-sizing: border-box;
  padding: 12px 14px;
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 10px;
  color: #fff; font-size: 14px; font-family: inherit;
  outline: none; transition: all 0.2s;
}
.form-field input:focus, .form-field select:focus, .form-field textarea:focus {
  border-color: #5ac8fa;
  background: rgba(255,255,255,0.12);
}
.form-field input::placeholder, .form-field textarea::placeholder {
  color: rgba(255,255,255,0.4);
}
.form-field select option { background: #1d1d1f; color: #fff; }
.submit-btn {
  width: 100%; margin-top: 12px;
  font-size: 17px; padding: 16px;
}
.msg {
  padding: 12px 16px; border-radius: 10px;
  margin-bottom: 18px; font-size: 14px;
}
.msg.ok { background: rgba(34,197,94,0.15); color: #86efac; border: 1px solid rgba(34,197,94,0.3); }
.msg.err { background: rgba(239,68,68,0.15); color: #fca5a5; border: 1px solid rgba(239,68,68,0.3); }
.msg a { display: inline-block; margin-left: 8px; color: inherit; font-weight: 700; text-underline-offset: 3px; }
.trust-note {
  text-align: center; font-size: 12px; color: rgba(255,255,255,0.55);
  margin: 8px auto 0; max-width: 600px;
}
.trust-note a { color: #fff; text-underline-offset: 3px; }

/* ── FAQ ── */
.faq {
  background: #fff; border: 1px solid #e5e7eb;
  border-radius: 12px; padding: 18px 22px;
  margin-bottom: 12px; cursor: pointer;
}
.faq summary {
  font-weight: 600; font-size: 16px; color: #1d1d1f;
  outline: none; list-style: none;
  display: flex; justify-content: space-between; align-items: center;
}
.faq summary::after {
  content: '+'; font-size: 22px; color: #0071e3; transition: transform 0.2s;
}
.faq[open] summary::after { content: '−'; }
.faq p {
  margin: 14px 0 0; color: #4b5563; line-height: 1.8; font-size: 14px;
}
.faq-links { text-align: center; margin-top: 30px; color: #6e6e73; }
.faq-links a { color: #0071e3; text-decoration: none; }
.faq-links a:hover { text-decoration: underline; }

/* ── Footer ── */
.footer {
  background: #f8fafc; padding: 30px 22px;
  border-top: 1px solid #e5e7eb;
}
.footer-inner {
  display: flex; justify-content: space-between; align-items: center;
  flex-wrap: wrap; gap: 12px;
  font-size: 13px; color: #6e6e73;
}
.footer-links { display: flex; gap: 18px; }
.footer-links a { color: #6e6e73; text-decoration: none; }
.footer-links a:hover { color: #0071e3; }

/* ── 响应式 ── */
@media (max-width: 980px) {
  .four-grid, .advantage-grid, .benefit-grid, .fit-grid { grid-template-columns: 1fr; }
  .device-grid { grid-template-columns: repeat(2, 1fr); }
  .form-row { grid-template-columns: 1fr; }
  .hero-stats { gap: 24px; }
}
@media (max-width: 600px) {
  .nav-inner { flex-wrap: wrap; gap: 10px; padding: 12px 18px; }
  .nav-links { order: 3; flex: 0 0 100%; justify-content: space-between; gap: 8px; }
  .nav-links a { font-size: 13px; white-space: nowrap; }
  .logo, .cta-pill { white-space: nowrap; }
  .cta-pill { margin-left: auto; }
  .hero { padding: 56px 20px 70px; }
  .hero h1 { font-size: clamp(34px, 9vw, 42px); }
  .hero-sub { font-size: 15px; }
  .kicker { max-width: 100%; font-size: 10px; letter-spacing: 0.06em; }
  .hero-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .hero-stats b { font-size: 18px; }
  .hero-stats span { font-size: 11px; }
  .hero-cta { gap: 4px 12px; }
  .hero-cta .btn-primary { width: 100%; }
  .hero-cta .btn-ghost { padding: 10px 2px; font-size: 14px; }
  .section { padding: 64px 20px; }
  .sec-title { font-size: 30px; }
  .sec-sub { font-size: 15px; }
  .device-grid { grid-template-columns: 1fr; }
}
</style>
