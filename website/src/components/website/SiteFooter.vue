<template>
  <footer class="site-footer">
    <div class="qs-wrap footer-top">
      <div>
        <BrandMark />
        <p>从自然对话开始，用好这台电脑的能力。<br />想要分享能力时，由你决定开放什么。</p>
      </div>
      <div v-for="group in groups" :key="group.title" class="footer-group">
        <h3>{{ group.title }}</h3>
        <a v-for="link in group.links" :href="link.href" :key="link.label">{{
          link.label
        }}</a>
      </div>
    </div>
    <div class="qs-wrap footer-bottom">
      <span>© 2026 千手算力 · 沈阳千手执棋网络科技有限公司</span
      ><a
        href="https://beian.miit.gov.cn/"
        target="_blank"
        rel="noopener noreferrer"
        >辽ICP备2026012682号</a
      ><span>QIANSHOU PC / 生态预览</span>
    </div>
  </footer>
</template>
<script setup lang="ts">
import BrandMark from "../../shared/BrandMark.vue";
const groups = [
  {
    title: "产品与平台",
    links: [
      { label: "千手 PC", href: "/#/downloads" },
      { label: "插件生态", href: "/#/?section=marketplace" },
      { label: "设备协作", href: "/#/?section=network" },
    ],
  },
  {
    title: "工作空间",
    links: [
      { label: "个人控制台", href: "/#/dashboard" },
      { label: "企业工作台", href: "/ea/" },
      { label: "运营管理", href: "/#/access" },
    ],
  },
  {
    title: "了解千手",
    links: [
      { label: "创作者与团队", href: "/#/?section=developers" },
      { label: "用户服务协议", href: "/#/terms" },
      { label: "隐私政策", href: "/#/privacy" },
    ],
  },
];
</script>
<style scoped>
.site-footer {
  border-top: 1px solid var(--qs-line);
  padding: 62px 0 25px;
  background: #e5eee9;
  border-color: #cadbd2;
}
.footer-top {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1fr;
  gap: 40px;
}
.footer-top p {
  line-height: 1.9;
  color: var(--qs-muted);
  margin-top: 24px;
  font-size: 15px;
}
.footer-group h3 {
  font-weight: 500;
  margin-bottom: 23px;
  font-size: 14px;
  color: #4c6b5b;
}
.footer-group a {
  display: block;
  color: #355249;
  text-decoration: none;
  margin: 16px 0;
  font-size: 15px;
}
.footer-group a:hover {
  color: #087c70;
}
.footer-bottom {
  border-top: 1px solid var(--qs-line);
  margin-top: 60px;
  padding-top: 24px;
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 14px;
  color: var(--qs-muted);
  font-size: 13px;
  line-height: 1.8;
}
.footer-bottom a {
  text-decoration: none;
}
@media (max-width: 650px) {
  .footer-top {
    grid-template-columns: 1fr 1fr;
    gap: 35px;
  }
  .footer-top > div:first-child {
    grid-column: 1/-1;
  }
  .footer-bottom {
    margin-top: 30px;
    line-height: 1.8;
  }
}
@media (max-width: 800px) {
  .footer-bottom {
    font-size: 12px;
  }
}
</style>
