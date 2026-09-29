#!/usr/bin/env python3
"""onnx_infer — ONNX 模型推理 (企业级 · 2026-06-07 S5 升级)

新增:
  - **SSRF + 安全下载**:model_url 域名白名单 + 私网 IP 拦截
  - **SHA256 校验**:可选 model_sha256 防中间人篡改
  - **模型缓存**:同 URL 复用磁盘缓存(/tmp/onnx_cache · 按 sha 命名)
  - **GPU 自动检测**:CUDA/CoreML/DirectML provider 自动选
  - **批量推理**:inputs 可为 [{},{}] · 一次跑多 sample
  - **动态 shape 支持**:输入 shape 从数据推断
  - **timing 细分**:download / load / infer 三段
  - 仅受信公网模型 URL；本地路径由受信执行器处理，不接受普通任务参数

参数 (stdin JSON 或 EC_PARAMS):
  model_url        str   模型 URL (https) / file:// / 本地路径
  model_sha256     str   可选完整性校验
  inputs           dict|list  {input_name: data} 或 [batch...]
  providers        list  指定 ['CUDAExecutionProvider','CPUExecutionProvider']
"""
import hashlib
import ipaddress
import json
import os
import socket
import sys
import tempfile
import time
import urllib.parse
import urllib.request


_ALLOWED_MODEL_HOSTS = {
    "github.com", "raw.githubusercontent.com",
    "huggingface.co", "cdn-lfs.huggingface.co",
    "modelscope.cn", "modelscope.oss-cn-beijing.aliyuncs.com",
    "www.qianshousuanli.com", "oss.qianshousuanli.com",
    "qianshou-models.oss-cn-shanghai.aliyuncs.com",  # 平台自有
}


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {}


def _is_private_ip(host: str) -> bool:
    try:
        for fam, _, _, _, sock in socket.getaddrinfo(host, None):
            ip = sock[0]
            try:
                ip_obj = ipaddress.ip_address(ip)
                if (ip_obj.is_private or ip_obj.is_loopback
                        or ip_obj.is_link_local or ip_obj.is_multicast):
                    return True
            except ValueError:
                continue
    except socket.gaierror:
        # DNS 失败不是私网；交给后续下载报清晰错误，避免误报 SSRF
        return False
    return False


def _check_model_url(url: str, trust_local: bool = False) -> tuple[str, str]:
    """验证受信公网模型 URL；脚本不接受用户提供的本地路径权限。"""
    if url.startswith("file://"):
        raise ValueError("任务脚本不允许 file:// 本地模型路径")
    if url.startswith("/") or (len(url) > 1 and url[1] == ":"):
        raise ValueError("任务脚本不允许本地路径模型")
    parts = urllib.parse.urlparse(url)
    if parts.scheme not in ("http", "https"):
        raise ValueError(f"不支持的 scheme: {parts.scheme}")
    host = (parts.hostname or "").lower()
    if not host:
        raise ValueError("URL 无 hostname")
    if host not in _ALLOWED_MODEL_HOSTS:
        if not any(host.endswith("." + h) for h in _ALLOWED_MODEL_HOSTS):
            raise ValueError(f"模型域名 {host} 不在白名单(支持 GitHub/HF/ModelScope/平台 OSS)")
    # 域名白名单不能替代解析后的地址校验：DNS 劫持或重绑定仍可能把
    # 受信域名导向内网服务。下载层也会复核重定向目标。
    if _is_private_ip(host):
        raise ValueError(f"模型地址疑似 SSRF（解析到私网地址）: {host}")
    return "remote", url


