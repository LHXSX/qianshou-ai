# 广州源码候选：构建与定向测试

2026-09-30 在 macOS arm64、Node 22.23.1、pnpm 11.7.0 上，从本目录运行 `pnpm install --frozen-lockfile`，再执行下列检查。它们只验证离线源码和本机进程，不证明广州现网已部署同一代码，也不证明 Windows 节点或正式收费任务跑通。

- `pnpm run verify-tsconfig-paths`：通过；补齐了非标准包名的显式源码别名。
- `pnpm exec vitest run packages/host/compute-core/tests/draft-card-meta.spec.ts packages/host/compute-core/tests/tools.spec.ts`：8/8 通过。
- `node --import tsx --test packages/host/model-gateway/tests/plugin-reviewable-execution.node-test.mjs packages/host/model-gateway/tests/plugin-license-bearer.node-test.mjs`：8/8 通过。
- `node --import tsx --test packages/host/admin-console/tests/operational-modules.node-test.ts`：4/4 通过。
- 凭据三个包的测试为 145/145 通过；媒体节点与研究任务的两组定向测试为 21/21 通过。

`pnpm exec tsc -b tsconfig.host.json --pretty false` 仍有 **10 项编译错误**，所以 `pnpm run build` 不能宣称通过。其中 2 项来自客户端源代码引用构建时生成、当前干净目录中尚不存在的 Session Remote 类型；其余 8 项集中在 `packages/host/admin-console/tests/workbench-routes.spec.ts`：该测试引用候选包缺失的 `internal-admin-routes.ts`，并使用当前 `CreditLedger` 没有的调账方法。源码快照与测试来源需要按实际广州网关版本对齐，不能通过跳过测试或伪造财务方法来制造全绿结果。
