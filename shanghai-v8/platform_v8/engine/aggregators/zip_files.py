"""
zip_files · 把 N 片的输出文件打包成 1 个 zip · 上传 OSS · 返 download URL

适用: image_resize / image_compress / image_convert (批量图)

输入 shard.output_ref 两种形态:
  1) JSON 字符串 {result_images_b64: {filename: b64, ...}, results: [...], summary: ...}
     节点端 image_resize.py 在 multi_file 模式产这种
  2) OSS URL (节点直接上传 zip 后返 URL) · MVP 暂不支持 · 但保留通道

输出 WorkloadResult.output_ref = OSS zip URL
"""
from __future__ import annotations
import base64
import io
import json
import logging
import mimetypes
import os
import zipfile

from platform_v8.core import Workload, Shard, WorkloadResult

logger = logging.getLogger(__name__)


def _load_shard_json(output_ref: str) -> dict:
    """读取内联 JSON，或读取节点为大输出上传的 JSON object_key。"""
    try:
        data = json.loads(output_ref)
        return data if isinstance(data, dict) else {}
    except (TypeError, json.JSONDecodeError):
        pass

    token = (output_ref or "").strip()
    if not token or "/" not in token or any(c in token for c in " \t\r\n"):
        raise ValueError("既不是 JSON，也不是合法 object_key")

    import httpx
    from platform_v8.services.oss_provider import get_oss_provider
    from platform_v8.services.url_safety import safe_transport_error

    signed = get_oss_provider().presign_get(token, expires=600)
    try:
        response = httpx.get(signed.url, timeout=180, follow_redirects=True)
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise ValueError(safe_transport_error(exc)) from exc
    if len(response.content) > 96 * 1024 * 1024:
        raise ValueError("分片 JSON 超过 96 MiB 上限")
    data = response.json()
    if not isinstance(data, dict):
        raise ValueError("分片 JSON 顶层必须是对象")
    return data


def _download_object_bytes(object_key: str, *, timeout: int = 300) -> bytes:
    import httpx
    from platform_v8.services.oss_provider import get_oss_provider
    from platform_v8.services.url_safety import safe_transport_error

    oss = get_oss_provider()
    # LAN local-oss 的 presign GET 打回本进程；单 worker 会自死锁。
    iter_obj = getattr(oss, "iter_object", None)
    if callable(iter_obj):
        try:
            chunks: list[bytes] = []
            total = 0
            for chunk in iter_obj(object_key):
                total += len(chunk)
                if total > 512 * 1024 * 1024:
                    raise ValueError("产物超过 512 MiB 上限")
                chunks.append(chunk)
            if chunks:
                return b"".join(chunks)
        except ValueError:
            raise
        except FileNotFoundError:
            pass
        except Exception as exc:
            logger.warning("download_object · local iter_object 失败, fallback HTTP: %s", exc)

    signed = oss.presign_get(object_key, expires=600)
    try:
        response = httpx.get(signed.url, timeout=timeout, follow_redirects=True)
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise ValueError(safe_transport_error(exc)) from exc
    if len(response.content) > 512 * 1024 * 1024:
        raise ValueError("产物超过 512 MiB 上限")
    return response.content


_JSON_ARTIFACT_NAMES = {"output.json", "results.json", "result.json"}
_BINARY_ARTIFACT_EXT = (
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff",
    ".zip", ".mp4", ".webm", ".mov", ".mkv", ".avi",
    ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg",
    ".pdf", ".docx", ".xlsx", ".pptx",
)


def _artifact_should_unwrap(data: dict) -> bool:
    """JSON/校验码类产物才展开；jpg/zip 仍走 zip_files 二进制 ingest。"""
    fname = os.path.basename(str(data.get("filename") or "")).lower()
    ctype = str(data.get("content_type") or data.get("mime") or "").lower()
    if fname in _JSON_ARTIFACT_NAMES or fname.endswith(".json"):
        return True
    if "json" in ctype:
        return True
    if fname.startswith("checksums.") and fname.endswith(".txt"):
        return True
    if "legacy-result" in fname:
        return True
    if any(fname.endswith(ext) for ext in _BINARY_ARTIFACT_EXT):
        return False
    return False


