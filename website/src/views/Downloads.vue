<template>
  <SupportLayout
    title="下载千手 PC"
    description="一款客户端，连接你的本机智能体、插件和经过授权的算力协作。请选择电脑系统，并先核对安装包的发布状态。"
  >
    <section id="download" class="pc-download">
      <!-- Existing deep links lead to the current product. -->
      <span id="qianshou-agent" class="legacy-anchor" aria-hidden="true"></span>
      <div class="download-hero support-panel">
        <div>
          <p class="support-overline">千手 AI · 桌面客户端</p>
          <h2>从这台电脑，开始做更多事。</h2>
          <p>自然对话、本机执行、插件能力和接单工作台，都在千手 PC 里。你决定设备开放哪些能力，也能随时关闭接单。</p>
          <div class="hero-meta" aria-live="polite">
            <span class="status-dot" :class="{ active: hasDownload }" aria-hidden="true"></span>
            <span v-if="hasVisibleBeta && formalRelease">已验收版与公开内测版可下载（内测包未签名）</span>
            <span v-else-if="hasVisibleBeta">{{ betaRelease!.version }} · 公开内测版（未签名）</span>
            <span v-else-if="formalRelease">{{ formalRelease.version }} · {{ formalRelease.channel === "preview" ? "预览版" : "正式版" }}</span>
            <span v-else-if="loading">正在核对安装包…</span>
            <span v-else>双端安装包验收中</span>
          </div>
        </div>
        <div class="hero-device" aria-hidden="true"><span>千</span><small>PC</small></div>
      </div>

      <div v-if="hasVisibleBeta" class="beta-notice" role="note">
        <strong>公开内测提醒：未签名，尚未完成安装验收</strong>
        <p>标为内测的安装包使用独立的内部应用身份 <code>com.qianshou.desktop.internal</code>。内测 Mac 包未完成正式签名与公证，内测 Windows 包未签名；这些包尚未完成真机安装、首次启动和功能验收，系统可能拦截，安装后也可能无法正常使用。仅建议在可接受测试风险的设备上试用，不要关闭系统安全保护。</p>
        <p>内测包没有正式自动更新源。请保留下载文件并按下方 SHA-256 核对；后续正式版发布时需要重新下载对应安装包。</p>
      </div>

      <div class="download-heading">
        <div><p class="support-overline">选择你的系统</p><h2>千手 PC</h2></div>
        <button class="refresh-button" type="button" :disabled="loading" @click="load">刷新发布状态</button>
      </div>
      <div class="platform-grid">
        <article v-for="platform in platforms" :key="platform.id" class="platform-card support-panel">
          <div class="platform-head">
            <div class="platform-icon" aria-hidden="true">{{ platform.icon }}</div>
            <span class="platform-state" :class="{ ready: artifact(platform.id), beta: isBeta(platform.id) }">{{ isBeta(platform.id) ? "内测版可下载" : artifact(platform.id) ? `${formalLabel}可下载` : "待发布" }}</span>
          </div>
          <h3>{{ platform.name }}</h3>
          <p class="platform-description">{{ platform.description }}</p>
          <p class="platform-format">{{ platform.format }} 安装包 <span aria-hidden="true">·</span> {{ platform.arch }}</p>
          <p v-if="isBeta(platform.id)" class="beta-card-note">未签名{{ platform.id === "macos-arm64" ? "、未公证" : "" }} · 未完成真机安装验收</p>
          <a v-if="artifact(platform.id)" class="qs-button primary download-action"
            :href="artifact(platform.id)!.url" :download="artifact(platform.id)!.fileName"
            :aria-label="`下载千手 PC ${platform.name}${isBeta(platform.id) ? '未签名内测' : formalLabel}安装包`">下载 {{ platform.name }}{{ isBeta(platform.id) ? "内测版" : formalLabel }} <span aria-hidden="true">↓</span></a>
          <div v-else class="pending-action" role="status">{{ loading ? "正在核对安装包" : "安装包验收后开放下载" }}</div>
          <details v-if="artifact(platform.id)" class="file-details">
            <summary>版本与文件校验</summary>
            <dl>
              <div><dt>版本</dt><dd>{{ isBeta(platform.id) ? betaRelease!.version : formalRelease!.version }}</dd></div>
              <div><dt>文件名</dt><dd>{{ artifact(platform.id)!.fileName }}</dd></div>
              <div><dt>大小</dt><dd>{{ sizeLabel(artifact(platform.id)!.sizeBytes) }}</dd></div>
              <div><dt>构建</dt><dd>{{ artifact(platform.id)!.buildId }}</dd></div>
              <div><dt>签名</dt><dd>{{ isBeta(platform.id) ? "未签名" : "已签名" }}</dd></div>
              <div v-if="isBeta(platform.id) && platform.id === 'macos-arm64'"><dt>公证</dt><dd>未完成</dd></div>
              <div><dt>安装验收</dt><dd>{{ isBeta(platform.id) ? "未完成" : "已完成" }}</dd></div>
              <div><dt>SHA-256</dt><dd><code>{{ artifact(platform.id)!.sha256 }}</code></dd></div>
            </dl>
          </details>
          <router-link :to="{ path: '/downloads', query: { platform: platform.query }, hash: '#usage' }" class="guide-link">查看安装步骤 <span aria-hidden="true">↗</span></router-link>
        </article>
      </div>
      <p class="release-state" role="status">
        <template v-if="status === 'unavailable' && !hasDownload">当前无法核对千手 PC 发布文件。请稍后刷新；在完成校验前，页面不会提供下载链接。</template>
        <template v-else-if="!hasDownload && !loading">千手 PC 的新安装包尚未发布。页面不会把旧产品安装包当作千手 PC 提供。</template>
        <template v-else-if="hasDownload">仅从本页下载与你的系统对应的文件，并核对 SHA-256。不同系统需要各自的安装包。</template>
      </p>
    </section>

    <section id="usage" class="support-panel guide-panel">
      <p class="support-overline">安装与开始使用</p>
      <h2>三步开始</h2>
      <div class="guide-grid">
        <div><span class="step-number">01</span><h3>确认设备</h3><p>Windows 请选择 x64 电脑；Mac 请确认是 Apple M 系列芯片。Intel Mac 暂无安装包。</p></div>
        <div><span class="step-number">02</span><h3>检查并试装</h3><p>下载对应系统的安装包，确认 SHA-256 完全一致后再试装。内测包未完成安装验收；遇到系统提示时按下方说明辨别，若校验不符或明确报恶意软件，请停止并反馈。</p></div>
        <div><span class="step-number">03</span><h3>按需开放能力</h3><p>先在对话里使用本机智能体。添加插件、开放接单和共享设备能力，均由你在客户端内选择。</p></div>
      </div>
      <details id="mac-fix" :open="selectedPlatform === 'mac'">
        <summary>Mac 怎么安装</summary>
        <ol class="platform-guide">
          <li>点屏幕左上角  →“关于本机”，确认芯片为 Apple M 系列。当前 Mac 安装包不适用于 Intel 芯片。</li>
          <li>从本页下载 Mac DMG；按下方方法计算 SHA-256，确认与上方“版本与文件校验”中的值完全一致。</li>
          <li>双击 DMG，将“{{ isBeta('macos-arm64') ? '千手 PC 内测' : '千手 PC' }}”拖入“应用程序”，然后尝试从“应用程序”启动。更新前先保存工作并退出旧版。</li>
          <li v-if="isBeta('macos-arm64')">如果因“无法验证开发者”或“无法检查是否含恶意软件”而被阻止，且你确认文件来自本页、SHA-256 一致并愿意承担内测风险，可在首次尝试打开后进入“系统设置 → 隐私与安全性”，找到此应用的“仍要打开”，再按系统提示确认。这只针对当前应用。</li>
          <li>按应用提示登录，再选择工作区。插件和接单能力由你在客户端内按需开启。</li>
        </ol>
        <p v-if="isBeta('macos-arm64')" class="guide-caution">内测包未签名且未公证。如果系统明确提示应用已损坏或含恶意软件，请停止并反馈。不要全局关闭 Gatekeeper；公司管理的 Mac 请按组织策略联系管理员。<a href="https://support.apple.com/zh-cn/102445" target="_blank" rel="noopener noreferrer">查看 Apple 的单应用打开说明 ↗</a></p>
        <p v-else class="guide-caution">如果 macOS 提示开发者无法验证、文件已损坏或存在风险，先停止安装，重新核对下载来源及校验值；公司管理的 Mac 请联系管理员。不要关闭系统安全保护。</p>
      </details>
      <details id="windows-fix" :open="selectedPlatform === 'windows'">
        <summary>Windows 怎么安装</summary>
        <ol class="platform-guide">
          <li>在“设置 → 系统 → 系统信息”确认电脑为 64 位 Windows 10 或 11。</li>
          <li>从本页下载 Windows EXE；按下方方法计算 SHA-256，确认与上方“版本与文件校验”中的值完全一致。</li>
          <li>保存工作并退出旧版，双击 EXE，按安装向导尝试安装，再从开始菜单启动“{{ isBeta('windows-x64') ? '千手 PC 内测' : '千手 PC' }}”。</li>
          <li v-if="isBeta('windows-x64')">如果 SmartScreen 显示“未知发布者”或“Windows 已保护你的电脑”，且你确认文件来自本页、SHA-256 一致并愿意承担内测风险，可选择“更多信息 → 仍要运行”（如系统提供此选项），仅放行这份安装器。</li>
          <li>按应用提示登录，再选择工作区。插件和接单能力由你在客户端内按需开启。</li>
        </ol>
        <p v-if="isBeta('windows-x64')" class="guide-caution">若 Defender 或其他安全软件明确报告恶意软件，或没有“仍要运行”选项，请停止并反馈。不要全局关闭 SmartScreen、Defender 或添加排除项；公司管理的电脑请按组织策略处理。</p>
        <p v-else class="guide-caution">如果系统显示未知发布者、SmartScreen 风险提示或杀毒软件拦截，先停止安装并反馈；公司管理的电脑请按组织策略处理。不要关闭 Defender 或系统保护。</p>
      </details>
      <details id="checksums"><summary>如何核对 SHA-256</summary><p>Mac：在“终端”输入 <code>shasum -a 256 </code>，把下载的 DMG 拖入窗口后按回车。Windows：在 PowerShell 输入 <code>Get-FileHash -Algorithm SHA256 -LiteralPath '安装包完整路径.exe'</code>。将结果与上方对应系统的摘要比较；不一致时请删除文件并重新下载。</p></details>
    </section>

    <section id="new" class="support-panel update-panel">
      <span id="developers" class="legacy-anchor" aria-hidden="true"></span>
      <p class="support-overline">版本与更新</p>
      <h2>{{ hasVisibleBeta ? `公开内测 ${betaRelease!.version}` : formalRelease ? `当前发布 ${formalRelease.version}` : "等待首个安装版本" }}</h2>
      <p v-if="hasVisibleBeta">{{ betaRelease!.releasedAt.slice(0, 10) }} 提供公开内测下载。标为内测的安装包来自内部测试构建，文件摘要可核对；签名、Mac 公证及真机安装验收尚未完成。</p>
      <p v-else-if="formalRelease">{{ formalRelease.releasedAt.slice(0, 10) }} 发布。对应安装包已分别完成构建、校验和安装验收；请只下载你所在系统对应的文件。</p>
      <p v-else>安装包就绪后，会在这里显示版本、文件大小、校验值和验收状态。</p>
      <div class="update-note"><strong>以后如何更新</strong><p v-if="hasVisibleBeta">此内测构建没有正式自动更新源。获取后续版本时，请回到本页查看状态、重新下载并核对 SHA-256。</p><p v-else>千手 PC 会在应用内显示可用版本和更新状态。更新时请先保存工作；若正在接单，先完成或安全结束当前任务，再按应用提示更新。</p></div>
    </section>
  </SupportLayout>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import SupportLayout from "../components/support/SupportLayout.vue";
