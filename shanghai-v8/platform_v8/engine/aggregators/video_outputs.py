"""
video_outputs · 视频压缩组合聚合

规则:
  - 同一 source_ref 的时长分段 → ffmpeg_concat（有序分段 zip + concat.txt）
  - 整文件 / 多源产物 → 并入 zip_files
  - 仅单源时长切 → 直接返回 ffmpeg_concat 结果
"""
from __future__ import annotations
import base64
import io
import json
import logging
import zipfile
from collections import defaultdict

from platform_v8.core import Workload, Shard, WorkloadResult
from platform_v8.engine.aggregators.media_concat import aggregate_ffmpeg_concat
from platform_v8.engine.aggregators.zip_files import aggregate_zip_files

logger = logging.getLogger(__name__)


def _source_key(shard: Shard) -> str:
    meta = shard.metadata or {}
    slice_meta = meta.get("slice_meta") or {}
    ref = (
        meta.get("source_ref")
        or slice_meta.get("source_ref")
        or shard.input_ref
        or ""
    )
    idx = meta.get("source_index", slice_meta.get("source_index"))
    if idx is not None:
        return f"src-{idx}:{ref}"
    return ref or f"shard-{shard.index}"


def _is_duration_shard(shard: Shard) -> bool:
    meta = shard.metadata or {}
    if meta.get("slice_strategy") == "duration_chunked":
        return True
    slice_meta = meta.get("slice_meta") or {}
    keys = ("start_s", "end_s", "start_sec", "end_sec", "start_pct", "end_pct")
    return any(k in slice_meta for k in keys)