def _parse_checksums_text(text: str, filename: str) -> dict | None:
    fname = os.path.basename(filename or "").lower()
    algo = ""
    if fname.startswith("checksums.") and fname.endswith(".txt"):
        algo = fname[len("checksums."):-len(".txt")]
        if algo not in ("sha256", "sha1", "md5", "crc32"):
            algo = ""
    results: list[dict] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        digest, name = parts[0], parts[-1]
        results.append({
            "filename": name,
            "algorithm": algo or "sha256",
            "digest": digest,
            "hash": digest,
            "status": "ok",
        })
    if not results:
        return None
    return {
        "ok": True,
        "status": "ok",
        "capability": "crypto.hash",
        "legacyTaskType": "hash_batch",
        "results": results,
        "columns": ["filename", "algorithm", "digest", "status"],
        "summary": {"items": len(results), "algorithm": algo or "sha256", "op": "file_hash"},
    }


def _unwrap_json_artifact(data: dict) -> dict:
    if str(data.get("schema") or "") != "artifact.v1":
        return data
    key = str(data.get("object_key") or "").strip()
    if not key:
        return data
    # Official Runtime 常把 Capability JSON 打进 zip（results.json）；JSON 聚合器需要展开
    fname = os.path.basename(str(data.get("filename") or "")).lower()
    if fname.endswith(".zip") or "zip" in str(data.get("content_type") or "").lower():
        return _unwrap_zip_capability(data)
    if not _artifact_should_unwrap(data):
        return data
    try:
        raw = _download_object_bytes(key)
    except Exception as exc:
        logger.warning("load_shard_result · artifact 下载失败: %s", exc)
        return data
    text = raw.decode("utf-8", errors="replace").lstrip("\ufeff").strip()
    if text.startswith("{") or text.startswith("["):
        try:
            inner = json.loads(text)
        except json.JSONDecodeError:
            inner = None
        if isinstance(inner, dict):
            out = dict(inner)
            out.pop("_artifact_v1", None)
            return _normalize_capability_json(out)
        if isinstance(inner, list):
            return _normalize_capability_json({"results": inner})
    parsed = _parse_checksums_text(text, str(data.get("filename") or ""))
    return parsed if parsed else data


def _unwrap_zip_capability(data: dict) -> dict:
    """artifact.v1 · *.zip → 读取内嵌 results.json / output.json。"""
    import io
    import zipfile

    key = str(data.get("object_key") or "").strip()
    if not key:
        return data
    try:
        raw = _download_object_bytes(key)
    except Exception as exc:
        logger.warning("load_shard_result · zip artifact 下载失败: %s", exc)
        return data
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as exc:
        logger.warning("load_shard_result · 非 zip: %s", exc)
        return data
    prefer = ("results.json", "output.json", "result.json")
    by_base = {os.path.basename(n).lower(): n for n in zf.namelist() if not n.endswith("/")}
    picked = None
    for name in prefer:
        if name in by_base:
            picked = by_base[name]
            break
    if not picked:
        for base, full in by_base.items():
            if base.endswith(".json"):
                picked = full
                break
    if not picked:
        return data
    try:
        text = zf.read(picked).decode("utf-8", errors="replace").lstrip("\ufeff").strip()
        inner = json.loads(text)
    except Exception as exc:
        logger.warning("load_shard_result · zip 内 JSON 解析失败: %s", exc)
        return data
    if isinstance(inner, dict):
        out = _normalize_capability_json(inner)
        # 保留 zip 供下载（客户端 bundle）
        out.setdefault(
            "artifacts",
            [{
                "role": "download_bundle",
                "fileName": os.path.basename(str(data.get("filename") or "results.zip")) or "results.zip",
                "filename": os.path.basename(str(data.get("filename") or "results.zip")) or "results.zip",
                "object_key": key,
                "schema": "artifact.v1",
                "size_bytes": data.get("size_bytes"),
                "content_type": "application/zip",
            }],
        )
        return out
    if isinstance(inner, list):
        return _normalize_capability_json({"results": inner})
    return data