import { usePcBetaRelease } from "../composables/usePcBetaRelease";
import { usePcRelease } from "../composables/usePcRelease";
import type { PcBetaArtifact } from "../services/pcBetaReleaseContract";
import type { PcArtifact, PcPlatform } from "../services/pcReleaseContract";

const route = useRoute();
const { release: formalRelease, loading: formalLoading, status: formalStatus, load: loadFormal } = usePcRelease();
const { release: betaRelease, loading: betaLoading, status: betaStatus, load: loadBeta } = usePcBetaRelease();
const loading = computed(() => formalLoading.value || betaLoading.value);
const formalLabel = computed(() => formalRelease.value?.channel === "preview" ? "预览版" : "正式版");
const hasDownload = computed(() => platforms.some((platform) => Boolean(artifact(platform.id))));
const hasVisibleBeta = computed(() => platforms.some((platform) => isBeta(platform.id)));
const status = computed(() => hasDownload.value ? "ready" : formalStatus.value === "unavailable" || betaStatus.value === "unavailable" ? "unavailable" : "pending");
const platforms: { id: PcPlatform; name: string; description: string; format: string; arch: string; icon: string; query: string }[] = [
  { id: "windows-x64", name: "Windows", description: "适用于 Windows 10 / 11 的 64 位电脑", format: "EXE", arch: "x64", icon: "⊞", query: "windows" },
  { id: "macos-arm64", name: "Mac", description: "适用于 Apple M 系列芯片的 Mac", format: "DMG", arch: "Apple Silicon", icon: "⌘", query: "mac" },
];
const selectedPlatform = computed(() => route.query.platform === "mac" || route.hash === "#mac-fix" ? "mac" : "windows");
function formalArtifact(platform: PcPlatform): PcArtifact | undefined { return formalRelease.value?.artifacts.find((file) => file.platform === platform); }
function betaArtifact(platform: PcPlatform): PcBetaArtifact | undefined { return betaRelease.value?.artifacts.find((file) => file.platform === platform); }
function artifact(platform: PcPlatform): PcArtifact | PcBetaArtifact | undefined { return formalArtifact(platform) ?? betaArtifact(platform); }
function isBeta(platform: PcPlatform): boolean { return !formalArtifact(platform) && Boolean(betaArtifact(platform)); }
async function load() { await Promise.all([loadFormal(), loadBeta()]); }
function sizeLabel(bytes: number): string { return `${(bytes / 1024 ** 2).toFixed(1)} MB（${bytes.toLocaleString("zh-CN")} 字节）`; }
</script>

