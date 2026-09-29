"""
manifest_only · 合并多片 metadata JSON · 不动文件

适用: pdf_info / video_info / image_info (每片产一份元数据 · 合并成表)
      llm_chat / ocr_image (每片处理一组 prompts/images · 合并 results 数组)

2026-07-21 · OCR / 校验类脚本常把正文放在 pages / result_text / result / rows，
而不是 results 列表。旧逻辑只收 results → 企业端下载变成「共 0 条记录」。
"""
from __future__ import annotations
import json
import logging

from platform_v8.core import Workload, Shard, WorkloadResult
from platform_v8.engine.aggregators.zip_files import load_shard_result as _load_shard_json
from platform_v8.services.result_envelope import wrap_plain_shard_result

logger = logging.getLogger(__name__)


def _as_list(value) -> list:
    if isinstance(value, list):
        return value
    return []


def aggregate_manifest_only(workload: Workload, shards: list[Shard]) -> WorkloadResult:
    all_results: list = []
    all_pages: list = []
    result_text_parts: list[str] = []
    elapsed_total = 0
    aggregated_summary: dict = {}

    for sh in sorted(shards, key=lambda s: s.index):
        if not sh.output_ref:
            continue
        try:
            data = _load_shard_json(sh.output_ref)
        except Exception as exc:
            # 2026-09-18 · 纯文本形状（全库 DONE 285 条）不是 JSON、也没有
            # object_key 的 "/"，load_shard_result 必然抛 ValueError。
            # 旧逻辑在这里 continue，把整片真实回答丢掉，最终合并成
            # {"summary":"合并 N 个分片 · 0 条记录","results":[],"result_text":""}。
            # 先尝试按纯文本包装；仍拿不到才保持原有 skip 行为。
            wrapped = wrap_plain_shard_result(sh.output_ref)
            if wrapped is None:
                logger.warning(
                    "manifest_only · shard=%s 结果 JSON 读取失败: %s",
                    sh.index,
                    exc,
                )
                continue
            logger.info(
                "manifest_only · shard=%s 按纯文本结果收纳 (%d 字)",
                sh.index,
                len(wrapped.get("shard_text") or ""),
            )
            data = wrapped
        if not isinstance(data, dict):
            continue

        # 收集每片的批量结果；兼容 results / result / rows / result_array
        shard_results = data.get("results")
        if not isinstance(shard_results, list):
            shard_results = data.get("result")
        if not isinstance(shard_results, list):
            shard_results = data.get("rows")
        if not isinstance(shard_results, list):
            shard_results = data.get("result_array")
        if isinstance(shard_results, list):
            all_results.extend(shard_results)

        pages = _as_list(data.get("pages"))
        if pages:
            all_pages.extend(pages)
            # OCR 页明细也并入 results，方便下载端统一消费
            for page in pages:
                if isinstance(page, dict):
                    all_results.append(page)

        text = data.get("result_text")
        if isinstance(text, str) and text.strip():
            result_text_parts.append(text.strip())

        # summary 数字字段累加
        for k, v in (data.get("summary", {}) or {}).items():
            if isinstance(v, (int, float)):
                aggregated_summary[k] = aggregated_summary.get(k, 0) + v
            else:
                aggregated_summary[k] = v

        elapsed_total += int(data.get("elapsed_ms", 0) or 0)

    # 去重：pages 已推进 results 时可能重复；保留顺序去重 dict 身份不适用，
    # 对 OCR 页用 (page, filename) 简单去重。
    deduped: list = []
    seen_page_keys: set = set()
    for item in all_results:
        if isinstance(item, dict) and ("page" in item or "filename" in item) and "line_detail" in item:
            key = (item.get("page"), item.get("filename"))
            if key in seen_page_keys:
                continue
            seen_page_keys.add(key)
        deduped.append(item)
    all_results = deduped

    merged_text = "\n\n".join(result_text_parts).strip()
    if not merged_text and all_pages:
        # 从 pages.line_detail 回拼可读正文
        chunks: list[str] = []
        for page in all_pages:
            if not isinstance(page, dict):
                continue
            header = page.get("filename") or f"第{page.get('page', '?')}页"
            lines = []
            for ld in _as_list(page.get("line_detail")):
                if isinstance(ld, dict) and ld.get("text"):
                    lines.append(str(ld["text"]))
            if lines:
                chunks.append(f"【{header}】\n" + "\n".join(lines))
        merged_text = "\n\n".join(chunks).strip()

    final = {
        "status": "ok",
        "schema_version": "v1",
        "task_type": workload.spec.task_type,
        "elapsed_ms": elapsed_total,
        "shard_count": len(shards),
        "summary": aggregated_summary,
        "results": all_results,
        "pages": all_pages,
        "result_text": merged_text,
        "summary_text": (
            f"合并 {len(shards)} 个分片 · 共 {len(all_results)} 条记录"
            + (f" · {len(merged_text)} 字" if merged_text else "")
        ),
    }
    return WorkloadResult(
        output_ref=json.dumps(final, ensure_ascii=False),
        summary=f"合并 {len(shards)} 个分片 · {len(all_results)} 条记录",
        elapsed_ms=elapsed_total,
        metadata={"shard_count": len(shards), "strategy": "manifest_only",
                  "total_records": len(all_results)},
    )
