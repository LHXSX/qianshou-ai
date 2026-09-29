# 上海人民币收单候选

本目录沿用上海 `we_payment_orders → mark_paid → ledger.deposit → we_ledger`。金额是人民币元，与广州模型网关的微 SP、订阅授予是不同业务。本候选没有决定汇率、手续费、退款或 SP 同步。

基线来自上海 `/opt/edge`，HEAD `2e7e55d721408e72f7b0c0c624d6412acb885dba`；取样时有 67 项 WIP。仅修改支付模块与支付 router；账本、repo、app.py 的现有 WIP 按原字节作为测试依赖。实际 Python 是 3.10.12，cryptography 是 42.0.5；已只读确认该版本具有证书 UTC 有效期属性。

## 支付行为

- 微信采用普通商户 API v3 Native，下单成功返回 `payment.mode=wechat_native` 和 `payment.code_url`。这不是 JSAPI / APP SDK，不返回虚构的 `prepay_id`。
- 支付宝采用 RSA2 **`alipay.trade.page.pay`**（电脑网站支付 · 页面跳转收银台），下单成功返回 `payment.mode=alipay_page`、`payment.action`、`payment.method` 和 `payment.params`。**服务端只签名、不发出站请求，也不返回 HTML**；由浏览器把参数集 POST 到收银台。因此这条链路没有可验签的服务端响应——付款事实只来自异步通知或 `alipay.trade.query`。
- **网关响应的字符集不是 UTF-8**。实测（对生产网关发了一次只读的 `alipay.trade.query`）：请求里写了 `charset=utf-8`，网关仍以 `Content-Type: text/html;charset=GBK` 返回 GBK 字节，**且 `sign` 是对 GBK 字节算的**（同一切片改用 UTF-8 回编码则验签失败）。因此 `_verified_response()` 必须用响应声明的 charset 解码、并用**同一个编码**回编码签名切片。修复前它对任何含非 ASCII 的真实响应都报 "Invalid provider JSON"——而 mock 出来的 UTF-8 测试体永远抓不到这一点。异步通知不受影响：通知体是 URL 编码的纯 ASCII，charset 参数在体内，我们显式要求 `charset=utf-8`。
- 之所以不走 `alipay.trade.precreate`（当面付扫码）：该主体**只签约了电脑网站支付**，开放平台「可调用产品」里 `precreate` 不在已开通接口列表中；当面付的官方定位也是「线下实体场所」。`precreate` 分支按原样保留在 `alipay.py` 中，签约后只需改 API 层的通道表即可启用。
- 每次下单先持久化本地订单及请求审计，再发起第三方请求。只有验签通过的下单响应才返回付款参数。二维码、跳转与同步回跳**都不能**把订单标为 paid。审计动作按通道区分：微信/预下单是 `payment.precreate.requested|unknown`，跳转收银台是 `payment.cashier.requested`（它没有出站请求，不谎称 precreate 过）。
- 超时、签名错误或第三方未明确确认时，HTTP 502 返回原 `order_no`，订单保持 pending，并记录 `payment.<通道>.unknown`。不得自动创建另一张充值单；可查看原订单或显式重取原订单支付参数。本地生成付款参数失败时返回 502 `payment_parameters_rejected`——第三方从未被触达，因此不与"结果未知"混为一谈。
- 线上金额范围为 `0.01..1000000` 元，拒绝非有限值和不足一分的精度。微信用 Decimal 转整数分；支付宝用两位小数字符串。现有 manual/bank 金额路径保留。
- 回调无需用户 cookie，但必须真实验签；微信还需 AES-256-GCM 解密、校验证书序列号和有效期、签名时钟 300 秒窗口、appid/mchid、NATIVE/SUCCESS、CNY。支付宝需 RSA2、UTF-8、appid/seller_id、TRADE_SUCCESS/TRADE_FINISHED、国内人民币金额。
- 下单写入不可由客户端指定的账号绑定：微信 `attach=account_<id>`；支付宝 `passback_params=account_<id>`。回调在锁定订单后比较订单号、账号绑定、通道、金额、币种和流水号；只使用数据库中的账号入账。
- `mark_paid` 的订单锁、DEPOSIT、余额缓存、paid 状态和成功审计在同一事务提交。原账本 helper 原本就不单独 commit；本次并未修复一个不存在的“中途 commit”问题。
- PostgreSQL advisory transaction lock 对相同 `(gateway, gateway_tx_id)` 的不同订单串行查重，订单行锁处理同单重试，账户行锁协调本充值路径不同订单的余额重算。所有线上入账必须经过本函数；普通数据库索引本身仍不是唯一索引。不声称修复所有其他账本 writer 的并发。
- 同单重复回调只有在字段和交易号一致时才成功返回；不同订单重用线上流水号被拒绝。manual/bank 可继续使用 `MANUAL` 参考号；已 paid 同单变更参考号被拒绝。
- 线上订单不能用 admin confirm 伪造已付；manual/bank 的请求签名和既有确认流程保留。迟到但经验证的成功回调可把本地 expired 转 paid，防止本地超时丢失付款事实；cancelled/failed/refunded 不自动改写。
- 拒绝日志只记录 gateway、处理阶段和已验签订单号，不写原始回调、签名、账号付款资料或密钥。金额/账号错留下 `stage=order_binding_or_ledger`，签名/商户/app 错留下 `stage=signature_or_provider_identity`。

