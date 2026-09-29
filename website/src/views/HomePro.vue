<template>
  <div class="ecosystem-site">
    <SiteNav />
    <main id="main" tabindex="-1">
      <section class="eco-hero" aria-labelledby="hero-title">
        <div class="qs-wrap hero-inner">
          <div class="hero-copy">
            <p class="eyebrow"><span class="eyebrow-dot" /> QIANSHOU PC · 生态预览</p>
            <h1 id="hero-title">你的想法，<br /><em>从这里开始做。</em></h1>
            <p class="hero-lead">千手是运行在你电脑上的智能体。用自然对话提出目标，让本机能力与插件成为可复用的工作方式；需要其他设备时，先看清来源和条件，再决定是否继续。</p>
            <div class="hero-actions">
              <router-link class="eco-button primary" to="/downloads">查看 PC 下载状态 <span aria-hidden="true">↗</span></router-link>
              <router-link class="eco-button secondary" :to="{ path: '/', query: { section: 'marketplace' } }">了解插件生态 <span aria-hidden="true">↓</span></router-link>
            </div>
            <div class="release-indicator" role="status"><span class="release-pulse" :class="{ ready: formalRelease || betaVisible }" aria-hidden="true" /><span v-if="formalRelease && betaVisible">千手 PC · 已验收版与未签名内测版可下载</span><span v-else-if="formalRelease">千手 PC {{ formalRelease.version }} · 查看已验收安装包</span><span v-else-if="betaVisible">千手 PC {{ betaRelease!.version }} · 未签名内测包可下载</span><span v-else-if="loading">正在核对 Mac 与 Windows 安装包状态</span><span v-else-if="status === 'unavailable'">暂时无法核对安装包，请稍后重试</span><span v-else>Mac 与 Windows 安装包仍在验收，发布后可从官网获取</span></div>
          </div>
          <figure class="product-stage" aria-label="千手 PC 对话与插件建议的产品界面示意">
            <div class="stage-orbit orbit-one" aria-hidden="true" /><div class="stage-orbit orbit-two" aria-hidden="true" />
            <div class="desktop-preview">
              <div class="preview-topbar"><span class="window-dots" aria-hidden="true"><i /><i /><i /></span><span>千手 PC</span><span class="preview-top-right">● 本机优先</span></div>
              <div class="preview-body">
                <div class="preview-sidebar" aria-hidden="true"><span class="preview-logo">千</span><div class="sidebar-pill active">对话</div><div class="sidebar-pill">插件</div><div class="sidebar-pill">接单</div><div class="sidebar-spacer" /><div class="sidebar-account"><span>人</span> 我的账号</div></div>
                <div class="preview-chat">
                  <div class="preview-chat-heading"><span>新的对话</span><small>这台电脑 · 可用能力</small></div>
                  <div class="preview-greeting"><span class="preview-spark">✳</span><strong>想做的事，交给千手</strong><p>从一个问题开始，慢慢找到合适的做法。</p></div>
                  <div class="preview-user">帮我整理这批照片，再做一个简短介绍视频</div>
                  <div class="preview-response"><span class="preview-answer-icon">✳</span><div><strong>我先查看这台电脑能做什么</strong><p>照片整理可以先在本机尝试。视频部分需要确认可用插件或其他能力，并向你说明所需素材与条件。</p><div class="preview-option"><span>◇</span><div><b>本机工作流建议</b><small>先查看能力与素材范围</small></div><span aria-hidden="true">↗</span></div></div></div>
                  <div class="preview-composer">发消息或创建任务 <span aria-hidden="true">↑</span></div>
                </div>
              </div>
            </div>
            <figcaption>产品界面示意 · 具体入口和可用能力以实际发布版本为准</figcaption>
          </figure>
        </div>
        <div class="qs-wrap hero-note"><span>一个客户端，两种角色</span><span>为自己做事 <i /> 经授权贡献能力</span></div>
      </section>

      <section id="experience" class="eco-section everyday" aria-labelledby="experience-title"><div class="qs-wrap"><div class="section-head"><p class="section-index">01 / 与你的电脑协作</p><h2 id="experience-title">先把事情说明白，<br />再决定怎么做。</h2><p>对话不必先选择“聊天、出图还是接单”。千手应结合已安装且可用的能力，给出下一步；执行、共享资料和费用都由你确认。</p></div><div class="principle-grid"><article><span class="principle-icon">✳</span><p class="card-index">01 · 对话</p><h3>像和伙伴说话一样</h3><p>说明目标、补充素材、接着追问。能直接回答的问题留在对话里，需要动手的事再形成可查看的方案。</p></article><article><span class="principle-icon">⌘</span><p class="card-index">02 · 本机</p><h3>先了解这台电脑</h3><p>查看真实可用的插件、工具和工作流。未安装、未试跑或缺少授权的能力，会说明原因与下一步。</p></article><article><span class="principle-icon">↗</span><p class="card-index">03 · 协作</p><h3>需要外部能力时再选择</h3><p>跨设备或云服务要先说明来源、数据范围、等待状态及真实报价；未能核实的信息不会用猜测数字替代。</p></article></div></div></section>

      <section id="marketplace" class="eco-section marketplace" aria-labelledby="market-title"><div class="qs-wrap"><div class="market-intro"><div><p class="section-index">02 / 插件生态</p><h2 id="market-title">让一个好方法，<br /><em>变成可复用的能力。</em></h2></div><p>插件不只是一个下载项。它需要说清用途、运行条件、输入输出、来源和授权。千手正在把“发现、制作、试用、审核、使用与接单”连成一条可检查的链路。</p></div><div class="market-tabs" role="tablist" aria-label="插件生态流程"><button v-for="(journey, index) in journeys" :key="journey.title" :id="`market-tab-${index}`" role="tab" :aria-selected="selectedJourney === index" :aria-controls="`market-panel-${index}`" :tabindex="selectedJourney === index ? 0 : -1" :class="{ selected: selectedJourney === index }" @click="selectJourney(index)" @keydown="onJourneyKey($event, index)"><span>0{{ index + 1 }}</span>{{ journey.title }}</button></div><div v-for="(journey, index) in journeys" v-show="selectedJourney === index" :key="journey.title" :id="`market-panel-${index}`" role="tabpanel" :aria-labelledby="`market-tab-${index}`" class="market-panel" tabindex="0"><div class="market-story"><span class="market-status">{{ journey.status }}</span><h3>{{ journey.heading }}</h3><p>{{ journey.description }}</p><div class="journey-steps"><div v-for="(step, stepIndex) in journey.steps" :key="step"><span>0{{ stepIndex + 1 }}</span>{{ step }}</div></div></div><div class="plugin-example" aria-label="插件信息卡片示意"><div class="example-top"><span class="example-glyph">✺</span><span class="example-label">信息结构示意</span></div><strong>{{ journey.exampleTitle }}</strong><p>{{ journey.exampleDescription }}</p><dl><div><dt>适用设备</dt><dd>按实际兼容检查</dd></div><div><dt>所需资料</dt><dd>执行前明确告知</dd></div><div><dt>可用状态</dt><dd>{{ journey.exampleState }}</dd></div></dl><div class="example-bottom">安装、价格与接单入口只会在验收通过后开放 <span aria-hidden="true">↗</span></div></div></div><p class="market-disclaimer">市场目前处于建设与分批验证阶段。页面展示的是使用流程和信息结构，不是已上架商品；购买、出售、安装及跨设备接单以客户端与平台的实际审核和状态为准。</p></div></section>

      <section id="network" class="eco-section network" aria-labelledby="network-title"><div class="qs-wrap network-layout"><div><p class="section-index">03 / 分布式协作</p><h2 id="network-title">你的设备，<br />由你决定开放多少。</h2><p class="network-lead">一台电脑既可以是自己的智能体，也可以在主人允许时贡献经过验证的能力。装了插件不等于开始接单；登录、在线和“有这个软件”也不代表它能接任何任务。</p><div class="network-points"><div><span>01</span><p><strong>逐项授权</strong><br />每项能力单独决定，接单总开关随时可关闭。</p></div><div><span>02</span><p><strong>精确匹配</strong><br />任务类型、插件版本、健康和数据范围都要符合要求。</p></div><div><span>03</span><p><strong>回到原对话</strong><br />进度、结果和费用应有可追溯的回执。</p></div></div><p class="network-footnote">这是产品的准入原则；新插件跨设备派单与结算仍在分阶段联调。</p></div><div class="network-diagram" role="img" aria-label="千手协作链路示意：用户对话，经平台能力发现与任务协调，由授权的设备执行并返回结果"><div class="diagram-head">QIANSHOU NETWORK <span>架构示意</span></div><div class="diagram-row"><div class="diagram-node active"><small>01 · 入口</small><strong>我的千手</strong><span>对话 · 确认</span></div><div class="diagram-line" aria-hidden="true">→</div><div class="diagram-node"><small>02 · 协调</small><strong>平台</strong><span>能力 · 任务</span></div></div><div class="diagram-route" aria-hidden="true"><span>↓</span></div><div class="diagram-row"><div class="diagram-node"><small>04 · 回传</small><strong>结果与回执</strong><span>进度 · 产物</span></div><div class="diagram-line" aria-hidden="true">←</div><div class="diagram-node"><small>03 · 执行</small><strong>获准的设备</strong><span>能力 · 机主策略</span></div></div><p>先确认，再执行；每一跳都应有对应的事实和权限。</p></div></div></section>

      <section id="developers" class="eco-section for-builders" aria-labelledby="builders-title"><div class="qs-wrap builders-layout"><div><p class="section-index">04 / 为创作者与团队准备</p><h2 id="builders-title">把你的专长，<br />接进千手。</h2><p>本地模型、脚本、专业工具和工作流可以成为插件的原料。先在自己的设备上形成私有草稿，检查依赖与输入输出；部分已登记的本机能力可以在机主逐次授权后试跑和私有使用。</p><div class="builder-tags"><span>插件创作助手</span><span>设备兼容检查</span><span>机主授权</span><span>企业接入</span></div></div><div class="builder-card"><p>对开发者</p><h3>从一个可验证的能力开始</h3><ol><li>描述用途、运行环境与示例</li><li>在本机验证可运行和结果质量</li><li>提交可信资料，等待平台审核</li><li>审核通过后，再决定如何分发</li></ol><div class="builder-card-bottom">公开市场投稿、售卖与订单结算仍在接入和验收中。</div></div></div></section>

      <section id="start" class="eco-section start" aria-labelledby="start-title"><div class="qs-wrap start-layout"><div><p class="section-index">05 / 开始使用</p><h2 id="start-title">每一步，都有清楚的入口。</h2><p>先查看适合这台电脑的安装包和验收状态，再决定是否下载、安装。想为自己制作插件或贡献能力时，先在本机验证，再由你决定是否继续开放。</p><div class="start-actions"><router-link class="eco-button primary" to="/downloads">查看 Mac / Windows 安装与版本 ↗</router-link><router-link class="eco-button secondary" to="/access">选择工作空间 ↗</router-link></div></div><div class="start-checklist"><div><span>1</span><p><strong>下载与安装</strong><br />先核对文件摘要、签名和安装验收状态；内测包有明确提示。</p></div><div><span>2</span><p><strong>登录并对话</strong><br />从自己的任务开始，了解这台电脑的能力。</p></div><div><span>3</span><p><strong>按需扩展</strong><br />插件与接单分别设置，默认不替你开放设备。</p></div></div></div></section>
    </main>
    <SiteFooter />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch, onMounted } from "vue";
