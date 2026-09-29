"""
v8 技能集下发 · 给节点客户端拉取 skill zip

设计:
  节点 RuntimePanel 装完一个 tier 的 pip 依赖后 · 按 tier.skills[] 列表
  逐个 GET /api/v8/skills/{id}/download 拉 skill 文件 zip · 校验 sha256 ·
  解压到 ~/.local/lib/edgecompute/skills/{id}/

为什么不用 git clone / rsync:
  - 节点机器墙 + 不允许装 git
  - sha256 校验比 git 签名简单
  - HTTP 走 nginx 缓存 + ETag 比 git 高效

为什么不用 tauri bundle resources:
  - 一旦把 skills 打进 .app/.exe · 改 skill 必须重发版客户端
  - skill 应该跟着后端走 · 服务端改完立刻能下发到所有在线节点

endpoint:
  GET /api/v8/skills                     列所有可下发 skill 概要
  GET /api/v8/skills/{id}/manifest       单 skill manifest.json (不下文件)
  GET /api/v8/skills/{id}/download       application/zip + Header X-Skill-Sha256
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import zipfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse, Response

logger = logging.getLogger("v8.skills")
router = APIRouter(prefix="/api/v8", tags=["v8-skills"])

# 仓库根 = platform_v8/../  · skills 目录在 <repo>/skills/
_SKILLS_ROOT = Path(__file__).resolve().parents[3] / "skills"
# v2 共享 runtime · 打到每个 skill zip 根的 _runtime/ 下
_SHARED_RUNTIME = _SKILLS_ROOT / "_runtime"

# 内部目录 / 特殊目录 · 不算 skill pack
_NON_PACK_DIRS = {"_runtime", "__pycache__", ".pytest_cache", ".venv", "venv", ".git"}


def _list_skill_dirs() -> list[Path]:
    if not _SKILLS_ROOT.exists():
        return []
    return sorted(
        p for p in _SKILLS_ROOT.iterdir()
        if p.is_dir()
        and p.name not in _NON_PACK_DIRS
        and (p / "manifest.json").is_file()
    )


def _read_manifest(skill_dir: Path) -> dict[str, Any] | None:
    mf = skill_dir / "manifest.json"
    try:
        return json.loads(mf.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("skill manifest 损坏: %s · %s", mf, exc)
        return None


# 2026-05-28 · v2 manifest 用 pack_id/pack_name 等 · v1 用 id/name · 这里统一兼容
def _mf_pack_id(m: dict[str, Any], fallback: str) -> str:
    return m.get("pack_id") or m.get("id") or fallback


def _mf_pack_name(m: dict[str, Any], fallback: str) -> str:
    return m.get("pack_name") or m.get("name") or fallback


def _mf_pack_version(m: dict[str, Any]) -> str:
    return str(m.get("pack_version") or m.get("version") or "0.0.0")


def _mf_pack_icon(m: dict[str, Any]) -> str:
    return m.get("pack_icon") or m.get("icon") or ""


def _mf_pack_description(m: dict[str, Any]) -> str:
    return m.get("pack_description") or m.get("description") or ""


def _should_pack_file(name: str, suffix_lower: str) -> bool:
    """判断文件是否打入 zip · 共用规则"""
    if name.startswith(".") or name.startswith("test_"):
        return False
    if name.endswith(".pyc"):
        return False
    allow_ext = {".py", ".json", ".md", ".txt", ".yaml", ".yml"}
    if suffix_lower not in allow_ext and name not in ("requirements.txt", "README.md"):
        return False
    return True


def _add_dir_to_zip(zf: zipfile.ZipFile, src_dir: Path, dest_prefix: str) -> None:
    """递归把 src_dir 加进 zip · arcname 加 dest_prefix(空串则放 zip 根)"""
    for p in sorted(src_dir.rglob("*")):
        if not p.is_file() or p.is_symlink():
            continue
        rel_parts = p.relative_to(src_dir).parts
        if any(part.startswith(".") or part in ("__pycache__", "venv") for part in rel_parts):
            continue
        if not _should_pack_file(p.name, p.suffix.lower()):
            continue
        rel = "/".join(rel_parts)
        arcname = f"{dest_prefix}/{rel}" if dest_prefix else rel
        zf.write(p, arcname=arcname)


def _build_skill_zip(skill_dir: Path) -> tuple[bytes, str]:
    """
    把 skill 目录打成内存 zip · 返回 (bytes, sha256_hex)

    打包内容:
      - skill_dir 自身: manifest.json + .py + README + requirements + ...
      - 共享 _runtime/ → zip 根 _runtime/ (v2 节点端 import 必需)
        (跳: skill 目录里若有 _runtime · 防止重复)
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        # 1. skill 自身
        _add_dir_to_zip(zf, skill_dir, dest_prefix="")
        # 2. 共享 _runtime/(v2 manifest 才需要 · 但打进去也兼容 v1 · 旧节点不读这个目录)
        if _SHARED_RUNTIME.exists() and _SHARED_RUNTIME.is_dir():
            # 防止 skill 目录里也有 _runtime · 重复 add 会触发 zip 警告
            if not (skill_dir / "_runtime").exists():
                _add_dir_to_zip(zf, _SHARED_RUNTIME, dest_prefix="_runtime")
    data = buf.getvalue()
    sha = hashlib.sha256(data).hexdigest()
    return data, sha


