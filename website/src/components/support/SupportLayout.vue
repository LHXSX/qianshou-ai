<template>
  <SiteNav />
  <main id="main" class="support-page" tabindex="-1">
    <div class="qs-wrap">
      <header class="support-header">
        <p class="support-kicker">千手 PC <span>/</span> 下载与支持</p>
        <h1>{{ title }}</h1>
        <p class="support-intro">{{ description }}</p>
      </header>
      <nav class="support-tabs" aria-label="下载与支持">
        <router-link
          v-for="item in links"
          :key="item.hash"
          :to="{ path: '/downloads', query: route.query, hash: item.hash }"
          :aria-current="
            (route.hash || '#download') === item.hash ? 'location' : undefined
          "
        >
          {{ item.label }}<span aria-hidden="true">↗</span>
        </router-link>
      </nav>
      <div class="support-body">
        <div class="support-content"><slot /></div>
      </div>
      <section class="support-assistance">
        <div>
          <h2>遇到问题？把具体情况告诉我们。</h2>
          <p>
            附上系统类型、客户端版本、错误提示和发生时间，便于定位问题。请勿发送密码、密钥或私人素材。
          </p>
        </div>
        <a class="qs-button" href="mailto:contact@qianshousuanli.com"
          >联系支持 <span aria-hidden="true">↗</span></a
        >
      </section>
    </div>
  </main>
  <SiteFooter />
</template>
<script setup lang="ts">
import { useRoute } from "vue-router";
import SiteNav from "../website/SiteNav.vue";
import SiteFooter from "../website/SiteFooter.vue";
import "../../styles/support.css";
defineProps<{ title: string; description: string }>();
const route = useRoute();
const links = [
  { hash: "#download", label: "千手 PC" },
  { hash: "#usage", label: "安装与使用" },
  { hash: "#new", label: "版本与更新" },
];
</script>
