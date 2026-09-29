# Canonical H3 机主运行态见证接口

适用范围：受控 `qs_new4/E_light4_sage`、固定 5 秒的 canonical API。接口只允许本机 loopback 调用，带 `Origin` 的请求拒绝。旧 V1/V2 身份合同保持独立；此处 `expected` 仍恰为 `executionRecipeSha256` 与 `modelSha256` 两项。

## 查询

`GET /v1/owner-runtime/identity`，无需 query。成功为 HTTP 200，`Cache-Control: no-store`。摘要字段均为小写 64 位 SHA256；`schemaVersion` 为 `qs.h3.owner-runtime-identity.v1`，`queueAdmissionGuardVersion` 必为整数 `1`：

```json
{
  "schemaVersion": "qs.h3.owner-runtime-identity.v1",
  "ownerConfigDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "apiProcessWitnessSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "comfyProcessWitnessSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "queueAdmissionGuardVersion": 1,
  "sourceManifestSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "classOriginSha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "comfyFfmpegSha256": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  "deliveryFfmpegSha256": "1111111111111111111111111111111111111111111111111111111111111111",
  "ownerRuntimeWitnessSha256": "2222222222222222222222222222222222222222222222222222222222222222"
}
```

以上摘要均为格式占位值，彼此无数学关系。服务不回显私有配置字节、设备路径、PID、启动 nonce、原始 Comfy token 或文件时间戳。启动时必须从显式的 `H3_CANONICAL_CONFIG_PATH` 读取同一独立安装的 `private/config.json`；API 对照其安装根、实际编码器、输入输出根、GPU 槽、监听端口、设备标签、源码清单和模型路径配置摘要。缺失或不符即拒绝启动。配置、模型路径 YAML 的字节与文件身份在运行期冻结；改变后需空队列重启并重新自检。运行态不可验证时查询为 503 `H3_OWNER_RUNTIME_UNAVAILABLE`。

## 摘要算法

`canon(x) = json.dumps(x, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')`；`H(x) = SHA256(canon(x)).hexdigest()`。以下字段名、大小写与 schema 字符串均固定：

```text
configSha = SHA256(config.json 原始字节)
modelPathsSha = SHA256(extra_model_paths.yaml 原始字节)
ownerConfigDigest = H({
  "schemaVersion":"qs.h3.owner-config.v1",
  "installConfigSha256":configSha,
  "modelPathConfigSha256":modelPathsSha
})

apiProcessWitnessSha256 = H({
  "schemaVersion":"qs.h3.api-process.v1",
  "bootNonce":进程启动时新建的 32 字节随机数小写 hex,
  "pid":实际 API PID,
  "bootNs":实际 API 进程创建时间的纳秒整数
})

comfyProcessWitnessSha256 = H({
  "schemaVersion":"qs.h3.comfy-process.v1",
  "attestorProcessToken":Comfy 进程内 attestor 原始 token,
  "runtimeProcessToken":API 按实际 Comfy 监听进程计算的私有 token,
  "pythonRuntimeSha256":Comfy 同进程解释器私有身份摘要,
  "queueAdmissionGuardVersion":1
})

ownerRuntimeWitnessSha256 = H(GET 响应对象中除 ownerRuntimeWitnessSha256 外的全部字段)
```

`sourceManifestSha256` 是安装清单的原始 UTF-8 字节 SHA；`classOriginSha256` 来自 Comfy 同进程已注册图节点的完整来源见证；两个 ffmpeg 摘要均为实际选中可执行文件的内容 SHA。公开配方身份仍按原 canonical 算法计算；机主配置及进程见证只进入上述私有运行态绑定。

API 在任务期间持有本机交付 ffmpeg 的只读句柄；Comfy attestor 对自身所选 ffmpeg 使用兼容的只读共享句柄核物理路径、原字节 SHA 和启动文件代。两进程可同时核同一编码器，写入、替换及代变化仍拒绝；不能以排他打开导致正常同机双读被误报为 409。

### Comfy Python 与已加载类来源

Windows 虚拟环境允许两个不同的可执行文件身份同时成立：进程内 `sys.executable` 是准备好的 `comfy/Scripts/python.exe`，`sys.prefix` 是该 venv 根，而操作系统监听进程的 `exe` 与 `argv[0]` 可指向 `pyvenv.cfg` 的 `executable` 基础 Python。API 从已冻结的私有准备回执核 venv `python.exe` 与 `pyvenv.cfg` 的原字节 SHA/大小，再冻结配置指定的基础 Python 文件；它要求监听 PID 的 `exe`、`argv[0]` 与基础 Python 为同一物理文件且 generation 未变。Comfy 进程内 attestor 在启动和每次来源核验时，用受控物理句柄核自己的 `sys.executable`、`sys.prefix`、`sys._base_executable` 与 `pyvenv.cfg`。两边分别计算相同的私有 `pythonRuntimeSha256`：

