# 个人后台审核与修复

范围：已有 Vue 个人门户，真实同源 /api/v8 请求与会话隔离保留。没有部署或调用真实资金/设备写操作。源码基线与现网产物对应性由主任务验证。

## 已修复

- Tasks：读取失败持久提示与重试，不再误报“还没有任务”；筛选/分页的请求代次防止旧响应覆盖新结果，失败清空旧数据。搜索明确只搜索本页；任务失败原因现在可见；表格小屏可横向滚动，分页加载时禁用。
- Wallet：主数据失败不再空白，流水单独显示错误和重试；流水请求代次防止切换筛选后串数据；提现金额上限、两位小数、空白账户信息校验，重复点击保护。只有响应带申请编号和状态才显示提交成功，提交期间不关闭对话框。
- Wallet：现有服务端 total_withdrawn 是所有负向账本金额，UI 由“累计提现”改“累计支出”；pending 在服务端固定零且尚未接入，显示“暂未接入”。新增真实 GET /payment/withdraw 的最近 100 笔提现申请，包括编号、状态、时间、审核说明与独立失败态；审核通过不当作打款完成。
- MyNodes：读取失败与空节点分开，刷新去重；详情清空上一台设备数据，关闭/切换后的旧响应不得显示；详情失败可见，后台标签页暂停轮询。筛选无匹配与真正无节点分开。
- MyEquipment / AppMarket / LevelCenter：持久失败状态、重新加载及加载互斥；统计失败不显示成真实零设备。Dashboard 错误时不再显示“暂无收益/节点”措辞。
- Account：通知偏好未读取或读取失败时不显示可保存的默认开关，防止覆盖未知服务端偏好；保留账户资料与安全组件及其权限逻辑。
- LevelCenter：服务端等级按余额计算，删除“累计收益升级”误述；进度条下限从错误的上一等级修成当前等级门槛。
- api.ts：个人资料、节点、装备、钱包关键响应结构校验，异常结构不再静默变空。
- 内容UI：6个旧页面统一到个人门户局部样式（中性底色、标题、卡片、表格、错误态、移动端布局、焦点边框），不修改 shared、不改公开首页或下载页。

## 已核查的接口与路由

| 页面 | 接口 | 边界 |
|---|---|---|
| /dashboard | GET /my/dashboard-summary | 真实聚合、轮询、身份切换保护保留 |
| /my-nodes | GET/PATCH/DELETE /my/nodes、详情、pause/resume | 单账号归属由服务端验证；未实操删除、暂停 |
| /tasks | GET /my/tasks | status/page/size；搜索仅本页，已明确 |
| /wallet | GET /my/wallet、GET /my/wallet/transactions、GET/POST /payment/withdraw | 未发起真实提现 |
| /equipment | GET /my/equipment | 跨节点已安装应用聚合 |
| /app-market | /marketplace/apps、library、provision、deprovision | 保留下发与实际安装区分；未实操安装 |
| /account/* | /my/profile、/auth/me、sessions、totp | 保留完整安全交互；通知发信渠道尚未接入 |
| /level | GET /my/wallet | 当前级别/倍率由服务器返回；全等级门槛与倍率表仍是本地说明，移除了未证实的 VIP / 解锁任务承诺 |

## 服务端证据

source-review/edge-live/platform_v8/api/v8/my.py: 钱包 SQL 统计所有负向流水，pending 固定 0；_next_level_threshold 使用 balance。payment.py: POST 返回 WithdrawOut（request_no/status），GET 返回 ok/items/total。主任务同时核对了现网 my.py 725、738 与 GET 提现契约。

## 验证

- `node tests/portal-state.test.mjs`：通过。执行实际 Vue script 内容，验证任务乱序响应、任务失败状态、流水新请求失败后的旧响应回填阻断，以及非法提现金额在发请求前被拒绝。
- `npm run build:check`：通过（vue-tsc --noEmit + Vite，1846 modules）。已有大bundle提示仍存在。原node_modules按需读取挂起，候选目录按原package-lock独立 npm ci 后完成，未修改原目录。
- 浏览器 fixture 与视觉验收由主任务统一进行；fixture 通过不等于真实登录后端验收。

## 剩余边界

未用真实账号端到端验证读写。服务器固定 pending、缺少动态等级权益规则、通知渠道未接入是服务端能力缺口；本次明确显示真实边界，未伪造补全。任务查询仍无服务端全文搜索。提现 POST 网络超时存在结果未知；本轮最终补充按账号持久化未确认标记，禁止页面内与重新挂载后的重复提交，并读取历史供核对，不把空列表当作未提交。

## 浏览器验收跟进

主任务确认钱包呈现正常，任务 503 为常驻错误且不显示伪空状态。按反馈将本轮六页所有操作/读取错误 toast 接入已有 errorMessage，HTTP 503 显示“服务暂时不可用，请稍后再试。”；清理标题、刷新、收益流水、提现和浏览市场按钮的装饰 emoji。再次 build:check 与原状态回归通过（Vite 3.21s）。

追加修复：个人登录与身份读取的全部 9 种共享 SessionCode 映射中文提示，使用 Record<SessionCode, string> 保证新增代码在编译时要求补全。会话隔离逻辑不变。状态回归增加全 SessionCode 覆盖与 HTTP 503 文案验证，通过。320px 钱包余额卡改纵向布局；金额不拆分、响应字号、超长金额仅金额行滚动；两个操作各占一行且整词显示；修正移动媒体规则优先级。最终 build:check 通过（Vite 3.31s）；移动端复验交主任务。


## 提现未知结果防重修复

发送前写入按账号隔离的 localStorage 未确认标记，仅存 1，不保存金额或收款信息。明确申请编号和状态、或明确 4xx 拒绝时清除；网络中断、5xx、408/499、缺少确认字段均保持标记，保留当前表单并禁止再次 POST。自动读取申请历史，常驻提示“无法确定是否已经提交成功”；关闭重开、刷新/重新挂载都不能绕过，也没有重试按钮解除标记。空历史不自动证明失败，需平台核实。

新增实际 Vue script 回归覆盖断网、503、缺确认字段：第二次点击、关闭重开、重新挂载均不会发送第二次 POST；422 确定拒绝保留输入并允许修正提交。测试通过。

服务端目前没有客户端幂等 key 或定位原提交的查询协议，前端无法自动证明未提交，未知结果必须人工核对；空列表不会解锁。未知结果提示使用现有 src/config/site.ts 的 OFFICIAL_LINKS.supportEmail（support@qianshousuanli.com）提供可点击邮箱，要求提供账号、提交时间与金额，不自动发送消息。
