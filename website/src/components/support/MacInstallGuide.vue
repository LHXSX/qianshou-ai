<template>
  <div class="mac-install-guide" :data-mac-install="artifact.role">
    <p class="install-note">此 Mac 预览版为临时签名，未经 Apple 公证。先完成以下校验，再决定是否打开。</p>
    <div class="install-step">
      <h4><span>1</span> 核对下载文件</h4>
      <p>命令假设文件位于“下载”文件夹且未改名。输出开头的 64 位 SHA-256 必须与本页该安装包的校验值完全一致；若位置不同，请先调整命令中的文件路径。</p>
      <CommandCopy :command="checksumCommand" :label="`${roleName} SHA-256 校验命令`" />
    </div>
    <div class="install-step">
      <h4><span>2</span> 选择实际安装位置</h4>
      <p>解压后，将 <strong>{{ appName }}</strong> 放入所选文件夹。两条路径不同，请按应用的实际位置选择。</p>
      <fieldset class="install-location">
        <legend class="install-sr-only">{{ roleName }}安装位置</legend>
        <label><input v-model="location" type="radio" :name="`${artifact.role}-install-location`" value="user" /><span><strong>仅当前用户 · 推荐</strong><code>~/Applications</code></span></label>
        <label><input v-model="location" type="radio" :name="`${artifact.role}-install-location`" value="system" /><span><strong>所有用户</strong><code>/Applications</code></span></label>
      </fieldset>
      <p class="install-location-note">{{ location === "user" ? "~ 代表你的用户主目录。若其中没有 Applications 文件夹，可先在访达中创建。" : "这是系统的“应用程序”目录。移动应用时可能需要管理员授权；请使用访达完成。" }}</p>
      <CommandCopy :command="signatureCommand" :label="`${roleName}签名完整性校验命令`" />
      <p>命令应成功结束且没有校验错误。签名完整性通过不代表 Apple 已公证，也不代表已取得正式开发者签名。</p>
    </div>
    <div class="install-step">
      <h4><span>3</span> 按需处理首次打开提示</h4>
      <p>优先按 <a href="https://support.apple.com/102445" target="_blank" rel="noopener noreferrer">Apple 官方说明</a>操作：尝试打开后，前往“系统设置 → 隐私与安全 → 仍要打开”。如果系统提示包含恶意内容，或上述校验不一致，请停止安装。</p>
      <details class="install-local-exception" data-quarantine-command>
        <summary>已核对来源与校验，查看单个应用命令</summary>
        <p><strong>请先确认安装包来自本页官方下载、SHA-256 完全一致，且所选位置的签名完整性校验通过。</strong>仅在确认信任此应用、仍遇到隔离提示时使用以下命令。它只移除所选 {{ appName }} 的下载隔离属性，不会替你运行应用。</p>
        <CommandCopy :command="quarantineCommand" :label="`${roleName}单个应用隔离处理命令`" />
      </details>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { AgentArtifact } from "../../services/agentReleaseContract";
import CommandCopy from "./CommandCopy.vue";

const props = defineProps<{ artifact: AgentArtifact }>();
const location = ref<"user" | "system">("user");
const roleName = computed(() => props.artifact.role === "controller" ? "主控端" : "协作端");
const appName = computed(() => props.artifact.role === "controller" ? "千手智能体.app" : "千手协作端.app");
const appPath = computed(() => `${location.value === "user" ? "$HOME/Applications" : "/Applications"}/${appName.value}`);
const checksumCommand = computed(() => `shasum -a 256 "$HOME/Downloads/${props.artifact.fileName}"`);
const signatureCommand = computed(() => `codesign --verify --deep --strict "${appPath.value}"`);
const quarantineCommand = computed(() => `xattr -dr com.apple.quarantine "${appPath.value}"`);
</script>

<style scoped>
.mac-install-guide { margin-top: 18px; border-top: 1px solid #d7e1ec; padding-top: 6px; min-width: 0; }
.install-note { color: #755018; background: #fff6e6; border-radius: 8px; padding: 10px 12px; }
.install-step { margin-top: 20px; min-width: 0; }
.install-step h4 { display: flex; align-items: center; gap: 8px; font-size: 14px; color: #203e64; margin: 0 0 10px; }
.install-step h4 > span { display: grid; place-items: center; width: 23px; height: 23px; border-radius: 50%; background: #e3edf9; color: #215a9f; font-size: 12px; flex: none; }
.install-step p { line-height: 1.75; }
.install-step a { color: #215a9f; text-decoration: underline; text-underline-offset: 3px; }
.install-location { margin: 12px 0 8px; border: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.install-location label { display: flex; align-items: flex-start; gap: 8px; border: 1px solid #ccd9e6; border-radius: 8px; padding: 10px; cursor: pointer; min-width: 0; }
.install-location label:has(input:checked) { border-color: #5083c7; background: #edf4ff; }
.install-location input { margin: 3px 0 0; accent-color: #225ba7; flex: none; width: 16px; height: 16px; }
.install-location strong, .install-location code { display: block; font-size: 12px; }
.install-location code { margin-top: 4px; color: #536b88; overflow-wrap: anywhere; }
.install-location-note { color: #657b94; font-size: 12px; }
.install-local-exception { margin-top: 12px; padding: 12px; background: #edf4ff; border-left: 3px solid #5083c7; border-radius: 6px; }
.install-local-exception summary { cursor: pointer; font-weight: 600; line-height: 1.7; }
.install-local-exception p { margin-top: 12px; }
.install-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.mac-install-guide :is(a, input, summary):focus-visible { outline: 3px solid #6a9ddd; outline-offset: 3px; }
@media (max-width: 480px) { .install-location { grid-template-columns: minmax(0, 1fr); } }
</style>
