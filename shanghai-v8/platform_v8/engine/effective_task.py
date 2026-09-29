"""Shard 级有效 task_type · 异构包编排向后兼容入口.

规则:
  effective = shard.metadata['task_type'] or workload.spec.task_type

无 metadata 覆盖时与历史行为完全一致。
"""
from __future__ import annotations


RUNTIME_CONTRACT_ID = "2026-08-13.delivery-evidence"  # keep in sync with platform_v8.runtime_contract.CONTRACT_ID

import hashlib
import logging
import os
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# 与 api/v8/scripts.py 同源候选路径 · 避免循环 import
_SCRIPT_DIR_CANDIDATES = (
    str(Path(__file__).resolve().parents[1] / "scripts" / "tasks"),
    "/opt/edge/platform_v8/scripts/tasks",
    "/opt/edge/backend/scripts/tasks",
    "/app/backend/scripts/tasks",
)


def effective_task_type(workload: Any = None, shard: Any = None) -> str:
    meta = getattr(shard, "metadata", None) or {}
    if isinstance(meta, dict):
        override = meta.get("task_type")
        if isinstance(override, str) and override.strip():
            return override.strip()
    spec = getattr(workload, "spec", None)
    return str(getattr(spec, "task_type", "") or "")


def default_code_url(task_type: str) -> str:
    """平台脚本默认 URL · 与 submit_workload 自动补全逻辑一致。"""
    from platform_v8.engine.task_registry import TASK_REGISTRY, get_spec

    get_spec(str(task_type or ""))

    registered = TASK_REGISTRY.get(str(task_type or ""))
    if registered is not None and (registered.requires_verified_adapter
                                   or getattr(registered, "official_provider_id", "")):
        return ""  # 已审适配器和官方独立执行器都不回退到平台 Python 脚本。
    if task_type == "video_generate":
        return ""  # 现役无对应脚本；不能生成指向 404 的可执行地址。
    if not task_type or task_type in ("shell", "llm_infer", "local_llm_chat", "package_digest"):
        return ""
    api_base = (
        os.environ.get("V8_PUBLIC_BASE_URL")
        or os.environ.get("PUBLIC_API_BASE")
        or "https://www.qianshousuanli.com"
    ).rstrip("/")
    return f"{api_base}/api/v8/scripts/{task_type}.py"


def legacy_python_fallback(task_type: str, code_url: str = "") -> str:
    """Return an executable Python fallback URL or an empty fail-closed result."""
    from platform_v8.engine.task_registry import TASK_REGISTRY, TaskMode, get_spec

    get_spec(str(task_type or ""))

    task = TASK_REGISTRY.get(str(task_type or ""))
    if task is None or task.mode != TaskMode.ONESHOT or task.requires_verified_adapter:
        return ""
    script_dir = _scripts_dir()
    if script_dir is None:
        return ""
    target = (script_dir / f"{task.task_type}.py").resolve()
    try:
        if not str(target).startswith(str(script_dir.resolve())) or not target.is_file():
            return ""
    except OSError:
        return ""
    return str(code_url or "").strip() or default_code_url(task.task_type)


def requires_python_executor(task_type: str, slice_meta: dict[str, Any] | None) -> bool:
    """Return true when a shard cannot honor its selector through native args."""
    meta = slice_meta if isinstance(slice_meta, dict) else {}
    if task_type != "pdf_to_text":
        return False
    has_percentage = (
        meta.get("page_pct_start") is not None
        and meta.get("page_pct_end") is not None
    )
    has_absolute_range = any(
        meta.get(key) is not None
        for key in ("page_start", "page_end", "start_page", "end_page")
    )
    # pdftotext cannot resolve percentages without first opening the PDF and
    # counting pages. The Python script already implements that conversion.
    return has_percentage and not has_absolute_range


def _scripts_dir() -> Path | None:
    env_dir = os.environ.get("EDGECOMPUTE_TASK_SCRIPTS_DIR")
    if env_dir and os.path.isdir(env_dir):
        return Path(env_dir)
    for c in _SCRIPT_DIR_CANDIDATES:
        if os.path.isdir(c):
            return Path(c)
    return None


def resolve_code_sha256(
    task_type: str,
    code_url: str = "",
    shard_meta: dict[str, Any] | None = None,
) -> str:
    """计算下发给节点的脚本 SHA256。

    优先级：
      1. shard.metadata['code_sha256'] / ['sha256']（市场包显式声明）
      2. 本地 scripts/tasks/{task_type}.py 文件摘要
      3. 从 code_url 路径推断脚本名再读盘
    找不到时返回空串（老客户端忽略；新客户端记 warn）。
    """
    meta = shard_meta if isinstance(shard_meta, dict) else {}
    for key in ("code_sha256", "sha256"):
        raw = str(meta.get(key) or "").strip().lower()
        if len(raw) == 64 and all(c in "0123456789abcdef" for c in raw):
            return raw

    script_dir = _scripts_dir()
    if script_dir is None:
        return ""

    names: list[str] = []
    if task_type and task_type not in ("shell", "package_digest"):
        names.append(f"{task_type}.py")
    if code_url:
        path = urlparse(code_url).path
        base = Path(path).name
        if base.endswith(".py") and base not in names:
            names.append(base)

    for name in names:
        target = (script_dir / name).resolve()
        try:
            if not str(target).startswith(str(script_dir.resolve())):
                continue
            if not target.is_file():
                continue
            digest = hashlib.sha256(target.read_bytes()).hexdigest()
            return digest
        except OSError as exc:
            logger.debug("resolve_code_sha256 · read %s failed: %s", name, exc)
    return ""


