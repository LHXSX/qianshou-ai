<template>
  <div class="deep-page">
    <section class="hero page-section">
      <div class="eyebrow">EDGECOMPUTE MASTER WHITEPAPER · v1.2 · 论文级深度版</div>
      <h1>全球边缘分布式算力网络项目白皮书</h1>
      <p class="lead">
        我们要建设一个面向企业的分布式算力基础设施：把全球闲置 CPU/GPU 资源接入网络，
        通过超算调度引擎完成任务分析、切片、调度、执行、验证、聚合与结算，让企业以更低成本获得可交付算力。
      </p>
      <aside class="planning-note" role="note">
        <strong>历史方案与测算示例</strong>
        <p>本页记录早期产品与商业规划。会员规模、价格、分润、服务时效、收入及估值均为目标或示例，不代表当前可用资源、生效政策或服务承诺。实际使用请以平台当前能力、正式报价和订单条款为准。<router-link to="/access">查看当前入口 →</router-link></p>
      </aside>
      <div class="hero-grid">
        <article v-for="item in heroStats" :key="item.label" class="stat-card">
          <span>{{ item.label }}</span>
          <strong>{{ item.value }}</strong>
          <small>{{ item.desc }}</small>
        </article>
      </div>
      <div class="visual-network">
        <div class="network-center">
          <strong>Supercompute V2</strong>
          <span>任务分析 · 切片 · 调度 · 验证 · 结算</span>
        </div>
        <div class="network-node n1">企业任务</div>
        <div class="network-node n2">200万会员入口</div>
        <div class="network-node n3">边缘GPU/CPU</div>
        <div class="network-node n4">收益结算</div>
        <div class="network-node n5">结果回传</div>
      </div>
    </section>

    <section class="poster-section">
      <article class="vision-map">
        <div class="vision-center">
          <span>核心闭环</span>
          <strong>企业任务 × 边缘算力 × 收益结算</strong>
        </div>
        <div class="vision-flow">
          <div>企业发布任务</div>
          <div>平台切片调度</div>
          <div>节点执行计算</div>
          <div>结果验证回传</div>
        </div>
      </article>
      <div class="value-grid">
        <article><span>企业</span><strong>降本 + 弹性</strong><p>按任务采购，不长期包机器。</p></article>
        <article><span>用户</span><strong>闲时收益</strong><p>设备空闲时参与有效任务。</p></article>
        <article><span>渠道</span><strong>合作分润待定</strong><p>具体比例以未来生效的合作政策与订单为准。</p></article>
        <article><span>平台</span><strong>服务收入待定</strong><p>平台负责调度、交付、风控和结算；收费规则另行确认。</p></article>
      </div>
    </section>

    <section v-for="chapter in thesisChapters" :key="chapter.no" class="page-section thesis-chapter">
      <div class="section-title">
        <span>{{ chapter.no }}</span>
        <h2>{{ chapter.title }}</h2>
      </div>
      <div class="chapter-visual">
        <div class="mini-network">
          <i></i><i></i><i></i><i></i><i></i>
        </div>
        <p>{{ chapter.visual }}</p>
      </div>
      <p class="chapter-lead">{{ chapter.thesis }}</p>
      <div class="dual">
        <article class="info-card">
          <h3>专业论证</h3>
          <p>{{ chapter.professional }}</p>
        </article>
        <article class="info-card accent">
          <h3>大白话解释</h3>
          <p>{{ chapter.plain }}</p>
        </article>
      </div>
      <div class="argument-grid">
        <article class="info-card">
          <h3>现实例子</h3>
          <p>{{ chapter.example }}</p>
        </article>
        <article class="info-card">
          <h3>说服证据</h3>
          <ul>
            <li v-for="item in chapter.evidence" :key="item">{{ item }}</li>
          </ul>
        </article>
        <article class="info-card">
          <h3>行动方案</h3>
          <ul>
            <li v-for="item in chapter.actions" :key="item">{{ item }}</li>
          </ul>
        </article>
      </div>
      <div class="chapter-conclusion">
        <strong>本章结论：</strong>{{ chapter.conclusion }}
      </div>
    </section>

    <section class="visual-break">
      <div>
        <span>FROM IDEA TO BUSINESS</span>
        <h2>不是白皮书概念，而是商业闭环</h2>
      </div>
      <div class="break-flow">
        <article>企业任务</article>
        <article>调度引擎</article>
        <article>边缘节点</article>
        <article>结果交付</article>
        <article>收益结算</article>
      </div>
    </section>

    <section class="page-section">
      <div class="section-title">
        <span>01</span>
        <h2>算力需求、市场现状与未来前景</h2>
      </div>
      <div class="dual">
        <article class="info-card">
          <h3>为什么现在需要新的算力网络</h3>
          <p>
            AI大模型、AIGC、影视渲染、数据处理、仿真计算正在把算力从“IT资源”变成“生产资料”。
            企业不只是需要买服务器，而是需要更便宜、更弹性、可按任务交付的计算能力。
          </p>
        </article>
        <article class="info-card accent">
          <h3>未来趋势</h3>
          <p>
            算力会从中心化机房走向“中心云 + 边缘节点 + 闲置设备”的混合网络。谁能把碎片化资源组织成可交付服务，
            谁就有机会成为下一代算力基础设施平台。
          </p>
        </article>
      </div>
      <div class="cards four">
        <article class="info-card">
          <h3>AI推理爆发</h3>
          <p>企业调用模型、图像生成、视频生成、智能客服都会持续消耗推理算力。</p>
        </article>
        <article class="info-card">
          <h3>传统云成本压力</h3>
          <p>中心化云资源稳定但价格高，中小企业对弹性、低成本算力有更强需求。</p>
        </article>
        <article class="info-card">
          <h3>闲置设备浪费</h3>
          <p>大量个人与机构设备在夜间、闲时未被充分利用，存在可组织的供给空间。</p>
        </article>
        <article class="info-card">
          <h3>任务型交付崛起</h3>
          <p>企业更关心任务结果、成本和时效，而不是关心买了哪台机器。</p>
        </article>
      </div>
    </section>

    <section class="page-section">
      <div class="section-title">
        <span>02</span>
        <h2>我们的行业定位：不是云厂商，也不是单纯共享显卡</h2>
      </div>
      <table>
        <thead>
          <tr>
            <th>模式</th>
            <th>传统做法</th>
            <th>存在问题</th>
            <th>我们的做法</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>传统云</td>
            <td>企业购买云主机/GPU实例</td>
            <td>成本高、资源闲置、弹性采购门槛高</td>
            <td>按任务交付，按结果与SLA计费</td>
          </tr>
          <tr>
            <td>算力租赁</td>
            <td>按卡、按小时出租</td>
            <td>客户仍需自己适配任务与环境</td>
            <td>平台封装任务包，负责调度与回传</td>
          </tr>
          <tr>
            <td>共享显卡</td>
            <td>偏C端赚钱工具</td>
            <td>供给侧强，企业交付弱</td>
            <td>企业侧任务发行 + 供给侧节点网络双轮驱动</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="page-section">
      <div class="section-title">
        <span>03</span>
        <h2>项目一句话与大白话解释</h2>
      </div>
      <div class="section-figure figure-supply">
        <div>企业任务</div>
        <div>调度引擎</div>
        <div>边缘算力</div>
      </div>
      <div class="dual">
        <article class="info-card">
          <h3>专业版</h3>
          <p>
            千手算力 是企业级边缘分布式算力网络，通过任务协议、节点画像、调度策略、执行沙箱、
            结果验证与分润结算，构建“算力供给网络 + 企业任务市场 + 超算调度引擎”的三端闭环。
          </p>
        </article>
        <article class="info-card accent">
          <h3>大白话版</h3>
          <p>
            企业有任务，我们帮它拆开；用户有闲置电脑和显卡，我们让它们赚钱；平台负责调度、验收和分钱。
            这不是无效跑分，而是把闲置算力变成企业可以购买的生产力。
          </p>
        </article>
      </div>
      <div class="example-box">
        <h3>让不懂技术的人快速理解</h3>
        <p>
          可以把 千手算力 理解成“算力版滴滴”。滴滴不是自己买所有车，而是把社会车辆组织起来接单；
          我们不是自己买所有服务器，而是把闲置电脑、显卡和边缘设备组织起来接企业计算任务。
        </p>
        <p>
          例子：一家影视公司要渲染 10,000 帧动画，传统方式是买云服务器或排队等机房。
          在我们这里，企业上传任务后，系统自动把 10,000 帧拆成很多小任务，分发给合适的节点计算，
          最后再把结果合并返回给企业。
        </p>
      </div>
    </section>

    <section class="page-section">
      <div class="section-title">
        <span>04</span>
        <h2>我们现在已经做成了什么</h2>
      </div>
      <div class="section-figure figure-progress">
        <div><b>Web</b><span>官网/文档</span></div>
        <div><b>Portal</b><span>企业/个人后台</span></div>
        <div><b>Engine</b><span>V2调度逻辑</span></div>
        <div><b>Screen</b><span>管理大屏</span></div>
      </div>
      <div class="cards four">
        <article v-for="item in completed" :key="item.title" class="info-card">
          <h3>{{ item.title }}</h3>
          <p>{{ item.desc }}</p>
          <b>{{ item.status }}</b>
        </article>
      </div>
      <div class="note">
        当前项目不是 PPT 阶段，已经具备官网、个人后台、企业后台、管理大屏、任务链路、文档体系与核心调度思想。
        下一阶段重点不是继续堆页面，而是完成“真实企业任务 + 真实节点 + 真实结算”的生产级闭环。
      </div>
      <div class="maturity-visual">
        <article><span>01</span><strong>可展示</strong><p>官网、后台、大屏、文档物料</p></article>
        <article><span>02</span><strong>可运行</strong><p>任务链路、调度思想、节点体系</p></article>
        <article><span>03</span><strong>待验证</strong><p>真实企业任务、真实结算、真实复购</p></article>
      </div>
    </section>

    <section class="page-section">
      <div class="section-title">
        <span>05</span>
        <h2>核心业务架构</h2>
      </div>
      <div class="section-figure figure-stack">
        <div>应用层</div>
        <div>调度层</div>
        <div>节点层</div>
        <div>结算层</div>
      </div>
      <div class="architecture">
        <article v-for="layer in architecture" :key="layer.title" class="arch-card">
          <span>{{ layer.index }}</span>
          <h3>{{ layer.title }}</h3>
          <p>{{ layer.desc }}</p>
        </article>
      </div>
      <div class="flow">
        <div v-for="step in flow" :key="step">{{ step }}</div>
      </div>
      <div class="diagram-panel">
        <h3>闭环图：从企业任务到三方分润</h3>
        <div class="loop-diagram">
          <div>企业发任务</div>
          <div>平台切片调度</div>
          <div>节点执行</div>
          <div>结果验证</div>
          <div>企业验收</div>
          <div>三方分润</div>
        </div>
      </div>
      <div class="example-box">
        <h3>任务运行例子：影视渲染任务如何跑</h3>
        <p>
          企业上传一个动画项目，要求 24 小时内完成 10,000 帧渲染。系统先识别任务类型是“渲染”，
          再按帧切片，例如每 20 帧为一个子任务。调度引擎根据节点显卡、内存、在线稳定性、历史完成率匹配节点。
          节点完成后上传结果，平台抽样复核，最后聚合成完整视频或序列文件返回企业。
        </p>
      </div>
    </section>

    <section class="page-section highlight">
      <div class="section-title">
        <span>06</span>
        <h2>200万会员战略：冷启动的核心资产</h2>
      </div>
      <div class="section-figure figure-members">
        <div class="member-dot big">200万</div>
        <div class="member-dot">10万</div>
        <div class="member-dot">1万</div>
        <div class="member-dot">2400</div>
      </div>
      <div class="dual">
        <article class="info-card">
          <h3>战略价值</h3>
          <p>
            200万会员不是普通流量，而是潜在算力节点入口。它可以帮助平台跨过供给侧冷启动，
            快速形成有效在线节点、任务吞吐能力和对企业销售的产能背书。
          </p>
        </article>
        <article class="info-card">
          <h3>执行原则</h3>
          <p>
            不做一次性全量推广。先按高性能设备人群灰度，验证安装率、有效在线率、任务成功率、
            客诉率与结算争议，再逐步扩大。
          </p>
        </article>
      </div>
      <div class="funnel">
        <article v-for="item in memberFunnel" :key="item.label">
          <span>{{ item.label }}</span>
          <strong>{{ item.value }}</strong>
          <small>{{ item.desc }}</small>
        </article>
      </div>
      <div class="example-box">
        <h3>200万会员不是直接等于200万节点</h3>
        <p>
          现实打法是分层转化：先从高性能电脑用户开始。比如 200 万会员里，先触达 10 万人，
          如果 10% 下载、60% 安装成功、40% 达到硬件与在线要求，就能形成约 2,400 个首批有效节点。
          这批节点先跑真实企业任务，验证收益、客诉和稳定性，再扩大到 5 万、10 万有效节点。
        </p>
      </div>
      <div class="conversion-visual">
        <article><b>200万</b><span>会员池</span></article>
        <article><b>10万</b><span>首批触达</span></article>
        <article><b>1万</b><span>下载试用</span></article>
        <article><b>6000</b><span>安装成功</span></article>
        <article><b>2400</b><span>有效节点</span></article>
      </div>
    </section>

    <section class="page-section">
      <div class="section-title">
        <span>07</span>
        <h2>市场份额与收入测算</h2>
      </div>
      <p class="section-copy">
        以国内可交易算力服务细分市场月规模 30 亿为策略测算口径，第一阶段目标不是全国大而全，
        而是拿下可交付细分场景的 0.5% - 2%。
      </p>
      <table>
        <thead>
          <tr>
            <th>市场份额</th>
            <th>月GMV</th>
            <th>客户端（示例65%）</th>
            <th>渠道（示例5%）</th>
            <th>平台（示例30%）</th>
            <th>平台年收入</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in marketRows" :key="row.share">
            <td>{{ row.share }}</td>
            <td>{{ row.gmv }}</td>
            <td>{{ row.client }}</td>
            <td>{{ row.channel }}</td>
            <td>{{ row.platform }}</td>
            <td>{{ row.year }}</td>
          </tr>
        </tbody>
      </table>
      <div class="chart-panel">
        <h3>市场份额可视化：很小份额也能形成千万级流水</h3>
        <div class="bar-chart">
          <article>
            <span>0.5%份额</span>
            <div class="track"><i style="width: 25%"></i></div>
            <strong>1500万/月GMV</strong>
          </article>
          <article>
            <span>1%份额</span>
            <div class="track"><i style="width: 50%"></i></div>
            <strong>3000万/月GMV</strong>
          </article>
          <article>
            <span>2%份额</span>
            <div class="track"><i style="width: 100%"></i></div>
            <strong>6000万/月GMV</strong>
          </article>
        </div>
      </div>
      <div class="market-poster">
        <article>
          <span>0.5%份额</span>
          <strong>1500万/月</strong>
          <p>适合第一阶段验证</p>
        </article>
        <article>
          <span>1%份额</span>
          <strong>3000万/月</strong>
          <p>进入稳定增长区间</p>
        </article>
        <article>
          <span>2%份额</span>
          <strong>6000万/月</strong>
          <p>具备下一轮融资故事</p>
        </article>
      </div>
      <div class="example-box">
        <h3>市场份额例子：为什么0.5%也有意义</h3>
        <p>
          如果细分算力服务市场月交易额按 30 亿测算，0.5% 不是很大的份额，但已经是 1500 万月GMV。
          若仅按下方 65/5/30 的历史假设演算，客户端为 975 万，渠道为 75 万，平台为 450 万；实际分配比例尚需另行确认。
          这说明我们早期不需要吃下整个市场，只要先拿很小一块可交付场景，就能形成可验证收入。
        </p>
      </div>
    </section>

    <section class="page-section">
      <div class="section-title">
        <span>08</span>
        <h2>历史分润假设：演算各方份额</h2>
      </div>
      <p class="section-copy">以下 65/5/30 仅供比较方案，不是已生效的收入分配规则。实际比例与结算条件须以平台正式政策和订单记录确认。</p>
      <div class="split-bar">
        <div class="client">示例：客户端 65%</div>
        <div class="channel">渠道 5%</div>
        <div class="platform">平台 30%</div>
      </div>
      <div class="split-visual">
        <div class="donut">
          <div class="donut-hole">65/5/30</div>
        </div>
        <div class="legend-list">
          <p><b class="dot client-dot"></b>客户端：最大比例，驱动装机与长期在线。</p>
          <p><b class="dot channel-dot"></b>渠道：持续分润，驱动会员触达与转化。</p>
          <p><b class="dot platform-dot"></b>平台：承担调度、交付、风控、结算和销售。</p>
        </div>
      </div>
      <div class="cards three">
        <article class="info-card">
          <h3>客户端</h3>
          <p>拿最大比例，目的是让用户愿意长期在线。收益与有效任务、设备性能、稳定性、验证通过率挂钩。</p>
        </article>
        <article class="info-card">
          <h3>渠道</h3>
          <p>拿持续推广分润，核心指标不是下载量，而是有效在线节点、留存、客诉率与作弊率。</p>
        </article>
        <article class="info-card">
          <h3>平台</h3>
          <p>在示例模型中承担调度、风控、销售、交付、结算、合规与技术运维；实际份额待定。</p>
        </article>
      </div>
      <div class="example-box">
        <h3>分润例子：企业付100万元怎么分</h3>
        <p>
          假设一个企业本月购买 100 万元任务服务，并采用本页历史示例比例，客户端节点池为 65 万，渠道方为 5 万，平台为 30 万；这不是实际报价或分账规则。
          客户端的 65 万不是平均发，而是按每台设备的有效任务量、完成质量、稳定性和风控结果分配；
          这样高质量设备拿得更多，虚假在线拿不到钱。
        </p>
      </div>
    </section>

    <section class="page-section">
      <div class="section-title">
        <span>09</span>
        <h2>不同角色最关心的收益问题</h2>
      </div>
      <div class="cards five">
        <article v-for="role in roleReturns" :key="role.role" class="info-card">
          <h3>{{ role.role }}</h3>
          <p><b>多久看结果：</b>{{ role.time }}</p>
          <p><b>收益/价值：</b>{{ role.return }}</p>
          <p><b>验证指标：</b>{{ role.metric }}</p>
        </article>
      </div>
      <div class="role-map">
        <article v-for="role in roleReturns" :key="role.role + '-map'">
          <strong>{{ role.role }}</strong>
          <span>{{ role.return }}</span>
        </article>
      </div>
    </section>

    <section class="page-section">
      <div class="section-title">
        <span>10</span>
        <h2>论文式说服结构：每个角色都要回答的5个问题</h2>
      </div>
      <p class="section-copy">
        这份材料不是只讲愿景，而是按“角色问题 - 项目回答 - 证据 - 收益 - 风险控制”的逻辑展开。
        不同角色看到的重点不同：投资人看回报与控制风险，企业看降本与交付，渠道看新增利润，客户端看收益与安全，团队看职责与成长。
      </p>
      <div class="thesis-grid">
        <article v-for="item in thesisQuestions" :key="item.title" class="info-card">
          <h3>{{ item.title }}</h3>
          <p>{{ item.answer }}</p>
        </article>
      </div>
    </section>

    <section class="page-section deep-role">
      <div class="section-title">
        <span>11</span>
        <h2>投资人视角：我为什么投、投多少、拿多少、多久回报</h2>
      </div>
      <div class="dual">
        <article class="info-card">
          <h3>投资人真正关心的问题</h3>
          <ul>
            <li>你们到底在做什么，是否只是概念？</li>
            <li>市场够不够大，能不能拿到真实份额？</li>
            <li>我投多少钱，占多少股份，股权是否清晰？</li>
            <li>多久看到经营数据，多久可能估值提升？</li>
            <li>失败时风险边界在哪里？</li>
          </ul>
        </article>
        <article class="info-card accent">
          <h3>我们的回答</h3>
          <p>
            我们不是先讲远期故事，而是先用 6-12 个月跑出三件事：真实企业任务、真实在线节点、真实结算数据。
            投资采用分轮进入，现金拿基础股，份额达成释放里程碑股，避免一次性高稀释与空承诺。
          </p>
        </article>
      </div>
      <table>
        <thead>
          <tr>
            <th>投资档位</th>
            <th>参考投前估值</th>
            <th>参考持股</th>
            <th>资金用途</th>
            <th>12个月验证目标</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in investorRows" :key="row.amount">
            <td>{{ row.amount }}</td>
            <td>{{ row.valuation }}</td>
            <td>{{ row.equity }}</td>
            <td>{{ row.use }}</td>
            <td>{{ row.target }}</td>
          </tr>
        </tbody>
      </table>
      <div class="note">
        投资人一句话：你投的不是一个“算力概念”，而是一个正在把企业任务、用户闲置设备、渠道流量和调度系统连接起来的生产型网络。
      </div>
    </section>

    <section class="page-section deep-role">
      <div class="section-title">
        <span>12</span>
        <h2>渠道创始人/200万会员方视角：我出资源，能换来什么</h2>
      </div>
      <div class="cards three">
        <article class="info-card">
          <h3>投入什么</h3>
          <p>提供会员触达入口、联合推广资源、品牌背书和试点人群，不需要改变原主营业务。</p>
        </article>
        <article class="info-card">
          <h3>拿什么</h3>
          <p>渠道分润与合作权益需根据实际贡献、正式协议和生效政策商定。</p>
        </article>
        <article class="info-card">
          <h3>多久验证</h3>
          <p>先做1万-5万人灰度，6-8周看激活、在线、收益、客诉和企业交付数据。</p>
        </article>
      </div>
      <table>
        <thead>
          <tr>
            <th>合作阶段</th>
            <th>渠道动作</th>
            <th>平台动作</th>
            <th>渠道收益</th>
            <th>是否放量</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in channelRows" :key="row.stage">
            <td>{{ row.stage }}</td>
            <td>{{ row.channel }}</td>
            <td>{{ row.platform }}</td>
            <td>{{ row.return }}</td>
            <td>{{ row.decision }}</td>
          </tr>
        </tbody>
      </table>
      <div class="example-box">
        <h3>企业报价例子：为什么不直接按显卡报价</h3>
        <p>
          企业真正关心的不是“用了几张显卡”，而是“这个任务多久完成、多少钱、结果能不能验收”。
          例如一个电商公司要批量生成 50 万张商品图，我们可以按“每万张图 + 完成时限 + 成功率SLA”报价，
          而不是让客户理解每台节点是什么显卡。
        </p>
      </div>
    </section>

    <section class="page-section deep-role">
      <div class="section-title">
        <span>13</span>
        <h2>企业客户视角：我为什么不用传统云，而用你们</h2>
      </div>
      <div class="dual">
        <article class="info-card">
          <h3>企业采购逻辑</h3>
          <p>
            企业不关心“你有多少节点”，它关心：任务能不能按时完成、成本能不能下降、结果能不能验收、出了问题谁负责。
            所以我们对企业讲“任务交付”，不是讲“装机数量”。
          </p>
        </article>
        <article class="info-card">
          <h3>企业试点承诺</h3>
          <p>
            7天需求诊断，14天POC，30天试运行。试点输出成本、时效、成功率、失败原因、复购建议五类报告。
          </p>
        </article>
      </div>
      <table>
        <thead>
          <tr>
            <th>企业关心点</th>
            <th>我们的机制</th>
            <th>可交付证据</th>
            <th>不达标处理</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in enterpriseProofRows" :key="row.concern">
            <td>{{ row.concern }}</td>
            <td>{{ row.mechanism }}</td>
            <td>{{ row.proof }}</td>
            <td>{{ row.fallback }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="page-section deep-role">
      <div class="section-title">
        <span>14</span>
        <h2>客户端用户视角：我装了客户端，安全吗，能赚多少</h2>
      </div>
      <div class="cards four">
        <article class="info-card">
          <h3>安全</h3>
          <p>仅在授权范围和闲时运行，可暂停、可退出、可卸载，任务类型由平台准入。</p>
        </article>
        <article class="info-card">
          <h3>收益</h3>
          <p>收益按有效任务与质量计算，高配设备和稳定在线用户收益更高。</p>
        </article>
        <article class="info-card">
          <h3>透明</h3>
          <p>用户可查看任务记录、收益明细、设备状态、提现进度。</p>
        </article>
        <article class="info-card">
          <h3>风控</h3>
          <p>虚假在线、作弊、异常收益会触发冻结，保障真实用户利益。</p>
        </article>
      </div>
      <div class="example-box">
        <h3>客户端收益例子</h3>
        <p>
          例如一台高配电脑晚上空闲 4 小时，实际参与了 3 小时有效任务，任务质量通过验证，稳定性评分高，
          那它获得的收益会高于普通低配设备。反过来，如果只是挂机但没有跑任务，或者任务失败、掉线、作弊，
          收益会降低甚至为 0。
        </p>
      </div>
    </section>

    <section class="page-section deep-role">
      <div class="section-title">
        <span>15</span>
        <h2>团队成员视角：我加入后干什么，未来拿什么</h2>
      </div>
      <table>
        <thead>
          <tr>
            <th>角色</th>
            <th>核心任务</th>
            <th>前90天目标</th>
            <th>长期收益</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in teamIncentiveRows" :key="row.role">
            <td>{{ row.role }}</td>
            <td>{{ row.task }}</td>
            <td>{{ row.target }}</td>
            <td>{{ row.reward }}</td>
          </tr>
        </tbody>
      </table>
      <div class="example-box">
        <h3>渠道老板能听懂的例子</h3>
        <p>
          这不是让眼镜公司改行做算力，而是把 200 万会员里的高性能设备用户筛出来，变成新的数字资产。
          若假设平台月GMV达到 3000 万、且采用历史示例的 5% 渠道比例，演算值为 150 万/月、1800 万/年；这不代表实际收入或承诺比例。
          是否产生渠道收入，仍取决于真实订单、贡献与正式结算规则。
        </p>
      </div>
    </section>

    <section class="page-section">
      <div class="section-title">
        <span>16</span>
        <h2>企业客户场景与报价逻辑</h2>
      </div>
      <p class="section-copy">
        我们不按“单台机器配置”直接对企业报价，而是按“任务交付能力 + SLA + 验收结果”报价。
        底层用节点配置核算成本，对外用任务包、有效算力单位与交付指标定价。
      </p>
      <table>
        <thead>
          <tr>
            <th>场景</th>
            <th>企业痛点</th>
            <th>适配任务</th>
            <th>计费口径</th>
            <th>试点周期</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in enterpriseScenarios" :key="row.scene">
            <td>{{ row.scene }}</td>
            <td>{{ row.pain }}</td>
            <td>{{ row.task }}</td>
            <td>{{ row.price }}</td>
            <td>{{ row.period }}</td>
          </tr>
        </tbody>
      </table>
      <div class="example-box">
        <h3>竞争差异例子：我们不是“算了么”的简单复制</h3>
        <p>
          如果一个平台主要解决“用户装客户端赚钱”，那它偏供给侧；而我们要同时解决“企业怎么发布任务、任务怎么切片、
          谁来调度、结果怎么验证、钱怎么分、失败怎么处理”。差异点在于我们要做企业交付闭环，而不只是装机网络。
        </p>
      </div>
    </section>

    <section class="page-section">
      <div class="section-title">
        <span>17</span>
        <h2>客户端结算规则：为什么用户愿意长期在线</h2>
      </div>
      <div class="dual">
        <article class="info-card">
          <h3>收益计算公式</h3>
          <p>客户端收益 = 有效任务量 × 任务单价 × 质量系数 × 稳定性系数 × 风控通过状态。</p>
          <ul>
            <li>只按有效任务结算，不按单纯挂机结算。</li>
            <li>高性能设备、高稳定在线、高通过率获得更高收益。</li>
            <li>异常收益、作弊、虚假在线会冻结或清零。</li>
          </ul>
        </article>
        <article class="info-card">
          <h3>用户侧表达</h3>
          <p>用户看到的是简单收益：今日收益、累计收益、预计月收益、可提现金额、设备状态。</p>
          <ul>
            <li>日统计，T+7可提现。</li>
            <li>可随时暂停，不影响正常使用。</li>
            <li>收益透明，任务记录可查看。</li>
          </ul>
        </article>
      </div>
    </section>

    <section class="page-section">
      <div class="section-title">
        <span>18</span>
        <h2>渠道合作模型：200万会员方如何赚钱</h2>
      </div>
      <div class="cards four">
        <article v-for="item in channelModel" :key="item.title" class="info-card">
          <h3>{{ item.title }}</h3>
          <p>{{ item.desc }}</p>
        </article>
      </div>
      <table>
        <thead>
          <tr>
            <th>月GMV</th>
            <th>渠道5%分润</th>
            <th>年化渠道分润</th>
            <th>对渠道老板的意义</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>1500万</td>
            <td>150万/月</td>
            <td>1800万/年</td>
            <td>新增利润线，且不改变主营业务</td>
          </tr>
          <tr>
            <td>3000万</td>
            <td>300万/月</td>
            <td>3600万/年</td>
            <td>会员资产升级为数字基础设施资产</td>
          </tr>
          <tr>
            <td>6000万</td>
            <td>600万/月</td>
            <td>7200万/年</td>
            <td>形成战略级第二增长曲线</td>
          </tr>
        </tbody>
      </table>
      <div class="equity-visual">
        <h3>控制权可视化：两轮融资后仍保持51%以上</h3>
        <div class="equity-row">
          <span>融资前</span>
          <div class="equity-track"><i style="width: 67%">创始人 67%</i></div>
        </div>
        <div class="equity-row">
          <span>首轮后</span>
          <div class="equity-track"><i style="width: 56.95%">创始人 56.95%</i></div>
        </div>
        <div class="equity-row">
          <span>二轮后</span>
          <div class="equity-track"><i style="width: 52.39%">创始人 52.39%</i></div>
        </div>
        <p>红线：创始人或一致行动人长期不低于 51%。</p>
      </div>
      <div class="example-box">
        <h3>股权例子：为什么创始人要保51%</h3>
        <p>
          早期项目方向会频繁调整，如果创始人控制权太低，战略容易被短期财务诉求带偏。
          所以我们设计为创始人融资前 67%，首轮后约 56.95%，二轮后约 52.39%，两轮后仍高于 51%，
          既能融资，又不丢方向盘。
        </p>
      </div>
    </section>

    <section class="page-section">
      <div class="section-title">
        <span>19</span>
        <h2>竞争格局与我们的差异化</h2>
      </div>
      <table>
        <thead>
          <tr>
            <th>类型</th>
            <th>代表模式</th>
            <th>优势</th>
            <th>短板</th>
            <th>我们的切入点</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in competitors" :key="row.type">
            <td>{{ row.type }}</td>
            <td>{{ row.mode }}</td>
            <td>{{ row.advantage }}</td>
            <td>{{ row.weakness }}</td>
            <td>{{ row.edge }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="page-section">
      <div class="section-title">
        <span>20</span>
        <h2>企业架构与治理结构</h2>
      </div>
      <div class="cards three">
        <article v-for="item in companyStructure" :key="item.title" class="info-card">
          <h3>{{ item.title }}</h3>
          <p>{{ item.desc }}</p>
        </article>
      </div>
      <table>
        <thead>
          <tr>
            <th>阶段</th>
            <th>创始人</th>
            <th>联合创始团队</th>
            <th>ESOP</th>
            <th>外部投资人</th>
            <th>控制权判断</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>融资前</td>
            <td>67.00%</td>
            <td>13.00%</td>
            <td>10.00%</td>
            <td>0.00%</td>
            <td>创始人绝对控制</td>
          </tr>
          <tr>
            <td>首轮后</td>
            <td>56.95%</td>
            <td>11.05%</td>
            <td>8.50%</td>
            <td>15.00%</td>
            <td>仍高于51%</td>
          </tr>
          <tr>
            <td>二轮后</td>
            <td>52.39%</td>
            <td>10.17%</td>
            <td>7.82%</td>
            <td>21.80%</td>
            <td>仍高于51%</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="page-section">
      <div class="section-title">
        <span>21</span>
        <h2>融资计划与资金用途</h2>
      </div>
      <div class="cards two">
        <article class="info-card">
          <h3>融资节奏</h3>
          <ul>
            <li>Seed-1：1200万，用于产品硬化、合规闭环、企业POC。</li>
            <li>Seed-2：800万，用于渠道放量、销售复制、风控结算扩容。</li>
            <li>总融资规划：2000万，覆盖12个月核心验证周期。</li>
          </ul>
        </article>
        <article class="info-card">
          <h3>一股多少钱</h3>
          <ul>
            <li>示例总股本：1000万股。</li>
            <li>投前估值5000万时，每股5元。</li>
            <li>若外部总上限49%，对应融资额取决于投前估值。</li>
          </ul>
        </article>
      </div>
      <div class="budget-bar">
        <div class="b1">研发产品 38%</div>
        <div class="b2">市场销售 26%</div>
        <div class="b3">基础设施 13%</div>
        <div class="b4">法务财税 9%</div>
        <div class="b5">运营结算 14%</div>
      </div>
      <div class="funding-visual">
        <article>
          <span>Seed-1</span>
          <strong>1200万</strong>
          <p>产品硬化、合规闭环、企业POC</p>
        </article>
        <article>
          <span>Seed-2</span>
          <strong>800万</strong>
          <p>渠道放量、销售复制、风控扩容</p>
        </article>
        <article>
          <span>12个月目标</span>
          <strong>0.5%-2%</strong>
          <p>形成可验证收入与下一轮融资基础</p>
        </article>
      </div>
      <div class="example-box">
        <h3>融资使用例子：2000万不是一次烧广告</h3>
        <p>
          这 2000 万主要用于把项目从“能演示”推进到“能交付”：研发产品用于调度、客户端、风控；
          市场销售用于企业POC和首批行业客户；法务财税用于协议、隐私、结算和开票；
          运营结算用于客服、提现、对账和异常处理。
        </p>
      </div>
    </section>

    <section class="page-section">
      <div class="section-title">
        <span>22</span>
        <h2>团队架构：15-25人最小可行组织</h2>
      </div>
      <div class="team-grid">
        <article v-for="team in teams" :key="team.name" class="team-card">
          <h3>{{ team.name }}</h3>
          <strong>{{ team.size }}</strong>
          <p>{{ team.desc }}</p>
        </article>
      </div>
    </section>

    <section class="page-section">
      <div class="section-title">
        <span>23</span>
        <h2>岗位清单与首批招聘优先级</h2>
      </div>
      <table>
        <thead>
          <tr>
            <th>优先级</th>
            <th>岗位</th>
            <th>人数</th>
            <th>为什么重要</th>
            <th>首月目标</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="job in hiring" :key="job.role">
            <td>{{ job.priority }}</td>
            <td>{{ job.role }}</td>
            <td>{{ job.count }}</td>
            <td>{{ job.reason }}</td>
            <td>{{ job.goal }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="page-section">
      <div class="section-title">
        <span>24</span>
        <h2>企业打法：先试点，再复购，再规模化</h2>
      </div>
      <div class="timeline">
        <article v-for="step in enterprisePlaybook" :key="step.title">
          <span>{{ step.time }}</span>
          <h3>{{ step.title }}</h3>
          <p>{{ step.desc }}</p>
        </article>
      </div>
    </section>

    <section class="page-section">
      <div class="section-title">
        <span>25</span>
        <h2>12个月关键KPI与红绿灯机制</h2>
      </div>
      <table>
        <thead>
          <tr>
            <th>指标</th>
            <th>绿色可放量</th>
            <th>黄色需观察</th>
            <th>红色必须暂停</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="kpi in kpis" :key="kpi.name">
            <td>{{ kpi.name }}</td>
            <td>{{ kpi.green }}</td>
            <td>{{ kpi.yellow }}</td>
            <td>{{ kpi.red }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="page-section">
      <div class="section-title">
        <span>26</span>
        <h2>合规与风控底座</h2>
      </div>
      <div class="cards four">
        <article v-for="item in compliance" :key="item.title" class="info-card">
          <h3>{{ item.title }}</h3>
          <p>{{ item.desc }}</p>
        </article>
      </div>
    </section>

    <section class="page-section">
      <div class="section-title">
        <span>27</span>
        <h2>未来市值与估值路径（规划口径）</h2>
      </div>
      <table>
        <thead>
          <tr>
            <th>阶段</th>
            <th>核心结果</th>
            <th>收入基础</th>
            <th>估值逻辑</th>
            <th>参考估值区间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in valuationRows" :key="row.stage">
            <td>{{ row.stage }}</td>
            <td>{{ row.result }}</td>
            <td>{{ row.revenue }}</td>
            <td>{{ row.logic }}</td>
            <td>{{ row.value }}</td>
          </tr>
        </tbody>
      </table>
      <p class="risk">
        风险声明：估值为规划口径，不构成承诺。真实估值取决于收入质量、复购率、交付稳定性、合规情况与市场环境。
      </p>
      <div class="example-box">
        <h3>未来市值怎么讲才不虚</h3>
        <p>
          不要一开始就说“未来百亿”。更专业的说法是：如果只是产品演示，估值只能按早期项目；
          如果跑出 0.5% 份额并稳定复购，就可以按收入倍数和网络价值重估；
          如果跑到 1%-2% 并跨行业复制，才有资格谈平台型估值。
        </p>
      </div>
    </section>

    <section class="page-section">
      <div class="section-title">
        <span>28</span>
        <h2>版本路线图</h2>
      </div>
      <div class="version-grid">
        <article v-for="version in versions" :key="version.name">
          <span>{{ version.name }}</span>
          <h3>{{ version.title }}</h3>
          <p>{{ version.desc }}</p>
        </article>
      </div>
      <div class="roadmap-visual">
        <div>v1.0 演示闭环</div>
        <div>v1.5 真实试点</div>
        <div>v2.0 规模运营</div>
        <div>v3.0 网络平台</div>
      </div>
    </section>

    <section class="page-section quote">
      <h2>一句话总纲</h2>
      <blockquote>
        先稳住创始人控制权，先跑通企业交付，再用200万会员打开供给侧冷启动，
        通过真实任务、真实节点、真实结算，建设一个可复制、可融资、可规模化的边缘分布式算力网络。
      </blockquote>
    </section>
  </div>
</template>

<script setup lang="ts">
const heroStats = [
  { label: '目标市场份额', value: '0.5% - 2%', desc: '第一阶段细分场景目标' },
  { label: '会员入口资源', value: '200万', desc: '潜在装机与供给冷启动入口' },
  { label: '分润结构', value: '65 / 5 / 30', desc: '客户端 / 渠道 / 平台' },
  { label: '控制权红线', value: '51%+', desc: '创始人长期控制权底线' },
];

const thesisChapters = [
  {
    no: 'I',
    title: '研究背景：为什么算力会成为新的基础设施',
    visual: '需求增长、成本压力、闲置供给三条曲线正在交汇。',
    thesis: '算力正在从“企业IT成本项”变成“企业生产资料”。AI推理、AIGC、渲染、数据处理和仿真计算的需求增长，使企业既需要更多算力，也需要更低成本、更弹性的交付方式。',
    professional: '传统中心化云计算能够提供稳定服务，但在价格、峰值弹性、长尾任务与中小企业可负担性方面存在结构性压力。边缘设备、个人GPU、闲置工作站和机构闲置服务器构成了潜在的分布式供给池，关键问题是如何把碎片化资源组织成可计量、可调度、可验收、可结算的企业服务。',
    plain: '以前企业买算力，就像只能去大超市买整箱货。现在大量电脑和显卡其实闲着，我们要做的是把这些零散资源组织起来，让企业可以按任务购买，而不是必须买昂贵服务器。',
    example: '一家短视频公司要批量生成10万条营销素材，如果全用传统云，峰值成本很高；如果交给分布式算力网络，任务可以拆成大量独立小任务，在夜间和闲时调度到不同节点执行。',
    evidence: ['AI推理和AIGC任务天然具备批量化、并行化特点。', '影视渲染、图片处理、数据清洗等任务可以按帧、按图、按文件拆分。', '大量个人设备在夜间和闲时存在未利用算力。'],
    actions: ['优先选择可切片、可验证、低耦合任务作为商业切入。', '不一开始挑战所有云计算场景，先从长尾企业任务进入。', '建立任务准入标准，筛掉不适合分布式执行的任务。'],
    conclusion: '算力市场不是缺概念，而是缺一种能把闲置资源变成企业可交付服务的组织系统。',
  },
  {
    no: 'II',
    title: '问题定义：传统云、算力租赁和共享显卡各自缺什么',
    visual: '资源、任务、交付之间存在断层，我们要补齐中间层。',
    thesis: '传统云解决了稳定性，但成本较高；算力租赁解决了资源购买，但企业仍要自己适配任务；共享显卡解决了供给入口，但企业交付链路不足。',
    professional: '现有市场存在明显分层：中心化云厂商偏基础资源供给，GPU租赁平台偏资源撮合，共享显卡平台偏C端供给激励。千手算力 的定位是企业任务交付平台，核心不只是提供设备，而是提供任务协议、切片调度、结果验证、SLA与结算。',
    plain: '别人可能只是“把机器租给你”，我们要做的是“你把任务交给我，我负责跑完并交结果”。这两个商业价值完全不同。',
    example: '企业要处理50万张商品图。如果只是租GPU，企业还要自己部署环境、拆任务、监控失败、合并结果。我们要把这些过程平台化，企业只看结果、成本和时间。',
    evidence: ['企业采购更关心结果、成本、时间和责任边界。', '中小企业缺少自建任务调度和运维团队。', '仅靠装机数量无法形成企业复购，必须有交付能力。'],
    actions: ['企业侧按任务包和SLA报价。', '节点侧按有效任务和质量结算。', '平台侧承担调度、验证、交付和风控责任。'],
    conclusion: '我们的核心差异不是便宜，而是把“资源”包装成“可交付任务服务”。',
  },
  {
    no: 'III',
    title: '项目方案：三端闭环如何真正跑起来',
    visual: '企业端、引擎端、节点端、结算端形成闭环网络。',
    thesis: '项目由企业任务端、超算调度引擎、边缘节点端和结算风控端组成，形成从任务发布到结果回传、从企业付款到用户收益的闭环。',
    professional: '企业端负责需求表达和SLA约束；调度引擎负责任务分析、切片、节点匹配、分发执行、失败重试、结果验证和聚合；节点端负责提供算力并回传结果；结算风控端负责收益分配、异常冻结、信誉评分和审计留痕。',
    plain: '企业发任务，我们拆任务，节点干活，我们验收结果，最后分钱。每一步都有记录，不是黑箱。',
    example: '10,000帧渲染任务可以拆成500个子任务，每个子任务20帧。系统优先分给GPU性能足够、历史成功率高、在线稳定的节点，失败任务自动重派。',
    evidence: ['项目已具备企业后台、文档体系、V2调度架构和商业物料。', '现有设计已围绕分析、切片、调度、聚合、验证、回传展开。', '分润模型已明确客户端65%、渠道5%、平台30%。'],
    actions: ['把任务类型模板化。', '把节点能力画像标准化。', '把结果验证和失败重试做成平台基础能力。'],
    conclusion: '项目不是单点工具，而是一套围绕企业任务交付设计的算力操作系统。',
  },
  {
    no: 'IV',
    title: '供给战略：200万会员为什么是关键资产',
    visual: '会员池不是流量广告位，而是潜在算力节点入口。',
    thesis: '分布式算力网络最大的早期难点是供给冷启动。200万会员不是直接等于200万节点，但它提供了极强的低成本触达入口和灰度验证基础。',
    professional: '会员池可以通过硬件画像、兴趣标签、设备类型、在线时段和收益敏感度进行分层运营。先筛选高性能设备与高意愿用户，形成高质量首批节点，再用真实收益和任务记录提升转化。',
    plain: '200万人不是一下子全装，而是先找里面最适合的人装。比如游戏电脑、设计师电脑、高配办公电脑，这些人才是第一批重点。',
    example: '先触达10万会员，其中10%下载、60%安装、40%符合硬件与在线要求，首批就可能形成约2,400个有效节点。只要这批节点能稳定跑企业任务，就能继续扩大。',
    evidence: ['渠道方已有会员触达能力。', '装机转化可通过灰度试点验证，而不是一次性赌全量。', '有效在线节点可成为企业销售时的产能背书。'],
    actions: ['先做1万-5万人灰度。', '建立硬件检测和收益预估。', '用客诉率、在线率、任务成功率决定是否放量。'],
    conclusion: '200万会员的价值不是流量曝光，而是帮助平台跨过算力供给冷启动。',
  },
  {
    no: 'V',
    title: '商业模式：每个角色如何赚钱，钱从哪里来',
    visual: '企业付款形成GMV，客户端、渠道、平台按真实任务分账。',
    thesis: '平台收入可来自真实企业任务。客户端65%、渠道5%、平台30%是本历史方案的演算假设，实际比例仍须以正式生效政策确认。',
    professional: '在平台早期，供给密度和交付能力同样重要。节点、渠道与平台各自承担不同职责；分配比例需要结合真实订单、履约成本和正式合同制定。',
    plain: '企业付钱买任务服务，用户出电脑赚钱，渠道帮我们找到用户拿推广分润，平台负责把任务跑完并抽服务费。',
    example: '企业本月付100万元，客户端节点池分65万元，渠道分5万元，平台分30万元。客户端内部再按每台设备的有效任务量、质量和稳定性分配。',
    evidence: ['0.5%市场份额对应1500万/月GMV。', '平台30%对应450万/月平台收入。', '渠道5%对应75万/月渠道收入。'],
    actions: ['用T+7结算建立信任。', '收益必须绑定有效任务，禁止纯挂机补贴。', '渠道分润绑定有效在线和客诉红线。'],
    conclusion: '这个模式的关键不是补贴，而是企业真实付费带来的持续分账。',
  },
  {
    no: 'VI',
    title: '投资逻辑：投什么、占多少、多久验证',
    visual: '资金进入公司增长系统，股权按现金和里程碑分层设计。',
    thesis: '投资人投资的不是单一软件，而是一个正在形成网络效应的算力交易与交付平台。投资应以分阶段、里程碑和控制风险为核心。',
    professional: '建议融资采用分轮策略，创始人保持51%以上控制权。Seed阶段资金用于产品硬化、企业POC、渠道灰度、合规结算和风控体系建设。投资人获得基础股权，资源型投资人可通过里程碑释放额外股权。',
    plain: '投资人不是一下子把钱砸进去赌未来，而是先投一段，看真实数据。跑出企业订单、节点在线、结算和复购，再进入下一轮。',
    example: '投前5000万、总股本1000万股时，每股5元。投资1000万约占投后16.67%。如果采用分两轮融资，第二轮在估值提升后进入，创始人仍可保持51%以上。',
    evidence: ['项目已有可演示产品基础。', '200万会员提供供给侧试点入口。', '0.5%-2%份额形成明确收入测算区间。'],
    actions: ['固定CAP TABLE和Term Sheet。', '设置6-8周试点数据门槛。', '把资金用途拆到研发、销售、合规、运营。'],
    conclusion: '投资回报不靠承诺，靠真实任务GMV、复购率和下一轮估值提升。',
  },
  {
    no: 'VII',
    title: '组织打法：谁来干、怎么干、用什么指标判断',
    visual: '小团队围绕签单、交付、结算、风控和工程闭环运转。',
    thesis: '项目早期不需要庞大组织，而需要一个15-25人的最小可行团队，围绕企业签单、方案交付、引擎稳定、客户端装机和结算风控展开。',
    professional: '组织应分为行业BD组、方案架构组、交付运营组、风控结算组和平台工程组。每个团队都必须有90天目标，并与核心指标绑定，包括企业POC数量、任务成功率、有效在线节点、作弊率和复购率。',
    plain: '先别搭大公司架子，先找能签单、能写系统、能交付、能防刷、能算账的人。',
    example: '前90天销售团队要拿30条有效线索、5个POC、2个转正；工程团队要让任务成功率达到95%以上；风控结算要跑通T+7结算。',
    evidence: ['项目需要同时解决B端销售和C端供给。', '边缘算力的核心风险在交付稳定和风控结算。', '岗位目标可以直接绑定商业闭环。'],
    actions: ['优先招聘企业销售负责人、调度后端负责人、客户端工程师。', '每周复盘红绿灯指标。', '用真实POC倒逼产品改进。'],
    conclusion: '团队建设的核心不是人数，而是围绕商业闭环配置关键能力。',
  },
  {
    no: 'VIII',
    title: '政策与风险：为什么必须先合规再放量',
    visual: '合同、隐私、资金、任务准入四条防线决定能否放量。',
    thesis: '共享算力涉及用户授权、设备资源、企业数据、资金结算和任务内容，必须先建立合规底座，否则规模越大风险越大。',
    professional: '上线前需要完成合同体系、隐私政策、数据最小化采集、任务准入、资金税务、反作弊、客诉与申诉机制。尤其在中国市场，建议优先采用算力积分或现金结算口径。',
    plain: '先把合同、隐私、钱怎么分、哪些任务不能接讲清楚，再推广。不然用户一多，问题会被放大。',
    example: '如果用户不知道客户端在什么时候运行、跑什么任务、如何暂停，就会产生安全疑虑；如果企业任务没有准入，可能接到灰产或侵权任务。',
    evidence: ['客户端装机需要明确授权。', '企业任务可能涉及数据与内容风险。', '分润提现涉及税务和资金合规。'],
    actions: ['上线前完成用户协议、隐私政策、企业SLA和渠道协议。', '建立任务白名单/黑名单。', '建立异常收益冻结和人工复核机制。'],
    conclusion: '合规不是阻碍增长，而是让增长可以持续的底座。',
  },
];

const completed = [
  { title: '官网与文档中心', desc: '已具备官网、文档中心、白皮书页面与多端导航。', status: '已完成基础版' },
  { title: '企业后台', desc: '已围绕任务发布方进行重构，支持任务发布、节点、进度与文档说明。', status: '已进入可演示阶段' },
  { title: '超算引擎V2', desc: '已形成分析、切片、调度、分发、聚合、验证、回传的核心架构。', status: '核心逻辑已搭建' },
  { title: '商业物料', desc: '已形成利润页、合作页、51%控制权宣传页与总纲白皮书。', status: '正在完善' },
];

const architecture = [
  { index: 'A', title: '企业任务端', desc: '企业发布任务、选择SLA、上传数据、查看进度、验收结果与对账。' },
  { index: 'B', title: '超算调度引擎', desc: '负责任务分析、切片、节点匹配、调度、容错、验证、聚合与回传。' },
  { index: 'C', title: '边缘节点端', desc: '用户客户端贡献闲置CPU/GPU，按照有效任务与质量评分获得收益。' },
  { index: 'D', title: '结算与风控端', desc: '负责分润、提现、反作弊、信誉评分、合规审计与异常冻结。' },
];

const flow = ['企业发任务', '引擎分析', '任务切片', '匹配节点', '分发执行', '结果验证', '聚合回传', '分润结算'];

const memberFunnel = [
  { label: '会员池', value: '200万', desc: '可触达基础' },
  { label: '灰度首批', value: '1万-5万', desc: '先验证转化' },
  { label: '有效在线', value: '5000-2万', desc: '首阶段目标' },
  { label: '放量目标', value: '10万+', desc: '企业产能背书' },
];

const marketRows = [
  { share: '0.5%', gmv: '1500万/月', client: '975万/月', channel: '75万/月', platform: '450万/月', year: '5400万/年' },
  { share: '1%', gmv: '3000万/月', client: '1950万/月', channel: '150万/月', platform: '900万/月', year: '1.08亿/年' },
  { share: '2%', gmv: '6000万/月', client: '3900万/月', channel: '300万/月', platform: '1800万/月', year: '2.16亿/年' },
];

const roleReturns = [
  { role: '企业客户', time: '7天诊断，14天POC，30天看报表', return: '降低算力成本、缩短交付周期、获得弹性产能', metric: '单位任务成本、成功率、交付时长' },
  { role: '渠道老板', time: '6-8周看试点财务复盘', return: '月GMV 1500万-6000万时，渠道分润150万-600万/月', metric: '有效节点数、渠道分润、客诉率' },
  { role: '渠道团队', time: '每周看触达与激活，每月看分润', return: '从广告投放变成长期收益型渠道资产', metric: '激活成本、有效在线率、留存率' },
  { role: '客户端用户', time: '日统计，T+7可提现', return: '闲时贡献算力获取副收入，高配设备收益更高', metric: '日均收益、提现成功率、设备占用率' },
  { role: '平台团队', time: '按月看GMV、复购和毛利', return: '月GMV 1500万-6000万时，平台收入300万-1200万/月', metric: '复购率、交付成功率、作弊率' },
];

const thesisQuestions = [
  { title: '1. 你们在做什么？', answer: '做企业级边缘分布式算力网络，不只是装客户端，也不只是租显卡，而是交付企业任务结果。' },
  { title: '2. 为什么现在能做？', answer: 'AI与AIGC带来算力需求，传统云成本高，同时大量个人设备闲置，供需两端存在错配。' },
  { title: '3. 凭什么你们能启动？', answer: '已有产品雏形、V2调度架构、企业后台、文档体系，以及200万会员潜在供给入口。' },
  { title: '4. 各方怎么赚钱？', answer: '通过真实任务交付形成收入。节点、渠道和平台的实际份额，以正式政策和订单结算记录为准；本页比例只是历史测算。' },
  { title: '5. 风险怎么控制？', answer: '先试点再放量，以任务成功率、作弊率、客诉率、复购率作为红绿灯，未达标暂停扩张。' },
];

const investorRows = [
  { amount: '500万', valuation: '5000万投前', equity: '约9.09%投后', use: '企业POC、核心工程、合规', target: '跑通首批真实任务与结算' },
  { amount: '1000万', valuation: '5000万投前', equity: '约16.67%投后', use: '产品硬化、销售团队、渠道灰度', target: '形成复购客户与有效节点池' },
  { amount: '2000万（分两轮）', valuation: '5000万->8000万', equity: '合计约20%-25%区间', use: '12个月商业验证与放量', target: '冲刺0.5%-2%细分份额' },
];

const channelRows = [
  { stage: '灰度期', channel: '触达1万-5万会员', platform: '提供客户端、落地页、客服与数据看板', return: '验证有效装机，不以收益承诺为主', decision: '看转化与客诉' },
  { stage: '试点期', channel: '持续触达高性能人群', platform: '接入企业任务并完成结算', return: '分润比例待正式政策确认', decision: '达标后扩大人群' },
  { stage: '放量期', channel: '全域会员推广与联合品牌', platform: '扩大企业订单与风控能力', return: '收入取决于真实订单和已确认分润', decision: '按红绿灯持续放量' },
];

const enterpriseProofRows = [
  { concern: '成本能否降低', mechanism: '按任务/SLA报价，不要求企业长期包机器', proof: 'POC成本对比报告', fallback: '成本不达标不转正' },
  { concern: '结果是否可靠', mechanism: '任务验证、冗余计算、失败重试', proof: '成功率与失败原因报告', fallback: '失败任务重算或退款规则' },
  { concern: '数据是否安全', mechanism: '任务准入、数据隔离、日志审计', proof: '操作日志与协议约束', fallback: '高风险任务拒绝接入' },
  { concern: '能否规模化', mechanism: '节点画像、调度策略、SLA分级', proof: '30天试运行报表', fallback: '先限定任务类型与规模' },
];

const teamIncentiveRows = [
  { role: '销售/BD', task: '签企业POC与复购', target: '30条线索、5个POC、2个转正', reward: '底薪+提成+期权池激励' },
  { role: '调度工程', task: '提高任务成功率与调度效率', target: '成功率>=95%，故障可追踪', reward: '薪资+核心技术期权' },
  { role: '客户端工程', task: '提升安装率与稳定在线', target: '灰度客户端稳定运行', reward: '薪资+节点增长里程碑奖励' },
  { role: '风控结算', task: '反作弊、对账、提现', target: 'T+7结算、作弊率<=2%', reward: '薪资+运营指标奖金' },
  { role: '运营交付', task: '任务上线、客户复盘、客诉处理', target: '客户满意度与复购提升', reward: '薪资+交付成功奖金' },
];

const enterpriseScenarios = [
  { scene: '影视/动画渲染', pain: '渲染高峰排队、云成本高', task: '帧渲染、批量转码、素材处理', price: '按帧/项目/SLA报价', period: '14-30天' },
  { scene: 'AI推理批处理', pain: '峰值调用成本高、弹性不足', task: '图片生成、文本处理、批量推理', price: '按请求量/任务包/有效算力单位', period: '7-21天' },
  { scene: '数据离线处理', pain: '大量任务低频但耗时', task: '清洗、标注、压缩、格式转换', price: '按数据量/任务包报价', period: '7-14天' },
  { scene: '科研与仿真', pain: '预算有限，需求不稳定', task: '参数扫描、蒙特卡洛、批量计算', price: '按有效计算小时与验收结果', period: '14-45天' },
];

const channelModel = [
  { title: '不改主营', desc: '渠道方不需要改变眼镜或原有业务，只提供会员触达入口。' },
  { title: '持续分润', desc: '不是一次性广告费，而是按有效算力和企业订单持续分润。' },
  { title: '低风险试点', desc: '先灰度1万-5万人，6-8周用真实数据决定是否放量。' },
  { title: '资产升级', desc: '把会员从消费用户升级为数字基础设施参与者。' },
];

const competitors = [
  { type: '中心化云厂商', mode: '自建机房与GPU集群', advantage: '稳定、品牌强、合规成熟', weakness: '成本高、弹性采购门槛高', edge: '用边缘供给做低成本补充，不正面硬刚大云' },
  { type: 'GPU租赁平台', mode: '按卡按小时出租', advantage: '价格清晰，上手快', weakness: '企业仍需自己解决任务适配', edge: '我们按任务交付，不只出租机器' },
  { type: '共享显卡平台', mode: 'C端装机赚收益', advantage: '供给侧容易传播', weakness: '企业任务与交付体系弱', edge: '我们同时建设企业发布、调度、验收和结算' },
  { type: '边缘云/CDN厂商', mode: '边缘节点与带宽资源', advantage: '节点和网络基础好', weakness: '偏网络与缓存，通用任务计算弱', edge: '聚焦可切片企业任务与算力调度' },
];

const companyStructure = [
  { title: '创始人控制权', desc: '创始人或一致行动人长期保持51%以上，保障战略连续性。' },
  { title: '分轮融资', desc: '采用小步融资与估值提升，避免早期一次性过度稀释。' },
  { title: '里程碑股权', desc: '资源型创始人按有效节点、份额目标、企业收入达标后分批释放。' },
];

const teams = [
  { name: '行业BD组', size: '3-5人', desc: '负责企业线索、签约、复购与行业渠道。' },
  { name: '方案架构组', size: '2-3人', desc: '把客户需求翻译为任务包与POC方案。' },
  { name: '交付运营组', size: '3-6人', desc: '负责任务上线、运行监控、异常处理与客户复盘。' },
  { name: '风控结算组', size: '2-4人', desc: '负责反作弊、对账、提现、客诉与结算规则。' },
  { name: '平台工程组', size: '6-12人', desc: '负责调度引擎、前后端、客户端、运维与安全。' },
];

const enterprisePlaybook = [
  { time: '第1步', title: '锁定细分场景', desc: '优先渲染、AI推理批处理、数据离线批处理，不一开始打全行业。' },
  { time: '第2步', title: '7天需求诊断', desc: '确认任务能否切片、能否验证、能否稳定交付。' },
  { time: '第3步', title: '14天POC', desc: '小规模真实任务试跑，输出成本、时效、成功率报告。' },
  { time: '第4步', title: '30天试运行', desc: '验证复购、对账、SLA、客户满意度，再进入规模采购。' },
];

const hiring = [
  { priority: 'P0', role: '企业销售负责人', count: '1', reason: '决定能否拿到首批企业真实任务', goal: '30条有效线索，5个POC' },
  { priority: 'P0', role: '调度/后端负责人', count: '1-2', reason: '决定任务能否稳定切片、调度与回传', goal: '核心链路可观测、可恢复' },
  { priority: 'P0', role: '客户端工程师', count: '2-3', reason: '决定200万会员装机体验与在线稳定性', goal: '灰度客户端可安装、可暂停、可上报' },
  { priority: 'P1', role: '风控结算运营', count: '2', reason: '决定分润是否可信、防刷是否有效', goal: 'T+7结算规则与异常冻结上线' },
  { priority: 'P1', role: '售前解决方案', count: '2', reason: '决定企业需求能否变成任务包', goal: '3套标准POC模板' },
];

const kpis = [
  { name: '任务成功交付率', green: '>=95%', yellow: '90%-95%', red: '<90%' },
  { name: '资金对账准确率', green: '>=99.5%', yellow: '98%-99.5%', red: '<98%' },
  { name: '作弊率', green: '<=2%', yellow: '2%-5%', red: '>5%' },
  { name: '客户端客诉率', green: '持续下降', yellow: '短期波动', red: '集中爆发' },
  { name: '企业复购率', green: '>=30%', yellow: '10%-30%', red: '<10%' },
];

const compliance = [
  { title: '合同体系', desc: '渠道合作协议、用户协议/隐私政策、企业服务协议与SLA必须齐备。' },
  { title: '数据合规', desc: '最小化采集、明确授权、可注销、可删除、日志可审计。' },
  { title: '资金税务', desc: '企业付款、渠道分润、用户提现、发票与税务口径需要提前设计。' },
  { title: '任务准入', desc: '建立白名单与黑名单，拒绝灰产、违法、侵权和高风险任务。' },
];

const valuationRows = [
  { stage: '验证期', result: '产品与首批POC跑通', revenue: '0-100万/月', logic: '早期技术与资源估值', value: '3000万-8000万' },
  { stage: '起量期', result: '0.5%份额稳定', revenue: '平台300万/月', logic: '收入倍数 + 网络价值', value: '1亿-3亿' },
  { stage: '增长期', result: '1%-2%份额稳定', revenue: '平台600万-1200万/月', logic: '收入规模 + 复购 + 数据壁垒', value: '3亿-8亿+' },
  { stage: '扩张期', result: '跨行业复制', revenue: '亿元级年收入', logic: '平台型基础设施估值', value: '10亿级探索' },
];

const versions = [
  { name: 'v1.0', title: '演示与闭环版', desc: '完成多端门户、任务逻辑、文档体系与商业物料。' },
  { name: 'v1.5', title: '真实试点版', desc: '接入真实企业任务、灰度真实节点、跑通T+7结算。' },
  { name: 'v2.0', title: '规模运营版', desc: '实现任务模板化、节点信誉体系、风控结算自动化。' },
  { name: 'v3.0', title: '网络平台版', desc: '扩展多行业、多区域、多渠道，形成算力网络效应。' },
];
</script>

<style scoped>
.deep-page {
  min-height: 100vh;
  padding: 28px 20px 90px;
  background:
    radial-gradient(circle at 10% 0%, rgba(37, 99, 235, 0.18), transparent 32%),
    radial-gradient(circle at 92% 12%, rgba(20, 184, 166, 0.16), transparent 30%),
    linear-gradient(180deg, #020617 0%, #0b1020 100%);
  color: #e2e8f0;
}

.page-section {
  position: relative;
  max-width: 1180px;
  margin: 0 auto 18px;
  padding: 24px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 22px;
  background: rgba(15, 23, 42, 0.72);
  box-shadow: 0 18px 44px rgba(2, 6, 23, 0.45);
  overflow: hidden;
}

.page-section::after {
  content: '';
  position: absolute;
  right: 18px;
  top: 18px;
  width: 92px;
  height: 92px;
  opacity: 0.24;
  background:
    radial-gradient(circle, #7dd3fc 2px, transparent 3px) 0 0 / 18px 18px,
    linear-gradient(135deg, rgba(37, 99, 235, 0.45), transparent);
  border-radius: 22px;
  pointer-events: none;
}

.planning-note {
  position: relative;
  z-index: 1;
  margin: 22px 0;
  padding: 16px 18px;
  border: 1px solid rgba(125, 211, 252, 0.38);
  border-radius: 14px;
  background: rgba(14, 116, 144, 0.12);
  color: #dbeafe;
}

.planning-note strong { display: block; margin-bottom: 5px; color: #7dd3fc; }
.planning-note p { margin: 0; line-height: 1.7; }
.planning-note a { color: #bae6fd; text-decoration: underline; text-underline-offset: 3px; }

.poster-section,
.visual-break {
  max-width: 1180px;
  margin: 0 auto 18px;
}

.poster-section {
  display: grid;
  grid-template-columns: 1.35fr 1fr;
  gap: 16px;
}

.vision-map,
.value-grid article,
.visual-break,
.maturity-visual article,
.conversion-visual article,
.market-poster article,
.role-map article {
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 22px;
  background: rgba(15, 23, 42, 0.72);
}

.vision-map {
  min-height: 260px;
  padding: 22px;
  display: grid;
  grid-template-rows: 1fr auto;
  gap: 16px;
  background:
    linear-gradient(90deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px),
    linear-gradient(0deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px),
    radial-gradient(circle at 50% 25%, rgba(37, 99, 235, 0.35), transparent 36%),
    rgba(2, 6, 23, 0.45);
  background-size: 30px 30px, 30px 30px, auto, auto;
}

.vision-center {
  display: grid;
  place-items: center;
  text-align: center;
  align-self: center;
  justify-self: center;
  width: min(420px, 100%);
  padding: 26px;
  border-radius: 22px;
  border: 1px solid rgba(125, 211, 252, 0.34);
  background: rgba(30, 64, 175, 0.52);
}

.vision-center span,
.visual-break span {
  color: #7dd3fc;
  font-size: 12px;
  letter-spacing: 0.12em;
  font-weight: 900;
}

.vision-center strong {
  display: block;
  margin-top: 8px;
  color: #f8fafc;
  font-size: 24px;
  line-height: 1.25;
}

.vision-flow {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.vision-flow div {
  padding: 11px 8px;
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.72);
  border: 1px solid rgba(148, 163, 184, 0.2);
  color: #dbeafe;
  text-align: center;
  font-weight: 800;
  font-size: 13px;
}

.visual-break h2 {
  margin: 10px 0;
  color: #f8fafc;
  font-size: 38px;
  line-height: 1.12;
}

.value-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(2, 1fr);
}

.value-grid article {
  position: relative;
  padding: 16px;
}

.value-grid article::before {
  content: '';
  display: block;
  width: 24px;
  height: 24px;
  border-radius: 9px;
  margin-bottom: 12px;
  background: linear-gradient(135deg, #38bdf8, #4f46e5);
}

.value-grid span {
  display: block;
  color: #94a3b8;
  font-size: 12px;
}

.value-grid strong {
  display: block;
  margin: 5px 0;
  color: #f8fafc;
  font-size: 20px;
}

.value-grid p {
  margin: 0;
  color: #cbd5e1;
  line-height: 1.6;
}

.visual-break {
  padding: 28px;
  display: grid;
  grid-template-columns: 0.8fr 1.2fr;
  gap: 18px;
  align-items: center;
}

.break-flow {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 8px;
}

.break-flow article {
  min-height: 92px;
  display: grid;
  place-items: center;
  border-radius: 16px;
  background: rgba(30, 64, 175, 0.45);
  color: #dbeafe;
  font-weight: 900;
  text-align: center;
}

.hero {
  padding: 34px;
}

.eyebrow {
  display: inline-flex;
  padding: 6px 12px;
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 999px;
  font-size: 11px;
  letter-spacing: 0.1em;
  color: #bfdbfe;
}

h1 {
  margin: 16px 0 12px;
  max-width: 880px;
  color: #f8fafc;
  font-size: 46px;
  line-height: 1.08;
  letter-spacing: -0.04em;
}

.lead,
.section-copy {
  max-width: 900px;
  margin: 0;
  color: #cbd5e1;
  line-height: 1.85;
}

.hero-grid,
.cards,
.dual,
.argument-grid,
.thesis-grid,
.architecture,
.funnel,
.team-grid,
.timeline,
.version-grid {
  display: grid;
  gap: 12px;
}

.hero-grid {
  grid-template-columns: repeat(4, 1fr);
  margin-top: 22px;
}

.stat-card,
.info-card,
.arch-card,
.funnel article,
.team-card,
.timeline article,
.version-grid article {
  position: relative;
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 16px;
  background: rgba(15, 23, 42, 0.62);
  padding: 16px;
}

.info-card::before,
.team-card::before,
.version-grid article::before {
  content: '';
  display: block;
  width: 34px;
  height: 6px;
  margin-bottom: 12px;
  border-radius: 999px;
  background: linear-gradient(90deg, #38bdf8, #4f46e5);
  opacity: 0.85;
}

.stat-card span,
.stat-card small,
.funnel span,
.funnel small,
.timeline span,
.version-grid span {
  display: block;
  color: #94a3b8;
  font-size: 12px;
}

.stat-card strong,
.funnel strong {
  display: block;
  margin: 6px 0;
  color: #f8fafc;
  font-size: 28px;
}

.visual-network {
  position: relative;
  min-height: 320px;
  margin-top: 24px;
  border: 1px solid rgba(125, 211, 252, 0.24);
  border-radius: 22px;
  background:
    linear-gradient(90deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px),
    linear-gradient(0deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px),
    rgba(2, 6, 23, 0.38);
  background-size: 42px 42px;
  overflow: hidden;
}

.visual-network::before,
.visual-network::after {
  content: '';
  position: absolute;
  inset: 60px 120px;
  border: 1px dashed rgba(125, 211, 252, 0.3);
  border-radius: 50%;
}

.visual-network::after {
  inset: 96px 210px;
  border-color: rgba(99, 102, 241, 0.35);
}

.network-center {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 240px;
  transform: translate(-50%, -50%);
  padding: 22px;
  border-radius: 20px;
  background: rgba(30, 64, 175, 0.72);
  border: 1px solid rgba(191, 219, 254, 0.42);
  text-align: center;
  z-index: 2;
}

.network-center strong {
  display: block;
  color: #f8fafc;
  font-size: 22px;
}

.network-center span {
  display: block;
  margin-top: 8px;
  color: #bfdbfe;
  font-size: 12px;
  line-height: 1.6;
}

.network-node {
  position: absolute;
  z-index: 2;
  min-width: 118px;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid rgba(148, 163, 184, 0.28);
  background: rgba(15, 23, 42, 0.82);
  color: #dbeafe;
  text-align: center;
  font-weight: 800;
}

.n1 { left: 8%; top: 14%; }
.n2 { right: 8%; top: 14%; }
.n3 { left: 10%; bottom: 16%; }
.n4 { right: 10%; bottom: 16%; }
.n5 { left: 50%; bottom: 7%; transform: translateX(-50%); }

.section-title {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
  position: relative;
  z-index: 1;
}

.section-title span {
  width: 42px;
  height: 42px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  background: rgba(37, 99, 235, 0.22);
  color: #bfdbfe;
  font-weight: 800;
  box-shadow: inset 0 0 0 1px rgba(191, 219, 254, 0.18);
}

h2 {
  margin: 0;
  color: #f8fafc;
  font-size: 29px;
}

h3 {
  margin: 0 0 8px;
  color: #e0e7ff;
  font-size: 18px;
}

p,
li {
  color: #cbd5e1;
  line-height: 1.78;
}

.dual {
  grid-template-columns: 1fr 1fr;
}

.argument-grid {
  grid-template-columns: 1.2fr 1fr 1fr;
  margin-top: 12px;
}

.thesis-grid {
  grid-template-columns: repeat(5, 1fr);
  margin-top: 12px;
}

.chapter-lead {
  margin: 0 0 14px;
  padding: 14px;
  border-radius: 14px;
  background: rgba(15, 23, 42, 0.72);
  color: #dbeafe;
  line-height: 1.85;
}

.chapter-visual {
  display: grid;
  grid-template-columns: 190px 1fr;
  gap: 14px;
  align-items: center;
  margin-bottom: 14px;
  padding: 14px;
  border-radius: 16px;
  border: 1px solid rgba(125, 211, 252, 0.2);
  background: rgba(2, 6, 23, 0.36);
}

.mini-network {
  position: relative;
  height: 92px;
  border-radius: 14px;
  background:
    linear-gradient(90deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px),
    linear-gradient(0deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px);
  background-size: 22px 22px;
}

.mini-network::before,
.mini-network::after {
  content: '';
  position: absolute;
  left: 22px;
  right: 22px;
  top: 45px;
  height: 1px;
  background: rgba(125, 211, 252, 0.35);
}

.mini-network::after {
  left: 94px;
  right: auto;
  top: 14px;
  bottom: 14px;
  width: 1px;
  height: auto;
}

.mini-network i {
  position: absolute;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #38bdf8;
  box-shadow: 0 0 0 6px rgba(56, 189, 248, 0.12);
}

.mini-network i:nth-child(1) { left: 18px; top: 36px; }
.mini-network i:nth-child(2) { left: 86px; top: 8px; background: #4f46e5; }
.mini-network i:nth-child(3) { left: 86px; bottom: 8px; background: #22c55e; }
.mini-network i:nth-child(4) { right: 18px; top: 20px; background: #f59e0b; }
.mini-network i:nth-child(5) { right: 18px; bottom: 20px; background: #06b6d4; }

.chapter-visual p {
  margin: 0;
  color: #bfdbfe;
  font-weight: 800;
}

.section-figure {
  display: grid;
  gap: 10px;
  margin-bottom: 16px;
  padding: 14px;
  border-radius: 18px;
  border: 1px solid rgba(125, 211, 252, 0.2);
  background: rgba(2, 6, 23, 0.34);
}

.figure-supply {
  grid-template-columns: repeat(3, 1fr);
}

.figure-progress,
.figure-stack {
  grid-template-columns: repeat(4, 1fr);
}

.figure-members {
  grid-template-columns: 1.4fr 1fr 0.8fr 0.7fr;
  align-items: center;
}

.figure-supply div,
.figure-stack div,
.figure-progress div,
.figure-members div {
  min-height: 72px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  background: rgba(30, 64, 175, 0.45);
  color: #dbeafe;
  font-weight: 900;
  text-align: center;
}

.figure-progress b {
  display: block;
  color: #f8fafc;
  font-size: 18px;
}

.figure-progress span {
  display: block;
  color: #bfdbfe;
  font-size: 12px;
}

.figure-stack div {
  min-height: 54px;
  background: linear-gradient(180deg, rgba(30, 64, 175, 0.55), rgba(8, 47, 73, 0.55));
}

.member-dot {
  border-radius: 999px !important;
  aspect-ratio: 1;
  min-height: auto !important;
  background: rgba(20, 184, 166, 0.4) !important;
}

.member-dot.big {
  font-size: 26px;
  background: rgba(37, 99, 235, 0.52) !important;
}

.chapter-conclusion {
  margin-top: 14px;
  padding: 14px;
  border-radius: 14px;
  border: 1px solid rgba(125, 211, 252, 0.22);
  background: rgba(14, 165, 233, 0.12);
  color: #e0f2fe;
  line-height: 1.8;
}

.cards.two {
  grid-template-columns: repeat(2, 1fr);
}

.cards.three {
  grid-template-columns: repeat(3, 1fr);
}

.cards.four {
  grid-template-columns: repeat(4, 1fr);
}

.cards.five {
  grid-template-columns: repeat(5, 1fr);
}

.info-card b {
  display: inline-flex;
  margin-top: 10px;
  padding: 4px 9px;
  border-radius: 999px;
  background: rgba(14, 165, 233, 0.16);
  color: #7dd3fc;
  font-size: 12px;
}

.accent {
  background: rgba(30, 64, 175, 0.25);
}

.note,
.risk,
.example-box {
  margin-top: 14px;
  padding: 14px;
  border-radius: 14px;
  background: rgba(37, 99, 235, 0.12);
  color: #bfdbfe;
  line-height: 1.8;
}

.maturity-visual,
.conversion-visual,
.market-poster,
.role-map {
  display: grid;
  gap: 12px;
  margin-top: 14px;
}

.maturity-visual {
  grid-template-columns: repeat(3, 1fr);
}

.maturity-visual article,
.conversion-visual article,
.market-poster article,
.role-map article {
  padding: 18px;
}

.maturity-visual span {
  color: #7dd3fc;
  font-weight: 900;
}

.maturity-visual strong {
  display: block;
  margin: 8px 0;
  color: #f8fafc;
  font-size: 24px;
}

.conversion-visual {
  grid-template-columns: repeat(5, 1fr);
}

.conversion-visual article {
  text-align: center;
  background: rgba(8, 47, 73, 0.72);
}

.conversion-visual b {
  display: block;
  color: #f8fafc;
  font-size: 26px;
}

.conversion-visual span {
  color: #bae6fd;
}

.market-poster {
  grid-template-columns: repeat(3, 1fr);
}

.market-poster article {
  background: rgba(30, 64, 175, 0.45);
}

.market-poster span {
  color: #bfdbfe;
}

.market-poster strong {
  display: block;
  margin: 8px 0;
  color: #f8fafc;
  font-size: 30px;
}

.role-map {
  grid-template-columns: repeat(5, 1fr);
}

.role-map article {
  min-height: 130px;
  background: rgba(2, 6, 23, 0.42);
}

.role-map strong {
  display: block;
  margin-bottom: 8px;
  color: #f8fafc;
}

.role-map span {
  color: #cbd5e1;
  line-height: 1.7;
}

.example-box {
  border: 1px solid rgba(125, 211, 252, 0.22);
  background: rgba(8, 47, 73, 0.55);
}

.example-box h3 {
  color: #bae6fd;
}

.example-box p {
  margin: 8px 0 0;
}

.architecture {
  grid-template-columns: repeat(4, 1fr);
}

.arch-card span {
  display: inline-flex;
  width: 32px;
  height: 32px;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: rgba(20, 184, 166, 0.2);
  color: #99f6e4;
  font-weight: 900;
  margin-bottom: 10px;
}

.flow {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 8px;
  margin-top: 14px;
}

.flow div {
  text-align: center;
  padding: 10px 6px;
  border-radius: 10px;
  background: rgba(51, 65, 85, 0.55);
  color: #dbeafe;
  font-size: 13px;
}

.diagram-panel,
.chart-panel,
.equity-visual {
  margin-top: 14px;
  padding: 16px;
  border-radius: 16px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  background: rgba(2, 6, 23, 0.35);
}

.diagram-panel h3,
.chart-panel h3,
.equity-visual h3 {
  color: #bae6fd;
}

.loop-diagram {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 8px;
}

.loop-diagram div {
  position: relative;
  padding: 12px 8px;
  border-radius: 12px;
  background: rgba(30, 64, 175, 0.45);
  text-align: center;
  font-weight: 800;
  color: #dbeafe;
}

.loop-diagram div:not(:last-child)::after {
  content: '>';
  position: absolute;
  right: -8px;
  top: 50%;
  transform: translateY(-50%);
  color: #7dd3fc;
}

.highlight {
  background: rgba(8, 47, 73, 0.72);
}

.funnel {
  grid-template-columns: repeat(4, 1fr);
  margin-top: 14px;
}

table {
  width: 100%;
  margin-top: 14px;
  border-collapse: collapse;
}

th,
td {
  padding: 12px 8px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.22);
  text-align: left;
  white-space: nowrap;
}

th {
  color: #cbd5e1;
  font-size: 13px;
}

.bar-chart {
  display: grid;
  gap: 12px;
}

.bar-chart article {
  display: grid;
  grid-template-columns: 120px 1fr 140px;
  align-items: center;
  gap: 12px;
}

.bar-chart span {
  color: #cbd5e1;
  font-weight: 800;
}

.bar-chart strong {
  color: #e0f2fe;
  text-align: right;
}

.track,
.equity-track {
  height: 18px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(51, 65, 85, 0.72);
}

.track i,
.equity-track i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #2563eb, #22d3ee);
}

.split-bar,
.budget-bar {
  display: flex;
  overflow: hidden;
  border-radius: 14px;
  margin: 12px 0 16px;
}

.split-bar div,
.budget-bar div {
  padding: 13px 8px;
  text-align: center;
  font-weight: 800;
  font-size: 13px;
}

.client { width: 65%; background: #16a34a; }
.channel { width: 5%; background: #d97706; }
.platform { width: 30%; background: #4f46e5; }

.split-visual {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 18px;
  align-items: center;
  margin: 16px 0;
  padding: 16px;
  border-radius: 16px;
  background: rgba(2, 6, 23, 0.35);
}

.donut {
  width: 180px;
  height: 180px;
  border-radius: 50%;
  background: conic-gradient(#16a34a 0 65%, #d97706 65% 70%, #4f46e5 70% 100%);
  display: grid;
  place-items: center;
}

.donut-hole {
  width: 104px;
  height: 104px;
  border-radius: 50%;
  background: #0f172a;
  display: grid;
  place-items: center;
  color: #f8fafc;
  font-weight: 900;
}

.legend-list p {
  margin: 8px 0;
}

.dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-right: 8px;
}

.client-dot { background: #16a34a; }
.channel-dot { background: #d97706; }
.platform-dot { background: #4f46e5; }

.b1 { width: 38%; background: #4338ca; }
.b2 { width: 26%; background: #2563eb; }
.b3 { width: 13%; background: #0891b2; }
.b4 { width: 9%; background: #0f766e; }
.b5 { width: 14%; background: #15803d; }

.equity-row {
  display: grid;
  grid-template-columns: 86px 1fr;
  align-items: center;
  gap: 12px;
  margin: 10px 0;
}

.equity-row span {
  color: #cbd5e1;
  font-weight: 800;
}

.equity-track {
  height: 28px;
}

.equity-track i {
  padding-left: 10px;
  line-height: 28px;
  color: #fff;
  font-style: normal;
  font-size: 12px;
  font-weight: 900;
  background: linear-gradient(90deg, #0f766e, #22c55e);
}

.funding-visual {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-top: 14px;
}

.funding-visual article {
  padding: 16px;
  border-radius: 14px;
  background: rgba(15, 23, 42, 0.62);
  border: 1px solid rgba(148, 163, 184, 0.2);
}

.funding-visual span {
  color: #94a3b8;
}

.funding-visual strong {
  display: block;
  margin-top: 6px;
  font-size: 26px;
  color: #f8fafc;
}

ul {
  margin: 0;
  padding-left: 18px;
}

.team-grid {
  grid-template-columns: repeat(5, 1fr);
}

.team-card strong {
  display: block;
  margin-bottom: 6px;
  color: #7dd3fc;
}

.timeline {
  grid-template-columns: repeat(4, 1fr);
}

.version-grid {
  grid-template-columns: repeat(4, 1fr);
}

.roadmap-visual {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-top: 14px;
}

.roadmap-visual div {
  padding: 12px 8px;
  border-radius: 12px;
  background: rgba(30, 64, 175, 0.42);
  text-align: center;
  color: #dbeafe;
  font-weight: 900;
}

.quote blockquote {
  margin: 0;
  padding: 16px 18px;
  border-left: 4px solid #38bdf8;
  border-radius: 0 14px 14px 0;
  background: rgba(14, 165, 233, 0.14);
  color: #e0f2fe;
  line-height: 1.9;
}

@media (max-width: 1100px) {
  .hero-grid,
  .poster-section,
  .value-grid,
  .vision-flow,
  .visual-break,
  .break-flow,
  .dual,
  .chapter-visual,
  .section-figure,
  .figure-supply,
  .figure-progress,
  .figure-stack,
  .figure-members,
  .argument-grid,
  .thesis-grid,
  .cards.two,
  .cards.three,
  .cards.four,
  .cards.five,
  .architecture,
  .funnel,
  .team-grid,
  .timeline,
  .version-grid,
  .roadmap-visual,
  .funding-visual,
  .split-visual,
  .maturity-visual,
  .conversion-visual,
  .market-poster,
  .role-map,
  .loop-diagram,
  .flow {
    grid-template-columns: 1fr;
  }

  .bar-chart article,
  .equity-row {
    grid-template-columns: 1fr;
  }

  .visual-network {
    min-height: 520px;
  }

  .network-node,
  .network-center {
    position: static;
    transform: none;
    margin: 12px auto;
  }

  h1 {
    font-size: 34px;
  }

  table {
    display: block;
    overflow-x: auto;
  }
}
</style>
