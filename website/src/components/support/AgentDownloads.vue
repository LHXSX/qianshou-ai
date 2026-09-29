<template>
  <section id="qianshou-agent" class="agent-downloads support-panel" aria-labelledby="agent-download-title">
    <div class="agent-heading">
      <div>
        <p class="support-overline">千手智能体 · 独立应用</p>
        <h2 id="agent-download-title">一处指挥，多端协作</h2>
      </div>
      <span class="support-tag">{{ release ? `v${release.version} · 预览版` : "预览版" }}</span>
    </div>
    <p class="agent-intro">在办公电脑安装主控端，与 CEO 对话、分派任务；在需要配合的电脑安装协作端，配对后参与工作。</p>
    <p v-if="loading" role="status">正在获取千手智能体版本…</p>
    <div v-else-if="error" role="alert" class="support-error">
      {{ error }} <button class="support-text-button" @click="load">重新获取智能体版本</button>
    </div>
    <p v-if="release" class="agent-release-date">发布时间：{{ dateLabel }}</p>
    <div class="agent-grid">
      <article v-for="role in roles" :key="role.id" class="agent-card" :aria-labelledby="`agent-${role.id}-title`">
        <header class="agent-role-heading">
          <span class="agent-icon" aria-hidden="true">
            <svg v-if="role.id === 'controller'" width="26" height="26" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4M8 9l2 2-2 2m5 0h3"/></svg>
            <svg v-else width="26" height="26" viewBox="0 0 24 24" fill="none"><rect x="2" y="3" width="13" height="10" rx="2"/><rect x="10" y="11" width="12" height="10" rx="2"/><path d="M5 17h2m11-10h3"/></svg>
          </span>
          <div><p>{{ role.eyebrow }}</p><h3 :id="`agent-${role.id}-title`">{{ role.name }}</h3></div>
        </header>
        <p class="agent-role-description">{{ role.description }}</p>
        <div v-if="release" class="agent-packages">
          <div v-for="artifact in artifactsFor(role.id)" :key="artifact.url" class="agent-package">
            <div class="agent-package-top"><strong>{{ agentPlatformLabel(artifact) }}</strong><span>{{ agentFileSize(artifact.size) }}</span></div>
            <a class="qs-button" :class="{ primary: role.id === 'controller' }" :href="artifact.url" :download="artifact.fileName" :aria-label="`下载${role.name} ${agentPlatformLabel(artifact)}`">下载{{ role.name }} <span aria-hidden="true">↓</span></a>
            <p class="agent-verification">{{ artifact.verified ? "已验证" : "待目标系统验证" }} · {{ artifact.signature === 'adhoc' ? "本机签名，未经公证" : "未进行发行签名" }}</p>
            <details class="agent-package-details">
              <summary>安装说明与文件校验</summary>
              <p class="agent-file-name">{{ artifact.fileName }}</p>
              <ul v-if="artifact.notes.length"><li v-for="(note, index) in artifact.notes" :key="index">{{ note }}</li></ul>
              <p><strong>SHA-256</strong><br /><code>{{ artifact.sha256 }}</code></p>
              <MacInstallGuide v-if="artifact.platform === 'darwin'" :artifact="artifact" />
              <p v-else-if="artifact.platform === 'win32'" class="agent-windows-note">此 Windows 预览版未进行发行签名，首次启动可能出现安全提示。请先确认安装包来自本页并核对 SHA-256，再按电脑的管理策略决定是否安装；无法确认来源或校验不一致时，请停止安装。</p>
            </details>
          </div>
          <p v-for="platform in missingPlatforms(role.id)" :key="platform" class="agent-unavailable">{{ platform }} · 暂未提供安装包</p>
        </div>
        <p v-else class="agent-unavailable">{{ loading ? "正在确认可下载的平台…" : "版本信息暂不可用" }}</p>
      </article>
    </div>
    <details class="agent-start">
      <summary>两端如何配合使用</summary>
      <ol>
        <li>在自己的办公电脑安装主控端，按应用提示配置模型接口和工作目录。</li>
        <li>把本页协作端的对应系统安装包发给对方。对方启动后，先添加允许访问的工作区。</li>
        <li>在主控的设备页面生成五分钟有效的一次性配对码；对方填入可达的主控 HTTPS 地址、设备名称与配对码，再确认连接。127.0.0.1 只表示当前电脑，不能当作另一台主控的地址。</li>
        <li>设备在线后，先分配一个查看目录的任务，对方在协作端核对并同意执行，再确认主控收到结果。命令使用对方当前用户权限；工作目录不等于系统沙箱。</li>
      </ol>
      <p>远程桌面需要两端另行安装 RustDesk；屏幕、鼠标键盘的连接确认和系统权限由 RustDesk 管理。安装协作端不会自动开放网络入口或配置路由器。</p>
      <p>千手智能体使用独立安装包与发布记录。上方千手生态 V3 客户端的安装和更新仍按其原流程进行。</p>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useAgentRelease } from "../../composables/useAgentRelease";
