"""应用市场上架包 CDN URL 约定（对齐 cdn_config）。"""
from __future__ import annotations

from platform_v8.core.cdn_config import MODELS_CDN_BASE, RELEASES_CDN_BASE

# dl 域用于脚本/元数据包；models 域用于模型权重
MARKETPLACE_DL_BASE = RELEASES_CDN_BASE.replace("/releases", "/marketplace")
MARKETPLACE_MODELS_BASE = f"{MODELS_CDN_BASE.rstrip('/')}/marketplace"


def script_bundle_url(slug: str, version: str) -> str:
    return f"{MARKETPLACE_DL_BASE.rstrip('/')}/apps/{slug}/{version}/bundle.json"


def model_bundle_url(slug: str, version: str, filename: str = "model.onnx") -> str:
    return f"{MARKETPLACE_MODELS_BASE.rstrip('/')}/{slug}/{version}/{filename}"