def aggregate_video_outputs(workload: Workload, shards: list[Shard]) -> WorkloadResult:
    ordered = sorted(shards, key=lambda s: s.index)
    duration_shards = [s for s in ordered if _is_duration_shard(s)]
    whole_shards = [s for s in ordered if not _is_duration_shard(s)]

    # 纯时长且同源（或仅一组）→ ffmpeg_concat
    if duration_shards and not whole_shards:
        groups: dict[str, list[Shard]] = defaultdict(list)
        for sh in duration_shards:
            groups[_source_key(sh)].append(sh)
        if len(groups) == 1:
            return aggregate_ffmpeg_concat(workload, duration_shards)

    # 纯整文件 → zip
    if whole_shards and not duration_shards:
        return aggregate_zip_files(workload, whole_shards)

    # 混合 / 多源：各源 concat，再与整文件产物一起 zip
    collected_files: dict[str, bytes] = {}
    all_results: list = []
    errors: list[str] = []
    elapsed_total = 0
    summary: dict = {}

    groups: dict[str, list[Shard]] = defaultdict(list)
    for sh in duration_shards:
        groups[_source_key(sh)].append(sh)

    for gkey, group in groups.items():
        sub = aggregate_ffmpeg_concat(workload, group)
        elapsed_total += int(sub.elapsed_ms or 0)
        try:
            payload = json.loads(sub.output_ref or "{}")
        except (TypeError, json.JSONDecodeError):
            payload = {}
        if isinstance(payload, dict):
            for k, v in (payload.get("summary") or {}).items():
                if isinstance(v, (int, float)):
                    summary[k] = summary.get(k, 0) + v
            if isinstance(payload.get("results"), list):
                all_results.extend(payload["results"])
            if payload.get("errors"):
                errors.extend(
                    e if isinstance(e, str) else json.dumps(e, ensure_ascii=False)
                    for e in payload["errors"]
                )
            url = payload.get("download_url") or ""
            # 单段直出 URL · 记入清单（最终 zip 可能只含 manifest 链）
            if url and not url.endswith(".zip") and "_segments.zip" not in url:
                safe = f"concat_{gkey.replace('/', '_')[-40:]}.url.txt"
                collected_files[safe] = url.encode("utf-8")
            elif url:
                # 尝试拉取 zip 内容展开；失败则写 URL 指针
                try:
                    import requests as _req
                    rr = _req.get(url, timeout=180)
                    if rr.status_code == 200 and rr.content[:2] == b"PK":
                        with zipfile.ZipFile(io.BytesIO(rr.content)) as zf:
                            for name in zf.namelist():
                                if name.endswith("/"):
                                    continue
                                collected_files[f"source_{gkey[-24:]}/{name}"] = zf.read(name)
                    elif rr.status_code == 200:
                        collected_files[f"source_{gkey[-24:]}.bin"] = rr.content
                    else:
                        collected_files[f"source_{gkey[-24:]}.url.txt"] = url.encode("utf-8")
                except Exception as exc:
                    errors.append(f"拉取 concat 产物失败 {gkey}: {exc}")
                    collected_files[f"source_{gkey[-24:]}.url.txt"] = url.encode("utf-8")

    # 整文件片：复用 zip_files 收集逻辑（临时合成）
    if whole_shards:
        whole_result = aggregate_zip_files(workload, whole_shards)
        elapsed_total += int(whole_result.elapsed_ms or 0)
        try:
            whole_payload = json.loads(whole_result.output_ref or "{}")
        except (TypeError, json.JSONDecodeError):
            whole_payload = {}
        if isinstance(whole_payload, dict):
            if isinstance(whole_payload.get("results"), list):
                all_results.extend(whole_payload["results"])
            for e in whole_payload.get("errors") or []:
                errors.append(e if isinstance(e, str) else str(e))
            for k, v in (whole_payload.get("summary") or {}).items():
                if isinstance(v, (int, float)):
                    summary[k] = summary.get(k, 0) + v
            # 从各 shard 再抽 b64（zip_files 已上传，这里从 shard 原始输出抽）
            for sh in whole_shards:
                if not sh.output_ref:
                    continue
                try:
                    data = json.loads(sh.output_ref)
                except (TypeError, json.JSONDecodeError):
                    continue
                if not isinstance(data, dict) or data.get("status") not in ("ok", None):
                    continue
                files = data.get("result_files_b64") or data.get("result_images_b64") or {}
                if not files and isinstance(data.get("output_b64"), str):
                    fname = "output.mp4"
                    res0 = (data.get("results") or [{}])[0] if data.get("results") else {}
                    if isinstance(res0, dict) and res0.get("filename"):
                        fname = f"compressed_{res0['filename']}"
                    files = {fname: data["output_b64"]}
                for fname, b64 in files.items():
                    try:
                        collected_files[f"shard-{sh.index:02d}_{fname}"] = base64.b64decode(b64)
                    except Exception as exc:
                        errors.append(f"shard {sh.index} {fname}: {exc}")
                # artifact URL 指针
                for item in data.get("results") or []:
                    if not isinstance(item, dict):
                        continue
                    art = item.get("artifact") or {}
                    url = art.get("url") or art.get("download_url") or item.get("download_url")
                    if url and not item.get("output_b64"):
                        pointer = f"shard-{sh.index:02d}_{item.get('filename', 'out')}.url.txt"
                        collected_files[pointer] = str(url).encode("utf-8")

    if not collected_files and not groups and not whole_shards:
        return aggregate_ffmpeg_concat(workload, ordered)

    if not collected_files:
        # 退化：只有 URL 清单
        final = {
            "status": "ok" if not errors else "failed",
            "task_type": workload.spec.task_type,
            "elapsed_ms": elapsed_total,
            "summary": summary,
            "results": all_results,
            "errors": errors,
            "summary_text": "🎬 多源视频产物已汇总",
        }
        return WorkloadResult(
            output_ref=json.dumps(final, ensure_ascii=False),
            summary="video_outputs · manifest",
            elapsed_ms=elapsed_total,
            metadata={"strategy": "video_outputs", "shard_count": len(shards)},
        )

    # 若只有一个文件且非 url.txt → 也可走 zip；统一 zip 交付多源
    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for fname, data in collected_files.items():
            zf.writestr(fname, data)
        zf.writestr(
            "manifest.json",
            json.dumps(
                {
                    "workload_id": str(workload.id),
                    "task_type": workload.spec.task_type,
                    "file_count": len(collected_files),
                    "summary": summary,
                    "results": all_results,
                    "errors": errors,
                },
                ensure_ascii=False,
                indent=2,
            ),
        )
    zip_bytes = zip_buf.getvalue()

    download_url = ""
    try:
        import requests as _req
        from platform_v8.services.oss_provider import get_oss_provider
        oss = get_oss_provider()
        key = f"v8/account-{workload.owner_id}/results/{workload.id}_video_outputs.zip"
        put_info = oss.presign_put(key, content_type="application/zip", expires=600)
        r = _req.put(
            put_info.url,
            data=zip_bytes,
            headers={"Content-Type": "application/zip"},
            timeout=120,
        )
        if r.status_code in (200, 201):
            download_url = oss.presign_get(key, expires=7 * 24 * 3600).url
    except Exception as exc:
        logger.warning("video_outputs · OSS 上传失败: %s", exc)

    final = {
        "status": "ok",
        "schema_version": "v1",
        "task_type": workload.spec.task_type,
        "elapsed_ms": elapsed_total,
        "summary": {
            **summary,
            "total_files": len(collected_files),
            "zip_size_bytes": len(zip_bytes),
            "error_count": len(errors),
        },
        "download_url": download_url,
        "results": all_results,
        "errors": errors,
        "summary_text": (
            f"✅ 视频产物 {len(collected_files)} 个 · "
            f"ZIP {len(zip_bytes) // 1024} KB · {len(shards)} 片"
        ),
    }
    return WorkloadResult(
        output_ref=json.dumps(final, ensure_ascii=False),
        summary=f"video_outputs · {len(collected_files)} files",
        elapsed_ms=elapsed_total,
        metadata={
            "strategy": "video_outputs",
            "shard_count": len(shards),
            "file_count": len(collected_files),
            "manifest": final,
        },
    )
