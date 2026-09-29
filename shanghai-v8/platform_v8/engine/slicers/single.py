"""
single slicer · 永远返 1 个 shard · 整个输入给一个 worker

适用:
  - 单文件操作 (image_info, video_info)
  - 不可切分的任务 (dedup_lines · 跨片去重需要 round 2 · MVP 先不切)
  - 默认 fallback
"""
from __future__ import annotations
from platform_v8.core import Workload, Shard, ShardStatus
from platform_v8.engine.slicers.input_names import resolve_entry_name


def _input_entries(spec) -> list[dict]:
    """Use the trusted submit manifest instead of fabricating batch identity."""
    refs = list(spec.input_refs or ([spec.input_ref] if spec.input_ref else []))
    params = dict(spec.params or {})
    indexed = {
        str(item.get("object_key") or ""): dict(item)
        for item in (params.get("input_batch") or {}).get("entries", [])
        if isinstance(item, dict)
    }
    used_names: set[str] = set()
    return [
        {
            "id": str(item.get("id") or f"file:{index}"),
            "source_index": int(item.get("index", index)),
            "name": resolve_entry_name(
                ref, item, index=index, params=params, used=used_names,
            ),
            "object_key": str(item.get("object_key") or ref),
            "size_bytes": int(item.get("size_bytes") or 0),
            "sha256": str(item.get("sha256") or ""),
            "content_type": str(item.get("content_type") or "application/octet-stream"),
            "fetch_ref": "",
            "selector": {},
        }
        for index, ref in enumerate(refs)
        for item in [indexed.get(str(ref), {})]
    ]


def slice_single(workload: Workload, n_workers: int) -> list[Shard]:
    spec = workload.spec
    entries = _input_entries(spec)
    from platform_v8.engine.task_registry import get_spec

    task_meta = get_spec(spec.task_type)
    manifest_semantics = task_meta.batch_semantics
    if manifest_semantics == "none":
        manifest_semantics = "whole_set" if spec.input_refs else "per_item"
    sh = Shard(
        workload_id=workload.id,
        index=0,
        total=1,
        status=ShardStatus.PENDING,
        input_ref=spec.input_ref,  # 整 URL · 节点端 fetch 整个文件
        metadata={
            "slice_strategy": "single",
            "workload_name": workload.name,
            "input_kind": spec.input_kind or "single_file",
            # 多 URL / inline 也透传 (节点 v8_ws → executor 看 metadata)
            "input_refs": list(spec.input_refs) if spec.input_refs else [],
            "input_manifest": {
                "schema": "input_manifest.v1",
                "semantics": manifest_semantics,
                "total_entries": max(1, len(entries)),
                "entries": entries,
            },
            "files_in_shard": max(1, len(entries)),
            "inline_input": spec.inline_input,
            "params": dict(spec.params or {}),
        },
    )
    return [sh]