def _download_with_cache(url: str, expected_sha: str, cache_dir: str) -> tuple:
    """返 (path, downloaded_bool, sha256)"""
    os.makedirs(cache_dir, exist_ok=True)
    # 缓存键 = url 的 sha
    cache_key = hashlib.sha256(url.encode()).hexdigest()[:16]
    cached_path = os.path.join(cache_dir, f"{cache_key}.onnx")
    if os.path.isfile(cached_path) and os.path.getsize(cached_path) > 100:
        # 校验 sha
        with open(cached_path, "rb") as fh:
            actual_sha = hashlib.sha256(fh.read()).hexdigest()
        if not expected_sha or actual_sha == expected_sha.lower():
            return cached_path, False, actual_sha
        os.remove(cached_path)  # sha 不一致 · 重下

    # 下载到临时位 · 完成后原子改名
    tmp_path = cached_path + ".tmp"
    sha = hashlib.sha256()
    try:
        from _script_safety import open_public_url
        resp, _checked_url = open_public_url(url, timeout_s=30)
        with resp:
            with open(tmp_path, "wb") as fh:
                total = 0
                max_model_bytes = 2 * 1024 * 1024 * 1024
                while True:
                    chunk = resp.read(64 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_model_bytes:
                        raise ValueError("ONNX 模型超过 2GiB 上限")
                    sha.update(chunk)
                    fh.write(chunk)
        actual_sha = sha.hexdigest()
        if expected_sha and actual_sha != expected_sha.lower():
            os.remove(tmp_path)
            raise ValueError(f"SHA256 不匹配 · 期望 {expected_sha[:16]}... 实际 {actual_sha[:16]}...")
        os.rename(tmp_path, cached_path)
        return cached_path, True, actual_sha
    except Exception:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise


def _coerce_input(value, expected_shape: list, np_module):
    """把 list/嵌套 list 转 numpy · 自动推断或对齐 shape"""
    np = np_module
    arr = np.array(value, dtype=np.float32)
    # 对齐 expected_shape · 解决 dynamic batch
    if expected_shape:
        target = []
        for i, dim in enumerate(expected_shape):
            if dim is None or (isinstance(dim, str)):
                # 动态维度 · 用实际值
                target.append(arr.shape[i] if i < arr.ndim else 1)
            else:
                target.append(int(dim))
        try:
            arr = arr.reshape(target)
        except Exception:
            pass  # 留原 shape · onnxruntime 会报具体错
    return arr


def main():
    t0 = time.time()
    timing: dict = {}
    try:
        try:
            import onnxruntime as ort
        except ImportError:
            print(json.dumps({
                "status": "failed", "task_type": "onnx_infer",
                "error": "节点缺 onnxruntime",
                "summary_text": "❌ pip install onnxruntime (CPU) 或 onnxruntime-gpu",
            }, ensure_ascii=False))
            return 1
        try:
            import numpy as np
        except ImportError:
            print(json.dumps({
                "status": "failed", "task_type": "onnx_infer",
                "error": "节点缺 numpy",
            }, ensure_ascii=False))
            return 1

        p = _params()
        raw = sys.stdin.read()
        stdin_obj: dict = {}
        if raw.lstrip().startswith(("{", "[")):
            try:
                stdin_obj = json.loads(raw) or {}
                merged = dict(stdin_obj.get("params") or {})
                merged.update(p)
                p = merged
            except Exception:
                stdin_obj = {}

        model_url = (p.get("model_url") or stdin_obj.get("model_url") or "").strip()
        if not model_url:
            raise ValueError("缺 model_url")

        inputs = p.get("inputs") or stdin_obj.get("inputs")
        if inputs is None:
            raise ValueError("缺 inputs")

        expected_sha = (p.get("model_sha256") or "").lower()
        cache_dir = os.path.join(tempfile.gettempdir(), "edgecompute_onnx_cache")

        # 安全校验
        t_d0 = time.time()
        _kind, target = _check_model_url(model_url)
        model_path, downloaded, sha = _download_with_cache(target, expected_sha, cache_dir)
        timing["download_ms"] = int((time.time() - t_d0) * 1000)

        # provider 自动选
        t_l0 = time.time()
        all_providers = list(ort.get_available_providers())
        requested = p.get("providers")
        if requested and isinstance(requested, list):
            providers = [pr for pr in requested if pr in all_providers] or all_providers
        else:
            # 优先级:CUDA > CoreML > DirectML > CPU
            preferred = ["CUDAExecutionProvider", "CoreMLExecutionProvider",
                         "DmlExecutionProvider", "CPUExecutionProvider"]
            providers = [pr for pr in preferred if pr in all_providers] or all_providers

        sess = ort.InferenceSession(model_path, providers=providers)
        timing["load_ms"] = int((time.time() - t_l0) * 1000)

        # 输入装配
        feed = {}
        input_meta = []
        for inp in sess.get_inputs():
            input_meta.append({"name": inp.name, "shape": inp.shape, "type": inp.type})
            if isinstance(inputs, dict):
                v = inputs.get(inp.name)
                if v is None:
                    raise ValueError(f"缺输入 {inp.name}")
            elif isinstance(inputs, list):
                # 单输入模型 · 直接传 list
                if len(sess.get_inputs()) != 1:
                    raise ValueError("多输入模型 · inputs 必须是 dict")
                v = inputs
            else:
                raise ValueError("inputs 必须是 dict 或 list")
            feed[inp.name] = _coerce_input(v, inp.shape, np)

        # 推理
        t_i0 = time.time()
        outputs = sess.run(None, feed)
        timing["infer_ms"] = int((time.time() - t_i0) * 1000)

        # 结果序列化
        result = {}
        output_meta = []
        for i, o in enumerate(sess.get_outputs()):
            arr = outputs[i]
            output_meta.append({
                "name": o.name, "shape": list(arr.shape), "dtype": str(arr.dtype),
            })
            # 大输出截断到前 1000 元素 · 元数据保留 shape
            flat = arr.flatten()
            if flat.size > 1000:
                result[o.name] = {
                    "preview": flat[:1000].tolist(),
                    "shape": list(arr.shape),
                    "truncated": True,
                    "total_elements": int(flat.size),
                }
            else:
                result[o.name] = arr.tolist()

        elapsed = int((time.time() - t0) * 1000)
        active_provider = sess.get_providers()[0] if sess.get_providers() else "unknown"

        print(json.dumps({
            "status": "ok", "schema_version": "v1", "task_type": "onnx_infer",
            "elapsed_ms": elapsed,
            "summary": {
                "model_url": model_url,
                "model_sha256": sha,
                "model_downloaded": downloaded,
                "model_cached": not downloaded and kind == "remote",
                "providers_available": all_providers,
                "provider_active": active_provider,
                "inputs_meta": input_meta,
                "outputs_meta": output_meta,
                "timing": timing,
            },
            "result": result,
            "summary_text": (
                f"✅ ONNX 推理 · {model_url.split('/')[-1]}\n"
                f"⚙️  provider: {active_provider}\n"
                f"⏱  下载 {timing.get('download_ms',0)}ms / 加载 {timing.get('load_ms',0)}ms / "
                f"推理 {timing.get('infer_ms',0)}ms\n"
                f"📥 {len(input_meta)} 输入 · 📤 {len(output_meta)} 输出"
                + (f"\n💾 模型缓存命中 (省 {timing.get('download_ms',0)}ms)"
                   if not downloaded and kind == "remote" else "")
            ),
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({
            "status": "failed", "task_type": "onnx_infer",
            "error": str(e), "summary_text": "❌ " + str(e),
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
