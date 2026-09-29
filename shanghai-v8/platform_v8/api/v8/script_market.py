"""
脚本市场只读视图 · /api/v8/script-market/*

设计要点 (P1-1 → P2 · 2026-05-24 · 完善计划第一+二阶段):
  - 数据源 = DB catalog (we_script_catalog) ∪ 文件系统扫描
  - catalog 优先 · 没有 catalog 记录的脚本回退到文件系统扫描 (向后兼容)
  - 节点拉脚本主链路完全不变 (/api/v8/scripts/{name} 直接读文件)
  - 任何 catalog 不可达异常 (DB 错) 自动回退文件扫描 · 保证服务可用

兼容:
  - 企业端 ScriptMarket.vue → axios.get('/script-market/list')
  - axiosInstance baseURL = /api/v8 → 实际命中 /api/v8/script-market/list

不破坏现有功能:
  - 不改 scripts.py
  - 不改 workloads / aggregator / ledger
  - DB 出错自动 fallback 到文件扫描
"""
from __future__ import annotations
import logging
import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_session
from platform_v8.api.v8.scripts import _resolve_scripts_dir, _ALLOWED_SCRIPT_EXTENSIONS
from platform_v8.services.scripts import catalog as catalog_svc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v8/script-market", tags=["script-market"])


_CATEGORY_PREFIX_MAP = (
    ("image_", "image"),
    ("audio_", "audio"),
    ("video_", "video"),
    ("ocr_", "ocr"),
    ("llm_", "ai"),
    ("hash_", "crypto"),
    ("md5_", "crypto"),
    ("crc32_", "crypto"),
    ("base64_", "encoding"),
    ("csv_", "data"),
    ("json_", "data"),
    ("blender_", "render"),
    ("pdf_", "doc"),
    ("text_", "text"),
    ("regex_", "text"),
    ("url_", "net"),
)


def _build_item(p: Path) -> dict:
    """文件 → 企业端 ScriptMarket 行项 (与现有 scripts.list_scripts 字段对齐 + 扩展)"""
    description = ""
    category = "general"
    try:
        content = p.read_text(encoding="utf-8", errors="ignore")[:2000]
        # 1. 优先匹配三引号 docstring 首行
        m = re.search(r'^("""|\'\'\')(.+?)\1', content, re.DOTALL | re.MULTILINE)
        if m:
            description = m.group(2).strip().split("\n")[0].strip()
        # 2. 否则取首个 # 注释
        if not description:
            for line in content.split("\n")[:20]:
                line = line.strip()
                if line.startswith("#") and not line.startswith("#!"):
                    description = line.lstrip("#").strip()
                    if description:
                        break
        # 3. 推断 category
        name_low = p.stem.lower()
        for prefix, cat in _CATEGORY_PREFIX_MAP:
            if name_low.startswith(prefix):
                category = cat
                break
    except Exception:
        pass

    stat = p.stat()
    return {
        "id": p.stem,
        "task_type": p.stem,
        "name": p.name,
        "description": description or f"{p.stem} 脚本",
        "category": category,
        "size": stat.st_size,
        "code_url": f"/api/v8/scripts/{p.name}",
        # 以下字段为前端兼容占位 (P2 接入真实统计)
        "used_count": 0,
        "created_at": datetime.fromtimestamp(stat.st_ctime, tz=timezone.utc).isoformat(),
        "updated_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        "preview": {"sandbox_elapsed_ms": None},
        "source_kind": "builtin",
        "version": "1.0.0",
        "status": "active",
    }


def _iter_scripts() -> list[Path]:
    script_dir = Path(_resolve_scripts_dir()).resolve()
    if not script_dir.exists():
        return []
    out: list[Path] = []
    for p in sorted(script_dir.iterdir()):
        if not p.is_file():
            continue
        if p.suffix.lower() not in _ALLOWED_SCRIPT_EXTENSIONS:
            continue
        out.append(p)
    return out


def _catalog_to_item(row: dict) -> dict:
    """catalog DB row → 企业端 ScriptMarket 行项"""
    return {
        "id": row["task_type"],   # 前端 ScriptMarket.vue 期望 id 字段做 key
        "catalog_id": int(row["id"]),
        "task_type": row["task_type"],
        "name": row["name"],
        "description": row["description"] or "",
        "category": row["category"] or "general",
        "size": int(row.get("size_bytes") or 0),
        "code_url": row["code_url"],
        "used_count": int(row.get("used_count") or 0),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
        "preview": {"sandbox_elapsed_ms": None},
        "source_kind": row.get("source_kind") or "builtin",
        "version": row.get("version") or "1.0.0",
        "status": row.get("status") or "active",
        "tags": row.get("tags") or [],
    }


