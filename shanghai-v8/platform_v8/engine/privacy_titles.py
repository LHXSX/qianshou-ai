"""节点可见任务标题脱敏 · 不把真实案卷/文件名发给节点主。

律师端材料清单仍用 file_manifest；库内 workload.name 可保留对账信息，
但派发帧 / 节点历史 / 节点侧收益 note 一律走本模块。
"""
from __future__ import annotations

import re
from typing import Any

# 能力中文 · task_type → 展示名
_TASK_LABELS: dict[str, str] = {
    "pdf_to_text": "PDF转文本",
    "pdf_ocr": "文档识别",
    "pdf_info": "PDF解析",
    "docx_to_text": "文书提取",
    "doc_to_text": "文书提取",
    "image_ocr": "图像识别",
    "ocr_image": "图像识别",
    "package_digest": "律所材料识别",
    "material_digest": "律所材料识别",
    "case_digest": "卷宗摘要",
    "contract_review": "合同审查",
}

_RECIPE_LABELS: dict[str, str] = {
    "law_materials": "律所材料识别",
    "material_digest": "律所材料识别",
}

_FILE_EXT_RE = re.compile(
    r"\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|png|jpe?g|gif|webp|txt|csv|mp3|mp4|wav|mov)(\b|$)",
    re.IGNORECASE,
)


def qs_code(workload_id: str | None) -> str:
    raw = str(workload_id or "").replace("-", "").strip()
    return (raw[:6] or "000000").upper()


def capability_label(*, task_type: str | None = None, recipe: str | None = None) -> str:
    r = str(recipe or "").strip().lower()
    if r and r in _RECIPE_LABELS:
        return _RECIPE_LABELS[r]
    tt = str(task_type or "").strip().lower()
    if tt in _TASK_LABELS:
        return _TASK_LABELS[tt]
    if r in ("law_materials",) or tt.startswith("law_"):
        return "律所材料识别"
    return "算力任务"


def node_safe_workload_title(
    workload_id: str | None,
    *,
    task_type: str | None = None,
    recipe: str | None = None,
) -> str:
    """节点端标题：`{能力中文} · QS-{短码}`。"""
    return f"{capability_label(task_type=task_type, recipe=recipe)} · QS-{qs_code(workload_id)}"


def looks_like_filename(name: str | None) -> bool:
    """判断是否像敏感文件名（含扩展名 / 路径分隔）。"""
    s = str(name or "").strip()
    if not s:
        return False
    if "/" in s or "\\" in s:
        return True
    if _FILE_EXT_RE.search(s):
        return True
    return False


def _spec_fields(workload: Any) -> tuple[str | None, str | None]:
    spec = getattr(workload, "spec", None)
    task_type: str | None = None
    recipe: str | None = None
    if spec is None:
        return None, None
    if isinstance(spec, dict):
        task_type = spec.get("task_type")
        params = spec.get("params") or {}
        if isinstance(params, dict):
            recipe = params.get("recipe")
        return (
            str(task_type) if task_type else None,
            str(recipe) if recipe else None,
        )
    task_type = getattr(spec, "task_type", None)
    params = getattr(spec, "params", None) or {}
    if isinstance(params, dict):
        recipe = params.get("recipe")
    return (
        str(task_type) if task_type else None,
        str(recipe) if recipe else None,
    )


def title_for_workload(workload: Any) -> str:
    """从 Workload ORM/对象推导节点安全标题。"""
    wid = getattr(workload, "id", None)
    task_type, recipe = _spec_fields(workload)
    return node_safe_workload_title(str(wid) if wid is not None else "", task_type=task_type, recipe=recipe)


def opaque_create_name(
    workload_id: str | None,
    *,
    task_type: str | None = None,
    recipe: str | None = None,
) -> str:
    """创建后写入 DB 的专业名（与节点标题同形）。"""
    return node_safe_workload_title(workload_id, task_type=task_type, recipe=recipe)