@router.get("/skills", summary="可下发技能集清单")
def list_skills() -> dict[str, Any]:
    """节点 RuntimePanel 装完 tier 后 · 调用此 endpoint 看可拉哪些 skill"""
    items: list[dict[str, Any]] = []
    for d in _list_skill_dirs():
        m = _read_manifest(d)
        if m is None:
            continue
        try:
            zdata, zsha = _build_skill_zip(d)
            pid = _mf_pack_id(m, d.name)
            items.append({
                "id": pid,
                "name": _mf_pack_name(m, d.name),
                "version": _mf_pack_version(m),
                "icon": _mf_pack_icon(m),
                "description": _mf_pack_description(m),
                "tools_count": len(m.get("tools", [])),
                "size_bytes": len(zdata),
                "sha256": zsha,
                "download_url": f"/api/v8/skills/{pid}/download",
            })
        except Exception as exc:
            logger.exception("打包 skill 失败 %s · %s", d, exc)
    return {"ok": True, "total": len(items), "skills": items}


@router.get("/skills/{skill_id}/manifest", summary="单 skill manifest")
def get_skill_manifest(skill_id: str) -> Any:
    for d in _list_skill_dirs():
        m = _read_manifest(d)
        if m and _mf_pack_id(m, d.name) == skill_id:
            return {"ok": True, "manifest": m}
    return JSONResponse(
        status_code=404,
        content={"ok": False, "code": "skill_not_found", "message": f"skill '{skill_id}' 不存在"},
    )


@router.get(
    "/skills/{skill_id}/download",
    summary="下载 skill zip · 含 sha256 校验头",
    response_class=Response,
)
def download_skill(skill_id: str) -> Response:
    """
    返回:
      200 + application/zip + Header X-Skill-Sha256: <hex> + ETag
      404 skill 不存在
    """
    for d in _list_skill_dirs():
        m = _read_manifest(d)
        if not m or _mf_pack_id(m, d.name) != skill_id:
            continue
        try:
            zdata, zsha = _build_skill_zip(d)
        except Exception as exc:
            logger.exception("打包 skill 失败 %s · %s", d, exc)
            return JSONResponse(
                status_code=500,
                content={"ok": False, "code": "skill_pack_fail", "message": str(exc)},
            )
        return Response(
            content=zdata,
            media_type="application/zip",
            headers={
                "X-Skill-Sha256": zsha,
                "X-Skill-Id": skill_id,
                "X-Skill-Version": _mf_pack_version(m),
                "ETag": f'W/"{zsha}"',
                "Cache-Control": "public, max-age=300",
                "Content-Disposition": f'attachment; filename="{skill_id}.zip"',
            },
        )
    return JSONResponse(
        status_code=404,
        content={"ok": False, "code": "skill_not_found", "message": f"skill '{skill_id}' 不存在"},
    )