import { useRoute } from "vue-router";
import SiteNav from "../components/website/SiteNav.vue";
import SiteFooter from "../components/website/SiteFooter.vue";
import { usePcBetaRelease } from "../composables/usePcBetaRelease";
import { usePcRelease } from "../composables/usePcRelease";
import "../assets/ecosystem-home.css";

const { release: formalRelease, loading: formalLoading, status: formalStatus } = usePcRelease();
const { release: betaRelease, loading: betaLoading, status: betaStatus } = usePcBetaRelease();
const betaVisible = computed(() => betaRelease.value?.artifacts.some((beta) => !formalRelease.value?.artifacts.some((formal) => formal.platform === beta.platform)) ?? false);
const loading = computed(() => formalLoading.value || betaLoading.value);
const status = computed(() => formalStatus.value === "unavailable" || betaStatus.value === "unavailable" ? "unavailable" : "pending");
const selectedJourney = ref(0);
const route = useRoute();
const journeys = [
  { title: "发现与使用", status: "目录与安装链路验证中", heading: "先知道它能做什么，再决定是否安装。", description: "市场信息应展示作者、用途、系统要求、输入输出与权限。只有兼容且可信的插件，才进入这台电脑的安装与本机试用流程。", steps: ["了解用途与来源", "检查本机兼容", "安装后先私有试用"], exampleTitle: "照片整理工作流", exampleDescription: "一个展示市场卡片所需信息的例子，不对应已经发布的插件。", exampleState: "示意 · 不可获取" },
  { title: "制作与投稿", status: "私有草稿与本机试跑正在验证", heading: "把自己做过的事，整理成可重复的步骤。", description: "插件助手可帮助梳理目标、依赖、输入输出和样例。草稿先留在本机，由主人检查；部分已登记的适配器可经逐次授权试跑。", steps: ["自然对话描述方法", "保存私有草稿", "本机检查与试跑", "由你选择是否投稿"], exampleTitle: "我的文档整理助手", exampleDescription: "私人草稿只用于展示信息结构；不会因创建草稿自动上架。", exampleState: "私有草稿示意" },
  { title: "出售与接单", status: "公开交易与派单尚未开放", heading: "共享能力，要先经过审核和机主同意。", description: "公开出售使用权、授权接单和实际收益是不同的步骤。审核、许可、价格、设备健康和真实订单均需分别核对；安装插件不会让设备自动接单。", steps: ["审核与许可", "选择可开放的能力", "机主逐项确认", "订单与收益可追溯"], exampleTitle: "专业能力的公开使用权", exampleDescription: "这里不展示虚构价格、销售量或收益。", exampleState: "交易与接单待开放" },
] as const;

function selectJourney(index: number) { selectedJourney.value = index; }
function onJourneyKey(event: KeyboardEvent, index: number) {
  const last = journeys.length - 1;
  let next = index;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") next = index === last ? 0 : index + 1;
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = index === 0 ? last : index - 1;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = last;
  else return;
  event.preventDefault(); selectedJourney.value = next;
  nextTick(() => document.getElementById(`market-tab-${next}`)?.focus());
}
function scrollToRequestedSection() {
  const target = typeof route.query.section === "string" ? route.query.section : "";
  if (target && /^[a-z-]+$/.test(target)) nextTick(() => document.getElementById(target)?.scrollIntoView());
}
onMounted(scrollToRequestedSection);
watch(() => route.query.section, scrollToRequestedSection);
</script>
