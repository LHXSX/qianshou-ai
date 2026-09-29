# Windows H3 8790 独立适配器补丁

此目录只提供已有 `h3_api/workbench/workbench_node.py` 的增量补丁和两个独立模块。千手自研文件按 Apache-2.0 提供，详见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)；上游 Comfy 组件保留各自许可。它不修改共享 `node-contributor`、`compute-core` 或技能目录，也不包含机主配置、权重、私钥、视频或本机绝对路径。

## 安装到另一台 Windows

1. 在该机器停用旧 8790 服务后，用本目录 `Install-Windows-H3Adapter.ps1` 自动检查并安装。先执行预检，再执行安装（把示例路径换成该机器的实际 H3 API 根和 Python 环境）：

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-Windows-H3Adapter.ps1 -ApiRoot 'X:\h3_api' -PythonExe 'X:\h3_env\python.exe' -CheckOnly
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-Windows-H3Adapter.ps1 -ApiRoot 'X:\h3_api' -PythonExe 'X:\h3_env\python.exe'
   ```

   脚本要求 Git for Windows、Python 3.11+、`psutil` 和 `PyYAML`；不联网安装依赖。它钉住原始 `workbench_node.py`、图构造器和五个 `local_h3` 源码的 SHA256（只容许 LF/CRLF 换行差异），检查补丁可用性，备份原文件，在私有副本应用补丁并固定目标字节摘要，再独占校验并写入原文件，创建两个模块并执行 `compile(bytes, filename, 'exec')` 内存语法检查。三份源码从可信物理路径的独占句柄冻结后以带原始 SHA256 的二进制标准输入交给 Python；Python 先核摘要，只解析语法，不导入或执行这些源码，也不生成 pyc。对于被 Git for Windows 检出为 CRLF 的补丁，安装器会重新核对固定摘要、拒绝孤立回车，并把固定的 LF 字节直接写入 `git apply` 的二进制标准输入，不创建临时补丁文件；用户无需手改补丁或 Git 设置。安装开始时固定本机 `workbench` 的卷 GUID 物理目录；后续读取、写入、创建和回滚均按实际句柄路径核对，父目录被改接或目标有链接时拒绝改动外部字节。无法查询卷 GUID 物理路径的根目录（例如部分 SMB 共享）会安全拒绝。备份放在当前用户的 `LocalAppData/Qianshou/H3AdapterBackups`，不进入 H3 源码或 Git 树；成功后会打印具体备份目录。失败时只对仍与脚本写入字节相符的文件执行独占校验恢复；若被其他进程改过，会保留外部字节和备份并明确报错。遇到其他 H3 基线、目录接点/符号链接、硬链接或已有模块内容冲突会用中文拒绝，不能强制补丁，也不要求普通用户手工改 Python 或写 JSON。
2. 启动本机 ComfyUI 时使用 `--cache-none`、显式 `--input-directory` 和 `--output-directory`，只监听 loopback。适配器对接 Comfy **本体**端口，不能把 8189 等转发进程当作受检渲染器。安装目录、输入根和输出根由本机配置给出，不由用户名或盘符推断。当前身份协议不接受 Comfy `--base-directory`、`--models-directory`、`--extra-model-paths-config` 额外覆盖；默认安装根的 `extra_model_paths.yaml` 受支持。五个模型 basename 在全部已知搜索根（含 Comfy 输出附加根）中必须唯一。
3. 启动 8790 前配置：`H3_COMFY_BASE=http://127.0.0.1:<Comfy端口>`；`H3_COMFY_MODEL_ROOT=<ComfyUI安装目录，含 main.py/models>`；`H3_ADAPTER_OUTPUT_ROOT=<Comfy输出目录>/MiniMax_H3/LocalAPI`。第三个值是**直接包含 `<jobId>/result.mp4` 的目录**，后续新版 Host 的参数化引导须把同一值绑定到 `ownerConfig.outputRoot`。本安装器只安装适配器源码，不生成机主配置或要求用户手工写 JSON；参数化引导完成前不得接单发布。适配器原有 `--api-root` 指向该机 H3 API/工作流源码根，`--root` 指向该机 Comfy 输入输出工作根，`--out` 指向该机作业元数据根；三者仍为可配置参数。`H3_ADAPTER_OUTPUT_ROOT` 必须与 Comfy 进程的 `--output-directory` 对应；不一致拒绝身份认证。
4. 用固定 PNG 的真实字节 SHA 和固定 negative 的 UTF-8 字节 SHA 调用 `GET /v1/recipes/qs_new4/identity`，按回执文档构造带 `expected` 的 `POST /v1/jobs`。再运行当前分支钉住源码 SHA 的 `owner_self_test.py`，检查返回的 `nativeBinding`、新视频、`recipe_identity.attested=true` 和独立的 Comfy loader generation。其他 Windows 节点使用相同 route/schema/算法，不能复制这台机器的私有配置或自检收据。

适配器在查询、提交、交给 Comfy 前及完成后检查实际 Comfy 监听 PID、启动时间、命令行、无缓存状态和输入输出目录；在作业边界强制重读五权重字节 SHA，并拒绝自 Comfy 启动后改过的模型/运行源码。完成时读取该 prompt 的 Comfy 历史，确认历史实际图与提交图一致、执行成功且五个模型 loader 节点均不在 `execution_cached` 中，才写入本次 `comfy_model_load_generation_sha256` 并对 `recipe_identity` 给出 `attested=true`。模型、源码或进程身份变化会自动拒绝任务；需空队列下重启 Comfy/适配器并重新自检后才能恢复受检接单。

该证据绑定 Comfy 本次实际执行的图、无节点缓存的五 loader generation 以及作业前后稳定的磁盘模型字节。若要证明 GPU 显存中的每个字节，还需要 Comfy 进程内的受控测量或只读不可变文件快照；本补丁不把普通磁盘 stat 当成这类证明。

## Windows 安装器隔离回归

在 Windows PowerShell 5.1 的临时基线上，LF/CRLF 安装、重复安装、原始基线 `-CheckOnly` 与已安装基线 `-CheckOnly` 均通过。已安装节点在原始摘要冻结前、两个合法模块分别在 `Assert-Hash` 后与独占原始摘要冻结前、旧基线只读预检的节点与已有模块在独占检查前，五处并发追加可编译注释的注入均以退出码 1 拒绝，外部注入字节保留。父目录 junction、硬链接、最终核验期间已有模块改写、CAS 回滚的隔离注入也都拒绝并保留外部字节；孤立回车和首次验包后补丁再变更同样被拒绝。加载原生句柄类型后，把 `TEMP/TMP` 指向不可作为目录的普通文件：旧版的原始基线及已安装只读预检都退出 1，新版两分支都退出 0，外部哨兵和基线字节不变；这验证新版 Git 补丁及语法检查不再进入旧临时补丁/编译目录路径。这里的语法检查是 `compile(bytes, filename, 'exec')`，不是 `py_compile`。末级 symlink 动态注入因测试身份创建符号链接返回 Win32 1314，**未动态验证**，不得把该项记为通过。以上测试未触碰现役 8790 或执行 GPU 任务。
