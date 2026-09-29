"""
v8 scripts router · GET /api/v8/scripts/{name}

提供任务脚本下载 · 节点端 run_script 用 code_url 拉这个 endpoint

设计:
  - 复用老 backend/scripts/tasks/ 目录 (30+ 个真实脚本 · dedup_lines / base64_encode / ...)
  - 通过 env EDGECOMPUTE_TASK_SCRIPTS_DIR 配置 (跟 v1 一致)
  - 公开 (不需鉴权 · 节点拉脚本是公开行为)

v8 submit_workload 时 · 如果 code_url 为空 · 自动 resolve 成:
  https://qianshousuanli.com/api/v8/scripts/{task_type}.py
"""
from __future__ import annotations
import logging
import os
import re
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_session

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v8/scripts", tags=["scripts"])


# 脚本目录定位 · 优先 env · 否则按候选路径自动探测
# v8.0.0 起 · 脚本随 platform_v8 走 · 不再依赖老 backend/
# 候选 (按优先级):
#   1) <repo>/platform_v8/scripts/tasks       (v8.0.0 统一架构 · 主路径)
#   2) /opt/edge/platform_v8/scripts/tasks    (线上 host python 部署)
#   3) /opt/edge/backend/scripts/tasks        (v1 兼容 · 老 host 部署)
#   4) /app/backend/scripts/tasks             (v1 兼容 · 老 docker 内路径)
def _resolve_scripts_dir() -> str:
    env_dir = os.environ.get("EDGECOMPUTE_TASK_SCRIPTS_DIR")
    if env_dir and os.path.isdir(env_dir):
        return env_dir
    candidates = [
        str(Path(__file__).resolve().parents[2] / "scripts" / "tasks"),  # platform_v8/scripts/tasks
        "/opt/edge/platform_v8/scripts/tasks",
        "/opt/edge/backend/scripts/tasks",
        "/app/backend/scripts/tasks",
    ]
    for c in candidates:
        if os.path.isdir(c):
            return c
    return candidates[0]  # 兜底 · list 时会返 total=0 dir=...


_TASK_SCRIPTS_DIR = _resolve_scripts_dir()
_ALLOWED_SCRIPT_EXTENSIONS = {".py", ".sh", ".js", ".wasm"}

# 危险/运维脚本黑名单 · 永不通过公开 endpoint 下发 (防 RCE / 信息泄露)
#   exec        : exec(sys.stdin.read()) · 任意代码执行向量
#   debug_repo  : import /app 持久层 · 节点端必崩 + 泄露内部结构
#   diag/sdiag/winfix/mini : 纯诊断/运维 · 不是算力任务 · 可能泄露宿主信息
#   pack_*      : 打包/构建运维脚本
_DENY_SCRIPTS = {
    "exec", "debug_repo", "diag", "sdiag", "winfix", "mini",
    "pack_v2", "pack_win_venvs", "submit_package_digest",
    "verify_client_release", "sync_client_manifests",
}

# 企业端技能广场分类（与 apps/enterprise-agent/src/services/skills.ts
# SKILL_CATEGORIES 对齐）。task_registry.category 是调度/文档 taxonomy
#（text/doc/compute），且 get_spec 未命中时回落 DEFAULT_SPEC.category="text"，
# 不能直接当广场分类，否则大量脚本会掉进不存在的「text」桶。
_PLAZA_PREFIX_CATEGORIES = (
    ("image_", "image"),
    ("audio_", "audio"),
    ("video_", "video"),
    ("ocr_", "ocr"),
    ("llm_", "ai"),
    ("hash_", "crypto"),
    ("base64_", "encoding"),
    ("csv_", "data"),
    ("json_", "data"),
    ("pdf_", "data"),
    ("crawl_", "crawl"),
    ("blender_", "render"),
    ("render", "render"),
)

# 前缀会分错、但广场要归到 AI 推理的显式覆盖
_PLAZA_CATEGORY_OVERRIDES = {
    "audio_transcribe_refine": "ai",
    "local_llm_chat": "ai",
    "whisper_transcribe": "ai",
    "image_caption": "ai",
    "video_analyze": "ai",
    "embedding": "ai",
}


