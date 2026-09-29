# Windows H3 canonical 软件来源清单

此清单只适用 `qs_new4/E_light4_sage`、`qs.h3.canonical.qs_new4.vnext`，供独立 Windows 安装目录核源。公开包不包含模型权重、媒体、本机路径、私有配置或凭据。实际进程加载来源由 Comfy 进程内 attestation 和 API 清单闸另行核验；这里的下载源记录本身不是运行验收。

| 软件 | 固定身份 | 来源与核验 |
| --- | --- | --- |
| 本项目 H3 API、采样节点、source attestor | `manifest.json` 原始字节及每文件 SHA256 | 仓库 `windows-h3`；API/Comfy 装配后须匹配全源清单。第一方 API/attestor 为 Apache-2.0，采样节点保留 GPL-3.0-or-later；见 [NOTICE.md](NOTICE.md)。 |
| ComfyUI、KJNodes、LayerStyle、VideoHelperSuite | 四个完整公开 Git commit/tree 和本地 patch SHA256 | `comfy/vendor-lock.json` 列出精确 GitHub origin、版本与许可证；装配器仅检出钉住的提交。 |
| CPython | `3.12.10`，Windows x64 | [Python 3.12.10 官方发布页](https://www.python.org/downloads/release/python-31210/)；API 与 Comfy 使用相互隔离的候选解释器，预检核完整三段版本。此包不携带 Python 二进制。 |
| Python API 包 | 7 个直接根、16 个本机元数据依赖闭包 | `dependencies.lock.json` 的 `api`/`apiResolved`；`python-wheels.lock.json` 钉住对应公开 wheel URL、文件名和 SHA256。 |
| Python Comfy 包 | 49 个直接根、116 个运行闭包包（含实测动态 Triton import） | `dependencies.lock.json` 的 `comfyAndVendor`/`runtimeImportRequirements`/`comfyResolved`；wheel 锁含 124 个 [PyPI](https://pypi.org/) 候选、3 个 [PyTorch CUDA 13.0 索引](https://download.pytorch.org/whl/cu130/)候选与 1 个 SageAttention 候选，API/Comfy 合计 128 种 `name==version` wheel。 |
| 隔离安装回执 | 准备器输出的仓库外私有 `prepare-receipt.json` | `prepared_env_receipt.py` 绑定两锁原字节、128 个 wheel 的完整文件集合/大小/SHA256、两 venv 的目录和全部普通文件集合/大小/SHA256、解释器物理路径；安装器与每次启动前重验。它记录可信准备流程观察到的安装结果，不独立证明 pip 展开算法，也不能防本机有私有目录写权限者同时伪造回执与配置。 |
| SageAttention Windows wheel | `2.2.0+cu130torch2.9.0andhigher.post4`，`cp39-abi3-win_amd64` | [woct0rdho/SageAttention v2.2.0-windows.post4](https://github.com/woct0rdho/SageAttention/releases/tag/v2.2.0-windows.post4) 的精确资产 URL 和 SHA256，取自现有分发包 `direct_url.json` 并钉在 wheel 锁中。它是 Windows 构建 fork，不可仅凭上游项目名替代其二进制来源。 |
| Triton Windows wheel | `triton-windows==3.5.1.post24`，`cp312-cp312-win_amd64`；SHA256 `2aef99d060f0345244494c682e97b389f7198c42247a4d493abc314dcc7129cb` | [PyPI 固定版文件](https://pypi.org/project/triton-windows/3.5.1.post24/)；现役 embedded 环境同版的 `triton.__version__` 为 `3.5.1`，SageAttention 可导入。最初 127 wheel 的全新 venv 虽通过 `pip check`，SageAttention 导入却因缺 `triton` 失败，故加入这个未被 Requires-Dist 声明的运行依赖。 |
| Git for Windows | `2.54.0.windows.1`；本机 Git engine `git.exe` SHA256 `cab4c4eea1d869cf9f7be73868dc9a90ad2df1b1b673e5f8c8714a576c25ea96` | [官方固定版本发布页](https://github.com/git-for-windows/git/releases/tag/v2.54.0.windows.1)列 x64 安装包 SHA256 `2b96e7854f0520f0f6b709c21041d9801b1be44d5e1a0d9fa621b2fbc40f1983`。已安装 engine 的版本、原字节和 Authenticode 状态已在本机测量，但原安装包字节未保留，故不能声称已独立证明安装包到 engine 的链路。该 engine 在官方安装中与 `git-upload-pack.exe`、`git-receive-pack.exe`、`git-upload-archive.exe` 共用四个硬链接；安装器及预检仅对 Git 特许并核这四个名称的同一文件身份，每次来源查询前后复核 SHA 和文件身份。私有绝对路径被固定，Git 不加入服务 PATH。 |
| ffmpeg | `n8.1-10-g7f5c90f77e-20260424`；现机 `ffmpeg.exe` SHA256 `6754c303ec0d7d9f7b5ecde92b91984b0ddd1e4a1e390bff86ae4786d4f330cb` | 安装目录名称符合 [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases/) 的 8.1 Windows GPL 静态资产；未找到原下载归档来独立核对来源。候选机必须提供相同字节并由预检核 SHA256；Comfy attestation 另核 VHS 实际选中的可执行件。 |
| NVIDIA 驱动 / CUDA | 现机 `nvidia-smi` 610.88，CUDA UMD 13.3；PyTorch runtime CUDA 13.0 | 驱动由 Windows 系统提供，现机 `nvidia-smi.exe` 的 Authenticode 签名有效，签名主体为 Microsoft Windows Hardware Compatibility Publisher。驱动安装包来源和字节未归档；候选机须通过 CUDA/设备预检及真实 GPU 样片。 |

`python-wheels.lock.json` 的 124 个 PyPI 候选 SHA 来自各固定版的官方 PyPI release JSON；3 个 PyTorch 候选 SHA 来自官方 CUDA 13.0 simple index；SageAttention SHA 来自已安装 wheel 的 PEP 610 `direct_url.json`。最初 127 种 wheel 的新 venv 通过离线安装和 `pip check`，但实际 SageAttention 导入缺 Triton。加入 Triton 后，128 种 wheel 已在新隔离目录下载并逐文件核 SHA，API/Comfy 两个 venv 离线安装与 `pip check` 通过，SageAttention、Triton 导入及 CUDA 可用性静态候选检查通过；这些步骤尚非 GPU 图或 MP4 回执。现机 Comfy 中有 62 个带 `direct_url.json` 的 PyPI wheel 摘要与对应候选完全一致，其余普通索引安装未记录原 wheel 下载地址；预检会拒绝带 `direct_url.json` 而 SHA 不符的候选安装。

Comfy 上游 custom node 的 `requirements.txt` 同时列 `opencv-python`、`opencv-python-headless` 和 `opencv-contrib-python`，实际固定环境由 `opencv-contrib-python==4.10.0.84` 提供 `cv2`。这属于有意的 provider 替代，不可把三个分发包一起无条件安装。元数据闭包不覆盖未声明的动态 import、可选 extra、GPU 架构差异或本机模型文件；必须完成 17 类实际注册来源核验、五个模型 loader、固定图和 MP4 的本机自测。旧 V1/V2 回执不能用于 canonical 验收。
