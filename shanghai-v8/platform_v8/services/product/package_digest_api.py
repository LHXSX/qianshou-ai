"""
混合编排包 · 产品 API 适配层

对外只暴露稳定字段（job_id / status / text / materials）。
对内仍提交 package_digest；引擎切片/路由/merge 可换，不改产品契约。
"""
from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

API_VERSION = "v1"
PRODUCT = "package-digest"
ENGINE_TASK_TYPE = "package_digest"
DEFAULT_RECIPE = "law_materials"

# 产品状态（对外）← 引擎 workload.status（对内）
_STATUS_MAP = {
    "NORMALIZING": "queued",
    "CREATED": "queued",
    "PLANNED": "queued",
    "RUNNING": "running",
    "DONE": "done",
    "FAILED": "failed",
    "CANCELED": "canceled",
    "CANCELLED": "canceled",
}


def map_status(engine_status: str | None) -> str:
    raw = str(engine_status or "").upper()
    return _STATUS_MAP.get(raw, "running" if raw else "queued")


def _count_online_workers() -> int:
    """在线台数：取派发集与 DB 心跳的较大值。

    gw_multi 下 Redis ZSET 常空，online_worker_ids_for_dispatch 会降级成
    「本 uvicorn 进程的本地 WS」——可能只有 0/1 台，严重低估。
    DB last_seen(ONLINE/BUSY) 是跨进程可靠口径，二者取 max。
    """
    dispatch_n = 0
    try:
        from platform_v8.engine import broker
        dispatch_n = len(broker.online_worker_ids_for_dispatch() or [])
    except Exception as exc:
        logger.debug("cluster_capacity dispatch probe skip: %s", exc)
    db_n = 0
    try:
        from platform_v8.storage.db import session_scope
        from platform_v8.storage import repo
        with session_scope() as s:
            rows = repo.WorkerRepo.list_online(s, online_ttl_seconds=90)
            db_n = len(rows or [])
    except Exception as exc:
        logger.debug("cluster_capacity db probe skip: %s", exc)
    return max(dispatch_n, db_n)


def _estimate_recommended_shards(
    *,
    online: int,
    material_count: int,
    files: list[dict[str, Any]] | None,
    k_max: int,
    k_hint: int,
) -> int:
    """有文件元数据时按页当量估；否则用 N×k_hint 中位。"""
    mats = max(0, int(material_count or 0))
    if files:
        try:
            from platform_v8.engine.package_recipes import FileRoute, ext_of
            from platform_v8.engine.slicers import package_recipe as pr
            plan: list[tuple[dict[str, Any], Any, int]] = []
            for i, f in enumerate(files):
                name = str(f.get("name") or f.get("filename") or f"file-{i}")
                mat = {
                    "name": name,
                    "size": int(f.get("size") or f.get("size_bytes") or 0),
                    "index": i,
                }
                pages = f.get("pdf_page_count")
                if pages is not None:
                    try:
                        mat["pdf_page_count"] = int(pages)
                    except (TypeError, ValueError):
                        pass
                ext = (ext_of(name) or "").lstrip(".").lower()
                # 粗路由：仅用于重量估计，不替代正式 classify
                if ext == "pdf":
                    route = FileRoute("pdf_ocr")
                elif ext == "docx":
                    route = FileRoute("docx_to_text")
                elif ext == "doc":
                    route = FileRoute("doc_to_text")
                else:
                    route = FileRoute("pdf_to_text" if ext else "docx_to_text")
                plan.append((mat, route, 1))
            return pr._target_shard_count(
                max(1, online or 1), max(1, len(plan) or mats or 1), part_plan=plan,
            )
        except Exception as exc:
            logger.debug("capacity weight estimate skip: %s", exc)
    if online <= 0:
        return max(k_hint, min(20, mats or k_hint))
    recommended = online * k_hint
    if mats and mats <= online:
        recommended = min(recommended, max(mats, online))
    elif mats and mats > online * 2:
        recommended = min(online * k_max, max(recommended, online * k_hint))
    return max(1, min(100, recommended))