def _unwrap_runtime_envelope(data: dict) -> dict:
    """Official Runtime 控制面 {ok, raw, artifacts:[]} → 内层 Capability JSON。"""
    raw = data.get("raw")
    if not isinstance(raw, dict):
        return data
    if not any(
        k in raw
        for k in ("results", "result", "result_lines", "capability", "legacyTaskType", "summary")
    ):
        return data
    out = dict(raw)
    merged: list = []
    seen: set[tuple] = set()
    for block in (data.get("artifacts"), out.get("artifacts")):
        if not isinstance(block, list):
            continue
        for item in block:
            if not isinstance(item, dict):
                continue
            key = (
                str(item.get("fileName") or item.get("filename") or item.get("relativePath") or ""),
                str(item.get("handle") or item.get("localPath") or item.get("object_key") or ""),
            )
            if key in seen:
                continue
            seen.add(key)
            merged.append(item)
    if merged:
        out["artifacts"] = merged
    if data.get("ok") is True:
        out.setdefault("ok", True)
    return out


def _promote_result_lines(data: dict) -> dict:
    """python 脚本 result_lines → 客户端表格可展开的 results[].text。"""
    if isinstance(data.get("results"), list) and data["results"]:
        return data
    lines = data.get("result_lines")
    if not isinstance(lines, list) or not lines:
        return data
    if not all(isinstance(x, str) for x in lines):
        return data
    tt = str(data.get("legacyTaskType") or data.get("task_type") or "").strip().lower()
    # hash/统计类 result_lines 是「摘要\\t原文」或结构化行，留给 lines_merge / 客户端解析
    if tt in {
        "hash_batch",
        "md5_batch",
        "crc32_batch",
        "base64_encode",
        "base64_decode",
        "line_count",
        "word_count",
    }:
        return data
    if any("\t" in x or x.lstrip().startswith(("{", "[")) for x in lines):
        return data
    body = "\n".join(lines)
    out = dict(data)
    if not str(out.get("result_text") or "").strip():
        out["result_text"] = body
    if not str(out.get("text") or "").strip():
        out["text"] = body
    out["results"] = [
        {
            "filename": "output.txt",
            "op": tt or "text",
            "status": "ok",
            "text": body,
            "text_preview": body[:800],
            "input_lines": len(lines),
            "output_lines": len(lines),
        }
    ]
    return out


def _normalize_capability_json(data: dict) -> dict:
    data = _unwrap_runtime_envelope(data)
    data = _alias_result_list(data)
    return _promote_result_lines(data)


def load_shard_result(output_ref: str) -> dict:
    """脚本/Runtime JSON；artifact.v1 若正文是 JSON、checksums 或内含 results.json 的 zip 则展开。"""
    data = _load_shard_json(output_ref)
    if str(data.get("schema") or "") == "artifact.v1":
        return _unwrap_json_artifact(data)
    return _normalize_capability_json(data)


def materialize_output_ref(output_ref: str) -> str:
    """artifact.v1 / Official Runtime 信封 → 内层 Capability/脚本 JSON。"""
    t = (output_ref or "").strip()
    if not t.startswith("{"):
        return t
    try:
        data = json.loads(t)
    except (TypeError, json.JSONDecodeError):
        return t
    if not isinstance(data, dict):
        return t
    if str(data.get("schema") or "") == "artifact.v1":
        inner = load_shard_result(t)
    else:
        inner = _normalize_capability_json(data)
    if not isinstance(inner, dict) or str(inner.get("schema") or "") == "artifact.v1":
        return t
    return json.dumps(inner, ensure_ascii=False)


def _alias_result_list(data: dict) -> dict:
    """老客户端只读 results；python 脚本常用 result: [ {...}, ... ]。"""
    if isinstance(data.get("results"), list) and data["results"]:
        return data
    alt = data.get("result")
    if isinstance(alt, list) and alt and isinstance(alt[0], dict):
        out = dict(data)
        out["results"] = alt
        return out
    return data


def _is_image_filename(name: str) -> bool:
    ext = os.path.splitext(os.path.basename(name))[1].lower()
    return ext in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}


def _looks_like_json_bytes(blob: bytes) -> bool:
    head = blob.lstrip()[:1]
    return head in (b"{", b"[")


def _is_preview_media_task(task_type: str) -> bool:
    """借调聚合时跳过控制面 JSON，避免 output.json 冒充预览行。"""
    tt = (task_type or "").strip().lower()
    return tt in {
        "image_compress",
        "image_convert",
        "image_resize",
        "image_thumbnail",
        "video_thumbnail",
        "audio_extract",
        "audio_transcode",
    }


