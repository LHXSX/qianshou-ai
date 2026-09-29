# 接单技能源包 v5（作者端）

作者在技能目录的 `scripts/order_adapter/` 放一个自包含源包。客户端读取真实文件、运行样例、计算摘要，再提交平台审核；`SKILL.md` 仍用于对话指导，不能单独作为可执行接单包。

`local-adapter.json` 使用 `qianshou.local-adapter-candidate.v2`：

```json
{
  "schema": "qianshou.local-adapter-candidate.v2",
  "taskType": "text_reverse_v1",
  "capabilityId": "text.transform",
  "inputKinds": ["inline"],
  "outputKind": "inline_json",
  "contractVersion": "v1",
  "category": "text",
  "platformDispatchable": true,
  "selfTests": [
    { "input": "samples/reverse.input.json", "expected": "samples/reverse.expected.json" }
  ]
}
```

`src/adapter.mjs` 从标准输入读入一个 JSON 对象，向标准输出写入一个 JSON 值并以状态 0 退出。作者必须提供 1–8 组实际输入及期望输出。客户端在 macOS 的 Seatbelt 和 Node 权限环境里逐组运行并严格比对。当前 v2 只接收内联输入、自包含 Node 源码，不打包第三方依赖；其他输入和运行环境须有对应的独立执行与验收合同后扩展。

源包包含 `package.json`、`pnpm-lock.yaml`、`local-adapter.json`、`src/adapter.mjs` 和样例，可另有自包含源码/资源。清单按路径排序，4–128 个普通文件，每文件至多 2 MB，总计至多 16 MB；禁止符号链接、路径穿越、隐藏安装目录及包脚本。客户端对每项依次哈希 `路径 + NUL + 十进制字节数 + NUL + 原始字节`，按 `qianshou.source-package.v1` 生成 ZIP_STORED 与作者签名。买家独立验同一清单与 ZIP。

本机样例通过只证明这台 Mac 的候选包能按样例运行。平台收到包后仍须独立核对真实任务合同、安装运行、结果验收、定价与审核回执；没有这些回执时，商品不得标为可接单。

买家获取已审商品后，客户端先验平台回执、作者签名和归档版本，再把完整源包暂存。`installOrderAdapterProductLocally` 将 v5 源包复制到独立私有运行树，重核每个文件、任务类型与能力 ID，确认无第三方依赖，并在该运行树内用 macOS 隔离环境跑全部样例。失败时不留下可用运行树；成功时只产生本机自检记录和运行摘要。

`activatePurchasedOrderAdapter` 是买家侧的一键入口：从当前上海在线会话取得本机 worker ID，完成真实源包安装和样例自检，再请求上海随机挑战；本机在同一个隔离运行树处理独立验收方给出的输入。独立验收方必须通过自身持有的锁定归档、沙箱执行和可信在线节点旁路独立核验，才能签发短期回执；客户端最后将回执交上海受理。只有上海返回已登记的设备记录，入口才返回 `deviceInstalled: true` 与 `dispatchEligible: true`。这些字段不打开用户的接单总开关。独立验收服务未接通、签名或回执不匹配时保持不可接单。当前服务缺锁定归档读取与在线节点执行见证，生产购买门保持关闭；测试中的模拟签发不代表现网可用。旧 v4 视频包暂不进入通用 v5 安装器。