def cluster_capacity(
    *,
    material_count: int = 0,
    files: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """产品侧容量快照：在线节点 +（可选）文件元数据 → 推荐片数。

    App 提交前可只传材料数；create 时带 files 则按页/体积估。
    真正切片以 package_recipe 为准。
    """
    import os

    online = _count_online_workers()
    try:
        k_max = max(1, min(5, int(os.environ.get(
            "PACKAGE_DIGEST_SHARDS_PER_WORKER_MAX", "4",
        ))))
    except ValueError:
        k_max = 4
    try:
        k_hint = max(1, min(k_max, int(os.environ.get(
            "PACKAGE_DIGEST_SHARDS_PER_WORKER", "2",
        ))))
    except ValueError:
        k_hint = 2
    mats = max(0, int(material_count or 0))
    if files and not mats:
        mats = len(files)
    recommended = _estimate_recommended_shards(
        online=online,
        material_count=mats,
        files=files,
        k_max=k_max,
        k_hint=k_hint,
    )
    recommended = max(1, min(100, int(recommended)))
    return {
        "ok": True,
        "api_version": API_VERSION,
        "product": PRODUCT,
        "slice_mode": "node_pack",
        "online_workers": online,
        "shards_per_worker": k_hint,
        "shards_per_worker_max": k_max,
        "recommended_shards": recommended,
        "admission_cap_per_worker": 5,
        "adaptive": True,
        "note": "小文件不切/可合批，大文件按页拆；总路数≈整包页当量并用在线台数卡在 N..N×Kmax",
    }


def build_file_manifest(files: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """把产品 files[] 转成引擎 file_manifest（引擎可读的子集）。"""
    out: list[dict[str, Any]] = []
    for f in files:
        item: dict[str, Any] = {
            "name": str(f.get("name") or f.get("filename") or "file"),
            "size": int(f.get("size") or f.get("size_bytes") or 0),
        }
        ctype = f.get("content_type") or f.get("type")
        if ctype:
            item["type"] = str(ctype)
        pages = f.get("pdf_page_count")
        if pages is not None:
            try:
                n = int(pages)
                if n > 0:
                    item["pdf_page_count"] = n
                    if f.get("pdf_page_approx"):
                        item["pdf_page_approx"] = True
            except (TypeError, ValueError):
                pass
        out.append(item)
    return out


def build_submit_spec(
    *,
    input_refs: list[str],
    files: list[dict[str, Any]],
    recipe: str = DEFAULT_RECIPE,
    lang: str = "ch",
    timeout_s: int = 3600,
    max_shards: int = 100,
    input_kind: str = "multi_file",
    extra_params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """构造提交给引擎的 spec · 产品调用方不应直接依赖这些字段。"""
    refs = [r.strip() for r in input_refs if isinstance(r, str) and r.strip()]
    if not refs:
        raise ValueError("files/object_key 不能为空")
    kind = (input_kind or "multi_file").strip().lower()
    if kind not in ("multi_file", "archive", "single_file"):
        kind = "multi_file"
    if kind == "archive" and len(refs) != 1:
        raise ValueError("archive 模式只接受 1 个 object_key（zip）")
    # 默认多文件；单文件 zip 走 archive
    if kind == "multi_file" and len(refs) == 1:
        name0 = str((files[0] if files else {}).get("name") or "").lower()
        if name0.endswith(".zip"):
            kind = "archive"

    params: dict[str, Any] = {
        "recipe": recipe or DEFAULT_RECIPE,
        "lang": lang or "ch",
        "file_manifest": build_file_manifest(files) if files else [
            {"name": f"file-{i+1}", "size": 0} for i in range(len(refs))
        ],
        "total_files": len(refs) if kind != "archive" else max(
            1, int((extra_params or {}).get("total_files") or len(refs))
        ),
        # 按在线节点粗切 · 少片少冷启动（可用 extra_params.slice_mode=page_first 回退）
        "slice_mode": "node_pack",
        # 标记来自产品 API，便于审计；不影响编排
        "_product_api": PRODUCT,
        "_product_api_version": API_VERSION,
    }
    if extra_params:
        for k, v in extra_params.items():
            if k.startswith("_"):
                continue
            if k == "total_files" and kind == "archive":
                params["total_files"] = int(v or params["total_files"])
                continue
            if k == "slice_mode" and v:
                params["slice_mode"] = str(v).strip().lower()
                continue
            if k in (
                "client_online_workers", "submit_online_workers",
                "shards_per_worker", "shards_per_worker_max",
                "recommended_shards",
            ) and v is not None:
                try:
                    params[k] = int(v)
                except (TypeError, ValueError):
                    params[k] = v
                continue
            if k == "client_presliced":
                params["client_presliced"] = bool(v) if not isinstance(v, str) else v.strip().lower() in (
                    "1", "true", "yes", "on",
                )
                if params["client_presliced"]:
                    params["slice_mode"] = "client_presliced"
                continue
            params.setdefault(k, v)

    return {
        "kind": "DATA_PROCESSING",
        "task_type": ENGINE_TASK_TYPE,
        "runtime": "python3",
        "code_url": "",  # 编排型：分片自带脚本
        "input_kind": kind,
        "input_ref": refs[0],
        "input_refs": refs if kind == "multi_file" else [],
        "params": params,
        "timeout_s": max(1, min(int(timeout_s or 3600), 3600)),
        "max_shards": max(1, min(int(max_shards or 100), 100)),
        "auto_shard": True,
    }


def _parse_jsonish(raw: Any) -> Any:
    if raw is None:
        return None
    if isinstance(raw, (dict, list)):
        return raw
    if not isinstance(raw, str):
        return None
    t = raw.strip()
    if not t or t[0] not in "{[":
        return None
    try:
        return json.loads(t)
    except (TypeError, json.JSONDecodeError):
        return None


def extract_package_payload(workload: Any) -> dict[str, Any]:
    """从引擎 workload.result 抽出 package_digest.v1 稳定载荷。"""
    result = getattr(workload, "result", None)
    meta: dict[str, Any] = {}
    output_ref = ""
    inline_output = ""
    summary = ""
    elapsed_ms = None

    if result is not None:
        meta = dict(getattr(result, "metadata", None) or {})
        output_ref = str(getattr(result, "output_ref", "") or "")
        inline_output = str(getattr(result, "inline_output", "") or "")
        summary = str(getattr(result, "summary", "") or "")
        elapsed_ms = getattr(result, "elapsed_ms", None)
        if isinstance(result, dict):
            meta = dict(result.get("metadata") or {})
            output_ref = str(result.get("output_ref") or "")
            inline_output = str(result.get("inline_output") or "")
            summary = str(result.get("summary") or "")
            elapsed_ms = result.get("elapsed_ms")

    candidates: list[Any] = [
        meta.get("inline_json"),
        _parse_jsonish(output_ref),
        _parse_jsonish(inline_output),
        _parse_jsonish(meta.get("result_text")),
    ]
    payload: dict[str, Any] = {}
    for c in candidates:
        if isinstance(c, dict) and (
            c.get("result_text")
            or c.get("text")
            or c.get("materials")
            or str(c.get("schema_version") or "").startswith("package_digest")
        ):
            payload = c
            break

    text = ""
    if isinstance(payload.get("result_text"), str):
        text = payload["result_text"].strip()
    elif isinstance(payload.get("text"), str):
        text = payload["text"].strip()
    elif isinstance(meta.get("result_text"), str):
        text = str(meta["result_text"]).strip()

    materials = payload.get("materials") if isinstance(payload.get("materials"), list) else []
    if not materials and isinstance(meta.get("materials"), list):
        materials = meta["materials"]

    if not text and materials:
        chunks: list[str] = []
        for m in materials:
            if not isinstance(m, dict):
                continue
            name = str(m.get("name") or m.get("filename") or "材料")
            body = str(m.get("text") or m.get("result_text") or "").strip()
            if body:
                chunks.append(f"【{name}】\n{body}")
        text = "\n\n".join(chunks)

    return {
        "schema": str(payload.get("schema_version") or meta.get("schema_version") or "package_digest.v1"),
        "text": text,
        "materials": materials,
        "summary": summary,
        "elapsed_ms": elapsed_ms,
        "raw_present": bool(payload or text or materials),
    }


def job_urls(job_id: str) -> dict[str, str]:
    base = f"/api/v8/product/v1/{PRODUCT}/{job_id}"
    return {
        "status_url": base,
        "result_url": f"{base}/result",
    }


def status_payload(workload: Any, *, shards: list[Any] | None = None) -> dict[str, Any]:
    wid = str(getattr(workload, "id", "") or "")
    engine_status = getattr(workload, "status", None)
    if hasattr(engine_status, "value"):
        engine_status = engine_status.value
    status = map_status(str(engine_status or ""))
    urls = job_urls(wid)
    total = int(getattr(workload, "total_shards", 0) or 0)
    completed = int(getattr(workload, "completed_shards", 0) or 0)
    failed = int(getattr(workload, "failed_shards", 0) or 0)
    active_workers = 0
    phase = "queued"
    if status == "running":
        phase = "recognize"
    elif status == "done":
        phase = "merge"
    elif status in ("failed", "canceled"):
        phase = status
    elif total > 0 and completed == 0:
        phase = "dispatch"
    if shards is not None:
        workers: set[str] = set()
        live_done = 0
        live_failed = 0
        live_active = 0
        for sh in shards:
            st = getattr(sh, "status", None)
            if hasattr(st, "value"):
                st = st.value
            st_u = str(st or "").upper()
            if st_u == "DONE":
                live_done += 1
            elif st_u in ("FAILED", "CANCELLED", "CANCELED"):
                live_failed += 1
            elif st_u in ("DISPATCHED", "RUNNING"):
                live_active += 1
                wid_w = getattr(sh, "worker_id", None)
                if wid_w:
                    workers.add(str(wid_w))
        active_workers = len(workers)
        # 2026-08-05 · 产品进度以分片实况为准。
        # workload.completed_shards 依赖 aggregator 刷新，偶发滞后时律师屏会长期 0/N，
        # 而节点客户端已显示完成 —— 用 shards 计数纠正。
        if shards:
            total = max(total, len(shards))
            completed = live_done
            failed = live_failed
            if status == "running" and live_done > 0:
                phase = "recognize"
            elif status in ("queued", "created", "planned") and live_active > 0:
                phase = "dispatch"
    # progress 也跟实况走，避免圆环停在 0
    progress = float(getattr(workload, "progress", 0) or 0)
    if total > 0:
        progress = max(progress, completed / float(total))
    return {
        "ok": True,
        "api_version": API_VERSION,
        "product": PRODUCT,
        "job_id": wid,
        "status": status,
        "progress": progress,
        "total_shards": total,
        "completed_shards": completed,
        "failed_shards": failed,
        "error": str(getattr(workload, "error", "") or "") or None,
        "engine_task_type": ENGINE_TASK_TYPE,  # 只读调试字段；产品逻辑勿依赖
        # 增量字段：旧客户端忽略即可
        "dispatch_summary": {
            "phase": phase,
            "active_workers": active_workers,
            "completed": completed,
            "total": total,
            "failed": failed,
        },
        **urls,
    }


def result_payload(workload: Any) -> dict[str, Any]:
    base = status_payload(workload)
    if base["status"] != "done":
        raise RuntimeError(f"任务尚未完成: {base['status']}")
    extracted = extract_package_payload(workload)
    return {
        **base,
        "schema": extracted["schema"],
        "text": extracted["text"],
        "materials": extracted["materials"],
        "summary": extracted["summary"] or None,
        "elapsed_ms": extracted["elapsed_ms"],
    }
