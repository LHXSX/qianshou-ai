<template>
  <article class="download-card support-panel">
    <div class="download-card-top">
      <span class="os-glyph" aria-hidden="true">{{
        platform === "windows-x64" ? "⊞" : "⌘"
      }}</span>
      <span class="support-tag">预览版</span>
    </div>
    <h2>{{ name }}</h2>
    <p class="download-chip">
      {{
        platform === "windows-x64"
          ? "64 位 · x64 架构"
          : "Apple Silicon · M 系列芯片"
      }}
    </p>
    <div class="download-file-meta">
      <span>{{ kind }} 安装包</span
      ><span>{{
        file ? (file.size_bytes / 1024 / 1024).toFixed(1) + " MB" : "—"
      }}</span>
    </div>
    <a
      v-if="file"
      class="qs-button primary"
      :href="file.url"
      download
      :aria-label="'下载 ' + name + ' ' + kind + ' 安装包'"
      >下载 {{ name }} 版 <span aria-hidden="true">↓</span></a
    >
    <button v-else class="qs-button" disabled>
      {{ loading ? "正在获取版本…" : "暂不可下载" }}
    </button>
    <router-link
      class="install-link"
      :to="{
        path: '/downloads',
        query: { platform: platform === 'windows-x64' ? 'windows' : 'mac' },
        hash: '#usage',
      }"
      >{{ name }} 安装指南 <span aria-hidden="true">↗</span></router-link
    >
    <details v-if="file">
      <summary>核对下载文件</summary>
      <p class="file-name">{{ file.url.split("/").pop() }}</p>
      <p>SHA-256</p>
      <code>{{ file.sha256 }}</code
      ><button class="support-text-button" @click="copy">复制校验值</button>
      <p role="status" class="copy-status">{{ copyState }}</p>
    </details>
  </article>
</template>
<script setup lang="ts">
import { ref } from "vue";
import type { EcoDownload } from "../../services/releaseContract";
const props = defineProps<{
  platform: string;
  name: string;
  kind: string;
  file?: EcoDownload;
  loading: boolean;
}>();
const copyState = ref("");
async function copy() {
  try {
    await navigator.clipboard.writeText(props.file!.sha256);
    copyState.value = "校验值已复制";
  } catch {
    copyState.value = "未能复制，请选择上方校验值手动复制。";
  }
}
</script>
<style scoped>
.download-card {
  padding: 28px 30px;
  background: linear-gradient(145deg, #fff, #f9fbff);
  border-top: 3px solid #2870d6;
}
.download-card-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 15px;
}
.os-glyph {
  font-size: 39px;
  color: #2268c5;
  font-weight: 400;
  line-height: 1;
}
.download-card h2 {
  font-size: 28px;
  margin: 0 0 4px;
}
.download-card .download-chip {
  margin: 0 0 18px;
  font-size: 15px;
}
.download-file-meta {
  display: flex;
  gap: 16px;
  font-size: 14px;
  color: #536d86;
  margin-bottom: 20px;
}
.download-file-meta span + span {
  border-left: 1px solid #b9cde3;
  padding-left: 16px;
}
.download-card > .qs-button {
  width: 100%;
  font-size: 16px;
  min-height: 50px;
}
.install-link {
  display: flex;
  justify-content: center;
  gap: 12px;
  padding: 16px 0 5px;
  text-decoration: none;
  font-size: 15px;
}
.download-card details {
  margin-top: 13px;
  padding-bottom: 0;
  font-size: 14px;
}
.download-card code {
  display: block;
  word-break: break-all;
}
.file-name {
  overflow-wrap: anywhere;
}
.copy-status {
  font-size: 14px;
  min-height: 0;
}
</style>
