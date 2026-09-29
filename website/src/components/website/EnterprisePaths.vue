<template>
  <section id="enterprise" class="qs-section enterprise">
    <div class="qs-wrap">
      <p class="qs-eyebrow">04 / BUILT TO CONNECT WITH YOUR BUSINESS</p>
      <div class="enterprise-heading">
        <h2 class="qs-heading">接入你的业务。<br />尊重你的边界。</h2>
        <p class="qs-description">
          从公网平台开始，也可以围绕企业自己的网络、<br />设备与数据要求规划部署。以实际需求定义接入方式。
        </p>
      </div>
      <div class="deployment-grid">
        <article>
          <DeploymentVisual mode="public" /><span class="qs-tag"
            >PUBLIC PLATFORM</span
          >
          <h3>公网算力平台</h3>
          <p>
            通过客户端应用或企业工作台访问平台能力。用统一的任务入口组织计算，查询执行进度并获取结果。
          </p>
          <ul>
            <li>独立应用与基础工具</li>
            <li>分布式设备接入与任务调度</li>
            <li>账户、任务与计算记录</li>
          </ul>
          <a class="qs-button" href="/ea/">进入企业工作台 ↗</a>
        </article>
        <article>
          <DeploymentVisual mode="private" /><span class="qs-tag"
            >PRIVATE DEPLOYMENT</span
          >
          <h3>企业内网部署方案</h3>
          <p>
            围绕自有设备组池、专有算法接入与数据边界设计部署。网络策略、资源规模与交付范围需结合环境评估。
          </p>
          <ul>
            <li>规划专有任务与算法接入</li>
            <li>按环境设计数据与网络边界</li>
            <li>按项目明确运维与交付责任</li>
          </ul>
          <router-link class="qs-button" to="/beta"
            >了解部署与合作 ↗</router-link
          >
        </article>
      </div>
      <div class="developer-strip">
        <div>
          <p class="qs-eyebrow">FOR DEVELOPERS</p>
          <h3>专注你的应用，连接共同的底座。</h3>
          <p>
            按客户端开发者规范构建应用，经审核后独立分发。双端需要分别完成原生构建和验收。
          </p>
        </div>
        <router-link class="qs-button" to="/downloads"
          >从客户端开发者中心开始 ↗</router-link
        >
      </div>
    </div>
  </section>
</template>
<script setup lang="ts">
import DeploymentVisual from "./DeploymentVisual.vue";
</script>
<style scoped>
.enterprise {
  background: #e0e9f0;
}
.enterprise-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 40px;
}
.enterprise-heading .qs-description {
  font-size: 14px;
}
.deployment-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  margin-top: 35px;
}
.deployment-grid article {
  border: 1px solid var(--qs-line);
  border-radius: 14px;
  padding: 32px;
  background: #edf3f7;
  border-color: #becfdd;
  transition:
    transform 0.35s,
    box-shadow 0.35s;
}
.deployment-grid h3 {
  margin: 22px 0 17px;
  font-weight: 500;
  font-size: 27px;
}
.deployment-grid p {
  color: var(--qs-muted);
  font-size: 16px;
  line-height: 1.9;
}
.deployment-grid ul {
  padding: 0;
  list-style: none;
  display: grid;
  gap: 13px;
  margin: 25px 0 30px;
}
.deployment-grid li {
  color: #4f657e;
  font-size: 15px;
  line-height: 1.8;
}
.deployment-grid li:before {
  content: "＋";
  color: var(--qs-accent);
  margin-right: 10px;
}
.developer-strip {
  margin-top: 50px;
  padding: 36px 0 0;
  border-top: 1px solid var(--qs-line);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 30px;
  border-color: #b6cadb;
}
.developer-strip h3 {
  font-weight: 500;
  margin: 15px 0;
  font-size: 25px;
}
.developer-strip p:last-child {
  color: var(--qs-muted);
  font-size: 15px;
  line-height: 1.9;
  max-width: 700px;
}
.developer-strip > a {
  font-size: 14px;
  white-space: normal;
  min-width: 240px;
}
@media (max-width: 850px) {
  .enterprise-heading {
    display: block;
  }
  .deployment-grid {
    grid-template-columns: 1fr;
  }
  .deployment-grid article {
    padding: 26px;
  }
  .developer-strip {
    display: block;
  }
  .developer-strip > a {
    margin-top: 25px;
  }
}
.has-entered .enterprise-heading {
  animation: qs-enter 0.7s cubic-bezier(0.16, 1, 0.3, 1) both;
}
.deployment-grid article:hover {
  transform: translateY(-5px);
  box-shadow: 0 16px 35px #30577816;
}
@media (max-width: 800px) {
  .deployment-grid article {
    padding: 25px;
  }
}
</style>
