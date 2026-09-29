<template>
  <div class="legal-wrap">
    <div class="legal-card">
      <header class="legal-head">
        <h1>{{ SITE_NAME }}用户服务协议</h1>
        <p class="meta">
          运营方:{{ COMPANY.legalName }}<br />
          生效日期:{{ effectiveDate }} · 版本 v1.0
        </p>
      </header>

      <section class="legal-body">
        <p class="tip">
          请您在使用本服务前,仔细阅读并充分理解本协议全部条款,特别是免除或限制责任、
          争议解决等加粗条款。<strong>一旦您注册、登录或使用本服务,即视为已阅读并同意本协议。</strong>
          如不同意,请勿使用本服务。
        </p>

        <h2>一、定义与协议主体</h2>
        <p>1.1 本协议由您(以下称"用户")与本平台运营方 <strong>{{ COMPANY.legalName }}</strong>
          (统一社会信用代码:{{ COMPANY.unifiedSocialCreditCode }},注册地址:{{ COMPANY.registeredAddress }},
          以下称"我们"或"平台")共同缔结。</p>
        <p>1.2 "本平台"/"本服务"指 {{ SITE_NAME }}({{ DOMAIN }})及其相关网站、桌面客户端、API 接口
          所提供的分布式边缘算力调度与交易服务。</p>
        <p>1.3 "任务方"指在平台发布计算任务并支付费用的用户;"节点方"(算力提供者)指向平台
          贡献闲置算力设备、执行任务并获取收益的用户。同一用户可同时具备两种身份。</p>

        <h2>二、账户注册与安全</h2>
        <p>2.1 您应以真实、准确、完整的信息注册账户,并在信息变更时及时更新。</p>
        <p>2.2 账户仅供您本人使用。您应妥善保管账户与密码,因您保管不善导致的损失由您自行承担。</p>
        <p>2.3 我们有权对涉嫌违规、被盗用或存在风险的账户采取限制、冻结或注销措施。</p>

        <h2>三、服务内容</h2>
        <p>3.1 平台提供任务发布与分发、算力节点接入与调度、技能/脚本市场、费用结算、收益提现等服务。</p>
        <p>3.2 平台仅作为算力供需双方的撮合与技术服务提供者。任务的合法性、数据内容由任务方负责;
          算力设备的合规接入由节点方负责。</p>
        <p>3.3 我们可能根据运营需要增加、调整或暂停部分服务功能,并尽合理努力提前通知。</p>

        <h2>四、用户行为规范</h2>
        <p>4.1 您承诺不利用本服务从事任何违反法律法规或本协议的行为,包括但不限于:</p>
        <ul>
          <li>发布或执行涉及违法犯罪、侵犯他人合法权益的计算任务;</li>
          <li>未经授权抓取、爬取受保护的数据,或绕过他人网站的访问控制;</li>
          <li>利用平台进行网络攻击、挖矿木马、流量代理滥用、加密货币非法挖矿等;</li>
          <li>上传含病毒、恶意代码的脚本或文件;</li>
          <li>实施欺诈、洗钱、虚假交易、刷量套利等行为。</li>
        </ul>
        <p>4.2 <strong>因您违反上述规范造成的一切法律责任与损失由您自行承担;给平台或第三方造成损失的,
          您应予以赔偿。</strong></p>

        <h2>五、节点方(算力提供者)特别约定</h2>
        <p>5.1 节点方应确保所接入设备为本人合法持有或已获授权,且接入行为不违反所在网络/场所的规定。</p>
        <p>5.2 节点方理解执行任务将占用设备的计算、存储、网络与电力资源,相关成本由节点方自行承担。</p>
        <p>5.3 平台依据任务完成情况、节点信誉与调度规则计算节点收益,具体规则以平台公示为准。</p>

        <h2>六、费用、结算与发票</h2>
        <p>6.1 任务方应按平台公示的计价规则支付费用。账户余额采用预充值与托管结算模式。</p>
        <p>6.2 节点方收益可在满足条件后申请提现,提现需经平台审核;为满足法律与风控要求,
          我们可能要求您完成必要的实名与收款信息核验。</p>
        <p>6.3 您可就已实际消费的服务向我们申请开具增值税发票,开票主体为 <strong>{{ COMPANY.legalName }}</strong>
          (税号 {{ COMPANY.unifiedSocialCreditCode }})。</p>

        <h2>七、知识产权</h2>
        <p>7.1 平台的软件、界面、商标、文档等知识产权归我们或相应权利人所有。</p>
        <p>7.2 您发布的任务数据与产出结果的权利归属由您与相关方约定;您授予平台为提供服务所必需的
          处理、传输、缓存等有限许可。</p>

        <h2>八、免责声明与责任限制</h2>
        <p>8.1 本服务按"现状"提供。<strong>在法律允许的最大范围内,我们不对因网络故障、不可抗力、
          第三方原因或节点设备异常导致的服务中断或数据损失承担责任。</strong></p>
        <p>8.2 <strong>在任何情况下,我们就本服务对您承担的累计赔偿责任,不超过您在主张权利之前三个月内
          就相关服务向我们实际支付的费用总额。</strong></p>

        <h2>九、隐私保护</h2>
        <p>我们重视您的个人信息保护,具体规则见
          <router-link to="/privacy">《{{ SITE_NAME }}隐私政策》</router-link>。</p>

        <h2>十、协议变更、终止</h2>
        <p>10.1 我们可根据法律法规及运营需要修订本协议,修订后将在平台公示;若您继续使用即视为接受。</p>
        <p>10.2 您可随时停止使用并注销账户;您严重违约的,我们有权终止向您提供服务。</p>

        <h2>十一、法律适用与争议解决</h2>
        <p>11.1 本协议的订立、效力、解释与争议解决均适用中华人民共和国法律。</p>
        <p>11.2 因本协议发生争议,双方应友好协商;协商不成的,任何一方均可向
          <strong>运营方所在地(辽宁省沈阳市皇姑区)有管辖权的人民法院</strong>提起诉讼。</p>

        <h2>十二、联系我们</h2>
        <p>运营方:{{ COMPANY.legalName }}<br />
          注册地址:{{ COMPANY.registeredAddress }}<br />
          客服邮箱:{{ OFFICIAL_LINKS.supportEmail }}<br />
          <span v-if="COMPANY.contactPhone">客服电话:{{ COMPANY.contactPhone }}</span>
        </p>

        <p class="disclaimer">
          注:本协议为平台通用版本,最终条款以平台正式公示并经法律审阅的版本为准。
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
import { SITE_NAME, DOMAIN, COMPANY, OFFICIAL_LINKS, COPYRIGHT_LINE } from '../config/site'

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