def _zip_member_basename(info: zipfile.ZipInfo) -> str:
    """优先 UTF-8 旗标；否则尝试把 CP437 误解码还原为 UTF-8。"""
    raw_name = info.filename or ""
    if info.flag_bits & 0x800:
        name = raw_name
    else:
        try:
            name = raw_name.encode("cp437").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            name = raw_name
    return os.path.basename(name.replace("\\", "/"))


def _parse_results_from_zip_json(blob: bytes) -> list[dict]:
    try:
        text = blob.decode("utf-8", errors="replace").lstrip("\ufeff").strip()
        data = json.loads(text)
    except Exception:
        return []
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if not isinstance(data, dict):
        return []
    rows = data.get("results")
    if isinstance(rows, list):
        return [x for x in rows if isinstance(x, dict)]
    return []


def _result_row_from_media(name: str, size: int) -> dict:
    ext = os.path.splitext(name)[1].lower().lstrip(".") or ""
    if ext == "jpeg":
        ext = "jpg"
    return {
        "filename": name,
        "output_filename": name,
        "format": ext or "—",
        "output_bytes": size,
        "output_size": f"{max(size, 0) / 1024:.1f} KB" if size else "—",
        "status": "ok",
    }


def _shard_ok(data: dict) -> bool:
    if data.get("status") == "ok":
        return True
    if data.get("ok") is True:
        return True
    return False


def _artifact_has_capability_payload(data: dict) -> bool:
    if str(data.get("schema") or data.get("schema_version") or "") == "artifact.v1":
        return False
    return bool(
        isinstance(data.get("results"), list)
        or data.get("capability")
        or data.get("legacyTaskType")
        or data.get("result_images_b64")
        or data.get("result_files_b64")
        or isinstance(data.get("output_b64"), str)
    )


def _ingest_artifact_v1(
    data: dict,
    *,
    shard_index: int,
    shard_count: int,
    all_files: dict[str, bytes],
    all_results: list,
    task_type: str = "",
    emit_results: bool = True,
) -> None:
    """把 artifact.v1（单文件或 outputs.zip）并入 all_files。

    emit_results=False：仅收文件（Capability 路径已有 results 时避免重复行）。
    """
    key = str(data.get("object_key") or "").strip()
    if not key:
        raise ValueError("artifact.v1 缺少 object_key")
    content = _download_object_bytes(key)
    fname = os.path.basename(str(data.get("filename") or "output.bin")) or "output.bin"
    size = int(data.get("size_bytes") or len(content))
    media_task = _is_preview_media_task(task_type)
    meta_results: list[dict] = []
    added_names: list[str] = []

    def _add(name: str, blob: bytes) -> None:
        nonlocal meta_results
        base = os.path.basename(name) or name
        lower = base.lower()
        # 媒体任务：控制面 JSON 只抽元数据，不当成预览文件
        if media_task and (
            lower.endswith(".json") or _looks_like_json_bytes(blob)
        ) and not _is_image_filename(base):
            if lower in _JSON_ARTIFACT_NAMES or lower.endswith(".json"):
                parsed = _parse_results_from_zip_json(blob)
                if parsed:
                    meta_results = parsed
            return
        safe = f"shard-{shard_index:02d}_{base}" if shard_count > 1 else base
        # 防重名
        stem, ext = os.path.splitext(safe)
        n = 1
        while safe in all_files:
            safe = f"{stem}_{n}{ext}"
            n += 1
        all_files[safe] = blob
        added_names.append(base)

    if fname.lower().endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            members = [i for i in zf.infolist() if not i.is_dir()]
            if not members:
                raise ValueError("artifact zip 为空")
            if len(members) > 256:
                raise ValueError("artifact zip 成员过多")
            total_unpacked = 0
            for info in members:
                if info.file_size > 128 * 1024 * 1024:
                    raise ValueError("artifact zip 单文件过大")
                total_unpacked += info.file_size
                if total_unpacked > 512 * 1024 * 1024:
                    raise ValueError("artifact zip 解压总量过大")
                if info.compress_size and info.file_size > info.compress_size * 100:
                    raise ValueError("artifact zip 压缩比异常")
                name = _zip_member_basename(info)
                if not name or name.startswith("."):
                    continue
                _add(name, zf.read(info))
    else:
        _add(fname, content)

    if not emit_results:
        return
    if meta_results:
        all_results.extend(meta_results)
    elif added_names:
        for n in added_names:
            blob = None
            for k, v in all_files.items():
                if k == n or k.endswith(f"_{n}") or k.endswith(n):
                    blob = v
                    break
            all_results.append(_result_row_from_media(n, len(blob) if blob else 0))
    elif not media_task and fname and not fname.lower().endswith(".zip"):
        all_results.append({"filename": fname, "output_bytes": size})