def _list_from_db_then_fs(
    session: Session,
    q: str | None,
    category: str | None,
    limit: int,
) -> list[dict]:
    """
    DB catalog 优先 + 文件系统兜底合并:
      1) 先从 catalog 读所有 status='active' 的脚本
      2) 文件系统扫描 · 没在 catalog 中的脚本作为 builtin 补齐
      3) 应用 q / category 过滤
    任何 DB 异常 → 全部回退文件扫描 (业务连续性优先)
    """
    db_items: list[dict] = []
    db_active_task_types: set[str] = set()
    # 已知 task_types (含 active + disabled + archived) · 用于文件系统去重
    # 避免: catalog 标 disabled 的脚本被文件系统补齐回来 (bug fix 2026-05-24)
    known_task_types: set[str] = set()
    try:
        active_rows = catalog_svc.list_catalog(
            session, status="active", category=None, q=None,
            limit=500, offset=0,
        )
        for row in active_rows:
            it = _catalog_to_item(row)
            db_items.append(it)
            db_active_task_types.add(it["task_type"])
            known_task_types.add(it["task_type"])
        # 再拿 disabled / archived 的 task_types · 不返回但参与去重
        for st in ("disabled", "archived"):
            other_rows = catalog_svc.list_catalog(
                session, status=st, category=None, q=None,
                limit=500, offset=0,
            )
            for row in other_rows:
                known_task_types.add(row["task_type"])
    except Exception as exc:
        logger.warning("script_market.list · DB catalog 读取失败 (回退文件扫描): %s", exc)
        db_items = []
        db_active_task_types = set()
        known_task_types = set()

    # 文件系统补齐 (catalog 未录入的 · 不论 status 都跳过)
    fs_items: list[dict] = []
    for p in _iter_scripts():
        if p.stem in known_task_types:
            continue  # 已在 catalog (任意状态) · 跳过
        fs_items.append(_build_item(p))

    all_items = db_items + fs_items

    # 过滤
    out: list[dict] = []
    ql = q.lower() if q else None
    for it in all_items:
        if ql:
            if (ql not in (it.get("description") or "").lower()
                    and ql not in (it.get("task_type") or "").lower()
                    and ql not in (it.get("name") or "").lower()):
                continue
        if category and it.get("category") != category:
            continue
        out.append(it)
        if len(out) >= limit:
            break
    return out


@router.get("/list", summary="脚本市场列表 (企业端用 · 只读)")
async def script_market_list(
    q: str | None = Query(default=None, description="按 description / task_type / name 模糊匹配"),
    category: str | None = Query(default=None, description="按 category 过滤"),
    limit: int = Query(default=100, ge=1, le=500),
    session: Session = Depends(get_session),
) -> list[dict]:
    """企业端脚本市场页面用 · 列出所有可用脚本 (catalog 优先 · 文件兜底)。

    返回 list 而非 {ok, items} 包裹 · 兼容企业端 axios 直接 res.data 拿数组。
    """
    return _list_from_db_then_fs(session, q=q, category=category, limit=limit)


@router.get("/{task_type}", summary="脚本市场详情")
async def script_market_detail(
    task_type: str,
    session: Session = Depends(get_session),
) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9._-]+", task_type):
        raise HTTPException(status_code=400, detail="invalid task_type")

    # 1. catalog 优先
    #   - active   → 返 catalog 数据
    #   - disabled/archived → 明确 404 (管理员已隐藏 · 不允许文件兜底覆盖)
    #   - 不存在   → 走文件系统兜底
    try:
        row = catalog_svc.get_by_task_type(session, task_type)
    except Exception as exc:
        logger.warning("script_market.detail · DB catalog 失败 (回退文件): %s", exc)
        row = None

    if row is not None:
        if row.get("status") == "active":
            return _catalog_to_item(row)
        # disabled / archived → 公开 404 (但节点拉脚本 /api/v8/scripts/* 不受影响)
        raise HTTPException(status_code=404, detail=f"script {task_type} not available")

    # 2. 文件系统兜底 (仅当 catalog 中完全无记录)
    script_dir = Path(_resolve_scripts_dir()).resolve()
    target: Path | None = None
    for ext in (".py", ".sh", ".js", ".wasm"):
        candidate = (script_dir / f"{task_type}{ext}").resolve()
        if not str(candidate).startswith(str(script_dir)):
            continue
        if candidate.exists() and candidate.is_file():
            target = candidate
            break
    if target is None:
        raise HTTPException(status_code=404, detail=f"script {task_type} not found")

    return _build_item(target)
