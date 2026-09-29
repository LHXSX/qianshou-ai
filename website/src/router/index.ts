import { createRouter, createWebHashHistory, RouteRecordRaw } from "vue-router";
import Home from "../views/HomePro.vue";
import { auth } from "../services/api";

const routes: RouteRecordRaw[] = [
  {
    path: "/downloads",
    name: "EcoDownloads",
    component: () => import("../views/Downloads.vue"),
    meta: { title: "下载与支持 · 千手" },
  },
  {
    path: "/access",
    name: "AccessHub",
    component: () => import("../views/AccessHub.vue"),
    meta: { title: "工作空间 · 千手" },
  },
  {
    path: "/",
    name: "Home",
    component: Home,
  },
  { path: "/downloads-center", redirect: "/downloads" },
  {
    path: "/runtime-mirrors",
    name: "RuntimeMirrors",
    component: () => import("../views/RuntimeMirrors.vue"),
    meta: { title: "环境镜像中心 · 千手算力" },
  },
  {
    // 千手旗下产品导航页（静态 HTML · 便于分享与 SEO）
    path: "/products",
    name: "Products",
    component: Home,
    beforeEnter() {
      window.location.replace("/products.html");
    },
    meta: { title: "千手旗下产品 · 千手算力" },
  },
  {
    path: "/beta",
    name: "BetaProgram",
    component: () => import("../views/BetaProgram.vue"),
    meta: { title: "种子企业招募 · 千手算力" },
  },
  {
    path: "/enterprise",
    redirect: "/beta",
  },
  {
    path: "/advertising",
    name: "AdvertisingPartner",
    component: () => import("../views/AdvertisingPartner.vue"),
    meta: { title: "广告位招商 · 千手算力" },
  },
  // 注意：不要再用 path:'/' 包 PortalLayout，会与首页 Home 抢匹配，导致 #app 空挂载黑屏。
  // 子路由用绝对 path，URL 仍是 /#/dashboard 等。
  {
    path: "/",
    component: () => import("../views/PortalLayout.vue"),
    meta: { requiresAuth: true },
    children: [
      {
        path: "/dashboard",
        name: "Dashboard",
        component: () => import("../views/Dashboard.vue"),
        meta: { title: "个人工作台 · 千手生态" },
      },
      {
        path: "/tasks",
        name: "Tasks",
        component: () => import("../views/Tasks.vue"),
        meta: { title: "任务记录 · 千手生态" },
      },
      {
        path: "/wallet",
        name: "Wallet",
        component: () => import("../views/Wallet.vue"),
        meta: { title: "收益钱包 · 千手生态" },
      },
      // 账户三页：必须是 / 下的绝对子路由（与 dashboard 同级），
      // 侧栏已写死 /account/info|security|notifications。
      {
        path: "/account",
        redirect: "/account/info",
      },
      {
        path: "/account/info",
        name: "AccountInfo",
        component: () => import("../views/Account.vue"),
        meta: { accountSection: "info", title: "账户信息 · 千手算力" },
      },
      {
        path: "/account/security",
        name: "AccountSecurity",
        component: () => import("../views/Account.vue"),
        meta: { accountSection: "security", title: "安全性 · 千手算力" },
      },
      {
        path: "/account/notifications",
        name: "AccountNotifications",
        component: () => import("../views/Account.vue"),
        meta: { accountSection: "notifications", title: "通知中心 · 千手算力" },
      },
      {
        path: "/my-nodes",
        name: "MyNodes",
        component: () => import("../views/MyNodes.vue"),
        meta: { title: "我的节点 · 千手生态" },
      },
      {
        path: "/equipment",
        name: "MyEquipment",
        component: () => import("../views/MyEquipment.vue"),
        meta: { title: "我的装备 · 千手算力" },
      },
      {
        path: "/app-market",
        name: "AppMarket",
        component: () => import("../views/AppMarket.vue"),
        meta: { title: "平台应用库 · 千手算力" },
      },
      {
        path: "/model-market",
        redirect: "/app-market",
      },
      {
        path: "/skill-marketplace",
        redirect: { path: "/", query: { section: "marketplace" } },
      },
      {
        path: "/level",
        name: "LevelCenter",
        component: () => import("../views/LevelCenter.vue"),
        meta: { title: "等级中心 · 千手算力" },
      },
    ],
  },
  {
    path: "/login",
    name: "Login",
    component: () => import("../views/Login.vue"),
  },
  {
    path: "/register",
    name: "Register",
    component: () => import("../views/Register.vue"),
  },
  {
    path: "/whitepaper-master",
    name: "WhitepaperMaster",
    component: () => import("../views/WhitepaperMasterDeep.vue"),
  },
  {
    path: "/terms",
    name: "Terms",
    component: () => import("../views/Terms.vue"),
    meta: { title: "用户服务协议 · 千手算力" },
  },
  {
    path: "/privacy",
    name: "Privacy",
    component: () => import("../views/Privacy.vue"),
    meta: { title: "隐私政策 · 千手算力" },
  },
  {
    path: "/:pathMatch(.*)*",
    name: "NotFound",
    component: () => import("../views/NotFound.vue"),
    meta: { title: "页面未找到 · 千手生态" },
  },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior(to, from, savedPosition) {
    if (to.path === "/downloads") {
      if (savedPosition) return savedPosition;
      if (to.hash && /^#[a-z][a-z0-9-]*$/.test(to.hash))
        return { el: to.hash, top: 100, behavior: "auto" };
      return { top: 0 };
    }
    if (from.path === "/downloads" && !to.hash && !to.query.section)
      return savedPosition || { top: 0 };
  },
});

router.beforeEach(async (to) => {
  document.title =
    typeof to.meta.title === "string"
      ? to.meta.title
      : "千手 PC · 从对话开始，让能力生长";
  const requiresAuth = to.matched.some((record) => record.meta.requiresAuth);
  if (!requiresAuth && to.path !== "/login" && to.path !== "/register")
    return true;
  let authenticated = false;
  try {
    authenticated = Boolean(await auth.ensureAccessToken());
  } catch {
    /* The login view explains unsupported browser/storage. */
  }
  if (requiresAuth && !authenticated)
    return { path: "/login", query: { redirect: to.path } };
  if ((to.path === "/login" || to.path === "/register") && authenticated)
    return "/dashboard";
  return true;
});

export default router;