def _plaza_category(task_type: str) -> str:
    """技能广场展示用 category · 与 task_registry 调度分类解耦。"""
    if task_type in _PLAZA_CATEGORY_OVERRIDES:
        return _PLAZA_CATEGORY_OVERRIDES[task_type]
    for prefix, cat in _PLAZA_PREFIX_CATEGORIES:
        if task_type.startswith(prefix):
            return cat
    return "general"


@router.get("/{name}", response_class=PlainTextResponse,
            summary="下载任务脚本 (节点端 run_script 用)")
async def serve_task_script(name: str):
    """
    节点拉取任务脚本 · 例:
      GET /api/v8/scripts/dedup_lines.py
      GET /api/v8/scripts/base64_encode.py

    自动补 .py 后缀: 不带后缀也接受 (例: dedup_lines)

    安全:
      - 文件名仅允许 [A-Za-z0-9._-]
      - 必须在 _TASK_SCRIPTS_DIR 下 (防路径遍历)
      - 仅 .py/.sh/.js/.wasm 后缀
    """
    if not re.fullmatch(r"[A-Za-z0-9._-]+", name):
        raise HTTPException(status_code=400, detail="invalid script name")

    # 自动补 .py
    if "." not in name:
        name = f"{name}.py"

    if name.startswith(".") or name.startswith("._") or Path(name).stem.startswith("._"):
        raise HTTPException(status_code=400, detail="invalid script name")

    if Path(name).suffix.lower() not in _ALLOWED_SCRIPT_EXTENSIONS:
        raise HTTPException(status_code=400, detail="unsupported script type")

    # 黑名单拦截 · 危险/运维脚本不下发 (按 stem 比对 · 防 RCE)
    if Path(name).stem in _DENY_SCRIPTS:
        logger.warning("v8.scripts · 拒绝下发受限脚本 %s", name)
        raise HTTPException(status_code=403, detail="restricted script")

    script_dir = Path(_TASK_SCRIPTS_DIR).resolve()
    target = (script_dir / name).resolve()
    try:
        target.relative_to(script_dir)
    except ValueError:
        raise HTTPException(status_code=400, detail="path traversal blocked")
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail=f"script {name} not found")

    logger.info("v8.scripts · serve %s", name)
    return FileResponse(
        path=str(target),
        media_type="text/plain; charset=utf-8",
        filename=name,
    )


@router.get("/{name}/source", response_class=PlainTextResponse,
            summary="下载任务脚本 (v1 兼容 alias · enterprise-client / 旧节点用 /source 后缀)")
async def serve_task_script_source(name: str):
    """v1 兼容 · 老客户端用 GET /api/v8/scripts/{name}/source"""
    return await serve_task_script(name)


