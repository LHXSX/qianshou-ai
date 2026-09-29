# 官网账号与微信支付接入

官网是独立的 `web-portal`，广州工作台的 `website/` 是 DSH 文档站。升级源码将原本位于项目上级目录的 `shared/` 收进 `src/shared/`，使官网可以独立安装依赖和构建。

## 手机号注册和登录

`/#/register` 默认显示手机号注册，`/#/login` 增加手机验证码入口，原账号密码与动态验证码入口保留。前端通过当前站点 `/api/v8/auth/sms/send` 请求验证码；仅在服务器确认发送后展示倒计时。注册和登录分别调用 `/api/v8/auth/register/phone`、`/api/v8/auth/login/phone`。若账号启用了身份验证器，手机验证码后还要走 `/auth/login/totp`；随后通过 `/auth/me` 核对身份并提交现有浏览器会话。线上后端的手机号 TOTP 修复部署并验证前，不能发布该入口。

短信由上海服务端连接阿里云。前端不保存阿里云密钥、短信验证码或微信商户私钥。若短信配置或签名模板未就绪，发送接口返回错误，页面提示当前不可用。

## 微信扫码充值

`/#/wallet` 的“账户充值”区先读取 `/api/v8/payment/channels`。只有 `wechat_pay` 通道标记可用时，才允许创建原生扫码充值单。点击后调用 `/api/v8/payment/recharge`，将服务器返回的 `code_url` 转成二维码。二维码只代表待付款订单，不代表到账。

页面每 5 秒读取一次 `/api/v8/payment/orders/{order_no}`，也允许用户主动调用原订单的 `/refresh` 核对支付结果。只有服务器返回 `paid` 才展示入账。创建请求结果不明时，会在账号范围内保存待核对标记，阻止再次新建充值单；用户可读取历史订单和重新取得原单二维码。

当前上海接口仅支持微信 Native 二维码，适合桌面浏览器。移动端的 H5、JSAPI 或 App 支付须另有商户产品开通及服务端下单能力，不能把二维码当作移动端微信支付已完成。

## 验证和发布

运行 `npm ci`、`npm run build:check`、`node --test tests/portal-state.test.mjs tests/agent-release.test.mjs`。浏览器联调可用隔离测试账号和 API 响应模拟验证 UI 与请求；模拟不会证明阿里云短信已送达或微信商户已收款。正式发布应使用官网原有的 `verify → preflight → activate` 静态发布流程，先核对服务器当前 manifest、保护文件、回滚包和实时通道配置。
