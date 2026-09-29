"""
lines_merge · 合并 N 个 shard 的 result_lines / duplicate_groups / summary

适用: word_count / json_filter / hash_batch / embedding (多片输出条目列表)

合并策略 (按 task_type 决定):
  - word_count: result_lines 是 "word\\tcount" · 按 word 累加 count 后重排
  - hash_batch: result_lines 是 "<hash>\\t<raw>" · extend (每行独立 hash 没冲突)
  - json_filter: result_lines 是 JSON 行 · extend (顺序拼接)
  - embedding / line_count / 其他: extend (默认安全合并)
"""
from __future__ import annotations
import json
import logging

from platform_v8.core import Workload, Shard, WorkloadResult
from platform_v8.engine.aggregators.zip_files import load_shard_result as _load_shard_json
from platform_v8.services.result_envelope import wrap_plain_shard_result

logger = logging.getLogger(__name__)


# task_type → "key_value_sum" 合并语义 (按 \t 分 key/value · value 当 int 累加)
_KV_SUM_TASKS = {"word_count"}


def _merge_kv_sum(all_lines: list[str], top_n: int = 1000) -> list[str]:
    """合并 'key\\tcount' 行 · 按 key sum count · 输出按 count desc 取 top N"""
    counter: dict = {}
    for ln in all_lines:
        if not ln or "\t" not in ln:
            continue
        k, _, v = ln.partition("\t")
        try:
            n = int(v)
        except (ValueError, TypeError):
            continue
        counter[k] = counter.get(k, 0) + n
    sorted_items = sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))
    return [f"{k}\t{n}" for k, n in sorted_items[:top_n]]


def aggregate_lines_merge(workload: Workload, shards: list[Shard]) -> WorkloadResult:
    all_lines: list = []
    all_results: list = []
    merged_summary: dict = {}
    merged_groups: list = []
    columns = None
    capability = ""
    legacy_task_type = ""

    elapsed_total = 0
    for sh in sorted(shards, key=lambda s: s.index):
        if not sh.output_ref:
            continue
        try:
            data = _load_shard_json(sh.output_ref)
        except Exception as exc:
            # 2026-09-18 · 纯文本形状先按文本收纳，避免整片被静默丢弃；
            # 仍拿不到才保持原有 skip 行为。
            wrapped = wrap_plain_shard_result(sh.output_ref)
            if wrapped is None:
                logger.warning("lines_merge · shard %s 结果 JSON 读取失败 · skip: %s", sh.id, exc)
                continue
            data = wrapped

        if columns is None and isinstance(data.get("columns"), list) and data["columns"]:
            columns = data["columns"]
        if not capability and isinstance(data.get("capability"), str):
            capability = data["capability"]
        if not legacy_task_type and isinstance(data.get("legacyTaskType"), str):
            legacy_task_type = data["legacyTaskType"]

        all_lines.extend(data.get("result_lines", []) or [])
        merged_groups.extend(data.get("duplicate_groups", []) or [])

        # 2026-09-18 · 纯文本分片（result_text 无 result_lines）也要计入，
        # 否则包装后仍会被下游判成 0 条。
        _plain = data.get("result_text")
        if (
            isinstance(_plain, str)
            and _plain.strip()
            and not isinstance(data.get("result_lines"), list)
        ):
            all_lines.append(_plain.strip())

        shard_results = data.get("results")
        if not isinstance(shard_results, list):
            shard_results = data.get("result")
        got_result_objects = (
            isinstance(shard_results, list)
            and shard_results
            and isinstance(shard_results[0], dict)
        )
        if got_result_objects:
            all_results.extend(item for item in shard_results if isinstance(item, dict))

        # 兼容脚本用 results / result / rows 而不是 result_lines
        # (hash_batch → results · json_validate → result · csv skill → rows)
        if not data.get("result_lines") and not got_result_objects:
            for key in ("results", "result", "rows", "result_array"):
                alt = data.get(key)
                if not isinstance(alt, list) or not alt:
                    continue
                for item in alt:
                    if isinstance(item, str):
                        all_lines.append(item)
                    else:
                        try:
                            all_lines.append(json.dumps(item, ensure_ascii=False))
                        except Exception:
                            all_lines.append(str(item))
                break

        # summary 字段加总 (数字字段累加 · 哈希字段保留最后一个)
        #   注意:部分 task (如 hash_batch) 的 summary 是字符串而非 dict ·
        #   不能无脑 .items() · 否则 finalize 全程崩溃 → workload 永远卡 RUNNING
        raw_summary = data.get("summary", {}) or {}
        if isinstance(raw_summary, dict):
            for k, v in raw_summary.items():
                if isinstance(v, (int, float)):
                    merged_summary[k] = merged_summary.get(k, 0) + v
                else:
                    merged_summary[k] = v
        elif raw_summary:
            # summary 非 dict (字符串等) · 保留为文本 · 不丢信息
            merged_summary["summary_text"] = str(raw_summary)

        # 脚本自带 summary_text · 保留首个非空（便于下载端做人读文本）
        st = data.get("summary_text")
        if isinstance(st, str) and st.strip() and "summary_text" not in merged_summary:
            merged_summary["summary_text"] = st.strip()

        elapsed_total += int(data.get("elapsed_ms", 0) or 0)

    # 2026-05-23 B5 · 按 task_type 切换合并语义
    task_type = workload.spec.task_type
    if task_type in _KV_SUM_TASKS:
        merged_lines = _merge_kv_sum(all_lines)
        # 重算 unique_tokens / top_n_returned (因为这些是按合并后定义的)
        merged_summary["unique_tokens"] = len(merged_lines)
        merged_summary["top_n_returned"] = len(merged_lines)
        # top1_token 重算
        if merged_lines:
            top1 = merged_lines[0].partition("\t")[0]
            merged_summary["top1_token"] = top1
    else:
        merged_lines = all_lines

    n_items = len(all_results) if all_results else len(merged_lines)
    final = {
        "status": "ok",
        "schema_version": "v1",
        "task_type": task_type,
        "elapsed_ms": elapsed_total,
        "summary": merged_summary,
        "result_lines": merged_lines,
        "duplicate_groups": merged_groups,
        "summary_text": f"合并 {len(shards)} 个分片 · 共 {n_items} 条结果",
    }
    if all_results:
        final["results"] = all_results
    if columns:
        final["columns"] = columns
    if capability:
        final["capability"] = capability
    if legacy_task_type:
        final["legacyTaskType"] = legacy_task_type
    return WorkloadResult(
        output_ref=json.dumps(final, ensure_ascii=False),
        summary=f"合并 {len(shards)} 个分片 · {n_items} 条结果",
        elapsed_ms=elapsed_total,
        metadata={"shard_count": len(shards), "strategy": "lines_merge",
                  "total_lines": n_items,
                  "kv_sum_applied": task_type in _KV_SUM_TASKS},
    )
