<template>
  <div class="qs-console">
    <a href="#workspace-content" class="qs-skip" @click.prevent="skipToContent"
      >跳至工作内容</a
    ><button
      v-if="mobileOpen"
      class="console-shade"
      aria-label="关闭导航"
      @click="mobileOpen = false"
    ></button>
    <aside
      id="personal-navigation"
      ref="sidebar"
      class="console-sidebar"
      :class="{ open: mobileOpen }"
    >
      <div class="console-brand">
        <BrandMark /><button
          class="sidebar-close"
          aria-label="关闭导航"
          @click="closeMenu"
        >
          ×
        </button>
      </div>
      <div class="workspace-identity">
        <span class="identity-icon">P</span>
        <div>
          <strong>个人工作空间</strong><small>PERSONAL WORKSPACE</small>
        </div>
      </div>
      <nav aria-label="个人控制台导航">
        <section v-for="group in groups" :key="group.title">
          <h2>{{ group.title }}</h2>
          <router-link
            v-for="item in group.items"
            :key="item.path"
            :to="item.path"
            :aria-current="route.path === item.path ? 'page' : undefined"
            @click="mobileOpen = false"
            ><span class="nav-symbol" aria-hidden="true">{{ item.symbol }}</span
            >{{ item.label }}</router-link
          >
        </section>
      </nav>
      <div class="sidebar-bottom">
        <router-link to="/downloads">查看千手 PC 下载 ↗</router-link
        ><router-link to="/access">切换工作空间 ↗</router-link
        ><small>QIANSHOU / PERSONAL WORKSPACE</small>
      </div>
    </aside>
    <div class="console-main">
      <header class="console-header">
        <div>
          <button
            ref="menuButton"
            class="console-menu"
            aria-label="展开导航"
            :aria-expanded="mobileOpen"
            aria-controls="personal-navigation"
            @click="openMenu"
          >
            ☰</button
          ><span class="breadcrumb-root">个人工作空间</span
          ><span class="breadcrumb-divider">/</span
          ><strong>{{ routeTitle }}</strong>
        </div>
        <div class="console-account">
          <DeviceNotifications
            v-if="sessionReady && currentUser"
            :account-id="currentUser.id"
          /><router-link class="security-link" to="/account/security"
            >账户安全</router-link
          ><span class="user-avatar">{{ userInitial }}</span
          ><span class="user-name">{{
            currentUser?.username || "正在验证身份"
          }}</span
          ><button :disabled="loggingOut" @click="logout">
            {{ loggingOut ? "退出中…" : "退出" }}
          </button>
        </div>
      </header>
      <main
        ref="workspaceContent"
        id="workspace-content"
        class="console-content"
        tabindex="-1"
      >
        <div v-if="identityError" class="qs-error" role="alert">
          {{ identityError }} <router-link to="/login">重新登录</router-link>
        </div>
        <div v-else-if="!sessionReady" class="session-loading" role="status">
          正在验证工作空间身份…
        </div>
        <router-view v-else :key="sessionGeneration" />
      </main>
    </div>
  </div>