def aggregate_zip_files(workload: Workload, shards: list[Shard]) -> WorkloadResult:
    """合并 N 个 shard 的 result_images_b64 → zip 上传 OSS"""
    all_files: dict[str, bytes] = {}  # filename → bytes
    all_results: list = []            # 每个文件的元数据
    aggregated_summary: dict = {}
    elapsed_total = 0
    errors: list[str] = []

    for sh in sorted(shards, key=lambda s: s.index):
        if not sh.output_ref:
            continue
        try:
            data = _load_shard_json(sh.output_ref)
        except Exception as exc:
            errors.append(f"shard {sh.index} 结果读取失败: {exc}")
            continue

        schema = data.get("schema") or data.get("schema_version")
        if schema == "artifact.v1":
            # batch.zip 内若嵌 results.json / 或主产物是 output.json → 先展开成 Capability
            unwrapped = _unwrap_json_artifact(data)
            if _artifact_has_capability_payload(unwrapped):
                data = unwrapped
            else:
                try:
                    _ingest_artifact_v1(
                        data,
                        shard_index=sh.index,
                        shard_count=len(shards),
                        all_files=all_files,
                        all_results=all_results,
                        task_type=workload.spec.task_type,
                    )
                except Exception as exc:
                    errors.append(f"shard {sh.index} artifact 拉取失败: {exc}")
                elapsed_total += int(data.get("elapsed_ms", 0) or 0)
                continue

        data = _normalize_capability_json(data)
        if not _shard_ok(data):
            errors.append(f"shard {sh.index} 失败: {data.get('error', '')}")
            continue

        # 收集文件 base64 · 支持 3 种 schema (向后兼容 + 容错):
        #   1) result_images_b64: {filename: b64}   (主路径 · 图片 zip_files)
        #   2) result_files_b64:  {filename: b64}   (主路径 · 通用 video/audio/doc 等)
        #   3) output_b64: "..."                    (单文件 fallback · 推断文件名)
        imgs = (
            data.get("result_images_b64")
            or data.get("result_files_b64")
            or {}
        )
        if not imgs and isinstance(data.get("output_b64"), str):
            # 单文件 fallback · 文件名优先用 results[0].filename · 否则用通用名
            inferred = "output"
            res0 = (data.get("results") or [{}])[0] if data.get("results") else {}
            if isinstance(res0, dict) and res0.get("filename"):
                inferred = res0["filename"]
            else:
                ext = (data.get("output_format") or "bin").lower()
                if ext == "jpeg": ext = "jpg"
                inferred = f"output.{ext}"
            imgs = {inferred: data["output_b64"]}
        files_before = len(all_files)
        for fname, b64 in imgs.items():
            try:
                # shard 间防文件名冲突 · 加 shard index 前缀 (仅多片场景)
                safe = f"shard-{sh.index:02d}_{fname}" if len(shards) > 1 else fname
                all_files[safe] = base64.b64decode(b64)
            except Exception as exc:
                errors.append(f"shard {sh.index} {fname} 解码失败: {exc}")

        # b64 为空时：补拉嵌套 artifact / artifact_manifest（video_compress 大文件常见）
        if len(all_files) == files_before:
            nested_arts: list = []
            if isinstance(data.get("artifacts"), list):
                nested_arts.extend(a for a in data["artifacts"] if isinstance(a, dict))
            if isinstance(data.get("artifact_manifest"), list):
                nested_arts.extend(a for a in data["artifact_manifest"] if isinstance(a, dict))
            if isinstance(data.get("results"), list):
                for item in data["results"]:
                    if not isinstance(item, dict):
                        continue
                    art = item.get("artifact")
                    if isinstance(art, dict):
                        nested_arts.append(art)
                    elif str(item.get("object_key") or "").strip():
                        nested_arts.append(item)
            seen_keys: set[str] = set()
            has_cap_results = isinstance(data.get("results"), list) and bool(data["results"])
            for art in nested_arts:
                key = str(art.get("object_key") or "").strip()
                if not key or key in seen_keys:
                    continue
                seen_keys.add(key)
                payload = dict(art)
                if (payload.get("schema") or payload.get("schema_version")) != "artifact.v1":
                    payload["schema"] = "artifact.v1"
                try:
                    _ingest_artifact_v1(
                        payload,
                        shard_index=sh.index,
                        shard_count=len(shards),
                        all_files=all_files,
                        all_results=all_results,
                        task_type=workload.spec.task_type,
                        emit_results=not has_cap_results,
                    )
                except Exception as exc:
                    errors.append(f"shard {sh.index} 嵌套 artifact 拉取失败: {exc}")

        # 收集 results 元数据
        if isinstance(data.get("results"), list):
            all_results.extend(data["results"])
        # summary 数字累加
        for k, v in (data.get("summary", {}) or {}).items():
            if isinstance(v, (int, float)):
                aggregated_summary[k] = aggregated_summary.get(k, 0) + v
            else:
                aggregated_summary[k] = v

        elapsed_total += int(data.get("elapsed_ms", 0) or 0)

    # 打 zip（audio_extract 单文件不走 zip，直接上传音频）
    if not all_files:
        return WorkloadResult(
            output_ref=json.dumps({
                "status": "failed",
                "task_type": workload.spec.task_type,
                "error": "没有可打包的输出文件",
                "errors": errors,
            }, ensure_ascii=False),
            summary=f"打包失败 · 0 个文件",
            elapsed_ms=elapsed_total,
            metadata={"shard_count": len(shards), "strategy": "zip_files", "error_count": len(errors)},
        )

    is_audio_batch = workload.spec.task_type in ("audio_extract", "audio_transcode")
    single_audio = is_audio_batch and len(all_files) == 1

    zip_bytes = b""
    zip_size = 0
    output_url = ""
    if single_audio:
        audio_name, audio_bytes = next(iter(all_files.items()))
        output_url = _upload_preview_to_oss(
            audio_name,
            audio_bytes,
            workload,
            object_basename=_safe_audio_basename(audio_name, 1),
        )
        zip_size = len(audio_bytes)
        logger.info(
            "zip_files · workload=%s %s 单文件直传 · %d 字节",
            workload.id, workload.spec.task_type, zip_size,
        )
    else:
        zip_buf = io.BytesIO()
        with zipfile.ZipFile(zip_buf, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            for fname, data in all_files.items():
                zf.writestr(fname, data)
            # 批量图片/封面/音频：包内只留媒体文件，不附带元数据 json
            if workload.spec.task_type not in (
                "image_compress", "image_convert", "image_resize", "image_thumbnail",
                "video_thumbnail", "audio_extract", "audio_transcode",
            ):
                manifest = {
                    "workload_id": str(workload.id),
                    "task_type": workload.spec.task_type,
                    "file_count": len(all_files),
                    "summary": aggregated_summary,
                    "results": all_results,
                    "errors": errors,
                }
                zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))

        zip_bytes = zip_buf.getvalue()
        zip_size = len(zip_bytes)
        logger.info("zip_files · workload=%s 打包 %d 个文件 · zip %d 字节",
                    workload.id, len(all_files), zip_size)
        output_url = _upload_to_oss(zip_bytes, workload)

    if not output_url:
        return WorkloadResult(
            output_ref=json.dumps({
                "status": "failed",
                "task_type": workload.spec.task_type,
                "error": "聚合产物上传失败",
            }, ensure_ascii=False),
            summary="打包失败 · 产物上传失败",
            elapsed_ms=elapsed_total,
            metadata={"shard_count": len(shards), "strategy": "zip_files"},
        )

    preview_url = ""
    preview_urls: list[str] = []
    if all_files:
        image_tasks = {
            "image_compress",
            "image_convert",
            "image_resize",
            "image_thumbnail",
        }
        if workload.spec.task_type in ("video_thumbnail", "audio_extract", "audio_transcode"):
            # 每张封面 / 每段音频单独上传，供完成页预览
            for idx, (preview_name, preview_bytes) in enumerate(all_files.items(), start=1):
                if workload.spec.task_type == "video_thumbnail":
                    if not _is_image_filename(preview_name) or _looks_like_json_bytes(preview_bytes):
                        continue
                if workload.spec.task_type in ("audio_extract", "audio_transcode"):
                    basename = _safe_audio_basename(preview_name, idx)
                else:
                    ext = ""
                    if "." in preview_name:
                        ext = "." + preview_name.rsplit(".", 1)[-1].lower()
                    if ext not in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}:
                        ext = ".jpg"
                    basename = f"preview-{idx:02d}{ext}"
                # 单文件时 download 已是该文件，预览复用同一 URL
                if single_audio and output_url:
                    url = output_url
                else:
                    url = _upload_preview_to_oss(
                        preview_name,
                        preview_bytes,
                        workload,
                        object_basename=basename,
                    )
                if url:
                    preview_urls.append(url)
            preview_url = preview_urls[0] if preview_urls else ""
        elif workload.spec.task_type in image_tasks:
            # 每张真图单独上传；跳过 JSON / 伪预览，避免「preview.jpg 其实是 JSON」
            image_items = [
                (n, b)
                for n, b in all_files.items()
                if _is_image_filename(n) and not _looks_like_json_bytes(b)
            ]
            for idx, (preview_name, preview_bytes) in enumerate(image_items, start=1):
                ext = os.path.splitext(preview_name)[1].lower() or ".png"
                if ext not in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}:
                    ext = ".png"
                basename = f"preview-{idx:02d}{ext}"
                url = _upload_preview_to_oss(
                    preview_name,
                    preview_bytes,
                    workload,
                    object_basename=basename,
                )
                if url:
                    preview_urls.append(url)
            preview_url = preview_urls[0] if preview_urls else ""
        else:
            preview_name, preview_bytes = next(iter(all_files.items()))
            preview_url = _upload_preview_to_oss(
                preview_name, preview_bytes, workload
            )
            if preview_url:
                preview_urls = [preview_url]

    if is_audio_batch:
        label = "音频提取" if workload.spec.task_type == "audio_extract" else "音频转码"
        summary_text = (
            f"✅ {label} {len(all_files)} 个文件"
            + (f" · 直链下载" if single_audio else f"\n📦 ZIP {zip_size // 1024} KB · {len(shards)} 片合并")
            + (f"\n⚠️ 失败 {len(errors)} 项" if errors else "")
        )
        summary_line = (
            f"{label} {len(all_files)} 个"
            + (f" · {zip_size // 1024} KB" if single_audio else f" · ZIP {zip_size // 1024} KB")
        )
    else:
        summary_text = (
            f"✅ 批量处理 {len(all_files)} 个文件\n"
            f"📦 ZIP {zip_size // 1024} KB · {len(shards)} 片合并\n"
            f"{'⚠️ 失败 ' + str(len(errors)) + ' 项' if errors else ''}"
        )
        summary_line = f"打包 {len(all_files)} 文件 · ZIP {zip_size//1024} KB"

    final = {
        "status": "ok",
        "schema_version": "v1",
        "task_type": workload.spec.task_type,
        "elapsed_ms": elapsed_total,
        "summary": {
            **aggregated_summary,
            "total_files": len(all_files),
            "zip_size_bytes": 0 if single_audio else zip_size,
            "output_bytes": zip_size if single_audio else aggregated_summary.get("output_bytes", zip_size),
            "error_count": len(errors),
            "download_kind": "audio" if single_audio else "zip",
        },
        "download_url": output_url,
        "preview_url": preview_url,
        "preview_urls": preview_urls,
        "results": all_results,
        "errors": errors,
        "summary_text": summary_text,
    }
    return WorkloadResult(
        # JSON manifest keeps download and browser-preview URLs together.
        # /workloads/{id}/download already unwraps download_url.
        output_ref=json.dumps(final, ensure_ascii=False),
        summary=summary_line,
        elapsed_ms=elapsed_total,
        metadata={"shard_count": len(shards), "strategy": "zip_files",
                  "file_count": len(all_files), "zip_size": zip_size,
                  "manifest": final},
    )


