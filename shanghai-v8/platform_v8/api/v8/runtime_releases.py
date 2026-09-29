"""Optional static Runtime Release hosting for explicitly configured deployments.

Requires both EDGE_SERVE_RUNTIME_RELEASES=1 and EDGE_RUNTIME_RELEASES_DIR.
Disabled by default; no source-tree directory is served implicitly.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter
from fastapi.staticfiles import StaticFiles

logger = logging.getLogger("platform_v8.runtime_releases")

router = APIRouter(tags=["runtime-releases"])


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "on", "yes")


def resolve_releases_dir() -> Path | None:
    raw = (os.environ.get("EDGE_RUNTIME_RELEASES_DIR") or "").strip()
    if not raw:
        return None
    p = Path(raw).expanduser()
    if not p.is_dir():
        return None
    try:
        next(p.iterdir())
    except StopIteration:
        return None
    except OSError:
        return None
    return p


def _is_release_dir(p: Path) -> bool:
    if not p.is_dir() or p.name.startswith("."):
        return False
    if p.name in {"eco-updates", "index"}:
        return False
    return (p / "runtime-release.json").is_file()


def _pick_latest(versions: list[str]) -> str | None:
    if not versions:
        return None
    arm = [v for v in versions if "macos-arm64" in v]
    if arm:
        return arm[-1]
    return versions[-1]


def mount_if_configured(app) -> bool:
    """在 FastAPI app 上挂载 StaticFiles；成功返回 True。"""
    if not _env_flag("EDGE_SERVE_RUNTIME_RELEASES"):
        return False
    root = resolve_releases_dir()
    if root is None:
        logger.warning(
            "EDGE_SERVE_RUNTIME_RELEASES 已开但目录不存在/为空 · 跳过挂载"
        )
        return False
    app.mount(
        "/static/runtime-releases",
        StaticFiles(directory=str(root), html=False),
        name="runtime_releases",
    )
    logger.info("✓ Runtime releases 静态目录 · %s → /static/runtime-releases", root)
    eco = root / "eco-updates"
    if eco.is_dir():
        app.mount(
            "/static/eco-updates",
            StaticFiles(directory=str(eco), html=False),
            name="eco_updates",
        )
        logger.info("✓ 生态客户端热更新 · %s → /static/eco-updates", eco)
    return True


@router.get("/api/v8/runtime-releases/info")
def runtime_releases_info():
    enabled = _env_flag("EDGE_SERVE_RUNTIME_RELEASES")
    root = resolve_releases_dir() if enabled else None
    versions: list[str] = []
    if root is not None:
        versions = sorted(p.name for p in root.iterdir() if _is_release_dir(p))
    latest = _pick_latest(versions)
    public_base = (os.environ.get("EDGE_RUNTIME_RELEASES_PUBLIC_BASE_URL") or "").strip().rstrip("/")
    parsed = urlsplit(public_base)
    if (parsed.scheme not in {"http", "https"} or not parsed.netloc
            or parsed.username or parsed.password or parsed.query or parsed.fragment):
        public_base = ""
    return {
        "ok": True,
        "enabled": enabled and root is not None,
        "mount": "/static/runtime-releases",
        "eco_updates_mount": "/static/eco-updates",
        "versions": versions,
        "latest": latest,
        "lan_example": (
            f"{public_base}/static/runtime-releases/{latest}/runtime-release.json"
            if latest and public_base
            else None
        ),
    }
