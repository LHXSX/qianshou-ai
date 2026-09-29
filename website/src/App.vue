<template>
  <router-view />
</template>

<script setup lang="ts">
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body, #app {
  width: 100%;
  min-height: 100%;
  /* base color/background/font supplied by theme.css */
}

/* 让所有页面默认带文字颜色 + 反白光标 */
input, textarea { caret-color: var(--neon-cyan); }
</style>
