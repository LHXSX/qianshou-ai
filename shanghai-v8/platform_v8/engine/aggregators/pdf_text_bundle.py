"""PDF 转文本聚合器：页序合并、单文件预览/下载、多文件 ZIP 交付。"""
from __future__ import annotations

import io
import json
import os
import zipfile
from collections import defaultdict

from platform_v8.core import Shard, Workload, WorkloadResult
from platform_v8.engine.aggregators.zip_files import (
    load_shard_result as _load_shard_json,
    _upload_preview_to_oss,
    _upload_to_oss,
)


def _safe_stem(filename: str, fallback: str) -> str:
    stem = os.path.splitext(os.path.basename(filename or fallback))[0]
    return stem.replace("/", "_").replace("\\", "_") or fallback


def aggregate_pdf_text_bundle(workload: Workload, shards: list[Shard]) -> WorkloadResult:
    """将片级 ``pdf_to_text`` JSON 聚合成用户可交付的文本 artifact。

    片可来自同一 PDF 的页切片，也可来自 multi_file 的文件切片。按文件名、实际页
    码而非仅 shard index 排序，避免重派/异步完成打乱正文顺序。
    """
    by_file: dict[str, list[dict]] = defaultdict(list)
    errors: list[dict] = []
    elapsed_ms = 0
    for shard in sorted(shards, key=lambda s: s.index):
        if not shard.output_ref:
            errors.append({"shard": shard.index, "error": "分片未返回结果"})
            continue
        try:
            payload = _load_shard_json(shard.output_ref)
        except Exception as exc:
            errors.append({"shard": shard.index, "error": f"读取结果失败: {exc}"})
            continue
        elapsed_ms += int(payload.get("elapsed_ms", 0) or 0)
        for item in payload.get("results") or []:
            if isinstance(item, dict):
                by_file[str(item.get("filename") or f"input-{shard.index}.pdf")].append(item)
        for error in payload.get("errors") or []:
            errors.append({"shard": shard.index, **(error if isinstance(error, dict) else {"error": str(error)})})

    files: list[dict] = []
    outputs: dict[str, bytes] = {}
    for filename, items in sorted(by_file.items()):
        pages: dict[int, str] = {}
        route = ""
        backend = ""
        page_total = 0
        for item in items:
            route = route or str(item.get("route") or "")
            backend = backend or str(item.get("backend") or "")
            page_total = max(page_total, int(item.get("pages_total") or 0))
            for page in item.get("text_pages") or []:
                try:
                    page_no = int(page.get("page"))
                except (TypeError, ValueError):
                    continue
                # 相同页的后到结果不能覆盖先到成功结果。
                pages.setdefault(page_no, str(page.get("text") or ""))
        text = "\n\n".join(pages[p] for p in sorted(pages)).strip() + "\n"
        stem = _safe_stem(filename, f"pdf-{len(files) + 1}")
        txt_name = f"{stem}.txt"
        md_name = f"{stem}.md"
        outputs[txt_name] = text.encode("utf-8")
        outputs[md_name] = "\n".join(
            f"## 第 {page}\n\n{pages[page]}" for page in sorted(pages)
        ).encode("utf-8")
        files.append({
            "filename": filename,
            "pages_total": page_total,
            "pages_extracted": len(pages),
            "missing_pages": [p for p in range(1, page_total + 1) if p not in pages] if page_total else [],
            "chars": len(text),
            "route": route,
            "backend": backend,
            "text_preview": text[:4000],
            "txt_name": txt_name,
            "md_name": md_name,
        })

    if not files:
        payload = {"status": "failed", "task_type": workload.spec.task_type, "errors": errors}
        return WorkloadResult(output_ref=json.dumps(payload, ensure_ascii=False), summary="PDF 文本聚合失败", elapsed_ms=elapsed_ms)

    manifest = {
        "schema_version": "pdf-text-result.v1",
        "workload_id": str(workload.id),
        "task_type": workload.spec.task_type,
        "files": files,
        "errors": errors,
    }
    multi = len(files) > 1
    if multi:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, data in outputs.items():
                archive.writestr(name, data)
            archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        download_url = _upload_to_oss(buf.getvalue(), workload)
        preview_url = ""
        delivery = "zip"
    else:
        only = files[0]
        download_url = _upload_preview_to_oss(only["txt_name"], outputs[only["txt_name"]], workload)
        preview_url = download_url
        delivery = "text"

    payload = {
        "status": "ok",
        "schema_version": "pdf-text-result.v1",
        "task_type": workload.spec.task_type,
        "elapsed_ms": elapsed_ms,
        "delivery": delivery,
        "download_url": download_url,
        "preview_url": preview_url,
        "files": files,
        "errors": errors,
        "summary_text": f"已完成 {len(files)} 个 PDF · {'结果 ZIP' if multi else '可预览并下载文本'}",
    }
    return WorkloadResult(
        output_ref=json.dumps(payload, ensure_ascii=False),
        summary=payload["summary_text"],
        elapsed_ms=elapsed_ms,
        metadata={"strategy": "pdf_text_bundle", "file_count": len(files), "manifest": manifest},
    )
