# 协作专用中转

[English](README.md) | 中文

本运维服务通过 FRP 0.71.0 公开一台已私有登记的千手主控的设备 WebSocket。它与服务器现有业务独立运行，不运行 Harness 智能体、不存储设备凭据，也不公开主控 HTTP API。主控和协作端均主动建立加密连接；配对、撤销、本地批准、任务执行与回执继续由现有[设备协议](../../packages/host/remote-devices/README.zh.md)负责。

## 公网与私有监听

| 监听 | 用途 |
| --- | --- |
| HTTPS `24443`，精确 `/qianshou-device` | 原生协作端 WebSocket；主控要求首个受限消息帧完成认证或配对。 |
| HTTPS `24443`，精确 `/~!frp` | 主控 WSS 传输；FRP 要求独立签发的注册令牌和已登记主控身份。 |
| HTTPS `24443`，精确 `/healthz` | 公共服务元数据；单凭此响应不能证明主控已经连接。 |
| 回环 `17440` / `17441` / `17442` | FRP 控制传输、HTTP 虚拟主机和注册策略 RPC，均不绑定公网地址。 |
| 现有 HTTP `80`，ACME challenge 前缀 | 仅提供证书机构验证文件；现有业务路由与监听保持原字节内容。 |

Nginx 拒绝其他公网路径及设备通道上的非 WebSocket 请求。注册插件只接受已登记身份、其 `devices` HTTP 代理、唯一域名及 `/qianshou-device`；其他协议、通配路径、额外主机和请求头覆盖均按拒绝处理。这是单主控部署，不支持在独立主控之间共用注册密钥；不同所有者需要分别登记路由身份并隔离公网映射。

中转服务器终止 TLS，因此它是受信任的设备消息处理方。加密保护两段公网传输，不构成针对中转管理员的应用层端到端加密。访问日志关闭，策略 RPC 不记录请求正文。注册密钥与 ACME 账户密钥存放在服务器独立受保护文件内。实际屏幕会话继续使用独立的 [RustDesk](https://rustdesk.com/docs/en/self-host/rustdesk-server-oss/install/) 连接；本服务不转发桌面像素，也不安装 `hbbs`/`hbbr`。

## 部署教程

使用管理员拥有的 Ubuntu 服务器，并准备 Nginx、Docker、Python 3、可达公网 IPv4 地址及独立可达的 24443 端口。首先检查运行中的服务、监听及 Nginx 配置。准备脚本要求提供已观察到的业务站点 SHA-256，遇到不符合预期或已经修改的配置会拒绝操作。现有 FRP、数据库、媒体和 API 服务均不属于它的管理范围。

1. 将这些 Python 模块和官方 `frp_0.71.0_linux_amd64.tar.gz` 放入 root 拥有的 `/opt/qianshou-agent-relay`。执行前按上游发布的 SHA-256 校验归档。桌面端的 [FRP 锁文件](../qianshou-desktop/relay/frpc.lock.json)记录同一版本及公共证书根。
2. 拉取 [certificate.py](certificate.py) 中固定摘要的 Certbot 镜像。运行 `python3 prepare_acme.py --site <业务-nginx-文件> --expected-sha256 <已观察-sha256>`。它记录私有备份、加入一个 ACME include、检查 Nginx 语法并重载。从服务器外部验证专用 challenge 探测文件。
3. 运行 `python3 certificate.py --stage staging --ip <公网-ip>`，随后对同一 IP 使用 `--stage production`。测试证书机构验证 challenge 可达性，不消耗正式签发限额；公网仅使用正式证书。
4. 运行 `python3 install_relay.py --ip <公网-ip> --archive <已验证-frp-归档> --sha256 <官方-sha256>`。安装器创建服务账户、私有登记文件、受限策略服务、独立 FRP 服务、HTTPS 站点及证书续期定时器。它绝不覆盖已有登记信息。
5. 通过经过身份验证的私有通道将 `/etc/qianshou-agent-relay/enrollment.json` 传给所有者电脑，保持仅账户可访问的权限。在主控的中转配置中导入并启用连接。此文件不得进入源码管理、下载归档、截图或设备邀请。协作端仅获得公网地址和主控签发的有效配对码。
6. 运行 `python3 certificate.py --stage check --ip <公网-ip>` 进行 ACME 续期演练，然后运行 `python3 verify_server.py` 生成不含密钥的部署回执。确认公网 TLS 受信任、认证拒绝测试及一项本地批准任务通过后，才能声明设备链路可用。

## 续期与回滚

[Let's Encrypt IP 证书](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)要求使用 `shortlived` profile，有效期为 160 小时。专用 systemd 定时器每 12 小时检查续期，具有随机延迟和补跑错过执行的功能。oneshot 使用固定摘要的 Certbot 容器，成功后验证 Nginx 配置并重载证书。`systemctl status qianshou-relay-certificate.service` 及其退出状态反映失败；不能仅凭定时器已启用就认定成功。证书及账户状态位于 `/var/lib/qianshou-agent-relay/acme`；[Certbot 官方 IP 使用说明](https://letsencrypt.org/2026/03/11/shorter-certs-certbot.html)解释了 webroot 验证和显式重载的要求。

`python3 /opt/qianshou-agent-relay/rollback.py` 仅停止中转及其续期定时器、移除独立 HTTPS 站点，并恢复按字节验证的 ACME 修改。它拒绝覆盖后来发生的业务配置变动。凭据和证书保留供管理员检查；脚本不删除无关资源，也不修改现有 FRP 服务。变更锁文件或 Certbot 摘要前，应主动审查固定上游版本的安全更新。

## 验证

运行 `python3 -m unittest discover -s apps/qianshou-relay/tests -v` 检查准入策略。[公网传输测试](../../packages/host/remote-devices/tests/relay-public.e2e.spec.ts)通过 `QIANSHOU_RELAY_ENROLLMENT`、`QIANSHOU_RELAY_FRPC` 和 `QIANSHOU_RELAY_CA` 显式启用；`QIANSHOU_RELAY_RECEIPT` 可指定不含密钥的结果文件。仅在测试独占已登记主控路由时，运行 `node node_modules/vitest/vitest.mjs run packages/host/remote-devices/tests/relay-public.e2e.spec.ts`。它使用临时主控和协作端状态，拒绝无效注册与配对尝试，验证本地批准及回执，并关闭所有自行创建的进程。它不调用 LLM，也不构成 Windows 或另一台真实收件电脑的验收。部署理由见[决策记录](../../.agents/notes/implemented/feature/2026-09-14-qianshou-dedicated-relay.zh.md)。
