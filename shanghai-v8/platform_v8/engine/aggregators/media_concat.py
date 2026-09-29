"""
media_concat · 视频/音频/帧序列的有序合并聚合器

提供两个聚合器 (此前都 fallback 到 inline_concat · 把 JSON 字符串硬拼 · 产物不可用):

  aggregate_frames_to_video  ← blender_render (frames_chunked)
      各片渲染连续帧段 · 按全局帧号排序 · 收齐所有帧 → 打 zip 传 OSS
      (渲染农场的真实交付物 = 完整帧序列 · 用户/最终节点可一条 ffmpeg 合成 mp4)

  aggregate_ffmpeg_concat    ← video_compress / audio_transcode (duration_chunked)
      各片压缩一个时段 → 按片序排序 · 收齐分段 → zip + 生成 ffconcat 播放列表
      (用户拿到有序分段 + concat.txt · 一条 `ffmpeg -f concat -i concat.txt -c copy out` 即合成)

设计取舍:
  - 不在 API 服务器上跑 ffmpeg 真合成:服务器不保证装 ffmpeg,且把所有分段拉回中心节点
    做媒体处理违背边缘算力架构、无法支撑 10w+ 节点规模。
  - 因此交付"有序分段 + 合成清单",数据真实完整、可一步合成,不伪造结果。
  - 后续可演进为"二阶段合成任务"(派一个最终节点做 concat) · 见 docs 规划。

输入 shard.output_ref 两种形态:
  1) JSON 字符串:{result_images:[{frame,image_b64}], result_files_b64:{name:b64},
                  output_b64, output_ref(URL), summary, elapsed_ms}
  2) 直接是 OSS URL 字符串 (节点上传大产物后回 URL)
"""
from __future__ import annotations
import base64
import io
import json
import logging
import zipfile

from platform_v8.core import Workload, Shard, WorkloadResult

logger = logging.getLogger(__name__)


def _upload_bytes_to_oss(data: bytes, key: str, content_type: str) -> str:
    """通用 OSS 上传 · presign PUT 上传 + presign GET 返下载 URL · 失败返空"""
    try:
        import requests as _req
        from platform_v8.services.oss_provider import get_oss_provider
        oss = get_oss_provider()
        put_info = oss.presign_put(key, content_type=content_type, expires=600)
        r = _req.put(put_info.url, data=data, headers={"Content-Type": content_type}, timeout=120)
        if r.status_code not in (200, 201):
            logger.warning("media_concat · OSS PUT 失败 status=%s body=%s", r.status_code, r.text[:200])
            return ""
        get_info = oss.presign_get(key, expires=7 * 24 * 3600)
        logger.info("media_concat · 上传 OSS OK · key=%s size=%d", key, len(data))
        return get_info.url
    except Exception as exc:
        logger.warning("media_concat · 上传 OSS 失败 (降级 inline): %s: %s", type(exc).__name__, exc)
        return ""


def _shard_json(sh: Shard) -> dict | None:
    if not sh.output_ref:
        return None
    ref = sh.output_ref
    # 直接是 URL → 包成统一结构
    if isinstance(ref, str) and ref.startswith(("http://", "https://")):
        return {"status": "ok", "output_ref": ref, "_is_url": True}
    try:
        d = json.loads(ref)
        if not isinstance(d, dict):
            return None
        # artifact.v1 · 产物在 OSS · 转成可下载 URL 供后续 zip/concat
        schema = d.get("schema") or d.get("schema_version")
        if schema == "artifact.v1" and d.get("object_key"):
            url = _presign_get_url(str(d["object_key"]))
            if not url:
                logger.warning("media_concat · artifact.v1 presign 失败 key=%s", d.get("object_key"))
                return None
            out = {
                "status": "ok",
                "output_ref": url,
                "_is_url": True,
                "filename": d.get("filename") or "",
                "content_type": d.get("content_type") or "",
                "size_bytes": d.get("size_bytes") or 0,
                "sha256": d.get("sha256") or "",
            }
            # 兼容旧字段名 · 聚合器也可从 URL 拉
            return out
        return d
    except Exception:
        return None


def _presign_get_url(object_key: str) -> str:
    """为 artifact object_key 签发短期 GET URL · 失败返空。"""
    try:
        from platform_v8.services.oss_provider import get_oss_provider
        oss = get_oss_provider()
        get_info = oss.presign_get(object_key, expires=3600)
        if hasattr(get_info, "url"):
            return str(get_info.url)
        if isinstance(get_info, dict):
            return str(get_info.get("url") or "")
        return str(get_info)
    except Exception as exc:
        logger.warning("media_concat · presign_get 失败: %s", exc)
        return ""


