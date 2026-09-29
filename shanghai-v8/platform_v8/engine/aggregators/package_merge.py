"""package_merge · 异构材料分片 → 保序聚合文本.

输出契约 package_digest.v1 (律所 / 其它产品共用).
同 material_index 的页切片按 page_part_index 拼回一条材料.
批片 (metadata.batch_items): 一片多材料 · 按结果拆回多条材料.
"""
from __future__ import annotations

import json
import logging
import os
import re
from collections import defaultdict

from platform_v8.core import Workload, Shard, WorkloadResult, ShardStatus
from platform_v8.engine.aggregators.zip_files import load_shard_result as _load_shard_json

logger = logging.getLogger(__name__)


def _extract_text(data: dict) -> str:
    if not isinstance(data, dict):
        return ""
    for key in ("result_text", "text", "inline_output", "summary_text"):
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    # pages / line_detail / text_pages
    for pages_key in ("pages", "text_pages"):
        pages = data.get(pages_key)
        if isinstance(pages, list) and pages:
            chunks = []
            for page in pages:
                if not isinstance(page, dict):
                    continue
                lines = []
                for ld in page.get("line_detail") or page.get("lines") or []:
                    if isinstance(ld, dict) and ld.get("text"):
                        lines.append(str(ld["text"]))
                    elif isinstance(ld, str) and ld.strip():
                        lines.append(ld.strip())
                if lines:
                    chunks.append("\n".join(lines))
                elif page.get("text"):
                    chunks.append(str(page["text"]))
            if chunks:
                return "\n".join(chunks).strip()
    # results[].text
    results = data.get("results")
    if isinstance(results, list):
        parts = []
        for item in results:
            if isinstance(item, dict) and item.get("text"):
                parts.append(str(item["text"]))
            elif isinstance(item, str) and item.strip():
                parts.append(item.strip())
        if parts:
            return "\n".join(parts).strip()
    lines = data.get("result_lines")
    if isinstance(lines, list):
        return "\n".join(str(x) for x in lines if x).strip()
    return ""


def _item_text_from_result(item: dict) -> str:
    """单文件 OCR/抽取结果 → 文本。"""
    if not isinstance(item, dict):
        return ""
    for key in ("text", "result_text"):
        val = item.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    pages = item.get("text_pages") or item.get("pages")
    if isinstance(pages, list):
        chunks = []
        for page in pages:
            if isinstance(page, dict) and page.get("text"):
                chunks.append(str(page["text"]))
        if chunks:
            return "\n".join(chunks).strip()
    return ""


def _basename_key(name: str) -> str:
    base = os.path.basename(str(name or "")).strip().lower()
    # 客户端 multi_file 落盘名: 000-xxx.pdf → 去掉序号前缀再比
    if len(base) > 4 and base[3:4] == "-" and base[:3].isdigit():
        base = base[4:]
    return base


_OCR_IMAGE_PAGE_MARK = re.compile(
    r"【第\d+页:([^】]+)】(?:\([^)]*\))?\n?"
)


def _split_ocr_image_result_text(result_text: str) -> list[dict]:
    """ocr_image 合成文本 → [{filename, text}, ...]（按标记拆）。"""
    text = result_text or ""
    matches = list(_OCR_IMAGE_PAGE_MARK.finditer(text))
    if not matches:
        return []
    out: list[dict] = []
    for i, m in enumerate(matches):
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        out.append({
            "filename": m.group(1).strip(),
            "text": text[start:end].strip(),
        })
    return out


