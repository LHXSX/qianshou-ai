# Windows H3 固定配方源码包

本目录提供 `qs_new4/E_light4_sage` 的受支持软件源码与必要来源身份。第一方代码按 Apache-2.0 开放；ComfyUI、定制采样节点和供应商补丁各保留其 GPL/MIT 许可，逐文件边界见 [NOTICE.md](NOTICE.md) 与 `manifest.json`。它不包含模型权重、媒体、私有配置、设备凭据、任务或服务日志；也不会自动启动 8790/8188 或提交 GPU 作业。其他 workflow 未纳入此闭包。

## 边界与来源

- `h3_api/`：按 Apache-2.0 提供的第一方运行源文件、全源身份核验器与隔离测试。机主路径与服务根须由本机显式配置；缺少 `gpu_slot`、Comfy 队列查询失败或释放失败时拒绝占卡。
- `comfy/`：ComfyUI、KJNodes、LayerStyle、VideoHelperSuite 的固定公开仓库提交与完整 Git tree，归档必要本地差异、定制 sampler、LoRA guard 及许可证。装配器只在**新输出目录**取得公开源码并应用固定差异；动态 package init 所需的上游其余源码由完整固定 tree 提供。
- `manifest.json`：每个归档文件的源字节、归档原字节和 CRLF→LF 后 SHA256；`liveBaseline10` 是当前已核实机器的固定配方测量子集，`canonicalTarget10` 是本包装配目标，两者不能混作完整导入闭包。两组摘要分别计算；目标的受控换行与 KJNodes 安全 guard 都可能造成差异。
- `dependencies.lock.json` 与 `python-wheels.lock.json`：分别固定 API/Comfy Python 3.12.10 的直接依赖及完整已解析分发包版本、Windows x64 wheel 公共来源与原字节 SHA256。`prepared_env_receipt.py` 在仓库外的新准备目录记录 128 个已核 wheel、两个 venv 的全部普通文件集合/字节及解释器路径；安装和每次启动前逐项重验。安装器和预检不会修改现役 Python。CUDA 驱动、GPU 架构与模型权重不在 wheel 锁内。

本包的 API 参数化副本是 **canonical v-next**，与现役 V1/V2 的脚本 SHA/ABI 不同。受控 runner 要求固定 `qs_new4`、5 秒与每个作业的 expected recipe/model 身份；Mac 需先绑定新 ABI 并重新完成 self-test，不能拿旧 proof 启用这个副本。为避免把原本机路径和旧测试故事带入仓库，API 的源到归档 diff 不归档；清单分别保留源/归档哈希及变更类别。Comfy 供应商差异则以审计过的 LF patch 归档，并在 `comfy/vendor-lock.json` 固定来源、版本、许可与 patch 摘要。

## 运行时身份边界

`sourceManifestSha256` 是最终 `manifest.json` **原始 UTF-8 字节**的 SHA256；清单本身不包含这个摘要。`runtimeSourceFiles` 对新装配 API/Comfy 根内受保护的全部 `.py` 逐项记录相对路径、公开来源、原字节数和原字节 SHA256，并核对精确增删；`runtimeAuxiliaryFiles` 同样覆盖 VHS `video_formats/` 中全部 13 个 JSON。清单还固定 `qs_new4/E_light4_sage` 实际图的 17 个 class type。Git commit/tree 和十个测量角色是来源与快速测量证据，不能替代此运行时全源清单。

清单顶层 `runtimeAbi` 与 `entrySha256`、`runnerSha256`、`identitySha256`、`sourceVerifierSha256`、`comfyAttestorSha256` 分别钉住受控入口、运行器、配方身份代码、运行时清单核验器和 Comfy 进程内证明模块；它们与逐文件归档 SHA 重复交叉核验，供 Mac 与后续 Windows 明确接线。公共完整清单摘要仍以 `sourceManifestSha256` 为准。