# ── frames_to_video (blender 帧序列) ─────────────────────────────────────────
def aggregate_frames_to_video(workload: Workload, shards: list[Shard]) -> WorkloadResult:
    frames: dict[str, bytes] = {}     # frame_name → bytes (按帧名去重 · Blender 全局帧号)
    frame_urls: list[dict] = []       # [{frame, url}] · 节点已上传 OSS 的帧
    elapsed_total = 0
    summary: dict = {}
    errors: list[str] = []
    frames_total = 0

    for sh in sorted(shards, key=lambda s: s.index):
        d = _shard_json(sh)
        if d is None:
            errors.append(f"shard {sh.index} 无有效输出")
            continue
        if d.get("status") not in ("ok", None):
            errors.append(f"shard {sh.index} 失败: {d.get('error','')}")
            continue
        elapsed_total += int(d.get("elapsed_ms", 0) or 0)
        for k, v in (d.get("summary", {}) or {}).items():
            if isinstance(v, (int, float)):
                summary[k] = summary.get(k, 0) + v
        # 1) inline 帧 (result_images: [{frame, image_b64}])
        for item in (d.get("result_images") or []):
            name = item.get("frame") or f"frame_{frames_total:05d}.png"
            b64 = item.get("image_b64")
            if not b64:
                if item.get("url"):
                    frame_urls.append({"frame": name, "url": item["url"]})
                continue
            try:
                frames[name] = base64.b64decode(b64)
                frames_total += 1
            except Exception as exc:
                errors.append(f"frame {name} 解码失败: {exc}")
        # 2) 节点上传的帧 URL / 整片 URL
        if d.get("_is_url") and d.get("output_ref"):
            frame_urls.append({"frame": f"shard-{sh.index:02d}", "url": d["output_ref"]})

    # 有序帧名
    ordered_names = sorted(frames.keys())
    download_url = ""
    if frames:
        zip_buf = io.BytesIO()
        with zipfile.ZipFile(zip_buf, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            for name in ordered_names:
                zf.writestr(name, frames[name])
            # ffmpeg 合成提示 (帧序列 → mp4)
            zf.writestr("HOW_TO_MAKE_VIDEO.txt",
                        "# 帧序列 → mp4 (任选其一):\n"
                        "ffmpeg -framerate 24 -pattern_type glob -i 'frame_*.png' "
                        "-c:v libx264 -pix_fmt yuv420p output.mp4\n")
            zf.writestr("manifest.json", json.dumps({
                "workload_id": str(workload.id),
                "task_type": workload.spec.task_type,
                "frame_count": len(frames),
                "frames": ordered_names,
                "frame_urls": frame_urls,
                "summary": summary,
            }, ensure_ascii=False, indent=2))
        zip_bytes = zip_buf.getvalue()
        download_url = _upload_bytes_to_oss(
            zip_bytes, f"v8/account-{workload.owner_id}/results/{workload.id}_frames.zip",
            "application/zip")

    final = {
        "status": "ok" if (frames or frame_urls) else "failed",
        "schema_version": "v1",
        "task_type": workload.spec.task_type,
        "elapsed_ms": elapsed_total,
        "summary": {**summary, "frame_count": len(frames), "shard_count": len(shards),
                    "error_count": len(errors)},
        "download_url": download_url,
        "frames": ordered_names,
        "frame_urls": frame_urls,
        "errors": errors,
        "summary_text": (
            f"✅ 渲染合并 {len(frames)} 帧 · {len(shards)} 片\n"
            f"{'📦 帧序列 zip 已生成' if download_url else '⚠️ 帧以 inline 返回'}\n"
            f"{'⚠️ 失败 ' + str(len(errors)) + ' 项' if errors else ''}"
        ),
    }
    return WorkloadResult(
        output_ref=download_url or json.dumps(final, ensure_ascii=False),
        summary=f"渲染合并 {len(frames)} 帧 · {len(shards)} 片",
        elapsed_ms=elapsed_total,
        metadata={"shard_count": len(shards), "strategy": "frames_to_video",
                  "frame_count": len(frames), "manifest": final},
    )


# ── ffmpeg_concat (视频/音频分段) ────────────────────────────────────────────
def aggregate_ffmpeg_concat(workload: Workload, shards: list[Shard]) -> WorkloadResult:
    segments: list[dict] = []    # 有序 [{name, bytes?/url?}]
    elapsed_total = 0
    summary: dict = {}
    errors: list[str] = []

    for sh in sorted(shards, key=lambda s: s.index):
        d = _shard_json(sh)
        if d is None:
            errors.append(f"shard {sh.index} 无有效输出")
            continue
        if d.get("status") not in ("ok", None):
            errors.append(f"shard {sh.index} 失败: {d.get('error','')}")
            continue
        elapsed_total += int(d.get("elapsed_ms", 0) or 0)
        for k, v in (d.get("summary", {}) or {}).items():
            if isinstance(v, (int, float)):
                summary[k] = summary.get(k, 0) + v

        idx = sh.index
        # 1) 节点已上传 → URL
        url = d.get("output_ref") if d.get("_is_url") else d.get("download_url") or d.get("url")
        # 2) inline 分段 (result_files_b64 / output_b64 / output_base64)
        files = d.get("result_files_b64") or {}
        if not files and isinstance(d.get("output_b64"), str):
            ext = (d.get("output_format") or "bin").lower()
            files = {f"segment_{idx:03d}.{ext}": d["output_b64"]}
        if not files and isinstance(d.get("output_base64"), str):
            ext = (d.get("output_format") or "bin").lower()
            files = {f"segment_{idx:03d}.{ext}": d["output_base64"]}
        if files:
            for fname, b64 in files.items():
                try:
                    segments.append({"index": idx, "name": f"segment_{idx:03d}_{fname}",
                                     "bytes": base64.b64decode(b64)})
                except Exception as exc:
                    errors.append(f"shard {idx} {fname} 解码失败: {exc}")
        elif url:
            segments.append({"index": idx, "name": f"segment_{idx:03d}", "url": url})
        else:
            errors.append(f"shard {idx} 无分段产物")

    segments.sort(key=lambda x: x["index"])
    download_url = ""
    inline_segs = [s for s in segments if "bytes" in s]
    url_segs = [s for s in segments if s.get("url") and "bytes" not in s]

    # 单段且已是可下载 URL（artifact.v1 常见）→ 直接作为结果 · 可预览/播放
    if not inline_segs and len(url_segs) == 1:
        download_url = str(url_segs[0]["url"])
    elif inline_segs or url_segs:
        zip_buf = io.BytesIO()
        wrote = 0
        with zipfile.ZipFile(zip_buf, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            concat_lines = []
            for s in segments:
                name = s["name"]
                payload: bytes | None = s.get("bytes")
                if payload is None and s.get("url"):
                    try:
                        import requests as _req
                        rr = _req.get(str(s["url"]), timeout=180)
                        if rr.status_code == 200 and rr.content:
                            payload = rr.content
                            if "." not in name.rsplit("/", 1)[-1]:
                                url_path = str(s["url"]).split("?", 1)[0]
                                ext = url_path.rsplit(".", 1)[-1].lower() if "." in url_path else ""
                                if ext in ("mp4", "mp3", "m4a", "webm", "mov", "mkv", "wav"):
                                    name = f"{name}.{ext}"
                        else:
                            errors.append(
                                f"shard {s['index']} 拉取分段失败 HTTP {rr.status_code}"
                            )
                    except Exception as exc:
                        errors.append(f"shard {s['index']} 拉取分段失败: {exc}")
                if payload is None:
                    continue
                zf.writestr(name, payload)
                concat_lines.append(f"file '{name}'")
                wrote += 1
            if concat_lines:
                zf.writestr("concat.txt", "\n".join(concat_lines) + "\n")
                zf.writestr(
                    "HOW_TO_MERGE.txt",
                    "# 有序分段 → 合成 (无损拼接):\n"
                    "ffmpeg -f concat -safe 0 -i concat.txt -c copy output\n",
                )
            zf.writestr(
                "manifest.json",
                json.dumps(
                    {
                        "workload_id": str(workload.id),
                        "task_type": workload.spec.task_type,
                        "segment_count": len(segments),
                        "segments": [
                            {"index": s["index"], "name": s["name"], "url": s.get("url")}
                            for s in segments
                        ],
                        "summary": summary,
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
            )
        if wrote > 0:
            download_url = _upload_bytes_to_oss(
                zip_buf.getvalue(),
                f"v8/account-{workload.owner_id}/results/{workload.id}_segments.zip",
                "application/zip",
            )

    if download_url and ("_segments.zip" in download_url or download_url.endswith(".zip")):
        deliver_hint = "📦 有序分段 zip + concat.txt 已生成"
    elif download_url:
        deliver_hint = "🎬 单段媒体已直出可预览"
    else:
        deliver_hint = "🔗 分段以 URL 清单返回"

    final = {
        "status": "ok" if segments else "failed",
        "schema_version": "v1",
        "task_type": workload.spec.task_type,
        "elapsed_ms": elapsed_total,
        "summary": {**summary, "segment_count": len(segments), "shard_count": len(shards),
                    "error_count": len(errors)},
        "download_url": download_url,
        "segments": [{"index": s["index"], "name": s["name"], "url": s.get("url")} for s in segments],
        "errors": errors,
        "summary_text": (
            f"✅ 分段合并 {len(segments)} 段 · {len(shards)} 片\n"
            f"{deliver_hint}\n"
            f"{'⚠️ 失败 ' + str(len(errors)) + ' 项' if errors else ''}"
        ),
    }
    return WorkloadResult(
        output_ref=download_url or json.dumps(final, ensure_ascii=False),
        summary=f"分段合并 {len(segments)} 段 · {len(shards)} 片",
        elapsed_ms=elapsed_total,
        metadata={"shard_count": len(shards), "strategy": "ffmpeg_concat",
                  "segment_count": len(segments), "manifest": final},
    )
