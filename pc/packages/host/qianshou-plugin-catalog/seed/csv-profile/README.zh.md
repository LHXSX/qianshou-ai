# 官方 CSV 结构体检种子，v1

[English](README.md) | 中文

`qianshou.csv-profile-1.0.0.qspkg` 是可复现的纯数据 ZIP。它恰好包含五个普通文件：`manifest.json`、`schemas/input.json`、`schemas/output.json`、`samples/basic-input.json` 和 `samples/basic-output.json`。运行 `node packages/host/qianshou-plugin-catalog/scripts/build-csv-profile-seed.mjs` 可根据仓库中的 Schema 与样例重新生成清单和制品。包大小为 3,058 字节，SHA-256 为 `257064f2a39b3b5bf4a410bebfba138af769bf4e1a7a23054b3aa31ca993f480`。

该操作是上海现有语义类别 `text.transform` 下的 `csv.profile`。执行器是独立且有界的 RFC 4180 CSV 解析器，不复用内置文本转换或词数统计运行器。经审核的 `qianshou.csv-profile.adapter.v1` 位于 `src/official-seed-csv.ts`；不会执行归档内的 JavaScript。它不需要工作区、网络、GPU、模型或文件系统权限。解析器最多接受 1 MiB CSV、10,000 条数据行、64 列，并预览最多 20 行。

`installPrivateOfficialCsvSeed` 在获得机主当前操作的授权并运行包内真实样例后，才把精确的包复制到已有的仅机主可访问目录。`runPrivateOfficialCsvSeed` 每次使用都复核回执与包。这仅供本机私有使用（`dispatchable: false`），不会建立广州买家许可、市场商品、上海能力声明、接单开关或扣费。广州审核签名与免费领取使用另一套合同；买家入口调用本机安装前必须先验证这些事实。

`official-seed-csv-tools` 子路径仅挂载在千手 CEO 与插件创作助手预设中。它提供只读状态、经机主明确授权的离线私有安装，以及处理用户在对话中提供的 CSV 文本。仅加载市场目录服务不会注册这些模型工具。每个工具结果都说明尚未取得买家许可或对外接单权。

用 `pnpm exec vitest run packages/host/qianshou-plugin-catalog/tests/official-seed-csv.spec.ts packages/host/qianshou-plugin-catalog/tests/official-seed-csv.host.spec.ts` 检查制品以及真实 Loader/Host 安装和运行。纯适配器与包格式不依赖操作系统；安装目录的权限模型仍需在 Windows 实机验证，才能承诺 Windows 可安装。