```text
pythonRuntimeSha256 = H({
  "schemaVersion":"qs.h3.python-runtime.v1",
  "sysPrefix":normcase(realpath(venv 根)),
  "sysExecutable":{"path":normcase(realpath(venv python.exe)),
                   "generation":[st_dev,st_ino,st_size,st_mtime_ns],"sha256":原字节 SHA},
  "pyvenvCfg":{"path":normcase(realpath(pyvenv.cfg)),
               "generation":[st_dev,st_ino,st_size,st_mtime_ns],"sha256":原字节 SHA},
  "baseExecutable":{"path":normcase(realpath(基础 python.exe)),
                    "generation":[st_dev,st_ino,st_size,st_mtime_ns],"sha256":原字节 SHA}
})
```

上述包含路径的对象仅在两进程内构造；loopback Comfy attestation 只返回 `pythonRuntimeSha256`，机主 GET 仅返回含该摘要的 `comfyProcessWitnessSha256`，不返回路径、原始配置、PID 或解释器命令行。Comfy 进程重启、venv/基础 Python/配置变化都会使旧作业见证失效。绝不能把监听进程的基础 Python 错认作 venv `sys.executable`，也不能只用相同字节认同另一个 venv。

Comfy attestation 的 `classOrigins` 每项精确包含 `classType,moduleName,classQualname,moduleRelativePath,sourceOrigin,sourceRawSha256,sourceSize,methodRelativePath,methodSourceRawSha256,methodSourceSize`。方法路径为安装根相对路径，不含私有安装盘符。固定图的 `BasicGuider`、`ImageFromBatch`、`MiniMaxH3ImageToVideo`、`RandomNoise`、`SamplerCustomAdvanced`、`VAEDecodeAudio` 属 Comfy V3：它们必须以 `FUNCTION=EXECUTE_NORMALIZED` 走清单固定的 `comfy_api/latest/_io.py` 框架方法，且自己的 `execute` 必须是本类源文件定义的 `classmethod`。其余 11 个 V1 节点有固定的 `FUNCTION` 方法名，方法必须由本类源文件定义。两类均按源码原字节和启动 generation 复核，并对**实际执行的函数代码对象**与固定源码中对应类作用域的编译结果做精确匹配；不沿 `__wrapped__` 跳到另一函数。进程内冻结类、descriptor、函数代码与源文件 generation。`classOriginSha256 = SHA256(canon(按 classType 排序的完整 classOrigins 数组))`；非清单来源、替换 wrapper、伪造同文件名代码、V3 的 FUNCTION 翻转或 V1 借用框架 wrapper 均拒绝。

## 投稿与阶段复核

调用方先取 GET 返回的 `ownerRuntimeWitnessSha256`，然后在 `POST /v1/jobs` 顶层附同名字段，值必须为小写 64 位 SHA。原始 JSON 的 `seconds` 必须是整数 `5`，浮点 `5.0` 和其他时长在 Pydantic 转换前拒绝；`expected` 仍只含原两项。API 在锁内复核当前见证，失配返回 HTTP 409 `H3_OWNER_RUNTIME_WITNESS_MISMATCH`；字段缺失或格式错返回 HTTP 400 `H3_OWNER_RUNTIME_WITNESS_REQUIRED`；运行态失效返回 503。通过原始整数检查后，网关产生的内部浮点 `5.0` 才受证明地恢复为整数 `5` 进入固定任务创建。

任务私有收据保存入队见证；构图前、真正提交 Comfy `/prompt` 前、渲染后和最终交付前均重核同一摘要。完成的 `recipe_identity.ownerRuntimeWitnessSha256` 与 `recipe_identity.actual.ownerRuntimeWitnessSha256` 应一致。

API 向**独立 canonical Comfy** 的 `/prompt` 请求顶层传 `qs_h3_expected_process_token`，值为仅本机内部使用的原始 attestor 进程 token，绝不进入公开 GET 或任务状态。canonical Comfy 的同步 guard 在 `prompt_queue.put` 紧前核当前进程 token 与源码/节点/编码器身份；检查到入队之间没有异步等待。Comfy 重启后旧请求的 token 必失配，缺失、失配或 guard 不可用时返回 HTTP 409，JSON `error.type="qs_h3_source_identity_changed"`，不入队。API 将此映射为 `H3_COMFY_PROCESS_IDENTITY_CHANGED`，任务不得获得 Comfy prompt 回执。旧服务不支持此字段，不能作为 canonical 测试节点。
