<template>
  <a href="#main" class="qs-skip" @click.prevent="focusMain">跳至正文</a>
  <header class="site-nav" @keydown.esc="closeMenu">
    <div class="qs-wrap nav-content">
      <BrandMark />
      <nav class="site-links" aria-label="官网导航" :class="{ open: menuOpen }">
        <a
          v-for="item in links"
          :key="item.id"
          :href="'/#/?section=' + item.id"
          @click.prevent="go(item.id)"
          >{{ item.label }}</a
        ><router-link to="/downloads" @click="menuOpen = false"
          >下载</router-link
        >
      </nav>
      <div class="nav-actions">
        <router-link
          class="nav-login"
          :to="loggedIn ? '/dashboard' : '/login'"
          >{{ loggedIn ? "控制台" : "登录" }}</router-link
        ><router-link class="qs-button primary small" to="/downloads"
          >获取客户端 <span aria-hidden="true">↗</span></router-link
        ><button
          ref="menuButton"
          class="menu-toggle"
          :aria-expanded="menuOpen"
          aria-controls="mobile-site-nav"
          :aria-label="menuOpen ? '收起导航' : '展开导航'"
          @click="menuOpen = !menuOpen"
        >
          ☰
        </button>
      </div>
    </div>
    <nav
      v-if="menuOpen"
      id="mobile-site-nav"
      class="mobile-site-nav"
      aria-label="移动导航"
    >
      <a
        v-for="item in links"
        :key="item.id"
        :href="'/#/?section=' + item.id"
        @click.prevent="go(item.id)"
        >{{ item.label }}</a
      ><router-link to="/downloads" @click="menuOpen = false"
        >下载中心</router-link
      >
    </nav>
  </header>
</template>
<script setup lang="ts">
import { ref, onUnmounted, watch } from "vue";
import { useRouter, useRoute } from "vue-router";
import BrandMark from "../../shared/BrandMark.vue";
import { auth } from "../../services/api";
const router = useRouter(),
  route = useRoute(),
  menuOpen = ref(false),
  menuButton = ref<HTMLButtonElement>(),
  loggedIn = ref(auth.isAuthenticated());
const stop = auth.onStateChange(
  () => (loggedIn.value = auth.isAuthenticated()),
);
onUnmounted(stop);
const links = [
  { id: "experience", label: "千手 PC" },
  { id: "marketplace", label: "插件生态" },
  { id: "network", label: "设备协作" },
  { id: "developers", label: "创作者与团队" },
];
function go(id: string) {
  menuOpen.value = false;
  if (route.path === "/")
    document
      .getElementById(id)
      ?.scrollIntoView({
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
  else router.push({ path: "/", query: { section: id } });
}
function closeMenu() {
  menuOpen.value = false;
  menuButton.value?.focus();
}
watch(
  () => route.path,
  () => {
    menuOpen.value = false;
  },
);
function focusMain() {
  const el = document.getElementById("main");
  el?.focus();
  el?.scrollIntoView();
}
</script>
<style scoped>
.site-nav {
  position: sticky;
  top: 0;
  z-index: 100;
  backdrop-filter: blur(22px);
  border-bottom: 1px solid #c5d9d1;
  background: #f7faf8ec;
}
.nav-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 30px;
  height: 80px;
}
.site-links,
.nav-actions {
  display: flex;
  align-items: center;
  gap: 27px;
}
.site-links a,
.nav-login {
  font-size: 13px;
  text-decoration: none;
  color: #425e58;
  white-space: nowrap;
}
.site-links a:hover,
.nav-login:hover {
  color: #087c70;
}
.nav-actions {
  gap: 22px;
}
.menu-toggle {
  display: none;
  background: none;
  border: 0;
  font-size: 24px;
  color: #24584e;
}
.nav-actions .qs-button.primary { background: #0d8275; border-color: #0d8275; border-radius: 9px; }
.nav-actions .qs-button.primary:hover { background: #096e64; }
.mobile-site-nav {
  display: none;
}
@media (max-width: 1120px) {
  .site-links {
    display: none;
  }
  .menu-toggle {
    display: block;
  }
  .nav-content {
    height: 72px;
  }
  .mobile-site-nav {
    display: grid;
    padding: 10px 24px 24px;
    gap: 5px;
    border-top: 1px solid var(--qs-line);
  }
  .mobile-site-nav a {
    padding: 12px;
    text-decoration: none;
    font-size: 14px;
  }
}
@media (max-width: 520px) {
  .nav-actions .qs-button {
    display: none;
  }
  .nav-actions {
    gap: 20px;
  }
}
.site-links a {
  font-size: 15px;
}
.nav-login {
  font-size: 15px;
}
@media (max-width: 800px) {
  .nav-content {
    height: 72px;
  }
}
</style>
