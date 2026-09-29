"""
ordered_concat · 按 shard.index 排序后拼接文本

适用: pdf_to_text (按页范围分片 · 按页码顺序拼回完整文本)
      whisper_transcribe (按时段分片 · 按时间顺序拼字幕)
"""
from __future__ import annotations
import json
import logging

from platform_v8.core import Workload, Shard, WorkloadResult
from platform_v8.engine.aggregators.zip_files import load_shard_result as _load_shard_json

logger = logging.getLogger(__name__)


def aggregate_ordered_concat(workload: Workload, shards: list[Shard]) -> WorkloadResult:
    parts: list[str] = []
    elapsed_total = 0
    for sh in sorted(shards, key=lambda s: s.index):
        if not sh.output_ref:
            continue
        # 节点回报可能是内联 JSON、大结果 OSS object_key，或纯字符串。
        text = ""
        try:
            data = _load_shard_json(sh.output_ref)
            if isinstance(data, dict):
                text = data.get("text") or data.get("result_text") or data.get("summary_text") or ""
                elapsed_total += int(data.get("elapsed_ms", 0) or 0)
            else:
                text = str(data)
        except Exception:
            token = (sh.output_ref or "").strip()
            # object_key 拉取失败时不能把 key 冒充正文；纯文本仍保持兼容。
            if "/" in token and not any(c in token for c in " \t\r\n"):
                logger.exception(
                    "ordered_concat · shard=%s object_key 结果读取失败",
                    sh.index,
                )
                continue
            text = token
        parts.append(text)

    final = {
        "status": "ok",
        "schema_version": "v1",
        "task_type": workload.spec.task_type,
        "elapsed_ms": elapsed_total,
        "text": "\n".join(parts),
        "shard_count": len(shards),
        "summary_text": f"按顺序合并 {len(shards)} 个分片 · 共 {sum(len(p) for p in parts)} 字符",
    }
    return WorkloadResult(
        output_ref=json.dumps(final, ensure_ascii=False),
        summary=f"按 index 顺序合并 {len(shards)} 片",
        elapsed_ms=elapsed_total,
        metadata={"shard_count": len(shards), "strategy": "ordered_concat",
                  "total_chars": sum(len(p) for p in parts)},
    )
