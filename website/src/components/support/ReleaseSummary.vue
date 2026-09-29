<template>
  <div v-if="note">
    <h3>{{ note.title }}</h3>
    <ul>
      <li v-for="line in note.changes" :key="line">{{ line }}</li>
    </ul>
    <div class="support-callout">
      <strong>你需要做什么</strong>
      <p>{{ note.action }}</p>
    </div>
    <template v-if="note.knownIssues.length"
      ><h3>使用前请了解</h3>
      <ul>
        <li v-for="line in note.knownIssues" :key="line">{{ line }}</li>
      </ul></template
    >
  </div>
  <p v-else>
    当前安装包版本以官方发布清单为准。该版本的详细更新说明正在整理，请先查看安装与升级指南。
  </p>
</template>
<script setup lang="ts">
import type { ReleaseNote } from "../../services/releaseEditorial";
defineProps<{ note?: ReleaseNote }>();
</script>