def _safe_audio_basename(filename: str, idx: int) -> str:
    """预览/直链用 ASCII 文件名，保留音频扩展名。"""
    ext = ".mp3"
    if "." in filename:
        cand = "." + filename.rsplit(".", 1)[-1].lower()
        if cand in {".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac"}:
            ext = cand
    return f"audio-{idx:02d}{ext}"


def _upload_to_oss(zip_bytes: bytes, workload: Workload) -> str:
    """上传 zip 到 OSS · 返 presign GET URL · 失败返空 (调用方降级 inline)

    OSS provider 只提供 presign_put · 不直接 put_object · 这里:
      1. 拿 presign_put URL (PUT method)
      2. requests.put 真正上传
      3. 拿 presign_get URL 返给前端 (用户下载)
    """
    try:
        import httpx
        from platform_v8.services.oss_provider import get_oss_provider
        oss = get_oss_provider()
        key = f"v8/account-{workload.owner_id}/results/{workload.id}.zip"
        # 1. presign PUT
        put_info = oss.presign_put(key, content_type="application/zip", expires=600)
        # 2. PUT 上传
        r = httpx.put(
            put_info.url,
            data=zip_bytes,
            headers={"Content-Type": "application/zip"},
            timeout=300,
        )
        if r.status_code not in (200, 201):
            logger.warning("zip_files · OSS PUT 失败 status=%s body=%s",
                           r.status_code, r.text[:200])
            return ""
        # 3. presign GET 给前端下载 (7 天)
        get_info = oss.presign_get(key, expires=7 * 24 * 3600)
        url = get_info.url
        logger.info("zip_files · 上传 OSS OK · key=%s size=%d", key, len(zip_bytes))
        return url
    except Exception as exc:
        logger.warning("zip_files · 上传 OSS 失败 (降级 inline · 大文件可能丢): %s: %s",
                       type(exc).__name__, exc)
        return ""