def _match_batch_payloads(
    batch_items: list[dict],
    data: dict | None,
) -> list[tuple[dict, dict | None, str]]:
    """返 [(batch_item, result_or_none, error)]."""
    data = data if isinstance(data, dict) else {}
    # pdf_ocr / pdf_to_text → results[]; ocr_image → result_text 页标记 / pages[]
    ordered: list[dict] = []
    results = data.get("results")
    if isinstance(results, list) and results:
        ordered = [x for x in results if isinstance(x, dict)]
    else:
        ordered = _split_ocr_image_result_text(str(data.get("result_text") or ""))
        if not ordered and isinstance(data.get("pages"), list):
            # 兜底: pages[].filename 顺序 + 整段 result_text（仅 1 材料时有用）
            for pg in data["pages"]:
                if not isinstance(pg, dict):
                    continue
                fn = str(pg.get("filename") or "")
                piece = ""
                if pg.get("text"):
                    piece = str(pg["text"])
                else:
                    lines = []
                    for ld in pg.get("line_detail") or []:
                        if isinstance(ld, dict) and ld.get("text"):
                            lines.append(str(ld["text"]))
                    piece = "\n".join(lines)
                ordered.append({"filename": fn, "text": piece.strip()})

    by_name: dict[str, dict] = {}
    for r in ordered:
        fn = str(r.get("filename") or r.get("name") or "")
        if fn:
            by_name[_basename_key(fn)] = r
            by_name[os.path.basename(fn).lower()] = r

    err_by_name: dict[str, str] = {}
    for e in (data.get("errors") or []):
        if not isinstance(e, dict):
            continue
        fn = str(e.get("filename") or "")
        if fn:
            err_by_name[_basename_key(fn)] = str(e.get("error") or "item_failed")

    out: list[tuple[dict, dict | None, str]] = []
    for i, item in enumerate(batch_items):
        name = str(item.get("material_name") or "")
        key = _basename_key(name)
        matched = by_name.get(key)
        if matched is None and i < len(ordered):
            matched = ordered[i]
        if matched is not None:
            text = _item_text_from_result(matched)
            if text.strip():
                out.append((item, matched, ""))
            else:
                out.append((item, matched, err_by_name.get(key) or "empty_ocr_text"))
        else:
            out.append((item, None, err_by_name.get(key) or "missing_in_batch_result"))
    return out


def _shard_text(sh: Shard) -> tuple[str, str, bool]:
    """返 (text, error, ok)。"""
    if sh.status == ShardStatus.DONE and sh.output_ref:
        try:
            data = _load_shard_json(sh.output_ref)
            text = _extract_text(data if isinstance(data, dict) else {})
            ok = bool(text.strip())
            return text, ("" if ok else "empty_ocr_text"), ok
        except Exception as exc:
            return "", f"parse_error: {exc}", False
    err = sh.error or f"shard_status={getattr(sh.status, 'value', sh.status)}"
    return "", err, False


def _expand_shard_materials(sh: Shard) -> list[dict]:
    """一片 → 1..N 条材料记录（批片拆开）。"""
    meta = sh.metadata or {}
    batch_items = meta.get("batch_items") or []
    task = str(meta.get("task_type") or "")

    if not (meta.get("batch") and isinstance(batch_items, list) and batch_items):
        text, err, ok = _shard_text(sh)
        return [{
            "name": str(meta.get("material_name") or f"material_{meta.get('material_index', sh.index)}"),
            "index": int(meta.get("material_index", sh.index) or 0),
            "type": str(meta.get("material_ext") or ""),
            "task": task,
            "ok": ok and bool(text),
            "chars": len(text),
            "text": text if ok else "",
            "error": "" if (ok and text) else (err or "empty_ocr_text"),
            "page_parts": 1,
            "batched": False,
        }]

    # 批片
    data = None
    load_err = ""
    if sh.status == ShardStatus.DONE and sh.output_ref:
        try:
            data = _load_shard_json(sh.output_ref)
        except Exception as exc:
            load_err = f"parse_error: {exc}"
    elif sh.status != ShardStatus.DONE:
        load_err = sh.error or f"shard_status={getattr(sh.status, 'value', sh.status)}"

    materials: list[dict] = []
    if data is None:
        for item in batch_items:
            if not isinstance(item, dict):
                continue
            materials.append({
                "name": str(item.get("material_name") or "unknown"),
                "index": int(item.get("material_index") or 0),
                "type": str(item.get("material_ext") or ""),
                "task": str(item.get("task_type") or task),
                "ok": False,
                "chars": 0,
                "text": "",
                "error": load_err or "batch_shard_failed",
                "page_parts": 1,
                "batched": True,
            })
        return materials

    for item, _matched, err in _match_batch_payloads(
        [x for x in batch_items if isinstance(x, dict)],
        data if isinstance(data, dict) else {},
    ):
        text = _item_text_from_result(_matched) if _matched else ""
        ok = bool(text.strip()) and not err
        materials.append({
            "name": str(item.get("material_name") or "unknown"),
            "index": int(item.get("material_index") or 0),
            "type": str(item.get("material_ext") or ""),
            "task": str(item.get("task_type") or task),
            "ok": ok,
            "chars": len(text) if ok else 0,
            "text": text if ok else "",
            "error": "" if ok else (err or "empty_ocr_text"),
            "page_parts": 1,
            "batched": True,
        })
    return materials