<style scoped>
.pc-download { position: relative; }
.legacy-anchor { position: absolute; top: 0; height: 1px; width: 1px; overflow: hidden; scroll-margin-top: 105px; }
.download-hero { display: flex; align-items: center; justify-content: space-between; gap: 28px; padding: 36px 42px; background: linear-gradient(120deg, #fff 0%, #f7fbff 66%, #e9f6f3 100%); border-color: #b5d6d2; overflow: hidden; }
.download-hero h2 { font-size: clamp(26px, 3vw, 36px); letter-spacing: -0.035em; margin: 0 0 8px; }
.download-hero p:not(.support-overline) { max-width: 660px; margin: 0; }
.hero-meta { display: inline-flex; align-items: center; gap: 9px; margin-top: 20px; padding: 6px 12px; border: 1px solid #ccdedc; background: #f5faf9; color: #275b56; border-radius: 999px; font-size: 13px; }
.status-dot { width: 7px; height: 7px; border-radius: 50%; background: #ba9a53; }.status-dot.active { background: #298772; }
.hero-device { width: 132px; height: 132px; flex: 0 0 auto; border: 1px solid #b3d7d1; border-radius: 32px; display: grid; place-items: center; position: relative; background: #fff9; box-shadow: 0 18px 42px #16514b14; color: #137c70; }
.hero-device span { font-size: 56px; font-weight: 700; line-height: 1; }.hero-device small { position: absolute; right: 12px; bottom: 10px; letter-spacing: .1em; font-weight: 700; }
.download-heading { display: flex; align-items: end; justify-content: space-between; gap: 15px; padding: 30px 2px 17px; }.download-heading .support-overline { margin-bottom: 1px; }.download-heading h2 { margin: 0; }
.refresh-button { border: 1px solid #c3d0dd; background: #fff; color: #35516a; border-radius: 9px; padding: 8px 15px; min-height: 38px; cursor: pointer; font: inherit; font-size: 13px; }.refresh-button:hover:not(:disabled) { border-color: #79a7a0; color: #147365; }.refresh-button:disabled { opacity: .5; cursor: wait; }
.platform-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
.platform-card { min-width: 0; display: flex; flex-direction: column; padding: 26px; border-color: #d1dbdf; box-shadow: 0 12px 30px #2843550b; }.platform-head { display: flex; align-items: start; justify-content: space-between; }
.platform-icon { width: 52px; height: 52px; display: grid; place-items: center; border-radius: 14px; border: 1px solid #d3e4e2; background: #f1f8f7; color: #19786f; font-size: 30px; }
.platform-state { padding: 4px 10px; border-radius: 999px; color: #80612b; background: #faf3e4; font-size: 12px; font-weight: 600; }.platform-state.ready { color: #14705f; background: #e7f7f1; }
.platform-state.beta { color: #8a521f; background: #fff0d9; }
.platform-card h3 { font-size: 23px; margin: 15px 0 0; }.platform-card .platform-description { margin: 0 0 15px; font-size: 14px; }
.platform-format { display: flex; gap: 9px; align-items: center; font-size: 13px; color: #667e91 !important; margin-bottom: 21px !important; }
.beta-notice { margin-top: 18px; padding: 18px 22px; border: 1px solid #e3b76f; border-radius: 12px; background: #fff8eb; color: #694a1e; }.beta-notice strong { display: block; font-size: 16px; }.beta-notice p { margin: 8px 0 0; font-size: 14px; }.beta-notice code { overflow-wrap: anywhere; }.beta-card-note { margin: -9px 0 17px !important; color: #875521; font-size: 13px; font-weight: 600; }
.download-action, .pending-action { min-height: 48px; width: 100%; display: flex; align-items: center; justify-content: center; gap: 12px; margin-top: auto; text-decoration: none; }.pending-action { border: 1px dashed #c8d6d9; border-radius: 10px; background: #f7f9fa; color: #71818e; font-size: 14px; }
.guide-link { display: block; align-self: center; padding-top: 17px; font-size: 13px; text-decoration: none; }.file-details { font-size: 13px; margin-top: 15px; }.file-details dl { margin: 8px 0 0; }.file-details dl div { display: grid; grid-template-columns: 70px minmax(0, 1fr); gap: 10px; margin: 8px 0; }.file-details dt { color: #667e91; }.file-details dd { margin: 0; overflow-wrap: anywhere; }
.release-state { margin: 17px 2px 0; font-size: 13px; color: #677e8e !important; }
.guide-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 22px; margin: 26px 0; }.guide-grid > div { border-top: 1px solid #d7e2e7; padding-top: 16px; }.step-number { display: block; color: #218071; font-size: 13px; font-weight: 700; margin-bottom: 10px; }.guide-grid h3 { margin: 0 0 7px; }.guide-grid p { font-size: 14px; margin: 0; }.guide-panel details { font-size: 14px; }.platform-guide { margin: 12px 0; padding-left: 1.5em; }.platform-guide li { margin: 8px 0; line-height: 1.7; }.guide-caution { padding: 10px 14px; border-left: 3px solid #d5a451; background: #fcf8ed; border-radius: 4px; }
.update-panel { position: relative; }.update-note { margin-top: 18px; padding: 16px 20px; background: #f3f8fa; border-radius: 10px; border: 1px solid #d9e8e8; font-size: 14px; }.update-note p { margin: 5px 0 0; }
@media (max-width: 700px) { .download-hero { padding: 27px; }.hero-device { display: none; }.platform-grid, .guide-grid { grid-template-columns: 1fr; }.download-heading { align-items: center; } }
</style>