@router.get("", summary="列出所有可用脚本")
async def list_scripts(session: Session = Depends(get_session)) -> dict:
    """列出 _TASK_SCRIPTS_DIR 下所有合法脚本"""
    script_dir = Path(_TASK_SCRIPTS_DIR).resolve()
    if not script_dir.exists():
        return {"total": 0, "items": [], "dir": str(script_dir)}

    import re as _re
    # 保留原广场的分类/字段协议，只过滤管理员在 catalog 中屏蔽的 task_type。
    # catalog 不可用时 fail-open，避免技能广场整体不可用。
    disabled_task_types: set[str] = set()
    try:
        from platform_v8.services.scripts import catalog as catalog_svc
        disabled_task_types = {
            row["task_type"]
            for row in catalog_svc.list_catalog(session, status="disabled", limit=500, offset=0)
        }
    except Exception as exc:
        logger.warning("scripts · 读取屏蔽技能失败，保持全部可见: %s", exc)
    items = []
    for p in sorted(script_dir.iterdir()):
        if not p.is_file() or p.is_symlink():
            continue
        # 跳过 macOS AppleDouble / 隐藏文件（._xxx.py 会被当成假技能进广场）
        if p.name.startswith(".") or p.name.startswith("._"):
            continue
        if p.suffix.lower() not in _ALLOWED_SCRIPT_EXTENSIONS:
            continue
        if p.stem in _DENY_SCRIPTS:  # 危险/运维脚本不进列表
            continue
        # stem 仍可能是 "._foo"（极少见命名）；再挡一层
        if p.stem.startswith(".") or p.stem.startswith("._"):
            continue
        if p.stem in disabled_task_types:
            continue
        # 提取脚本顶部 docstring 作为 description
        description = ""
        try:
            content = p.read_text(encoding="utf-8", errors="ignore")[:2000]
            # 1. 优先匹配 """xxx""" 或 '''xxx'''
            m = _re.search(r'^("""|\'\'\')(.+?)\1', content, _re.DOTALL | _re.MULTILINE)
            if m:
                description = m.group(2).strip().split("\n")[0].strip()
            # 2. 否则 # 第一行注释
            if not description:
                for line in content.split("\n")[:20]:
                    line = line.strip()
                    if line.startswith("#") and not line.startswith("#!"):
                        description = line.lstrip("#").strip()
                        if description:
                            break
        except Exception:
            pass

        # 广场分类：前缀 + 少量 AI 覆盖（勿用 task_registry.category）
        category = _plaza_category(p.stem)

        # V8.1 · 查 task_registry · 取 (required_tier, fallback_tiers)
        # 老客户端 (8.0.x) 拿到这两字段 ignore · 完全向后兼容
        # 未显式注册的脚本走 get_spec → DEFAULT_SPEC（含 multi_file/archive）
        required_tier = ""
        fallback_tiers: list[str] = []
        accepted_input_kinds: list[str] = []
        slicer = "single"
        max_shards_limit = 1
        batch_semantics = "none"
        archive_formats: list[str] = []
        min_input_files = 0
        max_input_files = 0
        max_files_per_shard = 0
        settlement_policy = "quarantine"
        try:
            from platform_v8.engine.task_registry import (
                get_spec, resolve_tier_routing,
                compute_origin_fields,
            )
            spec = get_spec(p.stem)
            rt, fbs = resolve_tier_routing(spec)
            required_tier = rt
            fallback_tiers = list(fbs)
            accepted_input_kinds = list(spec.accepted_input_kinds)
            slicer = spec.slicer
            max_shards_limit = int(spec.max_shards_limit)
            batch_semantics = spec.batch_semantics
            archive_formats = list(spec.archive_formats)
            min_input_files = int(spec.min_input_files)
            max_input_files = int(spec.max_input_files)
            max_files_per_shard = int(spec.max_files_per_shard)
            settlement_policy = spec.settlement_policy
        except Exception as e:  # 防 task_registry 失败影响列表 API
            logger.debug("scripts · resolve_tier_routing 失败: %s · 用空", e)

        items.append({
            "name": p.name,
            "task_type": p.stem,
            "description": description or f"{p.stem} 脚本",
            "category": category,
            "size": p.stat().st_size,
            "url": f"/api/v8/scripts/{p.name}",
            # V8.1 · 节点 v8.1.0+ 用此字段路由到 venvs/<tier>/bin/python · 老节点 ignore
            "required_tier": required_tier,
            "fallback_tiers": fallback_tiers,
            # 企业端据此生成输入协议，并把所有可切片任务交给后端自动扩片。
            "accepted_input_kinds": accepted_input_kinds,
            "slicer": slicer,
            "max_shards_limit": max_shards_limit,
            "batch_semantics": batch_semantics,
            "archive_formats": archive_formats,
            "min_input_files": min_input_files,
            "max_input_files": max_input_files,
            "max_files_per_shard": max_files_per_shard,
            "settlement_policy": settlement_policy,
            **compute_origin_fields(spec),  # 2026-09-18 · 算力归属 (加法字段)
        })

    return {"total": len(items), "items": items, "dir": str(script_dir)}