import { agentFileSize, agentPlatformLabel, type AgentArtifact } from "../../services/agentReleaseContract";
import MacInstallGuide from "./MacInstallGuide.vue";
const { release, loading, error, load } = useAgentRelease();
const roles = [
  { id: "controller", eyebrow: "你的办公电脑", name: "主控端", description: "对话、语音、团队派工与开发工作台，从这里组织工作。" },
  { id: "companion", eyebrow: "参与协作的电脑", name: "协作端", description: "连接已授权的设备，接收任务并配合主控端执行。" },
] as const;
const artifactsFor = (role: AgentArtifact["role"]) => release.value?.artifacts.filter(item => item.role === role) ?? [];
const missingPlatforms = (role: AgentArtifact["role"]) => (["darwin", "win32", "linux"] as const)
  .filter(platform => !artifactsFor(role).some(item => item.platform === platform))
  .map(platform => ({ darwin: "macOS", win32: "Windows", linux: "Linux" })[platform]);
const dateLabel = computed(() => release.value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeZone: "Asia/Shanghai" }).format(new Date(release.value.releasedAt)) : "");
</script>

<style scoped>
.agent-downloads { overflow-wrap: anywhere; }
.agent-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; flex-wrap: wrap; }
.agent-heading h2 { margin-bottom: 8px; }
.agent-intro { max-width: 820px; }
.agent-release-date { font-size: 13px; }
.agent-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; margin-top: 24px; }
.agent-card { min-width: 0; border: 1px solid #ccd9e6; border-radius: 12px; padding: 24px; background: #f8fbff; }
.agent-role-heading { display: flex; align-items: center; gap: 14px; }
.agent-role-heading p { font-size: 12px; margin: 0 0 2px; letter-spacing: .06em; }
.agent-role-heading h3 { margin: 0; font-size: 23px; }
.agent-icon { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 12px; background: #e5eefb; color: #225ba7; flex: none; }
.agent-icon svg { stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.agent-role-description { min-height: 3.5em; font-size: 15px; padding: 10px 0 4px; }
.agent-package { border-top: 1px solid #d7e1ec; padding: 20px 0 14px; }
.agent-package-top { display: flex; gap: 12px; align-items: baseline; justify-content: space-between; font-size: 14px; margin-bottom: 12px; }
.agent-package-top span { white-space: nowrap; color: #657b94; font-size: 13px; }
.agent-package .qs-button { min-height: 42px; width: 100%; justify-content: space-between; box-sizing: border-box; }
.agent-verification { font-size: 12px; }
.agent-package-details { font-size: 13px; margin-top: 8px; }
.agent-package-details summary, .agent-start summary { cursor: pointer; color: #215a9f; font-weight: 600; }
.agent-package-details p, .agent-package-details li { font-size: 13px; }
.agent-file-name { color: #314d70; }
.agent-windows-note { padding: 10px 12px; border-radius: 8px; background: #fff6e6; color: #755018; line-height: 1.75; }
.agent-unavailable { border-top: 1px solid #d7e1ec; padding-top: 10px; font-size: 13px; }
.agent-start { margin-top: 24px; border-top: 1px solid #d7e1ec; padding-top: 20px; font-size: 14px; }
.agent-downloads :is(a, button, summary):focus-visible { outline: 3px solid #6a9ddd; outline-offset: 4px; }
@media (max-width: 720px) {
  .agent-grid { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .agent-card { padding: 20px; }
  .agent-role-description { min-height: 0; }
}
</style>