def _upload_preview_to_oss(
    filename: str,
    content: bytes,
    workload: Workload,
    *,
    object_basename: str | None = None,
) -> str:
    """Upload processed image for inline web preview."""
    try:
        import httpx
        from platform_v8.services.oss_provider import get_oss_provider

        safe_name = filename.rsplit("/", 1)[-1]
        # 批量图片/封面截图：预览用固定 ASCII 名，避免文件名里已有 %XX 被二次 quote 导致 404
        if object_basename:
            safe_name = object_basename
        elif workload.spec.task_type in (
            "image_compress", "image_convert", "image_resize", "image_thumbnail",
            "video_thumbnail",
        ):
            ext = ""
            if "." in safe_name:
                ext = "." + safe_name.rsplit(".", 1)[-1].lower()
            if ext not in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}:
                ext = ".jpg"
            safe_name = f"preview{ext}"
        content_type = mimetypes.guess_type(safe_name)[0]
        if not content_type:
            low = safe_name.lower()
            if low.endswith(".mp3"):
                content_type = "audio/mpeg"
            elif low.endswith((".m4a", ".aac")):
                content_type = "audio/mp4"
            elif low.endswith(".wav"):
                content_type = "audio/wav"
            elif low.endswith(".flac"):
                content_type = "audio/flac"
            elif low.endswith(".ogg"):
                content_type = "audio/ogg"
            else:
                content_type = "image/jpeg"
        # 大音频 PUT 放宽超时
        put_timeout = 300 if content_type.startswith("audio/") else 60
        key = (
            f"v8/account-{workload.owner_id}/results/"
            f"{workload.id}/{safe_name}"
        )
        oss = get_oss_provider()
        put_info = oss.presign_put(
            key, content_type=content_type, expires=600
        )
        response = httpx.put(
            put_info.url,
            data=content,
            headers={"Content-Type": content_type},
            timeout=put_timeout,
        )
        if response.status_code not in (200, 201):
            return ""
        return oss.presign_get(key, expires=604800).url
    except Exception as exc:
        logger.warning("zip_files · preview 上传失败: %s", exc)
        return ""