## HTTP 契约

所有用户路由沿用 `get_current_account`。管理路由沿用 `get_admin_account`。

| 路由 | 输入 / 输出 |
| --- | --- |
| GET `/api/v8/payment/channels` | `{items:[{gateway,mode,available,reason?}]}`；`mode` 为 `wechat_native` 或 `alipay_page`；available 仅说明配置解析通过，不代表商户在线联调验收通过 |
| POST `/api/v8/payment/recharge` | `{amount:"1.00",gateway,remark?}`；201 返回 RechargeOut |
| POST `/api/v8/payment/orders/{order_no}/payment` | 无 body；仅订单本人，对未过期 pending 线上订单重取同一单号支付参数；不创建新单 |
| GET `/api/v8/payment/orders/{order_no}` | OrderOut；仅本人或 admin；这是本地订单查询，不是第三方对账查询 |
| GET `/api/v8/payment/orders?limit=30` | 原个人历史 `{ok,items,total}`；total 仍是本次数量；limit 1..100 |
| POST `/api/v8/payment/notify/wechat_pay` | 原始 JSON + 微信签名 headers；成功提交 204；拒绝 400，通道未配置 503 |
| POST `/api/v8/payment/notify/alipay` | 原始 form body；成功提交 200 文本 `success`；拒绝 400 文本 `failure`，未配置 503 |
| GET `/api/v8/admin/payment/orders` | `limit=30`(1..100), `offset=0`, 可选正整数 `account_id`、`status`、`gateway`；`{ok,items:AdminOrderOut[],total:筛选总数,limit,offset}` |
| GET `/api/v8/admin/payment/orders/{order_no}` | AdminOrderOut |
| POST `/api/v8/admin/payment/confirm` | 原 `{order_no,gateway_tx_id}`；`{ok,order:OrderOut}` |

OrderOut：`order_no,account_id,amount:string,currency,gateway,status,gateway_order_id?,gateway_tx_id?,created_at,paid_at?,expired_at?,remark`。本次新增 `account_id`，其余字段保留。AdminOrderOut 额外含 `ledger_id`。RechargeOut 额外含可空 `payment`：`alipay_page` 时是 `{mode,action,method,params}`（**参数，不是 HTML**），`wechat_native` 时是 `{mode,code_url}`，`alipay_precreate` 时是 `{mode,qr_code}`。前端不得自行拼装支付参数，也不得用 `innerHTML` 注入表单。

未知下单结果的错误体：

```json
{"detail":{"code":"payment_request_unknown","order_no":"PAY_...","message":"支付请求结果未确认，请查询或重试原订单，不要重复创建充值单"}}
```

如果浏览器连错误体也没有收到，应先读本人订单历史并核对原订单；没有客户端幂等键自动找回保证，禁止对新的 `/recharge` 自动重试。