受控 API 在启动、提交、GPU 前和交付前复核清单及本进程私有文件 generation；Comfy 同进程 loopback `POST /qs-h3/v1/source-attestation` 复核其实际已注册类来源、完整 Comfy 源清单、VHS JSON、所选 ffmpeg 可执行件与当前进程 token。公开身份不含本机盘符、路径、mtime；更换源码后须在空队列下重启并做新 self-test。清单排除 Comfy 的 Git 元数据及 `models/input/output/temp/user` 数据目录；固定图 class 来源若落在这些目录或额外 custom-node root，证明闸应拒绝。模型字节身份另由配方/model 摘要核验。torch、SageAttention、CUDA 等原生二进制没有被 `.py` 清单证明，仍须通过依赖版本闸、设备预检与真实样片验收。

运行时 API 和 Comfy 均须使用 `python -B` 防止写入新 `.pyc`；`-B` 本身不会禁止读取已有字节码，因此启动前完整源码清单另拒绝 `.pyc/.pyo`。Comfy 的私有清单路径指向 API 装配器写入的同一 `canonical-manifest.json`，两进程的清单原字节摘要必须一致。所选 ffmpeg 可执行件在两个进程分别按实际字节 SHA 核验，路径只留本机，不写入公共身份。

固定五秒交付编码使用 `libx264` CRF 14、视频 `-maxrate:v 16M` 与 `-bufsize:v 16M`、AAC 192k、120 帧/24 fps。VBV 参数用于控制高噪声素材的码率峰值，最终 MP4 仍以 **16 MiB（16 × 1024 × 1024 字节）**为硬上限；超出则交付失败并保留可诊断状态，不能把 GPU 图已完成当成成功出片回执。

## 非破坏核验

1. 在仓库根运行 `python -B windows-h3/tests/verify_package.py`、`python -B windows-h3/tests/test_runtime_source_identity.py` 和 `python -B windows-h3/tests/test_preflight_contract.py`。第一项核文件集合、SHA、敏感值迹象、Python 语法与 H3 导入关系，只把清单列出的源码复制到本任务 `work/` 新目录做隔离导入；后两项在独立合成目录验证运行时清单增删/链接/generation，以及本机 slot 与路径配置的拒绝。三者都**不按路径递归删除测试目录**。Windows 若无建 symlink 权限，动态 symlink 负控明确记未测。
2. 在另一个明确指定的**全新**目录运行 `python -B windows-h3/comfy/assemble_comfy.py --output <new-source-root>`。可按脚本帮助使用四个 `--*-source` 指向已存在的公开 vendor Git clone。装配器要求精确提交、tree、许可、patch 与定制节点摘要；失败保留新目录供排查，不回滚/覆盖现役安装。然后运行 `python -B windows-h3/tests/verify_package.py --comfy-assembled <new-source-root>` 核完整 `.py` 与 VHS JSON 集合。
3. 一般新机使用下面的标准安装器；底层 `h3_api/assemble.py` 仍可单独用于源码检查。安装器逐字节复制第一方 API、装配四个固定 vendor tree、生成源码树外的私有配置与目录，并**预初始化**新的 `GPU_SLOT_FILE` state/lock，或只读验证现存共享 guard。它调用两个 Python 环境的完整分发包/来源预检、完整运行时源码清单和五个模型文件字节身份核验。多 GPU 环境须指定 `--gpu-index`。任何闸失败均不会启动服务或提交图。

API 与 Comfy 进程内证明模块的独立合成单元测试必须先把 `H3_CANONICAL_TEST_ROOT` 指向本任务 `work/` 下的**现存物理目录**，再用 `python -B -m unittest discover -s windows-h3/h3_api/tests -p test_*.py` 与 `python -B -m unittest discover -s windows-h3/comfy/tests -p test_*.py` 执行；两个测试组均只在该目录建唯一子目录并保留结果，不在测试结束后递归清理。API 测试还需把 `h3_api/` 加入仅该测试进程的 `PYTHONPATH`。此测试目录不入 Git。

## 标准 Windows 安装、配置、自检