</template>
<script setup lang="ts">
import 'element-plus/dist/index.css'
import '../shared/element-plus-theme.css'
import "../assets/portal-content.css";
import { computed, ref, onMounted, onUnmounted, watch, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import BrandMark from "../shared/BrandMark.vue";
import { auth, type AuthUser } from "../services/api";
import { browserSession } from "../services/browserSession";
import { errorMessage } from "../services/identityContract";
import "../shared/console.css";
import DeviceNotifications from "../components/DeviceNotifications.vue";
const route = useRoute(),
  router = useRouter(),
  mobileOpen = ref(false),
  sidebar = ref<HTMLElement>(),
  menuButton = ref<HTMLButtonElement>(),
  sessionReady = ref(false),
  identityError = ref(""),
  currentUser = ref<AuthUser | null>(null),
  loggingOut = ref(false);
const sessionGeneration = ref("");
const workspaceContent = ref<HTMLElement>();
let verifyingGeneration = "";
let identityEpoch = 0;
let disposed = false;
const groups = [
  {
    title: "工作概览",
    items: [
      { path: "/dashboard", label: "工作台", symbol: "◫" },
      { path: "/tasks", label: "任务记录", symbol: "≡" },
    ],
  },
  {
    title: "设备与应用",
    items: [
      { path: "/my-nodes", label: "我的节点", symbol: "◇" },
      { path: "/equipment", label: "已装能力", symbol: "⊞" },
      { path: "/app-market", label: "平台应用库", symbol: "▦" },
    ],
  },
  {
    title: "账户与资产",
    items: [
      { path: "/wallet", label: "收益与账单", symbol: "⊙" },
      { path: "/level", label: "等级与权益", symbol: "☆" },
      { path: "/account/info", label: "账户资料", symbol: "◉" },
      { path: "/account/security", label: "安全设置", symbol: "⌑" },
      { path: "/account/notifications", label: "通知偏好", symbol: "◎" },
    ],
  },
];
const routeTitle = computed(
    () =>
      groups.flatMap((x) => x.items).find((x) => x.path === route.path)
        ?.label || "工作空间",
  ),
  userInitial = computed(
    () => currentUser.value?.username?.slice(0, 1).toUpperCase() || "P",
  );
function closeMenu() {
  mobileOpen.value = false;
  menuButton.value?.focus();
}
async function openMenu() {
  mobileOpen.value = true;
  await nextTick();
  sidebar.value?.querySelector<HTMLElement>("a,button")?.focus();
}
function keys(e: KeyboardEvent) {
  if (!mobileOpen.value) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeMenu();
  }
  if (e.key === "Tab") {
    const items = Array.from(
      sidebar.value?.querySelectorAll<HTMLElement>("a,button") || [],
    ).filter((x) => x.getClientRects().length);
    if (!items.length) return;
    const first = items[0],
      last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}
function skipToContent() {
  workspaceContent.value?.focus({ preventScroll: true });
  workspaceContent.value?.scrollIntoView({ block: "start" });
}
async function verifyIdentity() {
  let lease;
  try {
    lease = browserSession.capture();
  } catch {
    lease = null;
  }
  if (
    lease &&
    verifyingGeneration === lease.generation &&
    sessionGeneration.value === lease.generation
  )
    return;
  const epoch = ++identityEpoch;
  sessionGeneration.value = lease?.generation || "";
  verifyingGeneration = lease?.generation || "";
  sessionReady.value = false;
  currentUser.value = null;
  identityError.value = "";
  if (!lease) {
    void router.replace("/login");
    return;
  }
  const stillCurrent = () => {
    try {
      return (
        !disposed && epoch === identityEpoch && browserSession.isCurrent(lease)
      );
    } catch {
      return false;
    }
  };
  try {
    const me = await auth.me();
    if (!stillCurrent()) return;
    if (me.user.id !== lease.accountId)
      throw new Error("登录身份不一致，请重新登录。");
    currentUser.value = me.user;
    sessionReady.value = true;
  } catch (e) {
    if (stillCurrent())
      identityError.value = errorMessage(e, "无法验证账号身份。");
  } finally {
    if (epoch === identityEpoch) verifyingGeneration = "";
  }
}
const stop = auth.onStateChange((state) => {
  if (disposed) return;
  const nextGeneration = state.generation || "";
  // An exit invalidates an initial /me before any equal-state shortcut.
  if (!nextGeneration || !state.token) {
    identityEpoch++;
    verifyingGeneration = "";
    sessionGeneration.value = "";
    sessionReady.value = false;
    currentUser.value = null;
    identityError.value = "";
    void router.replace("/login");
    return;
  }
  if (
    nextGeneration === sessionGeneration.value &&
    (verifyingGeneration === nextGeneration ||
      (sessionReady.value && currentUser.value?.id === state.user?.id))
  )
    return;
  void verifyIdentity();
});
onMounted(() => {
  document.addEventListener("keydown", keys);
  verifyIdentity();
});
onUnmounted(() => {
  disposed = true;
  stop();
  document.removeEventListener("keydown", keys);
});
watch(
  () => route.path,
  () => {
    mobileOpen.value = false;
  },
);
async function logout() {
  loggingOut.value = true;
  try {
    await auth.logout();
    await router.replace("/login");
  } finally {
    loggingOut.value = false;
  }
}
</script>