## 配置（只列名称，不含真实值）

公共：`V8_PAYMENT_PUBLIC_ORIGIN` 必须是 HTTPS origin，无 path/query/userinfo。回调路径由服务生成，客户端不能指定。默认两条线上通道均关闭，缺配置在建订单之前返回 503。

微信：

```
V8_WECHAT_PAY_ENABLED=1
V8_WECHAT_PAY_APP_ID
V8_WECHAT_PAY_MCH_ID
V8_WECHAT_PAY_MERCHANT_SERIAL
V8_WECHAT_PAY_PRIVATE_KEY_FILE
V8_WECHAT_PAY_API_V3_KEY_FILE
V8_WECHAT_PAY_PLATFORM_SERIAL
V8_WECHAT_PAY_PLATFORM_KEY_FILE
```

平台验签文件接受 PEM 证书，或微信支付公钥 PEM。证书序列号必须一致且当前有效；公钥模式的 serial 必须是 `PUB_KEY_ID_...`。商户私钥为 RSA ≥2048，API v3 key 为 32 字节。私钥和 API key 文件必须是绝对路径且没有 group/other 权限（如 0600）；文件位于源码仓库外。配置仅支持一份当前固定验签材料；生产轮换需先安排新旧材料过渡方案并验证旧单回调，不能把单次切换等同无损轮换。

支付宝：

```
V8_ALIPAY_ENABLED=1
V8_ALIPAY_APP_ID               必填
V8_ALIPAY_PRIVATE_KEY_FILE     必填（应用私钥，仓库外 0600 绝对路径）
V8_ALIPAY_PUBLIC_KEY_FILE      必填（支付宝公钥 PEM）
V8_ALIPAY_SELLER_ID            商家 PID · 官方异步通知校验清单要求核对 seller_id
                               （或 seller_email）；配置了就每次回调强制校验，
                               未配置则跳过该项并留下明确日志，其余校验（签名 / app_id /
                               out_trade_no / total_amount / trade_status / notify_type /
                               币种）一项都不放宽。本部署已配置 2088451802817565。
```

`V8_PAYMENT_PUBLIC_ORIGIN` 同时决定异步通知地址 `…/api/v8/payment/notify/alipay` 和付款后回跳地址 `…/ea/#/wallet`。回跳地址由服务端从该 origin 推导，**不接受客户端传入**（避免把回跳变成开放重定向）；SPA 路由若迁移，需同步改 `config.SPA_RETURN_PATH`。

使用应用私钥和支付宝公钥，不接受客户端提供的钥匙；私钥同样要求独立受保护文件。配置加载异常不会把私钥内容、原始文件数据输出到 HTTP 响应。

## 过期清理候选

在实际服务器 Python 源码中，原 `expire_pending_orders` 只有定义、没有调用。本次提供可单独运行的入口，不修改 app.py：

```bash
/opt/edge/venv/bin/python -m platform_v8.services.payment.expire_orders
/opt/edge/venv/bin/python -m platform_v8.services.payment.expire_orders --apply
```

第一条仅统计，第二条实际标记超时 pending；不删除订单和幂等键，不入账。使用既有 `storage.db` 的 `V8_DATABASE_URL` 或分项 PostgreSQL 配置。`deploy/systemd/qianshou-payment-expiry.{service,timer}` 是未启用候选：一分钟触发一次，读取仓库外 `/etc/qianshou/payment-expiry.env`，使用 DynamicUser 和只读文件系统。部署前必须确认服务用户能读代码/解释器、能连接现有数据库；环境文件由 systemd 读取并保持 0600，不拷进仓库。候选没有安装或启动 timer。

## 验证和边界

本地测试生成临时 RSA 私钥和自签测试证书，真实执行 PKCS1v15/SHA256 与 AES-GCM；出站网络由 httpx transport 拦截，没有发送真实订单。数据库测试只允许显式 loopback `qianshou_test` DSN；在独立 PostgreSQL 18 实例创建、删除自身临时 schema/database，未连接生产数据库。示例测试命令：

```bash
PAYMENT_TEST_DATABASE_URL=postgresql://qianshou_test@127.0.0.1:59072/postgres python -m pytest tests/payment -q
```

