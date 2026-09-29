<script setup lang="ts">
/** 404：SPA 路由未命中。只做导航，不猜测意图。 */
import { RouterLink } from 'vue-router'
</script>

<template>
  <div class="not-found">
    <el-result icon="warning" title="页面不存在" sub-title="该路径不在管理台路由表里。">
      <template #extra>
        <RouterLink to="/">
          <el-button type="primary">回到总览</el-button>
        </RouterLink>
      </template>
    </el-result>
  </div>
</template>

<style scoped>
.not-found {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
}
</style>