def resolve_dispatch_task(
    workload: Any,
    shard: Any,
) -> tuple[str, str, Any]:
    """返 (task_type, code_url, TaskTypeSpec|None)。

    若 shard 覆盖了 task_type, code_url 优先 metadata, 否则按有效类型生成脚本 URL。
    无覆盖时沿用 workload.spec.code_url。
    """
    from platform_v8.engine.task_registry import TASK_REGISTRY, get_spec

    meta = getattr(shard, "metadata", None) or {}
    if not isinstance(meta, dict):
        meta = {}
    tt = effective_task_type(workload, shard)
    get_spec(tt)
    overridden = bool(meta.get("task_type"))
    if overridden:
        code_url = str(meta.get("code_url") or "") or default_code_url(tt)
    else:
        code_url = str(getattr(getattr(workload, "spec", None), "code_url", "") or "")
        if not code_url:
            code_url = default_code_url(tt)
    return tt, code_url, TASK_REGISTRY.get(tt)


def resolve_shard_timeout_s(
    workload: Any,
    shard: Any = None,
    tr_spec: Any = None,
) -> int:
    """分片超时：metadata 覆盖 → 按页估算 → TaskTypeSpec.timeout_s → workload.spec.timeout_s."""
    meta = getattr(shard, "metadata", None) or {}
    if not isinstance(meta, dict):
        meta = {}
    raw = meta.get("timeout_s")
    if raw is not None:
        try:
            n = int(raw)
            if n > 0:
                return min(3600, n)
        except (TypeError, ValueError):
            pass

    # package 二次切片: 按本片页数动态估 (OCR 20s/页 · 文字 3s/页)
    try:
        part_pages = int(meta.get("part_pages") or 0)
    except (TypeError, ValueError):
        part_pages = 0
    if part_pages <= 0:
        sm = meta.get("slice_meta") or {}
        if isinstance(sm, dict) and sm.get("page_start") is not None and sm.get("page_end") is not None:
            try:
                part_pages = max(0, int(sm["page_end"]) - int(sm["page_start"]))
            except (TypeError, ValueError):
                part_pages = 0
    if part_pages > 0:
        tt = effective_task_type(workload, shard)
        per = 20 if tt == "pdf_ocr" else 3
        return max(60, min(3600, part_pages * per + 30))

    # page_pct 切片（planner 不知总页数）：按输入体积 × 百分比估超时，避免卡死干等 600s
    sm = meta.get("slice_meta") if isinstance(meta.get("slice_meta"), dict) else {}
    if sm and sm.get("page_pct_start") is not None and sm.get("page_pct_end") is not None:
        try:
            pct = max(0.01, float(sm["page_pct_end"]) - float(sm["page_pct_start"]))
        except (TypeError, ValueError):
            pct = 0.1
        params = meta.get("params") if isinstance(meta.get("params"), dict) else {}
        if not params:
            wl_spec = getattr(workload, "spec", None)
            params = dict(getattr(wl_spec, "params", None) or {})
        try:
            size = int(params.get("input_size") or 0)
        except (TypeError, ValueError):
            size = 0
        # 粗估：100KB/页 · OCR 约 15s/页；无体积时按 40 页 × pct
        est_pages = max(1, int((size * pct) / 100_000)) if size > 0 else max(1, int(40 * pct))
        tt = effective_task_type(workload, shard)
        per = 15 if tt == "pdf_ocr" else 3
        return max(90, min(480, est_pages * per + 45))

    if tr_spec is None:
        _, _, tr_spec = resolve_dispatch_task(workload, shard)
    spec_timeout = getattr(tr_spec, "timeout_s", None) if tr_spec is not None else None
    if spec_timeout is not None:
        try:
            n = int(spec_timeout)
            if n > 0:
                return n
        except (TypeError, ValueError):
            pass
    wl_spec = getattr(workload, "spec", None)
    try:
        n = int(getattr(wl_spec, "timeout_s", None) or 300)
    except (TypeError, ValueError):
        n = 300
    return n if n > 0 else 300


def soft_reclaim_dispatched_horizon_s(
    workload: Any,
    shard: Any = None,
    tr_spec: Any = None,
) -> int:
    """派发后等待节点开始执行的软回收窗口。"""
    return max(90, resolve_shard_timeout_s(workload, shard, tr_spec) + 45)


def soft_reclaim_running_horizon_s(
    workload: Any,
    shard: Any = None,
    tr_spec: Any = None,
) -> int:
    """运行态无进度时的软回收窗口，同时作为 PULL 执行租约基线。"""
    return max(180, resolve_shard_timeout_s(workload, shard, tr_spec) + 45)