从已核验的源码包在 PowerShell 执行 `python -I -B windows-h3/install_windows.py --help`。三个用户入口均强制 Python 的 `-I -B`，避免继承外部 `PYTHONPATH` 并防止写入字节码；运行时清除旧 H3 与 GPU/CUDA 选择环境变量，PATH 只含固定 ffmpeg、两套隔离 Python 与 Windows 系统目录，VideoHelperSuite 也被明确指向同一已核 ffmpeg，健康信息使用独立的 canonical instance。安装参数全部由命令行提供；无须逐机编辑 JSON、Python 或 workflow。**必须先**用 `python -I -B windows-h3/prepare_python_windows.py --help` 准备两套 venv：传入现存 **Windows x64 CPython 3.12.10** 的 `--base-python`、全新 `--root`，再二选一提供已备齐 128 个固定 wheel 的 `--wheelhouse` 或显式 `--download`。锁内含 `triton-windows`：SageAttention 的 wheel 元数据未声明这一实际导入依赖，单靠 `pip check` 会漏报；准备器还执行 SageAttention 导入、CUDA 13.0 与候选设备探测。准备器逐个核 URL/文件名/SHA256，再离线按 hash 将固定 profile 安装到新 API 与 Comfy venv，最后在准备根写私有 `prepare-receipt.json`。`install_windows.py` 只接受该同一准备根下的 `api/Scripts/python.exe` 和 `comfy/Scripts/python.exe`，要求回执与 wheelhouse、两个 venv 的文件集合及字节完全一致；手工同版本环境会被拒绝。不向现役 Python 安装包、不运行 H3 图。`--download` 含大型 PyTorch wheel，应预留带宽与磁盘。即使准备器通过，源码安装仍会重新检完整闭包和本机 GPU。

示例中所有尖括号均须替换为**本机绝对路径**；选择未占用的新端口，现役 8790/8188/8799 保持原状：

```powershell
python -I -B windows-h3/install_windows.py `
  --root <全新独立安装目录> `
  --api-python <隔离API_Python_3.12.10.exe> `
  --comfy-python <隔离Comfy_Python_3.12.10.exe> `
  --models-dir <现有模型类别目录> `
  --gpu-slot-file <同机共享GPU_slot_state_绝对路径> `
  --machine-label <本机标识> `
  --api-port <新API端口> --comfy-port <新Comfy端口> `
  --ffmpeg <已核版本ffmpeg.exe> `
  --git-exe <已核版本Git_for_Windows引擎git.exe>