def aggregate_package_merge(workload: Workload, shards: list[Shard]) -> WorkloadResult:
    recipe = ""
    skipped: list[dict] = []
    # material_index → 页切片列表（非批）或批展开后直接进 materials
    groups: dict[int, list[Shard]] = defaultdict(list)
    batch_materials: list[dict] = []

    for sh in shards:
        meta = sh.metadata or {}
        if not recipe:
            recipe = str(meta.get("recipe") or "")
        for item in meta.get("skipped_materials") or []:
            if isinstance(item, dict):
                skipped.append(item)
        if meta.get("batch") and meta.get("batch_items"):
            batch_materials.extend(_expand_shard_materials(sh))
            continue
        idx = int(meta.get("material_index", sh.index) or 0)
        groups[idx].append(sh)

    materials: list[dict] = []
    for idx in sorted(groups.keys()):
        parts = sorted(
            groups[idx],
            key=lambda s: (
                int((s.metadata or {}).get("page_part_index", s.index) or 0),
                s.index,
            ),
        )
        meta0 = parts[0].metadata or {}
        name = str(meta0.get("material_name") or f"material_{idx}")
        ext = str(meta0.get("material_ext") or "")
        task = str(meta0.get("task_type") or "")

        texts: list[str] = []
        errs: list[str] = []
        any_ok = False
        for sh in parts:
            text, err, ok = _shard_text(sh)
            if ok:
                any_ok = True
                texts.append(text)
            elif err:
                errs.append(err)

        text = "\n".join(t for t in texts if t).strip()
        ok = any_ok and bool(text)
        materials.append({
            "name": name,
            "index": idx,
            "type": ext,
            "task": task,
            "ok": ok,
            "chars": len(text),
            "text": text,
            "error": "" if ok else ("; ".join(errs) or "empty_ocr_text"),
            "page_parts": len(parts),
            "batched": False,
        })

    materials.extend(batch_materials)

    for item in skipped:
        materials.append({
            "name": item.get("name") or "unknown",
            "index": item.get("index", 10_000),
            "type": item.get("type") or "",
            "task": item.get("task") or "",
            "ok": False,
            "chars": 0,
            "text": "",
            "error": item.get("error") or "skipped",
            "page_parts": 0,
            "batched": False,
        })

    # 同 index 合并（页切 + 偶发重复）
    by_idx: dict[int, dict] = {}
    for m in materials:
        idx = int(m.get("index") or 0)
        prev = by_idx.get(idx)
        if prev is None:
            by_idx[idx] = m
            continue
        # 拼文本
        if m.get("ok") and m.get("text"):
            if prev.get("ok") and prev.get("text"):
                prev["text"] = (prev["text"] + "\n" + m["text"]).strip()
                prev["chars"] = len(prev["text"])
            else:
                by_idx[idx] = {**m, "page_parts": int(prev.get("page_parts") or 0) + int(m.get("page_parts") or 0)}
                continue
            prev["page_parts"] = int(prev.get("page_parts") or 0) + int(m.get("page_parts") or 0)
        elif not prev.get("ok") and m.get("error"):
            prev["error"] = "; ".join(
                x for x in (prev.get("error"), m.get("error")) if x
            )

    materials = sorted(by_idx.values(), key=lambda m: int(m.get("index") or 0))

    segments = []
    for i, m in enumerate(materials):
        if not m.get("ok"):
            continue
        label = m.get("name") or f"材料{i + 1}"
        segments.append(f"【材料 {i + 1}：{label}】\n{m.get('text') or ''}")

    result_text = "\n\n".join(segments).strip()
    ok_n = sum(1 for m in materials if m.get("ok"))
    fail_n = len(materials) - ok_n
    if ok_n == 0:
        status = "failed"
    elif fail_n > 0:
        status = "partial"
    else:
        status = "ok"

    payload = {
        "status": status,
        "schema_version": "package_digest.v1",
        "recipe": recipe or (workload.spec.params or {}).get("recipe") or "law_materials",
        "result_text": result_text,
        "materials": materials,
        "summary": {
            "total": len(materials),
            "ok": ok_n,
            "failed": fail_n,
            "shards": len(shards),
            "batched_materials": sum(1 for m in materials if m.get("batched")),
        },
        "task_type": workload.spec.task_type,
    }

    summary_line = f"package_digest · {ok_n}/{len(materials)} 材料成功"
    return WorkloadResult(
        output_ref=json.dumps(payload, ensure_ascii=False),
        summary=summary_line,
        elapsed_ms=sum(int(s.elapsed_ms or 0) for s in shards),
        metadata={
            "strategy": "package_merge",
            "schema_version": "package_digest.v1",
            "ok": ok_n,
            "failed": fail_n,
            "inline_json": payload,
            "result_text": result_text,
        },
    )