本轮 146 项测试通过，包括两个公开 HTTP 回调、错误签名 4xx/零记账、商户/app/账号/金额/币种不一致、同单/跨单并发、事务回滚、manual 201+确认、权限边界、超时保原单、跳转收银台、对账 CLI、dry-run/apply/迟到回调。跳转收银台的签名由**独立重写的验证器**校验（不复用生产 helper），且该验证器本身被证明会拒绝被篡改的输入。十项变异都使对应测试失败并已按 SHA 还原：去掉 RSA2 排序、写错 `product_code`、往 `biz_content` 里塞文档未列的 `seller_id`、金额不符仍入账、第三方答"未支付"仍入账。

`alipay.trade.query` 是官方指定的漏通知兜底。独立入口 `python -m platform_v8.services.payment.reconcile_orders [--apply]` 对最近订单给出 `in_sync` / `provider_paid_local_unpaid` / `amount_mismatch` / `tx_mismatch` / `provider_has_no_order` / `local_paid_provider_unpaid` / `query_failed`，**默认只报告不入账**；只有 `provider_paid_local_unpaid` 可入账，且必须经由既有的 `mark_paid`，订单锁、金额/币种/通道交叉校验和幂等账本键全部照旧。验签失败不会被降级成"未知"。查询响应不回显 `passback_params`，所以查询入账的账号绑定取自**我们自己的订单行**（该行由已验签的 `out_trade_no` 定位），权威事实仍是签名响应里的 `out_trade_no`/`trade_status`/`total_amount`。

本地运行时 Python 3.14.3 与服务器 3.10.12 不同；本地依赖版本收据见候选外验证记录。代码 AST 按 Python 3.10 语法检查，服务器确切版本执行需另做独立候选复验。真实商户开通、真实密钥/证书、实时商户订单、扫码支付、网关回调可达、生产 ledger、systemd timer 激活、正式部署均未验证。

仍需关闭的运营缺口：真实商户凭据落地后的实测、凭据/平台公钥轮换过渡、完整部署回滚和真实小额验收。这里的本地 green 不能作为正式收单上线证明。原工单退款、费率、SP 同步、对公到账判断四项仍未决。

## 官方依据

- [微信 Native 下单](https://pay.wechatpay.cn/doc/v3/merchant/4012791877)：普通商户 endpoint、整数分、code_url。
- [微信 API v3 回调](https://pay.wechatpay.cn/doc/v3/merchant/4012791861)：签名 headers、证书/公钥身份、AES-GCM 和应答形状。
- [支付宝官方异步通知校验说明](https://developer.alibaba.com/docs/doc.htm?articleId=105302&docType=1&treeId=204)：订单、金额、seller_id 和 app_id 的交叉校验。
- [电脑网站支付快速接入](https://opendocs.alipay.com/open/00dn7k)：页面跳转流程、`product_code=FAST_INSTANT_TRADE_PAY`、「同步返回不可靠，以异步通知或 `alipay.trade.query` 为准」。
- [统一收单下单并支付页面接口](https://opendocs.alipay.com/open/028r8t)：公共参数、`biz_content` 必填字段与 `time_expire` 范围。
- [支付宝官方 Python SDK](https://github.com/alipay/alipay-sdk-python-all)：`AlipayTradePagePayModel` 的字段清单——`passback_params` 与 `time_expire` 在其中，**`seller_id` 不在**（这就是本实现不往 `biz_content` 里塞 `seller_id` 的依据）；`AlipayTradeQueryModel` 用 `out_trade_no` 查单。同时给出[precreate 参数模型](https://github.com/alipay/alipay-sdk-python-all/blob/master/alipay/aop/api/domain/AlipayTradePrecreateModel.py)供保留分支对照。
- [支付宝官方 precreate 接口](https://developer.alibaba.com/docs/api.htm?apiId=862&docType=4)：二维码收单产品（本主体未签约，仅供参考）。
- opendocs 的动态页面本工具取不到正文，因此以上以官方域名下的 `.md` 全文与官方 SDK 源码交叉核对，未采用第三方博客协议。
