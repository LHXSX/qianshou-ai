# 固定 V1 源码的独立 V2 升级器

`Install-Windows-H3Adapter-V2.ps1` 只升级已经采用受支持 `workbench_node.py` 基线的 H3 API。它没有改写旧安装器，不安装完整 H3 软件，不创建私有模型/作者配置，不启动 8790、ComfyUI 或 GPU，也不把 V1 试用收据、平台样单或授权升级为 V2。

## 当前状态与阻断

适配器基线的 LF 摘要为 `0650d18bc9060efda379185944ef6841a0dcae5ce0ed3cec24076fefd512a2f2`，补丁和目标摘要来自已冻结的 `adapter-v2.manifest.json`。独立的 `adapter-v2.install.manifest.json` 列出与生产 V2 身份算法相同的 20 个源码角色。

其中 10 个 Comfy 源码角色尚未取得受审摘要；此外，修改的 Comfy 核心、LoRA guard 及完整 API/import 软件清单也尚未取得。20 个角色是当前有限的测量输入，不能代表完整软件闭包。新安装器会在创建副本、修改源码或调用 Python/Git 前明确拒绝。清单中记录的 Comfy/KJNodes commit 是来源线索，不代替这十个文件的真实摘要，也不允许在安装时自动采纳本机任意代码。此版本尚不能宣称已在 Windows 安装成功。

升级器还要求独立安装清单的 `canonicalSoftwareClosure` 明确完整，并检查列出的 raw 固定软件文件。除 models/input/output、Git、Python 环境和 pycache 数据目录外，API workbench/local_h3 与 Comfy 软件树中的 `.py/.pyd/.dll` 必须全部入清单；未知额外软件、缺文件、链接和大小写冲突拒绝。此安装前检查不把新增 extras 隐式写入已冻结的 V2 公共配方算法，也不宣称每次执行已测量完整闭包；完整配方运行时绑定仍是后续独立事项。

清单范围是此固定 H3 配方的第一方代码及必需的软件模块，不包含 `.git`、venv、pycache、模型、输入输出或用户数据。Python 标准库、解释器依赖和 native ABI 需要另行锁定受支持上游版本；这份清单不声称逐字节证明整个 Python/系统依赖环境。未知用户 custom_nodes 不能混入此受支持软件树，建议独立的标准配方目录。

取得实际受支持源码清单后，必须同时更新独立安装清单及脚本内固定清单摘要，并重新审核、运行 Windows PowerShell 5.1 parser/动态测试。不能手填一个本机摘要就宣称成为公共标准配方。新机完整源码分发仍按 `STANDARD-SOURCE-RECIPE.md` 单独完成。

## 本人操作

使用已安装 H3 环境自己的 Python，先正常关闭 8790 适配器。脚本不会替本人停止进程；ComfyUI 可以保持原状态，脚本不会调用其网络接口或提交 GPU 作业。

```powershell
powershell.exe -NoProfile -File .\Install-Windows-H3Adapter-V2.ps1 `
  -ApiRoot 'D:\existing-h3-api' -ComfyRoot 'D:\existing-comfy' `
  -PythonExe 'D:\h3-python\python.exe' -CheckOnly
```

`CheckOnly` 对 live 源码只读。待完整受支持清单可用时，它会在本人 LocalAppData 创建一个受控的源码检查副本，使用 Git 二进制 stdin 应用固定补丁，保留副本用于排查；没有补丁临时路径、磁盘 `pyc` 或目录自动删除。

核对通过后，移除 `-CheckOnly` 使用同一命令升级。已有正确 V2 源码时只做离线检查。若 8790 正在监听，离线预检和真正升级都拒绝，避免排他读取干扰用户在途任务；无法取得监听状态也拒绝。提交前再次确认；不会自动停止用户服务。

## 字节与恢复边界

- bundle 补丁、离线检查器及安装 JSON 只允许 CRLF/LF 传输差异，固定摘要校验后转为 LF 的内存字节；受管 V2 helper 和其他实际配方源码必须符合固定 raw LF 摘要。V1 适配器基线可从已知 CRLF 字节生成固定 LF 副本，但原始备份保留原字节。
- 源码目录及所有祖先拒绝 reparse point，并持有无 write/delete 共享的目录句柄。每个现有源码通过排他文件句柄读取，检查真实物理路径和单硬链接；20 个测量角色不能被缺失、替换或临时占位文件代替。
- 新 helper 用 `CREATE_NEW` 排他创建，适配器在同一排他句柄上比较旧摘要、写入并复查。失败恢复只接受本脚本写入后的精确摘要；外部修改或未知文件保留，不强制覆盖或删除。原始节点字节和检查副本保留在本人私有 LocalAppData 目录。
- 自动恢复限本次失败事务。成功升级后不要把备份直接强制复制到运行目录；回退需要独立核对当前源码/权限状态，避免覆盖后续编辑。

离线检查会对全部 20 个冻结源码字节执行 `compile()`，只实际导入固定的三个身份模块。API gateway、graph builder、Comfy package 不被执行。适配器的 imports 和 V2 路由/schema 在 AST 中核对；这不等于已经启动真实 Windows ASGI 路由。已冻结增量补丁另有 25 项实际 ASGI 合成端口回归，不能代替真机安装或 GPU 出片验收。

升级成功仍必须本人启动正确服务，创建明确的 V2 owner 配置，执行新的 V2 本机试用，并继续真实平台登记、双样单、审核和接单供给授权。源码升级本身不会开启接单。

## 维护验证

```text
python -I -B tests/test_v2_upgrade.py -v
```

这组测试使用真实固定适配器和身份模块，其余编译输入明确为合成源码；验证拒绝旧版本升级、角色/摘要/路径/语法损坏及无服务导入。它包含脚本字节合同检查，不冒充 Windows PowerShell 5.1 执行。此 Mac 环境无 `pwsh`；Windows parser、目录锁兼容性、CRLF/重复安装、junction/hardlink/CAS 冲突及回滚动态验收仍需真实 Windows 单独完成。
