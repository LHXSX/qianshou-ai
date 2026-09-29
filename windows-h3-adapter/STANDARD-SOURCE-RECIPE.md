# 标准 H3 软件配方源码闭包

本清单记录 2026-09-27 的源码分发边界，供一次性归集受支持的软件配方使用。当前 `Install-Windows-H3Adapter.ps1` 是已有固定 H3 API 的升级器；完整新机 bootstrap 尚未实现。本清单、单个源码 fixture 或 V2 身份验证用例通过，都不能证明普通新 Windows 已能直接安装、通过双样单或接单出片。

## 当前已知边界

安装器要求已有 `ApiRoot/workbench`、`ApiRoot/local_h3`，校验七个基线文件的固定摘要后才应用补丁。仓库目前提供增量补丁、两个 V1 身份模块及新的 V2 身份模块，没有完整 H3 API 源码包。

当前固定配方是 `graphs.SPECS["E_light4_sage"]` 构造的 `qs_new4`：四步、五秒、固定首帧 PNG 和受约束的输入。相同代码和五个实际模型可以在不同本机路径运行；V2 将路径事实放入私有配置摘要。任意 H3 workflow、另一图构造器、另一 Comfy 版本或不同模型不因此获得相同配方身份。

## 请 Windows 一次性归集的 canonical 源码

先归集运行软件源码，不收集权重、用户配置或产物。只从当前已确认的软件安装读取，不更新现役服务、不运行 GPU，不通过重建旧回执来证明新包有效。

1. **H3 API 完整包**：
   - `workbench/workbench_node.py`：当前受支持已安装 V1 的完整固定源码，作为增量 V2 补丁基线。
   - `workbench/graphs.py`：实际 `SPECS` 和 `build()` 图构造器。
   - `workbench/runner.py`：启动入口实际导入的 `idle`、`request`、`verify_sources` 所在模块。
   - `local_h3/app.py`、`comfy.py`、`jobs.py`、`schemas.py`、`workflows.py`。
   - 上述文件实际需要的包初始化、其他本包模块、固定资源及静态工作流定义；依据真实 import、动态 import、子进程入口和文件读取依赖补齐，不以这八个路径代替完整闭包。
2. **受支持 Comfy 核心源码及版本**：
   - `main.py`、`folder_paths.py`、`execution.py`。
   - `comfy_execution/caching.py`、`comfy/cli_args.py`。
   - 记录实际仓库版本与必要运行模块闭包；这些文件是当前身份输入的一部分，普通最新 Comfy 安装不能直接视作兼容。
3. **实际启用的定制节点包**：
   - `custom_nodes/h3_benchmark_sampler/{__init__.py,sampling.py,core.py}` 及其真实本包依赖。
   - `comfy_extras/nodes_minimax_h3.py` 及真实运行依赖。
   - `custom_nodes/ComfyUI-KJNodes/nodes/model_optimization_nodes.py` 所在的受支持完整包与版本。
   - 图中其他实际节点（包含视频输出节点）的实现包、版本、必要资源和许可证；不能只复制一个节点文件并假定其包初始化或依赖自然存在。
4. **运行环境的可复现说明**：实际 Python 版本、依赖锁、软件来源版本及许可证。只记录分发所需依赖，不导出用户环境变量、账号状态或整个个人虚拟环境。

现有 V1 的 19 个代码角色、V2 的 20 个代码角色是明确测量的身份输入，不能据此声称全部传递依赖已经归集和锁定。完整归集后，应统一确认执行模块的安装清单、启动快照和配方身份覆盖，而不是在每台电脑忽略不同的缺项。

## 固定字节与 provenance

每个归集文件记录相对路径、来源版本、原始字节 SHA256、仅将 CRLF 转为 LF 后的 SHA256、字节数和许可证。拒绝孤立回车；源码归集不进行其他静默替换。

当前已安装 V1 `workbench_node.py` 的预期 **LF 规范化摘要**为：

```text
0650d18bc9060efda379185944ef6841a0dcae5ce0ed3cec24076fefd512a2f2
```

原始 Windows 字节和规范化 fixture 分别记录，不能把它们称作同一原始摘要。该 fixture 用于补丁应用、编译和路由负控；它不独自构成可安装的 API 包。V1 原有摘要算法和回执不得改成隐式 V2。

新增 `recipe_identity_v2.py` 的 Git 属性为 `text eol=lf`。其他软件代码仍按受支持的固定字节版本处理，不为了让两台机摘要相同而改写现役源码或旧证明。

## 安全排除清单

不要归集或提交：

- 模型、权重、模型缓存及模型二进制；只归集软件实现和必要版本说明。
- `extra_model_paths.yaml`、机主配置、绝对本机路径及盘符映射；必要时只提供 YAML 字段名称用于兼容性审查。
- 首帧图片、上传文件、用户 workflow、提示词、视频、作业目录、Comfy 输入输出目录和用户项目。
- 私钥、访问令牌、Cookie、凭据、`.env`、账户数据库、授权配置。
- 旧自检收据、样单 nonce、设备证明、presence、任务租约、计费记录或其他设备的登记状态。
- 日志、缓存、`__pycache__`、`.pyc`、个人环境和无关目录。

提交前检查源码是否意外内嵌凭据或私有路径。存在此类内容时先报告该文件，不能将未审字节提交，也不能静默脱敏后仍沿用旧源码摘要或配方身份。

## 一次标准分发的最窄后续方案

将审过的 canonical API、定制节点、固定版本说明和依赖锁组成一个标准源码包，并附完整相对路径/SHA256 清单。新机安装应在可信独立目录排他落盘，核验闭包后再由普通产品流程填写本机配置、预检和执行新的本人自检。升级器继续保留固定原始/目标摘要、CAS 写入和冲突拒绝。

本机自检通过、平台双样单通过、投稿批准、当前连接确认和机主接单授权仍分别成立。不能复制其他电脑的旧证明，也不能把软件源码安装完成写成已可接单。完整 bootstrap 与真实新机验收完成前，分发能力仍属于待完成范围。

## 显式 V2 增量候选

`workbench_node.v2.patch` 基于上面的完整已安装 V1 fixture 生成，`adapter-v2.manifest.json` 记录其原始/目标摘要和新增模块。它增加独立的 `/v2/recipes/qs_new4/identity`、`POST /v2/jobs`、`GET /v2/jobs/{id}`，使用明确的 V2 schema；旧 V1 请求和证明不会被升级为 V2。修改后的适配器源码本身形成新的源码身份，不能沿用修改前的旧配方收据。

此候选的路由和身份负控使用实际补丁、实际生产验证函数及合成 Comfy/存储端口测试，没有执行 GPU 或真实 Windows 安装。实际 Windows 的 YAML 字段兼容性尚待盘点。manifest 是后续独立 V2 升级器的受审输入，不表示当前 V1 安装器已经会安装 V2，也不允许绕过私有 stage、最终 CAS 和来源冲突检查。

维护回归可在具备 FastAPI、httpx、psutil、PyYAML 的独立 QA Python 中执行 `python -I -B tests/test_adapter_v2.py -v`；它在临时目录真正检查并应用补丁，原始 V1 fixture 保持不变。
