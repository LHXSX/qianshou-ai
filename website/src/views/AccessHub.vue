<template>
  <SiteNav />
  <main id="main" class="qs-wrap access-hub" tabindex="-1">
    <p class="qs-eyebrow">YOUR ROLE. YOUR WORKSPACE.</p>
    <h1 class="qs-heading">找到你的工作空间。</h1>
    <p class="qs-description">
      每个工作空间服务不同的工作职责。<br />账号身份与操作权限由平台验证，选择入口不会改变账号权限。
    </p>
    <div class="access-grid">
      <article class="qs-panel">
        <span class="qs-eyebrow">01 / PERSONAL</span>
        <h2>个人控制台</h2>
        <p>管理设备、查看任务与收益记录，维护个人账户安全。</p>
        <router-link class="qs-button primary" to="/dashboard"
          >进入个人控制台 ↗</router-link
        >
      </article>
      <article class="qs-panel">
        <span class="qs-eyebrow">02 / ENTERPRISE</span>
        <h2>企业工作台</h2>
        <p>组织业务任务、查看执行记录，通过工作台或接口连接计算能力。</p>
        <a class="qs-button" href="/ea/">进入企业工作台 ↗</a>
      </article>
      <article class="qs-panel">
        <span class="qs-eyebrow">03 / OPERATIONS</span>
        <h2>运营管理</h2>
        <p>
          面向已授权的运营管理员。后台正在恢复与升级，现有维护状态不代表业务 API
          已完成验收。
        </p>
        <span class="qs-tag">后台升级中</span>
      </article>
    </div>
    <div class="access-bottom">
      <h2>从客户端开始使用应用</h2>
      <p>插件安装、运行与能力管理在千手 PC 内完成，使用同一平台账号登录。</p>
      <router-link class="qs-link" to="/downloads"
        >查看千手 PC 安装包状态 ↗</router-link
      >
    </div>
  </main>
  <SiteFooter />
</template>
<script setup lang="ts">
import SiteNav from "../components/website/SiteNav.vue";
import SiteFooter from "../components/website/SiteFooter.vue";
</script>
<style scoped>
.access-hub {
  padding-top: 80px;
  padding-bottom: 100px;
}
.access-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 22px;
  margin-top: 45px;
}
.access-grid article {
  padding: 30px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.access-grid h2 {
  font-size: 24px;
  font-weight: 500;
  margin: 30px 0 18px;
}
.access-grid p {
  font-size: 15px;
  line-height: 1.9;
  color: var(--qs-muted);
  margin-bottom: 35px;
  flex: 1;
}
.access-grid .qs-button {
  font-size: 14px;
  width: 100%;
  padding: 0 15px;
}
.access-bottom {
  margin-top: 65px;
  border-top: 1px solid var(--qs-line);
  padding-top: 35px;
}
.access-bottom h2 {
  font-size: 21px;
  font-weight: 500;
}
.access-bottom p {
  font-size: 15px;
  color: var(--qs-muted);
  line-height: 1.8;
  margin: 15px 0 20px;
}
@media (max-width: 900px) {
  .access-grid {
    grid-template-columns: 1fr;
  }
  .access-grid p {
    margin-bottom: 25px;
  }
  .access-grid h2 {
    margin-top: 22px;
  }
  .access-grid .qs-button {
    width: auto;
  }
  .access-hub {
    padding-top: 50px;
  }
}
</style>