```

已有 GPU slot 必须同时有普通 state 文件与非空 `.lock` 文件；unknown、损坏、缺半对或链接一律保持原样并拒绝。**仅全新设备**且两个文件均不存在时，可显式加 `--initialize-gpu-slot` 一次性创建空 state/lock。安装器拒绝已有安装目录、占用端口、链接或 junction 路径；`--git-exe` 必须指向固定 SHA/版本的 Git 引擎，运行时只通过其绝对路径执行来源核验，不将 Git 目录加入服务 PATH。四个 `--comfyui-source`、`--kjnodes-source`、`--layerstyle-source`、`--videohelpersuite-source` 可指向现存公开 Git clone，省略时只从锁定的公开 origin 获取。它不会写模型权重，而是递归搜索显式 `--models-dir` 内固定图五个**精确 loader 文件名**，拒绝缺失、同名重复、链接与硬链接，并在新 Comfy 根写本机私有 `extra_model_paths.yaml`，只登记这五个文件的物理父目录。静态自检还要求 API 配方解析器与 Comfy `folder_paths` 解析到相同的五个物理文件，再核原字节 SHA。该 YAML 在运行时被冻结，不能在服务运行中更改。

成功安装含 `source/api`、`source/comfy`、`control` 与 `private` 四部分。私有目录保存配置、输入输出、jobs/workflow、日志和模型文件 SHA 回执，不属于源码交接包；准备目录及其 `prepare-receipt.json` 也须保留在仓库外，启动配置只存其私有绝对路径与回执原字节 SHA。安装器复制的 `control/launch_windows.py` 可在新目录独立执行：

```powershell
<隔离API_Python_3.12.10.exe> -I -B <新安装目录>/control/launch_windows.py check
<隔离API_Python_3.12.10.exe> -I -B <新安装目录>/control/launch_windows.py start-comfy
# 另一个终端，确认新 Comfy 的队列与实际进程后：
<隔离API_Python_3.12.10.exe> -I -B <新安装目录>/control/launch_windows.py start-api
```

`check` 在启动前重验私有准备回执原字节、128 个 wheel 与两 venv 全部普通文件的精确集合/字节，并复核依赖闭包、来源、vendor Git commit/tree、完整 Python/JSON 源清单、所选 ffmpeg、GPU 静态能力和五个模型候选文件；它不生成视频。当前机一轮准备目录全量 SHA 测量包含 128 wheel、API 1,370 文件、Comfy 45,335 文件，耗时约 351 秒，实际新机耗时依磁盘与扫描环境变化。`start-comfy` 在前台以 `-B`、`--cache-none`、独立输入输出目录及 loopback 新端口启动；`start-api` 在前台启动 canonical 受控入口，其进程内闸进一步核实际监听 PID、Comfy 命令行、17 个类的注册来源、五个 loader 的本次加载及 MP4 回执。两个启动命令不进行系统服务注册、平台启用、旧进程重启或自动重跑任务。启动前仍须核现役队列、安全更新与共享 GPU guard；真实五秒样片必须另行经受控 API 明确提交，且其回执不能由静态检查代替。

Windows venv 的监听进程 `exe/argv[0]` 可为基础 Python，而进程内 `sys.executable/sys.prefix` 是准备好的 Comfy venv。canonical API 分别核已准备的 venv 文件/私有回执与基础 Python 物理身份，Comfy 同进程 attestor 返回其私有解释器身份摘要；两端必须一致。固定图 17 类中有 6 类 Comfy V3，类自己的 `execute` 与清单固定的框架 `EXECUTE_NORMALIZED` wrapper 分别验源；其他 11 类仍要求执行方法与类同文件。全部 17 类还将实际执行的代码对象与固定源码中本类方法做精确匹配，并拒绝 `__wrapped__` 隐藏包装、伪造同源文件名方法及 V3 FUNCTION 翻转。精确字段和摘要算法见 [机主运行态接口](h3_api/OWNER-RUNTIME-INTERFACE.md)。

准备回执记录的是受控离线 pip 安装完成后测得的实际文件字节，并使后续安装/启动发现增删或变化；它不能独立证明 pip 对 wheel 的每一步展开，也不能防拥有准备目录与私有配置写权限的本机攻击者同时伪造文件和回执。官方 CPython 安装介质、Git 的相邻 DLL/辅助程序及驱动包也未由此回执覆盖。Comfy 的进程 token 是公开 loopback 来源证明中的新鲜度字段，入队闸用于证明同一固定 Comfy 进程当时仍通过源码/类/ffmpeg 核验，并非阻止本机其他客户端直接调用 `/prompt` 的鉴权凭据。

安装失败会在新目录 `private/install-state.json` 标明需检查状态，并保留 `private/install.log` 及部分源码供诊断；不会递归删除、覆盖或自动恢复旧目录。重试请检查失败原因后选**另一个全新目录**。回退只需停止新前台进程，旧服务和旧安装从未被切换；不要在共享 GPU slot 为 unknown 或运行中时清空它。路径调整也通过另一个全新安装目录完成，保持源码和旧安装可复查。固定工作流由受控入口注入，旧 `local_h3` 直接入口仍拒绝。静态自检通过之后，新设备还必须完成实际受控 self-test、平台验包/安全闸、双样签名及当前设备证明，不能沿用 V1/V2 的回执。

并发安全边界仍有明确未证项：GPU slot 使用全局具名互斥、已持有的父目录/叶文件物理句柄并拒绝 reparse/hardlink，但祖先普通目录若恰在预检与绝对路径 `CreateFileW` 之间被替换，尚未用 `NtCreateFile RootDirectory` 相对打开证明状态叶绑定。隔离的父 junction 换接负控通过，不代表所有祖先目录竞态均已根治；动态 leaf symlink 创建在当前 Windows 权限下返回 1314，按未测记录。
