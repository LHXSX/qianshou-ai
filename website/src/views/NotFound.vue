<template>
  <SiteNav />
  <main id="main" class="qs-wrap not-found" tabindex="-1">
    <p class="qs-eyebrow">404 / PAGE NOT FOUND</p>
    <h1>这个页面暂时没有找到。</h1>
    <p>入口可能已更新。你可以回到首页，或从工作空间继续。</p>
    <div>
      <router-link class="qs-button primary" to="/">返回首页 ↗</router-link
      ><router-link class="qs-button" to="/access">选择工作空间 ↗</router-link>
    </div>
  </main>
  <SiteFooter />
</template>
<script setup lang="ts">
import SiteNav from "../components/website/SiteNav.vue";
import SiteFooter from "../components/website/SiteFooter.vue";
</script>
<style scoped>
.not-found {
  min-height: 60vh;
  padding-top: 100px;
  padding-bottom: 100px;
}
.not-found h1 {
  font-size: clamp(30px, 4vw, 48px);
  font-weight: 550;
  line-height: 1.5;
  margin: 25px 0;
}
.not-found > p:not(.qs-eyebrow) {
  color: var(--qs-muted);
  font-size: 17px;
  line-height: 1.9;
}
.not-found > div {
  display: flex;
  flex-wrap: wrap;
  gap: 15px;
  margin-top: 35px;
}
</style>
