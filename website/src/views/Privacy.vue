<template>
  <div class="legal-wrap">
    <div class="legal-card">
      <header class="legal-head">
        <h1>{{ SITE_NAME }}隐私政策</h1>
        <p class="meta">
          运营方:{{ COMPANY.legalName }}<br />
          生效日期:{{ effectiveDate }} · 版本 v1.0
        </p>
      </header>

      <section class="legal-body">
        <p class="tip">
          {{ COMPANY.legalName }}(以下称"我们")深知个人信息对您的重要性,并会尽力保护您的个人信息安全。
          本政策说明我们如何收集、使用、存储、共享您的信息,以及您享有的权利。
          <strong>请您在使用本服务前仔细阅读并理解本政策。</strong>
        </p>

        <h2>一、我们收集的信息</h2>
        <p>1.1 <strong>账户信息</strong>:注册时的手机号/邮箱、用户名、密码(加密存储)。</p>
        <p>1.2 <strong>设备与硬件信息</strong>(节点方):为调度算力,我们会采集设备的 CPU/GPU 型号、内存、
          操作系统、可用资源、网络状况等硬件能力信息。</p>
        <p>1.3 <strong>任务与使用信息</strong>:您发布或执行的任务类型、参数、运行日志、结果元数据、调用记录。</p>
        <p>1.4 <strong>交易与支付信息</strong>:充值/提现记录、账户余额、收款账户(用于提现)、开票抬头。
          支付通道由第三方支付机构处理,我们不存储您的完整银行卡密码等敏感支付凭证。</p>
        <p>1.5 <strong>日志信息</strong>:访问 IP、设备标识、浏览器类型、操作时间等,用于安全风控与故障排查。</p>

        <h2>二、我们如何使用信息</h2>
        <ul>
          <li>提供、维护并改进算力调度、任务分发、结算等核心服务;</li>
          <li>进行身份核验、账户安全保护与风险控制(反欺诈、反洗钱);</li>
          <li>计算节点收益、处理充值/提现、依法开具发票;</li>
          <li>在您同意的前提下,向您发送服务通知或运营信息;</li>
          <li>履行法律法规规定的义务。</li>
        </ul>

        <h2>三、信息的共享、转让与公开</h2>
        <p>3.1 我们不会出售您的个人信息。仅在以下情形共享必要信息:</p>
        <ul>
          <li><strong>第三方支付/银行机构</strong>:为完成充值、提现与开票;</li>
          <li><strong>税务/发票服务商</strong>:为依法开具增值税发票;</li>
          <li><strong>云服务/基础设施供应商</strong>:为提供存储、计算、CDN 等支撑服务;</li>
          <li><strong>依法配合</strong>:应主管机关、司法机关依法定程序提出的要求。</li>
        </ul>
        <p>3.2 上述共享将遵循最小必要原则,并要求接收方履行保密与安全义务。</p>

        <h2>四、信息的存储与安全</h2>
        <p>4.1 您的信息存储于中华人民共和国境内的服务器。</p>
        <p>4.2 我们采用加密传输(HTTPS)、密码加盐哈希、访问控制、审计日志等技术与管理措施保护信息安全。</p>
        <p>4.3 我们仅在实现本政策目的所必需的期限及法律要求的期限内保留您的信息。</p>

        <h2>五、Cookie 与本地存储</h2>
        <p>我们使用 Cookie / localStorage 等技术保存登录状态与偏好设置。您可通过浏览器设置管理或清除,
          但这可能影响部分功能的正常使用。</p>

        <h2>六、您的权利</h2>
        <p>您有权查询、更正、补充、删除您的个人信息,撤回授权同意,以及注销账户。
          您可通过 {{ OFFICIAL_LINKS.supportEmail }} 与我们联系,我们将在法定期限内响应。
          账户注销后,我们将删除或匿名化您的个人信息(法律要求保留的除外)。</p>

        <h2>七、未成年人保护</h2>
        <p>本服务主要面向成年人。若您为未成年人,应在监护人陪同与同意下使用;
          我们不会在明知的情况下收集未成年人的个人信息。</p>

        <h2>八、本政策的更新</h2>
        <p>我们可能适时更新本政策,更新后将在平台公示并标注生效日期。重大变更我们将以显著方式提示。</p>

        <h2>九、联系我们</h2>
        <p>运营方:{{ COMPANY.legalName }}<br />
          注册地址:{{ COMPANY.registeredAddress }}<br />
          隐私事务邮箱:{{ OFFICIAL_LINKS.supportEmail }}<br />
          <span v-if="COMPANY.contactPhone">客服电话:{{ COMPANY.contactPhone }}</span>
        </p>

        <p class="disclaimer">
          注:本隐私政策为平台通用版本,最终条款以平台正式公示并经法律审阅的版本为准。
        </p>
      </section>

      <footer class="legal-foot">
        <router-link to="/">← 返回首页</router-link>
        <span>{{ COPYRIGHT_LINE }}</span>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { SITE_NAME, COMPANY, OFFICIAL_LINKS, COPYRIGHT_LINE } from '../config/site'

const effectiveDate = COMPANY.foundedDate
</script>

<style scoped>
.legal-wrap { min-height: 100vh; background: #0b1020; color: #d7dcea; padding: 40px 16px; }
.legal-card { max-width: 860px; margin: 0 auto; background: #11172b; border: 1px solid #1f2a44;
  border-radius: 16px; padding: 40px 44px; box-shadow: 0 20px 60px rgba(0,0,0,.35); }
.legal-head h1 { font-size: 26px; margin: 0 0 10px; color: #fff; }
.meta { color: #8b96b3; font-size: 13px; line-height: 1.8; margin: 0; }
.legal-body { margin-top: 28px; line-height: 1.9; font-size: 14.5px; }
.legal-body h2 { color: #7aa2ff; font-size: 17px; margin: 28px 0 10px; }
.legal-body p { margin: 8px 0; }
.legal-body ul { margin: 8px 0; padding-left: 22px; }
.legal-body li { margin: 4px 0; }
.legal-body strong { color: #ffd479; }
.tip { background: #0e1530; border: 1px solid #243150; border-radius: 10px; padding: 14px 16px;
  font-size: 13.5px; color: #aab4d0; }
.disclaimer { margin-top: 26px; color: #8b96b3; font-size: 12.5px; }
.legal-foot { margin-top: 34px; padding-top: 18px; border-top: 1px solid #1f2a44;
  display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;
  font-size: 12.5px; color: #8b96b3; }
.legal-foot a { color: #7aa2ff; text-decoration: none; }
.legal-foot a:hover { text-decoration: underline; }
</style>
