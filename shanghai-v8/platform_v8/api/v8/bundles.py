"""
v8 工具包 (bundles) + 客户端更新路由

含:
  GET /api/v8/bundles                                       工具包清单 (节点客户端工具管理页用)
  GET /api/v8/client/updates/{target}/{arch}/{version}     客户端版本检查
"""
from __future__ import annotations
import json
import logging
import os
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from platform_v8 import __version__
from platform_v8.core.cdn_config import (
    ASSET_MIRROR_BASE,
    MODELS_CDN_BASE,
    RELEASES_CDN_BASE,
    RUNTIME_CDN_BASE,
)

logger = logging.getLogger("v8.bundles")
router = APIRouter(prefix="/api/v8", tags=["v8-bundles"])


# ════════════════════════════════════════════════════════════════════
# 工具包静态清单 (从 v1 simple_server._RUNTIME_BUNDLES 迁移过来)
#
# 每个 bundle 描述: 节点客户端拉到后会按 deps 自动安装/检测依赖
# 客户端结构对应 client-v3/src/composables/useBundles.ts Bundle interface
# ════════════════════════════════════════════════════════════════════
_BUNDLES: list[dict[str, Any]] = [
    {
        "id": "builtin-basic",
        "name": "内置基础计算",
        "icon": "⚡",
        "desc": "零依赖内置执行器。支持数学计算、文本去重、数据清洗、加密校验等通用 CPU 任务。",
        "platform": "any",
        "task_types": [
            "echo", "compute_pi", "hash", "data_clean", "sleep",
            "dedup_lines", "data_dedup", "text_extract", "csv_transform",
            "sha256_batch", "md5_batch",
        ],
        "deps": [],
    },
    {
        "id": "python-image-v1",
        "name": "图片批量处理工具包",
        "icon": "🖼",
        "desc": "自动安装 Pillow。支持批量缩放、加水印、生成缩略图、格式转换 (JPG/PNG/WebP)。",
        "platform": "any",
        "task_types": [
            "image_resize", "image_watermark", "image_thumbnail",
            "image_compress", "image_convert", "image_batch_rename",
        ],
        "deps": [
            {
                "name": "Pillow",
                "check": "python3 -c 'import PIL; print(PIL.__version__)'",
                "install": "pip3 install Pillow",
                "install_sources": [
                    {"label": "默认 PyPI", "cmd": "pip3 install Pillow"},
                    {"label": "清华源", "cmd": "pip3 install -i https://pypi.tuna.tsinghua.edu.cn/simple Pillow"},
                    {"label": "阿里源", "cmd": "pip3 install -i https://mirrors.aliyun.com/pypi/simple Pillow"},
                ],
                "required": True,
            },
        ],
    },
    {
        "id": "ffmpeg-video-v1",
        "name": "视频处理工具包",
        "icon": "🎬",
        "desc": "支持视频转码、截帧、压缩、剪辑、提取音频、添加水印。常用于短视频、广告素材批量制作。",
        "platform": "any",
        "task_types": [
            "video_transcode", "video_thumbnail", "audio_extract",
            "video_compress", "video_trim", "video_watermark",
        ],
        "deps": [
            {
                "name": "ffmpeg",
                "check": "ffmpeg -version",
                "install": None,
                "install_sources": [
                    {"label": "macOS (Homebrew)", "cmd": "brew install ffmpeg", "needs_password": False},
                    {"label": "Ubuntu/Debian", "cmd": "sudo apt-get install -y ffmpeg", "needs_password": True},
                    {"label": "Windows", "cmd": "winget install -e --id Gyan.FFmpeg", "manual": True},
                ],
                "required": True,
            },
        ],
    },
    {
        "id": "python-ml-lite-v1",
        "name": "AI 模型批量推理",
        "icon": "🧠",
        "desc": "自动安装 onnxruntime + numpy。支持 ONNX 模型批量推理、文本分类、图片分类、向量嵌入。",
        "platform": "any",
        "task_types": [
            "model_feed", "onnx_infer", "batch_predict",
            "embedding", "text_classify", "image_classify",
        ],
        "deps": [
            {
                "name": "numpy",
                "check": "python3 -c 'import numpy; print(numpy.__version__)'",
                "install": "pip3 install numpy",
                "install_sources": [
                    {"label": "默认 PyPI", "cmd": "pip3 install numpy"},
                    {"label": "清华源", "cmd": "pip3 install -i https://pypi.tuna.tsinghua.edu.cn/simple numpy"},
                ],
                "required": True,
            },
            {
                "name": "onnxruntime",
                "check": "python3 -c 'import onnxruntime; print(onnxruntime.__version__)'",
                "install": "pip3 install onnxruntime",
                "install_sources": [
                    {"label": "默认 PyPI", "cmd": "pip3 install onnxruntime"},
                    {"label": "清华源", "cmd": "pip3 install -i https://pypi.tuna.tsinghua.edu.cn/simple onnxruntime"},
                ],
                "required": True,
            },
        ],
    },
    {
        "id": "ocr-tools-v1",
        "name": "OCR 文本识别工具包",
        "icon": "🔍",
        "desc": "图片/PDF/发票/身份证 OCR。基于 paddleocr 或 tesseract。",
        "platform": "any",
        "task_types": [
            "ocr_extract", "ocr_invoice", "ocr_id_card", "ocr_table",
            "pdf_to_text", "invoice_parse",
        ],
        "deps": [
            {
                "name": "paddleocr",
                "check": "python3 -c 'import paddleocr'",
                "install": "pip3 install paddleocr",
                "install_sources": [
                    {"label": "清华源", "cmd": "pip3 install -i https://pypi.tuna.tsinghua.edu.cn/simple paddleocr"},
                ],
                "required": False,
            },
        ],
    },
    {
        "id": "render-tools-v1",
        "name": "3D 渲染工具包",
        "icon": "🎨",
        "desc": "Blender 帧渲染、视频合成。适合动画、视觉特效批量渲染。",
        "platform": "any",
        "task_types": ["blender_render", "blender_info", "render_split", "frame_compose"],
        "deps": [
            {
                "name": "blender",
                "check": "blender --version",
                "install": None,
                "install_sources": [
                    {"label": "macOS", "cmd": "brew install --cask blender"},
                    {"label": "Ubuntu", "cmd": "sudo snap install blender --classic"},
                    {"label": "Windows", "cmd": "winget install -e --id BlenderFoundation.Blender", "manual": True},
                ],
                "required": True,
            },
        ],
    },
]


@router.get("/health", summary="健康检查 · 运维/监控/LB 探活")
def health() -> dict[str, Any]:
    """轻量健康检查:DB 必检 · Redis 尽力探 · 返版本。任何子检查失败都不抛异常。"""
    import time as _t
    checks: dict[str, str] = {}
    db_ok = False
    try:
        from platform_v8.storage.db import session_scope
        from sqlalchemy import text as _text
        with session_scope() as s:
            s.execute(_text("SELECT 1"))
        checks["db"] = "ok"; db_ok = True
    except Exception as e:
        checks["db"] = f"fail: {str(e)[:80]}"
    try:
        import os as _os, redis as _redis  # type: ignore
        _r = _redis.from_url(_os.environ.get("REDIS_URL") or "redis://127.0.0.1:6379/0",
                             socket_connect_timeout=2)
        _r.ping(); checks["redis"] = "ok"
    except Exception as e:
        checks["redis"] = f"skip: {str(e)[:60]}"
    return {
        "ok": db_ok, "service": "edge-backend", "version": __version__,
        "checks": checks, "ts": _t.strftime("%Y-%m-%d %H:%M:%S"),
    }


@router.get("/bundles", summary="工具包清单")
def list_bundles() -> dict[str, Any]:
    """节点客户端"工具管理"页拉清单 + 检测本地依赖安装情况"""
    return {"ok": True, "bundles": _BUNDLES, "total": len(_BUNDLES)}


@router.get("/bundles/{bundle_id}", summary="单个工具包详情")
def get_bundle(bundle_id: str) -> Any:
    for b in _BUNDLES:
        if b["id"] == bundle_id:
            return {"ok": True, "bundle": b}
    from platform_v8.api.errors import ErrorCode
    return JSONResponse(status_code=404, content={
        "ok": False, "code": ErrorCode.RESOURCE_NOT_FOUND.value,
        "message": f"bundle '{bundle_id}' 不存在",
    })


# ════════════════════════════════════════════════════════════════════
# 客户端版本检查
# ════════════════════════════════════════════════════════════════════
# 最新客户端版本 · fallback 兜底 (binary.json / release.json 均不可读时用)
# 2026-06-19 · 与 release.json / client-v3 Cargo.toml 同步
LATEST_CLIENT_VERSION = "8.3.0"


def _version_tuple(v: str) -> tuple:
    """统一解析纯数字、生态 rc/beta 版本，供 OTA 比较。"""
    text = str(v or "").strip()
    # 兼容 eco-3.0.0-rc.6、3.0.0-rc.12、8.4.3 等历史格式。
    m = re.search(r"(?<!\d)(\d+)\.(\d+)\.(\d+)(?:[-.]([A-Za-z]+)[.-]?(\d+)?)?", text)
    if not m:
        return (0, 0, 0, 0, 0)
    major, minor, patch = (int(m.group(i)) for i in (1, 2, 3))
    tag = (m.group(4) or "").lower()
    serial = int(m.group(5) or 0)
    # 正式版高于预览版；同一预览通道按序号递增。
    if not tag:
        return (major, minor, patch, 1, 0)
    rank = {"dev": -3, "alpha": -2, "a": -2, "beta": -1, "b": -1, "rc": 0}.get(tag, 0)
    return (major, minor, patch, 0, rank * 1_000_000 + serial)


# ════════════════════════════════════════════════════════════════════
# Runtime Manifest · OSS 预打包依赖镜像
#
# 设计 (2026-05-20):
#   节点不再 brew/pip install (墙 + 50% 失败)
#   改成从 OSS 拉预打包 tarball · curl + tar 装到 ~/.qianshou/runtime/
#
#   分 3 层:
#     python  必装 · portable Python 3.11 (~30 MB · 跟系统 Python 隔离)
#     lite    必装 · pillow + numpy + onnxruntime + ffmpeg (~70 MB)
#     ocr     可选 · paddleocr + 训好模型 (~180 MB)
#     3d      可选 · blender portable (~380 MB)
#
#   节点 toolbox.rs 拉 manifest → 并行下载 → 校验 sha256 → 解压
#   节点 executor.rs spawn 脚本时:
#     PYTHONPATH=~/.qianshou/runtime/lite/site-packages:~/.qianshou/runtime/ocr/site-packages
#     PATH=~/.qianshou/runtime/lite/bin:$PATH
#     ~/.qianshou/runtime/python/bin/python3 script.py
# ════════════════════════════════════════════════════════════════════

# 镜像服务器 endpoint (2026-06-19 重构 · OSS 改造 edgecompute bucket)
#
# 新架构(2026-06-19):
#   - OSS bucket = edgecompute(华南 oss-cn-guangzhou · 私有 · BPA on)
#   - 4 个 CDN 域映射到不同 prefix(原样回源):
#       dl.qianshousuanli.com/releases/...    → edgecompute/releases/...    客户端 OTA 包
#       by.qianshousuanli.com/runtime/...     → edgecompute/runtime/...     ffmpeg/uv/python/pypi
#       models.qianshousuanli.com/models/...  → edgecompute/models/...      ONNX 模型
#       oss.qianshousuanli.com/uploads/...    → edgecompute/uploads/...     企业上传(私密 · 走 STS)
#
# 兜底主源:走 platform 签名 302
#   www.qianshousuanli.com/api/v8/oss/asset-mirror/<key>
#     → 后端用主 AK/SK 给私有 bucket 签 V1 GET URL
#     → 302 重定向到 edgecompute.oss-cn-guangzhou.aliyuncs.com/<key>?sign=...
#   节点 curl -L 自动 follow · CDN 失败时走这个

# CDN 主域 · 定义见 platform_v8/core/cdn_config.py (2026-06-19 定稿)
# 平台签名 302 兜底(BPA-on bucket · CDN 失败时可用)
RUNTIME_OSS_BASE = ASSET_MIRROR_BASE

# 2026-07-07 · dl/by/models 三个 CDN 域回源鉴权未配(私有 bucket + BPA)→ 全部 403
# 修复前所有下发给客户端的 CDN URL 统一重写为平台签名 302(asset-mirror · 实测可用)
# CDN 控制台配好回源鉴权、curl 验证 200 后:设 env EDGE_CDN_DIRECT=1 即回切 CDN 直链
_CDN_REWRITE_TO_ASSET_MIRROR = os.environ.get("EDGE_CDN_DIRECT", "") != "1"

_CDN_BASE_TO_PREFIX = (
    (RELEASES_CDN_BASE, "releases"),
    (RUNTIME_CDN_BASE, "runtime"),
    (MODELS_CDN_BASE, "models"),
)


def _mirror(url: str) -> str:
    """CDN URL → asset-mirror 签名 302 URL · 非 CDN URL 原样返回。"""
    if not _CDN_REWRITE_TO_ASSET_MIRROR or not isinstance(url, str):
        return url
    for base, prefix in _CDN_BASE_TO_PREFIX:
        if url.startswith(base + "/"):
            return f"{ASSET_MIRROR_BASE}/{prefix}/{url[len(base) + 1:]}"
    return url


def _mirror_deep(obj: Any) -> Any:
    """递归重写响应体里的 url / fallback_urls · 其余字段原样。

    只处理下载直链(url/fallback_urls)· 不动 index_url(PyPI simple 索引
    含相对链接 · 经 302 兜底会解析错 · 客户端本身有公共镜像轮询兜底)。
    """
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k == "url" and isinstance(v, str):
                out[k] = _mirror(v)
            elif k == "fallback_urls" and isinstance(v, list):
                out[k] = [_mirror(u) for u in v]
            else:
                out[k] = _mirror_deep(v)
        return out
    if isinstance(obj, list):
        return [_mirror_deep(v) for v in obj]
    return obj

# ════════════════════════════════════════════════════════════════════
# 2026-05-30 · render tier (Blender 4.2.0 LTS) 直下系统二进制
#
# 设计依据 (与历史 migrations/v8_024_runtime_tiers.sql 的 render 设计一致):
#   - Blender 是 ~300MB 级独立大软件 · 不走自家 PyPI 源 · 走国内公共镜像直下
#   - 客户端 try_install_system_binary 支持 dmg/zip/tarxz/targz · 解到
#     ~/.qianshou/runtime/system_bin/render/ · 按 binary 找可执行 · exposes 建 symlink
#   - blender_render.py._find_blender() 按这套布局 os.walk 发现 blender (已对齐)
#
# 各平台真实产物 (2026-05-30 HEAD 校验 · 扩展名/大小/sha256 取自官方 .sha256):
#   linux-x64    tar.xz  335MB  解出 blender-4.2.0-linux-x64/blender
#   windows-x64  zip     365MB  解出 blender-4.2.0-windows-x64/blender.exe
#   macos-arm64  dmg     293MB  解出 Blender.app/Contents/MacOS/Blender
#   macos-x64    dmg     319MB  解出 Blender.app/Contents/MacOS/Blender
#
# 平台 key 与客户端 detect_platform_key() 对齐: macos-arm64 / macos-x64 /
#   windows-x64 / linux-x64 (注意 arch 用 x64 · 不是 wheel 源的 x86_64)
# ════════════════════════════════════════════════════════════════════
_BLENDER_VER = "4.2.0"
# 主源放阿里云 · 清华在部分 Mac/代理环境下会 SSL_ERROR_SYSCALL · 官方全球兜底
_BLENDER_MIRROR_HOSTS = [
    "https://mirrors.aliyun.com/blender/release/Blender4.2",
    "https://mirror.nju.edu.cn/blender/release/Blender4.2",
    "https://download.blender.org/release/Blender4.2",
    "https://mirrors.tuna.tsinghua.edu.cn/blender/release/Blender4.2",
    "https://repo.huaweicloud.com/blender/release/Blender4.2",
]
# platform_key -> (产物文件名, kind, 解压后 binary 相对路径, 暴露命令名, size_mb, sha256)
_BLENDER_PLATFORMS = {
    "linux-x64": (
        f"blender-{_BLENDER_VER}-linux-x64.tar.xz", "tarxz",
        f"blender-{_BLENDER_VER}-linux-x64/blender", "blender", 335,
        "4f4fd7646af01f6fee9d420408318381a6e52571268eb7cf9cd5033bd9e7a359"),
    "windows-x64": (
        f"blender-{_BLENDER_VER}-windows-x64.zip", "zip",
        f"blender-{_BLENDER_VER}-windows-x64/blender.exe", "blender.exe", 365,
        "b6e72874f8cb5c4ed77f9b03d7f1fde851b9455a7ff02a1e1119c876318ebc65"),
    "macos-arm64": (
        f"blender-{_BLENDER_VER}-macos-arm64.dmg", "dmg",
        "Blender.app/Contents/MacOS/Blender", "blender", 293,
        "241dbfa6dac2c3b5e15bb1c132e0fcf16f7bf6e5bf3959440b6c8052b7b26d08"),
    "macos-x64": (
        f"blender-{_BLENDER_VER}-macos-x64.dmg", "dmg",
        "Blender.app/Contents/MacOS/Blender", "blender", 319,
        "ca987d61b70cc3f8c292f575d1694c8dded48a217476f8e25502879eb3ded293"),
}


def _blender_system_binaries() -> dict[str, dict[str, Any]]:
    """render tier 各平台 blender 直下规范 · 喂给客户端 system_binaries"""
    out: dict[str, dict[str, Any]] = {}
    for pkey, (fname, kind, binary, exposes, size_mb, sha) in _BLENDER_PLATFORMS.items():
        urls = [f"{host}/{fname}" for host in _BLENDER_MIRROR_HOSTS]
        out[pkey] = {
            "url": urls[0],
            "mirrors": urls[1:],
            "kind": kind,
            "binary": binary,
            "exposes": exposes,
            "size_mb": size_mb,
            "sha256": sha,
        }
    return out


# ════════════════════════════════════════════════════════════════════
# 2026-06-11 · V8.2 RFC · libonnxruntime 运行时分发
#
# 设计:
#   - ort crate (Rust) 用 load-dynamic feature · 运行时 dlopen libonnxruntime.{dylib,so,dll}
#   - 节点没装 libonnxruntime → Session::builder() panic → fallback 不掉到 python3
#   - 解法: 客户端启动时 ensure_onnxruntime_loaded() 自动从这里拉 + setenv ORT_DYLIB_PATH
#
# ort 2.0.0-rc.4 (我们锁的版本) 跟 ONNX Runtime v1.18.x 配套
# 版本对照表 (ort releases note):
#   ort 2.0.0-rc.4   ↔ onnxruntime 1.18.x
#   ort 2.0.0-rc.10  ↔ onnxruntime 1.19.x
#
# 各平台 dylib 大小 (实测 2024-06):
#   macos-arm64  ~24MB
#   macos-x86_64 ~25MB
#   linux-x86_64 ~13MB (libonnxruntime.so.1.18.1)
#   windows-x86_64 ~14MB (onnxruntime.dll)
#
# 主源 by.qianshousuanli.com CDN · fallback 用平台签名 302 + GitHub release
# ════════════════════════════════════════════════════════════════════
_ONNXRUNTIME_VERSION = "1.18.1"
_ONNXRUNTIME_CDN_BASE      = f"{RUNTIME_CDN_BASE}/onnxruntime/v{_ONNXRUNTIME_VERSION}"      # CDN 主源
_ONNXRUNTIME_OSS_FALLBACK  = f"{RUNTIME_OSS_BASE}/runtime/onnxruntime/v{_ONNXRUNTIME_VERSION}"  # 平台签名兜底
_ONNXRUNTIME_GH_BASE = (
    f"https://github.com/microsoft/onnxruntime/releases/download/v{_ONNXRUNTIME_VERSION}"
)

# 每平台 onnxruntime release archive (官方命名规则)
# kind: tarball 是 .tgz · zip 是 .zip · 解压后 binary 路径相对存放目录
_ONNXRUNTIME_PLATFORMS: dict[str, dict[str, Any]] = {
    # 2026-06-12 · sha256 来自 .local_models 实拉文件 · prepare_oss_assets.py 算
    "macos-arm64": {
        "archive_name": f"onnxruntime-osx-arm64-{_ONNXRUNTIME_VERSION}.tgz",
        "archive_kind": "tar.gz",
        # 解压后内部目录 onnxruntime-osx-arm64-1.18.1/lib/libonnxruntime.dylib
        "extracted_binary": f"onnxruntime-osx-arm64-{_ONNXRUNTIME_VERSION}/lib/libonnxruntime.dylib",
        "size_mb": 8,  # tarball 7,705,611B
        "sha256": "f3356203e9b6f5023168a12db74b1060ab397f8f3ce8f5cb2c2bd9e7f1195b01",
    },
    "macos-x86_64": {
        "archive_name": f"onnxruntime-osx-x86_64-{_ONNXRUNTIME_VERSION}.tgz",
        "archive_kind": "tar.gz",
        "extracted_binary": f"onnxruntime-osx-x86_64-{_ONNXRUNTIME_VERSION}/lib/libonnxruntime.dylib",
        "size_mb": 9,  # 8,714,874B
        "sha256": "938198521ecccd6fca4cadd627a57966de092feb6ea9ecb579437898d04ebad8",
    },
    "linux-x86_64": {
        "archive_name": f"onnxruntime-linux-x64-{_ONNXRUNTIME_VERSION}.tgz",
        "archive_kind": "tar.gz",
        # libonnxruntime.so.1.18.1 · 客户端会建 libonnxruntime.so 软链
        "extracted_binary": f"onnxruntime-linux-x64-{_ONNXRUNTIME_VERSION}/lib/libonnxruntime.so.{_ONNXRUNTIME_VERSION}",
        "size_mb": 6,  # 5,744,161B
        "sha256": "a0994512ec1e1debc00c18bfc7a5f16249f6ebd6a6128ff2034464cc380ea211",
    },
    "linux-aarch64": {
        "archive_name": f"onnxruntime-linux-aarch64-{_ONNXRUNTIME_VERSION}.tgz",
        "archive_kind": "tar.gz",
        "extracted_binary": f"onnxruntime-linux-aarch64-{_ONNXRUNTIME_VERSION}/lib/libonnxruntime.so.{_ONNXRUNTIME_VERSION}",
        "size_mb": 5,  # 5,018,240B
        "sha256": "c1dcd8ab29e8d227d886b6ee415c08aea893956acf98f0758a42a84f27c02851",
    },
    "windows-x86_64": {
        "archive_name": f"onnxruntime-win-x64-{_ONNXRUNTIME_VERSION}.zip",
        "archive_kind": "zip",
        "extracted_binary": f"onnxruntime-win-x64-{_ONNXRUNTIME_VERSION}/lib/onnxruntime.dll",
        "size_mb": 60,  # 60,979,938B
        "sha256": "53fb7226fe3cf16001afd1eae79e35f891a20e80bd686185d62ea878e6f9b1a6",
    },
}


def _onnxruntime_spec(platform: str) -> dict[str, Any] | None:
    """按平台返回 libonnxruntime 下载规范 · 节点 onnxruntime_loader 用"""
    rec = _ONNXRUNTIME_PLATFORMS.get(platform)
    if not rec:
        return None
    archive_name = rec["archive_name"]
    return {
        "version": _ONNXRUNTIME_VERSION,
        # 主源:CDN by.qianshousuanli.com (国内加速)
        "url": f"{_ONNXRUNTIME_CDN_BASE}/{platform}/{archive_name}",
        "fallback_urls": [
            # 兜底1:平台签名 302 → OSS (BPA-on bucket · CDN 失败时可用)
            f"{_ONNXRUNTIME_OSS_FALLBACK}/{platform}/{archive_name}",
            # 兜底2:GitHub 官方 release · 全球兜底 · 国内慢
            f"{_ONNXRUNTIME_GH_BASE}/{archive_name}",
        ],
        "archive_kind": rec["archive_kind"],
        "extracted_binary": rec["extracted_binary"],
        "size_mb": rec["size_mb"],
        "sha256": rec["sha256"],
    }


# ════════════════════════════════════════════════════════════════════
# 2026-05-26 · 预打包 venv 注册表
#
# 设计: 大厂 Ollama-型 (跟 ollama pull llama3 同模式)
#   - 我们在 CI 跑 uv venv + uv pip install
#   - tar.gz 整个 venv 上 OSS (阿里云 oss-cn-hangzhou)
#   - 客户端拉 tarball + sha256 校验 + 解压 + smoke test
#   - 跳过 PyPI 镜像轮询 · 失败率从 ~40% 降到 < 5%
#
# 每条记录: tier -> { platform -> { url, sha256, size_mb } }
#
# TBD 的 sha256 = "TBD" → 客户端解析时跳过校验 + 打 warn (生产前必须填实)
# url 模板 = "https://wuji-runtime.oss-cn-hangzhou.aliyuncs.com/venvs/{tier}-{platform}-{version}.tar.gz"
#
# 添加新 tier 步骤:
#   1. scripts/prebake-venv.sh <tier> <platform> 跑出 tar.gz + sha256
#   2. ossutil cp tar.gz oss://wuji-runtime/venvs/
#   3. 回填 PREBUILT_VENVS[tier][platform] = { url, sha256, size_mb }
# ════════════════════════════════════════════════════════════════════
#
# 2026-05-30 · 暂时全局关闭 tarball 快路 (prebuilt_venv)
# 原因: 现有 v1/<platform>/<tier>.tar.gz 不可移植 —
#   ① 多套了一层 <tier>/ 顶层目录 (解压后变 venvs/<tier>/<tier>/bin/python)
#   ② bin/python 是指向"构建机绝对路径"的软链 · 换机即失效
#   ③ macOS tar 夹带 AppleDouble (._*) 垃圾
# 客户端拉了必失败 → 白下载+解压+回退。统一走自家 PyPI 源 (已加 PEP658 · 快)。
# 待用 `uv venv --relocatable` + 正确布局重建可移植 tarball 后, 置回 True 即恢复秒装。
PREBUILT_VENV_FASTPATH_ENABLED = True

PREBUILT_VENVS: dict[str, dict[str, Any]] = {
    "lite": {
        "version": "2026.05.30",
        "verify_cmd": "import PIL, numpy, onnxruntime, fitz, pdfplumber; print('lite ok')",
        "platforms": {
            "macos-arm64":   {"url": f"{RUNTIME_CDN_BASE}/python/macos-arm64/lite.tar.gz",
                              "sha256": "5fbc24852eac7012996b382c87b3de7e098b6225facbfdb0688a352b32f662ff",
                              "size_mb": 66},
            "macos-x86_64":  {"url": f"{RUNTIME_CDN_BASE}/python/macos-x86_64/lite.tar.gz",
                              "sha256": "TBD", "size_mb": 0},
            "linux-x86_64":  {"url": f"{RUNTIME_CDN_BASE}/python/linux-x86_64/lite.tar.gz",
                              "sha256": "3134924550466d82ac9b268241fcc68f8f8e249f5447d14cd5140dc73ba8ecde",
                              "size_mb": 88},
            "windows-x86_64":{"url": f"{RUNTIME_CDN_BASE}/python/windows-x86_64/lite.tar.gz",
                              "sha256": "39e33db1115f2a60c5d36ecdd0f425b3a600b75bde560e15ef01fe601001fa26",
                              "size_mb": 66},
        },
    },
    "crawl": {
        "version": "2026.05.30",
        "verify_cmd": "import requests, selectolax, tldextract; from readability import Document; print('crawl ok')",
        "platforms": {
            "macos-arm64":   {"url": f"{RUNTIME_CDN_BASE}/python/macos-arm64/crawl.tar.gz",
                              "sha256": "4492f2d0f821af6cbecf7896d263c57083103f7a1c2397286b8711198be382ee",
                              "size_mb": 13},
            "macos-x86_64":  {"url": f"{RUNTIME_CDN_BASE}/python/macos-x86_64/crawl.tar.gz",
                              "sha256": "TBD", "size_mb": 0},
            "linux-x86_64":  {"url": f"{RUNTIME_CDN_BASE}/python/linux-x86_64/crawl.tar.gz",
                              "sha256": "dbcd1bde6150af770c307b6193626de8e9bb15cdd46b0214cad34ec2e0634a25",
                              "size_mb": 17},
            "windows-x86_64":{"url": f"{RUNTIME_CDN_BASE}/python/windows-x86_64/crawl.tar.gz",
                              "sha256": "5725ce0435e09484459c2cc334d8d890a9edf3f0c1a85120077301a3ee4b76f0",
                              "size_mb": 8},
        },
    },
    "ffmpeg": {
        "version": "2026.05.30",
        "verify_cmd": "import imageio_ffmpeg; p=imageio_ffmpeg.get_ffmpeg_exe(); print('ffmpeg ok:', p)",
        "platforms": {
            "macos-arm64":   {"url": f"{RUNTIME_CDN_BASE}/python/macos-arm64/ffmpeg.tar.gz",
                              "sha256": "4a29188c9cb1e7ee60d9581e9d8b4f962645f343f25deee3d5c762301076d179",
                              "size_mb": 21},
            "macos-x86_64":  {"url": f"{RUNTIME_CDN_BASE}/python/macos-x86_64/ffmpeg.tar.gz",
                              "sha256": "TBD", "size_mb": 0},
            "linux-x86_64":  {"url": f"{RUNTIME_CDN_BASE}/python/linux-x86_64/ffmpeg.tar.gz",
                              "sha256": "718e98b673ae44c1adb5367822550b986a5ad92b1a6634c92e78c0ed240bc853",
                              "size_mb": 36},
            "windows-x86_64":{"url": f"{RUNTIME_CDN_BASE}/python/windows-x86_64/ffmpeg.tar.gz",
                              "sha256": "ab7a65f8e711f5c78df770aaa17c335036358f9da0cb0b8cd8cede416eca56f3",
                              "size_mb": 30},
        },
    },
    "ocr": {
        "version": "2026.05.30",
        "verify_cmd": "import rapidocr_onnxruntime, paddle, paddleocr, fitz, PIL, numpy; print('ocr ok:', paddle.__version__); import sys,os; sys.stdout.flush(); os._exit(0)",
        "platforms": {
            "macos-arm64":   {"url": f"{RUNTIME_CDN_BASE}/python/macos-arm64/ocr.tar.gz",
                              "sha256": "1dcc0b6b4d78ca42acb134d7f6a1b178337edea7daf2da97eb9cdaa74e1702ec",
                              "size_mb": 215},
            "macos-x86_64":  {"url": f"{RUNTIME_CDN_BASE}/python/macos-x86_64/ocr.tar.gz",
                              "sha256": "TBD", "size_mb": 0},
            "linux-x86_64":  {"url": f"{RUNTIME_CDN_BASE}/python/linux-x86_64/ocr.tar.gz",
                              "sha256": "d6e994eb7919ad1e85c8353f2c6b0d9ace0a8e373c9bfb470603e72c10d260e0",
                              "size_mb": 338},
            "windows-x86_64":{"url": f"{RUNTIME_CDN_BASE}/python/windows-x86_64/ocr.tar.gz",
                              "sha256": "5d61c5574bd28c8d59d2d22cbe802308869d4db63fbebf63e58ea3c2cb66d1ea",
                              "size_mb": 205},
        },
    },
    "speech": {
        "version": "2026.05.30",
        "verify_cmd": "import faster_whisper; print('speech ok')",
        "platforms": {
            "macos-arm64":   {"url": f"{RUNTIME_CDN_BASE}/python/macos-arm64/speech.tar.gz",
                              "sha256": "9272b4faead508ea1d57de8c3ac852e657274906a23fbacfb82913b5493afbac",
                              "size_mb": 54},
            "macos-x86_64":  {"url": f"{RUNTIME_CDN_BASE}/python/macos-x86_64/speech.tar.gz",
                              "sha256": "TBD", "size_mb": 0},
            "linux-x86_64":  {"url": f"{RUNTIME_CDN_BASE}/python/linux-x86_64/speech.tar.gz",
                              "sha256": "65f259f0badaaeb2c0ec1a9ac060b1c274817ba4deb2a8a28482c87b45b35360",
                              "size_mb": 126},
            "windows-x86_64":{"url": f"{RUNTIME_CDN_BASE}/python/windows-x86_64/speech.tar.gz",
                              "sha256": "dcc274a5c465c8b04b9f799ef30aa4ad8826030774195587d09d181ea5cff2bc",
                              "size_mb": 62},
        },
    },
    "vision-ai": {
        "version": "2026.05.30",
        "verify_cmd": "import transformers, torch, diffusers; print('vision-ai ok'); import sys,os; sys.stdout.flush(); os._exit(0)",
        "platforms": {
            "macos-arm64":   {"url": f"{RUNTIME_CDN_BASE}/python/macos-arm64/vision-ai.tar.gz",
                              "sha256": "TBD", "size_mb": 0},
            "macos-x86_64":  {"url": f"{RUNTIME_CDN_BASE}/python/macos-x86_64/vision-ai.tar.gz",
                              "sha256": "TBD", "size_mb": 0},
            "linux-x86_64":  {"url": f"{RUNTIME_CDN_BASE}/python/linux-x86_64/vision-ai.tar.gz",
                              "sha256": "TBD", "size_mb": 0},
            "windows-x86_64":{"url": f"{RUNTIME_CDN_BASE}/python/windows-x86_64/vision-ai.tar.gz",
                              "sha256": "8c38d4a60b69c782f1a0bfaddef685014d7505170b9e5117ddba092e4c86ee51",
                              "size_mb": 103},
        },
    },
}


# 离线运行环境包协议。包由 scripts/build_offline_runtime_bundles.py 生成，
# 通过 U 盘/共享盘分发；sha256 由同名 .sha256 文件提供，客户端仍会校验包内
# payload_sha256。正式 CDN 分发时可在 v8_runtime_tiers 增加外层 sha256 覆盖。
OFFLINE_BUNDLE_FORMAT_VERSION = 1


def _attach_offline_bundle_specs(
    tiers: dict[str, Any], platform: str,
) -> dict[str, Any]:
    """给所有已下发 tier 补充可导入的离线包描述，不依赖 DB schema 变更。"""
    for tier_name, spec in tiers.items():
        layout = "system-bin" if tier_name == "render" else "venv"
        spec["offline_bundle"] = {
            "format_version": OFFLINE_BUNDLE_FORMAT_VERSION,
            "platform": platform,
            "filename": f"qianshou-runtime-{tier_name}-{platform}.tar.gz",
            "checksum_filename": f"qianshou-runtime-{tier_name}-{platform}.tar.gz.sha256",
            "layout": layout,
            # 外层 sha 在生成包后由发布清单回填；空值时客户端只接受包内 payload 校验。
            "sha256": "",
        }
    return tiers


def _build_prebuilt_venv(tier_name: str, platform: str) -> dict[str, Any] | None:
    """从注册表组装当前 tier × platform 的 prebuilt_venv 字段 · 不存在返 None"""
    if not PREBUILT_VENV_FASTPATH_ENABLED:
        return None
    rec = PREBUILT_VENVS.get(tier_name)
    if not rec:
        return None
    plat = rec.get("platforms", {}).get(platform)
    if not plat:
        return None
    # 与 DB 路径 (见 _load_tiers_from_db 的 psha != "TBD" 守卫) 一致:
    # sha=TBD/空 或 size<=0 视为"该平台尚无可用预打包 venv" · 不下发 prebuilt_venv
    # 否则客户端会去下并不存在的 tarball (如 win/intel-mac 尚未构建) → 404 → 才降级 ·
    # 返 None 让客户端直接走 wheel 源 (已是自家 PEP503 源 · 无 404 浪费)
    sha = plat.get("sha256", "TBD")
    if not sha or sha == "TBD" or plat.get("size_mb", 0) <= 0:
        return None
    return {
        "version": rec.get("version", "unknown"),
        "url": plat["url"],
        "sha256": sha,
        "size_mb": plat.get("size_mb", 0),
        # 解压目标 (相对 ~/.qianshou/runtime/venvs/ · 默认就是 tier 名)
        "extract_to": plat.get("extract_to", tier_name),
        # 内部 python 相对路径 (默认 unix bin/python · windows Scripts/python.exe)
        "python_rel": plat.get("python_rel", "bin/python" if not platform.startswith("windows") else "Scripts/python.exe"),
        # 安装后跑这个验证装好了 · 跟 smoke_test 同语义
        "verify_cmd": rec.get("verify_cmd", ""),
    }


def _detect_region_by_ip(ip: str) -> str:
    """
    粗略 IP 段判断 · 返回 cn / intl
    不依赖外部 GeoIP 库 · 用常见中国大陆运营商前缀做白名单
    无法识别时返回 cn (国内用户多 · 误判海外用户最多多等几秒)

    覆盖率: 约 90% 中国大陆 IP · 不能识别的 (新分配段) 退回默认
    生产可换成 maxmind / ip2location 提升精度
    """
    if not ip or ip in ("127.0.0.1", "localhost", "::1"):
        return "cn"  # 本地测试默认国内
    # 中国大陆三大运营商 + 主流云厂常见 /8 前缀 (粗筛 · 不全)
    # 数据来源: APNIC delegated-apnic-latest (2024)
    cn_prefixes = (
        "1.", "14.", "27.", "36.", "39.", "42.", "49.", "58.", "59.", "60.", "61.",
        "101.", "103.", "106.", "110.", "111.", "112.", "113.", "114.", "115.",
        "116.", "117.", "118.", "119.", "120.", "121.", "122.", "123.", "124.", "125.",
        "139.", "140.", "150.", "153.", "159.", "163.", "171.", "175.", "180.",
        "182.", "183.", "192.144.", "202.", "203.", "210.", "211.", "218.", "219.",
        "220.", "221.", "222.", "223.",
    )
    if any(ip.startswith(p) for p in cn_prefixes):
        return "cn"
    # 不在白名单 → 当海外处理 (官方 PyPI 优先)
    return "intl"


@router.get("/runtime/manifest", summary="运行时依赖清单 (OSS 预打包 + DB 动态)")
def runtime_manifest(
    os: str = "macos",
    arch: str = "arm64",
    region: str = "auto",
    request: Request = None,
    metal: str = "false",
    cuda: str = "false",
    vram_gb: float = 0,
    ram_gb: float = 0,
    gpu: str = "false",
) -> dict[str, Any]:
    """
    region: cn = 国内源优先 (默认 · 适配国内用户)
            intl = 海外源优先 (海外用户)
            auto = 按请求 IP 自动判断 (中国大陆 IP → cn · 其余 → intl)

    硬件参数 (客户端传 · 用于过滤不适配的 tier):
      metal=true    Apple Metal 可用
      cuda=true     NVIDIA CUDA 可用
      gpu=true      有 GPU (通用)
      vram_gb=7.5   GPU 显存 (GB)
      ram_gb=16     系统内存 (GB)
    """
    arch_norm = "arm64" if arch in ("aarch64", "arm64") else arch
    platform = f"{os}-{arch_norm}"

    # 2026-05-30 · Layer 3 动态 tier 管理 · 从 v8_runtime_tiers 表读
    # 替代老 _inject_prebuilt 静态字典 · 支持硬件门控 + 多下载源
    # DB 读失败时 fallback 到 PREBUILT_VENVS 静态字典
    def _load_tiers_from_db() -> tuple[dict[str, Any], bool]:
        """从 v8_runtime_tiers 表读取 tier 配置 · 返回 (tiers_dict, db_ok)"""
        try:
            from platform_v8.storage.db import session_scope
            from sqlalchemy import text as _text
            with session_scope() as s:
                rows = s.execute(_text("""
                    SELECT * FROM v8_runtime_tiers
                    WHERE enabled = TRUE
                      AND (platform = :plat OR platform = 'any')
                    ORDER BY display_order, tier_name, platform
                """), {"plat": platform}).mappings().all()

            if not rows:
                return {}, False

            tiers: dict[str, Any] = {}
            for r in rows:
                d = dict(r)
                mirrors_raw = d.get("mirror_sources")
                if isinstance(mirrors_raw, str):
                    try:
                        mirrors_raw = json.loads(mirrors_raw)
                    except Exception:
                        mirrors_raw = []
                if not mirrors_raw:
                    mirrors_raw = []

                tn = d["tier_name"]

                # 硬件门控: 不满足条件的跳过
                # 注意: 客户端未上报(0)时不要按最小值误杀 · 否则 render/vision
                # 在探针完成前会被直接从工具管理列表剔除。
                has_gpu_any = (gpu.lower() == "true" or metal.lower() == "true" or cuda.lower() == "true")
                if d.get("requires_gpu") and not has_gpu_any:
                    continue
                if d.get("requires_cuda") and cuda.lower() != "true":
                    continue
                if d.get("requires_metal") and metal.lower() != "true":
                    continue
                if d.get("min_vram_gb", 0) > 0 and 0 < vram_gb < float(d["min_vram_gb"]):
                    continue
                # Apple Silicon 常把统一内存报成 ram、vram=0；有 Metal 时用 ram 代替显存门控
                if (
                    d.get("min_vram_gb", 0) > 0
                    and vram_gb <= 0
                    and metal.lower() == "true"
                    and 0 < ram_gb < float(d["min_vram_gb"])
                ):
                    continue
                if d.get("min_ram_gb", 0) > 0 and 0 < ram_gb < float(d["min_ram_gb"]):
                    continue

                # 优先取该平台专用行 · else 取 platform='any' 的
                row_plat = d.get("platform", "any")
                if tn in tiers:
                    existing_plat = tiers[tn].get("_row_platform", "any")
                    if existing_plat != "any" and row_plat == "any":
                        continue
                    if existing_plat == "any" and row_plat != "any":
                        tiers[tn] = {}  # 清掉重建

                # 2026-05-30 方案A · software 用专列(缺则回退 packages) · 与静态字典对齐
                _sw = list(d.get("software") or []) or list(d.get("packages") or [])
                spec = {
                    "required": d.get("required", False),
                    "auto_install": d.get("auto_install", False),
                    "description": d.get("description", ""),
                    "packages": list(d.get("packages") or []),
                    "pip_args": list(d.get("pip_args") or []),
                    "smoke_test": d.get("verify_cmd", ""),
                    "smoke_timeout_secs": d.get("verify_timeout_secs", 60),
                    "software": _sw,
                    "task_types": list(d.get("task_types") or []),
                    "skills": list(d.get("skills") or []),
                    "_row_platform": row_plat,
                }

                # 2026-05-30 方案A · 下发 system_commands/system_binaries/install_hint
                #   (render→blender 直下靠这三个 · JSONB 列 · psycopg2 已解析为 py 对象)
                def _coerce(v):
                    if isinstance(v, str):
                        try:
                            return json.loads(v)
                        except Exception:
                            return None
                    return v
                _sc = _coerce(d.get("system_commands"))
                if _sc:
                    spec["system_commands"] = _sc
                _sb = _coerce(d.get("system_binaries"))
                if _sb:
                    spec["system_binaries"] = _sb
                _ih = _coerce(d.get("install_hint"))
                if _ih:
                    spec["install_hint"] = _ih

                # 注入 prebuilt_venv (tarball 直下模式)
                purl = d.get("prebuilt_url", "")
                psha = d.get("prebuilt_sha256", "")
                psize = d.get("prebuilt_size_mb", 0)
                if PREBUILT_VENV_FASTPATH_ENABLED and purl and (psha and psha != "TBD") and psize > 0:
                    spec["prebuilt_venv"] = {
                        "version": d.get("prebuilt_version", ""),
                        "url": purl,
                        "sha256": psha,
                        "size_mb": psize,
                        "extract_to": tn,
                        "python_rel": "Scripts/python.exe" if platform.startswith("windows") else "bin/python",
                        "verify_cmd": d.get("verify_cmd", ""),
                    }

                # 注入多下载源 (mirror_sources)
                if mirrors_raw:
                    spec["prebuilt_mirrors"] = mirrors_raw

                # 注入 source_type
                spec["source_type"] = d.get("source_type", "self_mirror")

                if d.get("depends_on"):
                    spec["depends_on"] = list(d["depends_on"])

                tiers[tn] = spec

            for tn in list(tiers.keys()):
                tiers[tn].pop("_row_platform", None)

            return tiers, True

        except Exception as e:
            logger.warning("manifest · DB 读取 v8_runtime_tiers 失败: %s · fallback 静态字典", e)
            return {}, False

    # 尝试 DB · 失败则 fallback 到 PREBUILT_VENVS 静态字典
    tiers_from_db, db_ok = _load_tiers_from_db()

    if db_ok and tiers_from_db:
        tiers_with_prebuilt = tiers_from_db
    else:
        # fallback: 老静态字典 + _inject_prebuilt
        def _inject_prebuilt(tiers_dict: dict[str, Any]) -> dict[str, Any]:
            for name, spec in tiers_dict.items():
                pv = _build_prebuilt_venv(name, platform)
                if pv is not None:
                    spec["prebuilt_venv"] = pv
            return tiers_dict

        tiers_with_prebuilt = _inject_prebuilt({
            "lite": {
                "required": True,
                "auto_install": True,
                "description": "轻量运行环境: 图片/PDF/ONNX (不含音视频 · 见 ffmpeg tier)",
                "packages": ["pillow", "numpy", "onnxruntime", "PyMuPDF", "pdfplumber"],
                "pip_args": [],
                "smoke_test": "import PIL, numpy, onnxruntime, fitz, pdfplumber; print('lite ok')",
                "software": ["pillow", "numpy", "onnxruntime", "pymupdf", "pdfplumber"],
                "task_types": ["image_resize", "image_compress", "image_convert", "image_thumbnail", "image_info", "onnx_infer", "fft_compute", "pdf_info", "pdf_to_text"],
                "skills": ["image-tools-v1", "data-tools-v1", "file-tools-v1", "text-tools-v1", "llm-tools-v1"],
            },
            "ffmpeg": {
                "required": True,
                # 2026-06-05 · 设自动装:30MB 小包·required·且 speech tier 依赖它·镜像三平台已齐
                "auto_install": True,
                "description": "音视频运行环境: imageio-ffmpeg",
                "packages": ["imageio-ffmpeg"],
                "pip_args": [],
                "smoke_test": "import imageio_ffmpeg; p=imageio_ffmpeg.get_ffmpeg_exe(); print('ffmpeg ok:', p)",
                "software": ["ffmpeg", "ffprobe"],
                "task_types": ["audio_extract", "audio_transcode", "video_thumbnail", "video_compress", "video_info", "video_trim"],
                "skills": [],
            },
            "ocr": {
                "required": False,
                # 2026-06-05 硬件感知:PaddleOCR 重·需 4GB+ 内存
                "min_ram_gb": 4,
                "description": "OCR 运行环境: RapidOCR/PaddleOCR + PDF 页面渲染",
                "packages": ["rapidocr-onnxruntime", "onnxruntime", "paddleocr>=3.3.0", "paddlepaddle", "PyMuPDF", "pillow", "numpy"],
                "pip_args": [],
                "smoke_test": "import rapidocr_onnxruntime, paddle, paddleocr, fitz, PIL, numpy; print('ocr ok:', paddle.__version__); import sys,os; sys.stdout.flush(); os._exit(0)",
                "smoke_timeout_secs": 300,
                "software": ["rapidocr", "onnxruntime", "paddleocr", "paddlepaddle", "pymupdf", "pillow", "numpy"],
                # pdf_to_text 预检后可能转 PP-OCRv6；客户端据此能把 OCR runtime
                # 与该技能正确关联并在收到 runtime_update_available 后提示更新。
                "task_types": ["ocr_image", "pdf_ocr", "pdf_to_text"],
                "skills": ["ocr-tools-v1"],
            },
            "speech": {
                "required": False,
                # 2026-06-05 硬件感知:faster-whisper 模型吃内存·需 4GB+
                "min_ram_gb": 4,
                "description": "语音转文字运行环境: faster-whisper (依赖 ffmpeg tier)",
                "packages": ["faster-whisper"],
                "pip_args": [],
                "smoke_test": "import faster_whisper; print('speech ok')",
                "smoke_timeout_secs": 180,
                "software": ["faster_whisper", "whisper"],
                "task_types": ["whisper_transcribe"],
                "skills": [],
                "depends_on": ["ffmpeg"],
            },
            "vision-ai": {
                "required": False,
                # 2026-06-05 硬件感知:Transformers+Diffusers 重·需 GPU(4GB+显存)或 8GB+ 内存
                "requires_gpu": True,
                "min_vram_gb": 4,
                "min_ram_gb": 8,
                "description": "图片理解/生成运行环境: Transformers + Diffusers",
                "packages": ["transformers", "torch", "torchvision", "safetensors", "diffusers", "accelerate"],
                "pip_args": [],
                "smoke_test": "import transformers, torch, diffusers; print('vision-ai ok'); import sys,os; sys.stdout.flush(); os._exit(0)",
                "smoke_timeout_secs": 300,
                "software": ["transformers", "torch", "diffusers"],
                "task_types": ["image_caption", "sd_txt2img", "sd_img2img", "sd_inpaint"],
                "skills": ["photo-edit-v1"],
            },
            "crawl": {
                "required": False,
                "auto_install": True,
                "description": "公开数据采集运行环境: requests + selectolax",
                "packages": ["requests", "selectolax", "tldextract", "readability-lxml", "lxml"],
                "pip_args": [],
                "smoke_test": "import requests, selectolax, tldextract; from readability import Document; print('crawl ok')",
                "software": ["requests", "selectolax", "readability", "tldextract"],
                "task_types": ["crawl_url_fetch", "crawl_url_extract", "crawl_batch_fetch"],
                "skills": [],
            },
            "render": {
                "required": False,
                # 2026-06-05 硬件感知:Blender 3D 渲染·需 4GB+ 内存
                "min_ram_gb": 4,
                "description": "3D 渲染运行环境: Blender",
                "packages": [],
                "pip_args": [],
                # blender 是独立大软件 · 非 pip 包 · 必须声明 system_commands ·
                # 否则客户端走默认 venv+pip 路径 · 把 shell 命令 "blender --version"
                # 当 python -c 跑 → NameError。声明后路由到 system-check 路径:
                #   which 探测 blender → 缺则按 install_hint 装 → shell 跑 smoke_test
                "system_commands": ["blender"],
                # 首选: 各平台直下 Blender 4.2.0 (走国内公共镜像 · 不需 brew/winget/sudo)
                "system_binaries": _blender_system_binaries(),
                # 兜底: 直下全部失败时 (极少) · 再退到包管理器装
                "install_hint": {
                    "macos":   "brew install --cask blender",
                    "windows": "winget install -e --id BlenderFoundation.Blender",
                    "linux":   "sudo snap install blender --classic",
                },
                "smoke_test": "blender --version",
                "software": ["blender"],
                # 2026-05-30 修: blender_frame_render 是幽灵名(无实现) → 改为 blender_render
                #   (引擎注册表/企业端派单/技能包 tool_id/v1脚本 全都用 blender_render)
                "task_types": ["blender_render", "blender_info", "render_split", "frame_compose"],
                "skills": ["render-tools-v1"],
            },
        })

    # 离线包说明独立于 DB tier 表，保证 DB 动态配置与静态回退均可导入同一套包。
    tiers_with_prebuilt = _attach_offline_bundle_specs(tiers_with_prebuilt, platform)

    self_mirror = {
        "label": "千手自家 PyPI",
        "index_url": "https://by.qianshousuanli.com/runtime/pypi/simple/",
    }
    cn_mirrors = [
        {"label": "阿里云 PyPI",   "index_url": "https://mirrors.aliyun.com/pypi/simple",        "trusted_host": "mirrors.aliyun.com"},
        {"label": "北外 PyPI",     "index_url": "https://mirrors.bfsu.edu.cn/pypi/web/simple",   "trusted_host": "mirrors.bfsu.edu.cn"},
        {"label": "南京大学 PyPI", "index_url": "https://mirror.nju.edu.cn/pypi/web/simple",     "trusted_host": "mirror.nju.edu.cn"},
        {"label": "腾讯云 PyPI",   "index_url": "https://mirrors.cloud.tencent.com/pypi/simple", "trusted_host": "mirrors.cloud.tencent.com"},
        {"label": "清华 PyPI",     "index_url": "https://pypi.tuna.tsinghua.edu.cn/simple",      "trusted_host": "pypi.tuna.tsinghua.edu.cn"},
        {"label": "中科大 PyPI",   "index_url": "https://pypi.mirrors.ustc.edu.cn/simple",       "trusted_host": "pypi.mirrors.ustc.edu.cn"},
        {"label": "华为云 PyPI",   "index_url": "https://repo.huaweicloud.com/repository/pypi/simple", "trusted_host": "repo.huaweicloud.com"},
    ]
    intl_mirrors = [
        {"label": "官方 PyPI (US)",   "index_url": "https://pypi.org/simple"},
        {"label": "PyPI Mirror (DE)", "index_url": "https://pypi.python.org/simple"},
    ]

    # 决定 region
    chosen_region = region.lower()
    if chosen_region == "auto" and request is not None:
        client_ip = (request.headers.get("X-Forwarded-For", "") or request.client.host or "").split(",")[0].strip()
        chosen_region = _detect_region_by_ip(client_ip)
    if chosen_region not in ("cn", "intl"):
        chosen_region = "cn"  # 默认国内优先

    if chosen_region == "cn":
        mirrors = [self_mirror] + cn_mirrors + intl_mirrors
    else:
        mirrors = [self_mirror] + intl_mirrors + cn_mirrors

    # V8.1 · 构建 task_routing 表 · 客户端按 task_type 路由到对应 venv
    # 来源: task_registry.TASK_REGISTRY + resolve_tier_routing (SOFTWARE_TO_TIER 推断)
    # 加新 task 只需在 task_registry.py 注册 + (可选) 改 SOFTWARE_TO_TIER · 客户端零修改
    task_routing: dict[str, dict[str, Any]] = {}
    # V8.2 (2026-06-11 RFC) · 构建 task_executors 表 · 客户端按此选执行器(native/onnx/http/python3)
    # 老客户端(8.1.x)ignore 这个字段 · 维持 task_routing 走老 python3 路径 · 完全向后兼容
    task_executors: dict[str, dict[str, Any]] = {}
    try:
        from platform_v8.engine.task_registry import (
            TASK_REGISTRY, Executor, resolve_tier_routing,
        )
        for tt, spec in TASK_REGISTRY.items():
            rt, fbs = resolve_tier_routing(spec)
            # 只导出有路由信息的 · 没 required_tier 的纯 stdlib task 不进表 (客户端走默认)
            if rt or fbs:
                task_routing[tt] = {
                    "required_tier": rt,
                    "fallback_tiers": list(fbs),
                }
            # V8.2 · 只导出非 PYTHON3 的 · PYTHON3 是默认 · 不进表减小负载
            if spec.executor != Executor.PYTHON3:
                task_executors[tt] = {
                    "executor": spec.executor.value,
                    "native_binary": spec.native_binary,
                    "onnx_model": spec.onnx_model,
                }
    except Exception as e:
        logger.warning("manifest · build task_routing/task_executors 失败: %s · 用空表", e)

    # 2026-06-06 · 功能分层显式建模 · 给每个 tier 标 layer (客户端 UI 可按层分组展示)
    #   骨架(skeleton)=连接/心跳(非 tier·客户端基础) · basic=hybrid 内置必备(lite/crawl/ffmpeg)
    #   advanced=按需重 tier(ocr/speech/vision-ai/render) · super=GEO/IP/广告/爬虫(admin 私有·不在此 tiers)
    _TIER_LAYER = {
        "lite": "basic", "crawl": "basic", "ffmpeg": "basic",
        "ocr": "advanced", "speech": "advanced", "vision-ai": "advanced", "render": "advanced",
    }
    try:
        for _tn, _spec in tiers_with_prebuilt.items():
            if isinstance(_spec, dict) and "layer" not in _spec:
                _spec["layer"] = _TIER_LAYER.get(_tn, "advanced")
    except Exception as e:
        logger.debug("manifest · 注入 tier layer 失败(不致命): %s", e)

    # V8.2 (2026-06-11 RFC) · 构建 onnx_models 下发清单
    # 客户端拉到 ~/.qianshou/runtime/onnx/<model>/ · 节点 ort crate 直推 ·
    # 不依赖 Python(transformers/torch/paddleocr 都不需要)· 全平台同一份模型
    # 老客户端 ignore 这个字段 · 完全向后兼容
    onnx_models = _build_onnx_models_for_platform(platform)

    # V8.2 (2026-06-11 RFC) · 构建 libonnxruntime 下载规范 (按平台)
    # 节点 onnxruntime_loader 启动时 ensure 这个 dylib/so/dll 存在 → 设 ORT_DYLIB_PATH
    # 老客户端 ignore 这个字段 · 完全向后兼容
    onnx_runtime = _onnxruntime_spec(platform)

    # 2026-07-07 · CDN 回源 403 · 全量下发 URL 重写为 asset-mirror(见 _mirror_deep)
    return _mirror_deep({
        "ok": True,
        "platform": platform,
        # V8.1 · schema_version=3 表示包含 task_routing + tiers.auto_install
        # V8.2 · schema_version=4 表示新增 task_executors + onnx_models
        # V8.2 · schema_version=5 表示新增 onnx_runtime (libonnxruntime 分发)
        # 老 8.0.x 客户端只看 mirrors + tiers · ignore 新字段 · 向后兼容
        "schema_version": "5",
        "install_mode": "public_mirror_venv",
        "region": chosen_region,
        "python": {
            "min_version": "3.9",
            "preferred_versions": ["3.11", "3.10", "3.9"],
        },
        "mirrors": mirrors,
        # V8.1 · 客户端按此选择 task 跑在哪个 venv (主 tier + 兜底)
        "task_routing": task_routing,
        # V8.2 RFC · 客户端按此选执行器 (native/onnx/http) · 不在表的走 python3
        "task_executors": task_executors,
        # V8.2 RFC · ONNX 模型下发清单 · 节点按需拉
        "onnx_models": onnx_models,
        # V8.2 RFC · libonnxruntime 运行时 · 节点装好后 setenv ORT_DYLIB_PATH
        # 若 onnx_models 非空但 onnx_runtime 缺(平台不支持)· 节点降级走 python3
        "onnx_runtime": onnx_runtime,
        "tiers": tiers_with_prebuilt,
    })


# ════════════════════════════════════════════════════════════════════
# V8.2 (2026-06-11 RFC) · ONNX 模型下发注册表
#
# 设计:
#   - 服务端把模型 URL + sha256 + size_mb 写在这里(后期可挪到 v8_onnx_models 表)
#   - 客户端 manifest 拉到后 按 task.onnx_model 找记录 · 下载到 ~/.qianshou/runtime/onnx/<name>/
#   - 节点 ort crate 用文件路径直接 load · 不开 Python · 不装 paddleocr/transformers
#   - 跨平台共享同一份模型(ONNX 是平台无关的)
#
# 模型来源:
#   rapid_ocr_v1     · RapidOCR (PaddleOCR ONNX 移植) · CC BY 4.0 · 60MB
#                     https://github.com/RapidAI/RapidOCR/releases
#   clip_vit_b32_v1  · CLIP ViT-B/32 ONNX · MIT · 330MB
#                     https://huggingface.co/Xenova/clip-vit-base-patch32
#
# CDN: 走自家 models.qianshousuanli.com 镜像 · 兜底 GitHub raw / HuggingFace
# ════════════════════════════════════════════════════════════════════
_ONNX_MODELS_REGISTRY: dict[str, dict[str, Any]] = {
    "rapid_ocr_v6": {
        # 2026-08 · PP-OCRv6 small（RapidOCR v3.9 默认）· 端侧/桌面平衡档
        "version": "v3.9.0-PP-OCRv6-small",
        "description": "RapidOCR · PP-OCRv6 small · ONNX · 端侧默认",
        "license": "Apache-2.0",
        "size_mb": 30,
        "extract_to": "rapid_ocr_v6",
        "files": [
            {
                "name": "PP-OCRv6_det_small.onnx",
                "role": "det",
                "url": f"{MODELS_CDN_BASE}/rapid_ocr_v6/PP-OCRv6_det_small.onnx",
                "fallback_urls": [
                    "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.0/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx",
                ],
                "sha256": "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f",
                "size_mb": 10,
            },
            {
                "name": "PP-OCRv6_rec_small.onnx",
                "role": "rec",
                "url": f"{MODELS_CDN_BASE}/rapid_ocr_v6/PP-OCRv6_rec_small.onnx",
                "fallback_urls": [
                    "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.0/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx",
                ],
                "sha256": "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884",
                "size_mb": 18,
            },
            {
                # v6 无独立 cls · 复用 v4 cls（方向分类）
                "name": "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
                "role": "cls",
                "url": f"{MODELS_CDN_BASE}/rapid_ocr_v1/ch_ppocr_mobile_v2.0_cls_mobile.onnx",
                "fallback_urls": [
                    "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.0/onnx/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.onnx",
                ],
                "sha256": "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c",
                "size_mb": 1,
            },
        ],
        "smoke_test": "PP-OCRv6_det_small.onnx",
    },
    "rapid_ocr_v1": {
        # 2026-06-11 · 实际拉取自 modelscope · PP-OCRv4 中英 mobile · 总 16MB
        # SHA256 全部跟官方 default_models.yaml v3.8.0 一致(我们这边脚本验证过)
        "version": "v3.8.0-PP-OCRv4-mobile",
        "description": "RapidOCR · PP-OCRv4 中英 mobile · ONNX · 16MB（v6 缺失时回落）",
        "license": "Apache-2.0",
        "size_mb": 16,
        "extract_to": "rapid_ocr_v1",
        # 节点 ort 加载文件列表 · 按顺序 det → cls → rec → keys
        "files": [
            {
                # 文本检测 · DBNet · 4.7MB
                "name": "ch_PP-OCRv4_det_mobile.onnx",
                "role": "det",
                # 主源 models CDN · 兜底 modelscope + HuggingFace
                "url": f"{MODELS_CDN_BASE}/rapid_ocr_v1/ch_PP-OCRv4_det_mobile.onnx",
                "fallback_urls": [
                    "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.8.0/onnx/PP-OCRv4/det/ch_PP-OCRv4_det_mobile.onnx",
                    "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx?download=true",
                ],
                "sha256": "d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9",
                "size_mb": 5,
            },
            {
                # 方向分类 · 0/180 度 · 585KB
                "name": "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
                "role": "cls",
                "url": f"{MODELS_CDN_BASE}/rapid_ocr_v1/ch_ppocr_mobile_v2.0_cls_mobile.onnx",
                "fallback_urls": [
                    "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.8.0/onnx/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.onnx",
                ],
                "sha256": "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c",
                "size_mb": 1,
            },
            {
                # 文本识别 · CRNN · 10.4MB
                "name": "ch_PP-OCRv4_rec_mobile.onnx",
                "role": "rec",
                "url": f"{MODELS_CDN_BASE}/rapid_ocr_v1/ch_PP-OCRv4_rec_mobile.onnx",
                "fallback_urls": [
                    "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.8.0/onnx/PP-OCRv4/rec/ch_PP-OCRv4_rec_mobile.onnx",
                    "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx?download=true",
                ],
                "sha256": "48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b",
                "size_mb": 11,
            },
            {
                # 字符字典(6625 行)· CTC 解码用
                "name": "ppocr_keys_v1.txt",
                "role": "keys",
                "url": f"{MODELS_CDN_BASE}/rapid_ocr_v1/ppocr_keys_v1.txt",
                "fallback_urls": [
                    "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.8.0/paddle/PP-OCRv4/rec/ch_PP-OCRv4_rec_mobile/ppocr_keys_v1.txt",
                ],
                "sha256": "28b2362ad4ab2dc38769aa72feb535e3a9ddb3fd2a7585a05920e6393b1dc7f7",
                "size_mb": 1,
            },
        ],
        # 节点装好后跑这个验证 · "model_dir/file_name" 存在 + 非 0 字节
        "smoke_test": "ch_PP-OCRv4_det_mobile.onnx",
    },
    "clip_vit_b32_v1": {
        "version": "1.0.0",
        "description": "CLIP ViT-B/32 · 图像描述/相似度 · 330MB",
        "license": "MIT",
        "size_mb": 330,
        "extract_to": "clip_vit_b32_v1",
        "files": [
            {
                "name": "visual.onnx",
                "role": "visual",
                "url": "https://models.qianshousuanli.com/models/clip_vit_b32_v1/visual.onnx",
                "fallback_urls": [
                    "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model.onnx",
                ],
                "sha256": "",
                "size_mb": 168,
            },
            {
                "name": "textual.onnx",
                "role": "textual",
                "url": "https://models.qianshousuanli.com/models/clip_vit_b32_v1/textual.onnx",
                "fallback_urls": [
                    "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/text_model.onnx",
                ],
                "sha256": "",
                "size_mb": 161,
            },
            {
                "name": "tokenizer.json",
                "role": "tokenizer",
                "url": "https://models.qianshousuanli.com/models/clip_vit_b32_v1/tokenizer.json",
                "fallback_urls": [
                    "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/tokenizer.json",
                ],
                "sha256": "",
                "size_mb": 1,
            },
        ],
        "smoke_test": "visual.onnx",
    },
}


def _build_onnx_models_for_platform(platform: str) -> dict[str, Any]:
    """V8.2 · 给定 platform · 返该平台 ONNX 模型清单

    ONNX 是平台无关的 · 所以返回的内容跟 platform 无关 · 但保留参数让以后好扩
    (如某些模型只在特定 GPU/CPU 上能跑 · 后期可在此过滤)
    """
    # 只导出 task_registry 真用到的模型 · 避免下发无用模型增加节点负担
    needed: set[str] = set()
    try:
        from platform_v8.engine.task_registry import required_onnx_models
        needed = required_onnx_models()
    except Exception:
        pass
    if not needed:
        return {}
    return {name: spec for name, spec in _ONNX_MODELS_REGISTRY.items() if name in needed}


def _fetch_json_url(url: str, timeout: float = 5.0) -> dict[str, Any] | None:
    """HTTP GET JSON · 用于读 dl CDN release/latest 清单。"""
    try:
        import urllib.request
        req = urllib.request.Request(url, headers={"User-Agent": "edgecompute-platform/8"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        logger.debug("fetch json fail · %s · %s", url, exc)
        return None


_RELEASE_JSON_PATHS = [
    "/var/www/web/downloads/latest/release.json",
    str(Path(__file__).resolve().parents[3] / "frontend" / "web-portal" / "public" / "downloads" / "latest" / "release.json"),
]


def _load_release_json() -> dict[str, Any] | None:
    """读下载页 release.json · 本地优先 · 其次 dl CDN。"""
    for p in _RELEASE_JSON_PATHS:
        try:
            if os.path.isfile(p):
                with open(p, "r", encoding="utf-8") as f:
                    return json.load(f)
        except Exception as exc:
            logger.warning("release.json read fail · %s · %s", p, exc)
    # 2026-07-07 · CDN 403 期间走 asset-mirror 拉(_mirror 修好回切后仍指 CDN)
    return _fetch_json_url(_mirror(f"{RELEASES_CDN_BASE}/release.json"))


def _resolve_latest_client_version() -> tuple[str, str, dict[str, Any] | None]:
    """解析最新客户端版本 · 优先级: binary.json > release.json > 常量。"""
    m = _load_binary_manifest_file("client-v3")
    if m is not None:
        v = str(m.get("version", "")).strip()
        if v:
            notes = str(m.get("notes", "")).strip() or "v8 客户端最新版本"
            return v, notes, m

    r = _load_release_json()
    if r is not None:
        v = str(r.get("version", "")).strip()
        if v:
            notes = str(r.get("release_notes") or r.get("release_notes_zh") or "v8 客户端最新版本")
            return v, notes[:500], r

    return LATEST_CLIENT_VERSION, "v8 客户端最新版本", None


def _tauri_os_dir(target: str) -> str:
    if target in ("darwin", "macos"):
        return "macos"
    if target == "windows":
        return "windows"
    return target


@router.get(
    "/client/updates/{target}/{arch}/{current_version}",
    summary="客户端更新检查",
)
def check_client_update(target: str, arch: str, current_version: str) -> dict[str, Any]:
    """
    target: macos / windows / linux
    arch: aarch64 / x86_64
    current_version: 当前客户端版本

    返回:
      { available: bool, latest_version, download_url, notes }

    2026-06-19 · 版本源: binary.json → release.json → LATEST_CLIENT_VERSION
    """
    # 生态 v3 rc 客户端的历史兼容入口：不能回落到已失效的 v8 节点安装包。
    # 旧 rc.6 客户端会请求本路由，统一返回生态 rc.12 安装包。
    if str(current_version or "").startswith("eco-"):
        eco_manifest = _load_binary_manifest_file("eco-client")
        eco_info = (eco_manifest or {}).get("platforms", {}).get(
            _eco_plat_key(target, arch),
        )
        eco_latest = str((eco_manifest or {}).get("version", "")).strip()
        eco_notes = str((eco_manifest or {}).get("notes", "")).strip()
        if eco_latest and isinstance(eco_info, dict) and eco_info.get("url"):
            cur = _version_tuple(current_version)
            latest = _version_tuple(eco_latest)
            available = latest > cur
            return {
                "available": available,
                "version": eco_latest if available else None,
                "latest_version": eco_latest,
                "current_version": current_version,
                "download_url": str(eco_info["url"]),
                "notes": eco_notes or "千手生态 v3 最新版本",
                "pub_date": str((eco_manifest or {}).get("pub_date", "")),
            }

    latest_str, notes, src = _resolve_latest_client_version()

    cur = _version_tuple(current_version)
    latest = _version_tuple(latest_str)
    available = latest > cur

    # 下载链接 (按 target/arch 组合)
    # 客户端 OTA 包走 dl.qianshousuanli.com CDN (OSS edgecompute/releases/{os}/v{ver}/)
    # 命名规范跟 OSS 目录一致 · 见 docs/OSS_对接.md
    if target == "macos" and arch in ("aarch64", "arm64"):
        dl = f"{RELEASES_CDN_BASE}/macos/v{latest_str}/千手节点_{latest_str}_arm64.dmg"
    elif target == "macos":
        dl = f"{RELEASES_CDN_BASE}/macos/v{latest_str}/千手节点_{latest_str}_x86_64.dmg"
    elif target == "windows":
        dl = f"{RELEASES_CDN_BASE}/windows/v{latest_str}/千手节点_{latest_str}_x64-setup.exe"
    else:
        dl = f"{RELEASES_CDN_BASE}/"

    # 2026-05-26 fix · 客户端 commands.rs check_for_updates 期望 `version` 字段
    # 之前用 `latest_version` · 客户端反序列化拿不到 version → 误报 available=false → 不弹更新提示
    # 双字段并存 · 老逻辑兼容 + 新客户端能拿到 `version`
    return {
        "available": available,
        "version": latest_str if available else None,
        "latest_version": latest_str,
        "current_version": current_version,
        # 2026-07-07 · CDN 回源 403 · 重写为 asset-mirror 签名 302
        "download_url": _mirror(dl),
        "notes": notes,
        "pub_date": str(src.get("pub_date", "")) if src else "",
    }


# ════════════════════════════════════════════════════════════════════
# 前端热更新 · /api/v8/client/web-manifest  (2026-05-21)
#
# 设计:
#   客户端打包内嵌一份 dist 作 fallback。启动时拉这个 manifest:
#     - entry_url 远端可达 → webview navigate 过去 (热更新生效)
#     - 远端 fail → 用本地内嵌 (离线/网络问题自动降级)
#
#   发版流程:
#     scripts/deploy-client-web.sh
#       1. vite build
#       2. rsync dist/ → /var/www/qianshou-app/client-v3/<commit>/
#       3. 写 /var/www/qianshou-app/client-v3/manifest.json (本 endpoint 读它)
#
#   nginx serve /app/client-v3/ → /var/www/qianshou-app/client-v3/
# ════════════════════════════════════════════════════════════════════
_WEB_MANIFEST_PATHS = [
    "/var/www/qianshou-app/client-v3/manifest.json",
    str(Path(__file__).resolve().parents[3] / "dist" / "manifest.json"),
]

_DEFAULT_WEB_HOST = "https://www.qianshousuanli.com"


def _load_web_manifest_file() -> dict[str, Any] | None:
    for p in _WEB_MANIFEST_PATHS:
        try:
            if os.path.isfile(p):
                with open(p, "r", encoding="utf-8") as f:
                    return json.load(f)
        except Exception as exc:
            logger.warning("web-manifest read fail · %s · %s", p, exc)
    return None


@router.get("/client/web-manifest", summary="前端代码热更新清单")
def web_manifest() -> dict[str, Any]:
    """客户端启动时拉这个 · 决定 webview 加载本地还是远端

    返回字段:
      version            当前生产前端版本号 (建议 git commit 短哈希)
      entry_url          完整入口 URL (https://...) · 远端可达就 navigate 过去
      base_url           前端静态资源 base
      min_client_version 最低兼容客户端版本
      released_at        发布时间 (ISO8601)
      notes              发布说明
    """
    m = _load_web_manifest_file()
    if m is None:
        return {
            "ok": True,
            "version": "",
            "entry_url": "",
            "base_url": "",
            "min_client_version": "8.0.0",
            "released_at": "",
            "notes": "尚未推送前端热更新版本 · 客户端使用打包内置版本",
        }
    version = str(m.get("version", "")).strip()
    base = str(m.get("base_url") or f"{_DEFAULT_WEB_HOST}/app/client-v3").rstrip("/")
    entry = m.get("entry_url") or (f"{base}/{version}/index.html" if version else "")
    return {
        "ok": True,
        "version": version,
        "entry_url": entry,
        "base_url": base,
        "min_client_version": str(m.get("min_client_version", "8.0.0")),
        "released_at": str(m.get("released_at", "")),
        "notes": str(m.get("notes", "")),
    }


# ════════════════════════════════════════════════════════════════════
# Rust 二进制热更新 · /api/v8/client/updater/{target}/{arch}/{version}
#
# Tauri 2 updater 协议 · 见 https://v2.tauri.app/plugin/updater/
#   200 + JSON {version, pub_date, url, signature, notes}  → 有更新
#   204 No Content                                          → 已最新
#
# 发版流程:
#   scripts/deploy-client-binary.sh
#     1. tauri build (createUpdaterArtifacts: true 自动出 .app.tar.gz + .sig)
#     2. rsync 到 /var/www/qianshou-app/client-v3/binary/{version}/
#     3. 写 /var/www/qianshou-app/client-v3/binary.json
# ════════════════════════════════════════════════════════════════════
# 2026-05-21 · 二进制 manifest 按 product 分仓 · 节点 (client-v3) / 企业 (enterprise)
_BINARY_PRODUCTS = {
    "client-v3": [
        "/var/www/qianshou-app/client-v3/binary.json",
        str(Path(__file__).resolve().parents[3] / "dist" / "binary.json"),
    ],
    "enterprise": [
        "/var/www/qianshou-app/enterprise/binary.json",
        str(Path(__file__).resolve().parents[3] / "dist" / "enterprise-binary.json"),
    ],
    # UPDATE-002 · 生态客户端（CDN 主通道 releases/eco/{plat}/latest.json）
    "eco-client": [
        "/var/www/qianshou-app/eco-client/binary.json",
        str(Path(__file__).resolve().parents[3] / "dist" / "eco-binary.json"),
    ],
}


def _load_binary_manifest_file(product: str = "client-v3") -> dict[str, Any] | None:
    for p in _BINARY_PRODUCTS.get(product, []):
        try:
            if os.path.isfile(p):
                with open(p, "r", encoding="utf-8") as f:
                    return json.load(f)
        except Exception as exc:
            logger.warning("binary-manifest read fail · product=%s path=%s · %s", product, p, exc)
    return None


def _plat_update_info(manifest: dict[str, Any] | None, plat_key: str) -> dict[str, Any] | None:
    """从 Tauri 清单取某平台条目 · 无 url+signature 才算有效。"""
    if not manifest:
        return None
    info = (manifest.get("platforms") or {}).get(plat_key)
    if not isinstance(info, dict):
        return None
    url = str(info.get("url") or "").strip()
    sig = str(info.get("signature") or "").strip()
    if not url or not sig:
        return None
    return info


def _resolve_tauri_manifest_for_platform(
    product: str, target: str, plat_key: str,
) -> dict[str, Any] | None:
    """解析 OTA 清单 · binary.json 优先 · 缺平台时 client-v3 回落 CDN {os}/latest.json。

    历史坑: 205 上 binary.json 常只有 darwin · 旧逻辑「有文件就不再读 CDN」
    → Windows 即使已上传 latest.json 也永远 204。
    """
    local = _load_binary_manifest_file(product)
    if _plat_update_info(local, plat_key) is not None:
        return local
    if product != "client-v3":
        return local if local is not None else None
    os_dir = _tauri_os_dir(target)
    cdn = _fetch_json_url(_mirror(f"{RELEASES_CDN_BASE}/{os_dir}/latest.json"))
    if _plat_update_info(cdn, plat_key) is not None:
        return cdn
    return local


def _tauri_updater_resp(product: str, target: str, arch: str, current_version: str):
    """Tauri 2 updater 协议核心 · 共享给节点 / 企业两个路由"""
    from fastapi.responses import Response, JSONResponse

    arch_key = arch
    if target == "darwin" and arch in ("arm64", "aarch64"):
        arch_key = "aarch64"
    if target == "windows" and arch in ("x86_64", "x64"):
        arch_key = "x86_64"
    plat_key = f"{target}-{arch_key}"

    m = _resolve_tauri_manifest_for_platform(product, target, plat_key)
    info = _plat_update_info(m, plat_key)
    if m is None or info is None:
        return Response(status_code=204)

    latest = str(m.get("version", "")).strip()
    if not latest or _version_tuple(latest) <= _version_tuple(current_version):
        return Response(status_code=204)

    return JSONResponse({
        "version": latest,
        "pub_date": str(m.get("pub_date", "")),
        # 2026-07-07 · CDN 回源 403 · binary.json 里的 dl CDN URL 重写为 asset-mirror
        "url": _mirror(info.get("url", "")),
        "signature": info.get("signature", ""),
        "notes": str(m.get("notes", "")),
    })


@router.get(
    "/client/updater/{target}/{arch}/{current_version}",
    summary="节点客户端 Tauri 二进制更新清单 (Tauri 2 updater 协议)",
)
def tauri_updater_client(target: str, arch: str, current_version: str):
    return _tauri_updater_resp("client-v3", target, arch, current_version)


@router.get(
    "/enterprise/updater/{target}/{arch}/{current_version}",
    summary="企业客户端 Tauri 二进制更新清单 (Tauri 2 updater 协议)",
)
def tauri_updater_enterprise(target: str, arch: str, current_version: str):
    return _tauri_updater_resp("enterprise", target, arch, current_version)


def _eco_plat_key(target: str, arch: str) -> str:
    """归一化为 CDN 目录名：darwin-aarch64 / windows-x86_64 / …"""
    t = (target or "").strip().lower()
    a = (arch or "").strip().lower()
    if "-" in t and t.count("-") >= 1 and a in ("", "{{arch}}"):
        return t
    if t in ("darwin", "macos"):
        t = "darwin"
    elif t in ("win", "windows"):
        t = "windows"
    elif t in ("linux",):
        t = "linux"
    if a in ("arm64", "aarch64"):
        a = "aarch64"
    elif a in ("x64", "amd64", "x86_64"):
        a = "x86_64"
    if not a:
        return t
    return f"{t}-{a}"


def _tauri_updater_resp_eco(target: str, arch: str, current_version: str):
    """生态客户端 OTA：本地 binary.json → CDN releases/eco/{plat}/latest.json。"""
    from fastapi.responses import Response, JSONResponse

    plat_key = _eco_plat_key(target, arch)
    m = _load_binary_manifest_file("eco-client")
    if m is None:
        m = _fetch_json_url(_mirror(f"{RELEASES_CDN_BASE}/eco/{plat_key}/latest.json"))
    if m is None:
        return Response(status_code=204)

    platforms = m.get("platforms") or {}
    info = platforms.get(plat_key) or platforms.get(f"{target}-{arch}")
    if not info and len(platforms) == 1:
        info = next(iter(platforms.values()))
    if not info:
        return Response(status_code=204)

    latest = str(m.get("version", "")).strip()
    if not latest or _version_tuple(latest) <= _version_tuple(current_version):
        return Response(status_code=204)

    return JSONResponse({
        "version": latest,
        "pub_date": str(m.get("pub_date", "")),
        "url": _mirror(info.get("url", "")),
        "signature": info.get("signature", ""),
        "notes": str(m.get("notes", "")),
    })


@router.get(
    "/eco/updater/{target}/{arch}/{current_version}",
    summary="生态客户端 Tauri 二进制更新清单 (Tauri 2 updater 协议)",
)
def tauri_updater_eco(target: str, arch: str, current_version: str):
    """UPDATE-002 · 后端桥：优先于直连 CDN latest.json。"""
    return _tauri_updater_resp_eco(target, arch, current_version)


@router.get(
    "/client/updater/eco/{target}/{arch}/{current_version}",
    summary="生态客户端 Tauri OTA 历史兼容入口",
)
def tauri_updater_eco_legacy(target: str, arch: str, current_version: str):
    """兼容早期生态客户端文档使用的 client/updater/eco 路径。"""
    return _tauri_updater_resp_eco(target, arch, current_version)


# ════════════════════════════════════════════════════════════════════
# 2026-05-21 · 任务能力矩阵 (节点客户端 智能能力 页用)
#
# 用 engine.task_registry.list_specs() 暴露所有已注册 task_type 给前端 ·
# 让节点能看出"我这台机器能接哪些活" + "需要装什么依赖才能接更多"
# ════════════════════════════════════════════════════════════════════
@router.get("/runtime/task-catalog", summary="所有 task_type 列表 · 客户端能力矩阵用")
def task_catalog() -> dict:
    try:
        from platform_v8.engine.task_registry import (
            list_specs, all_categories, compute_origin_fields,
        )
        specs = list_specs()
        items = []
        for s in specs:
            items.append({
                "task_type": s.task_type,
                "category": s.category,
                "description": s.description,
                "accepted_input_kinds": list(s.accepted_input_kinds),
                "default_input_kind": s.default_input_kind,
                "slicer": s.slicer,
                "aggregator": s.aggregator,
                "runtimes": list(s.runtimes),
                "required_software": list(s.required_software),
                "min_memory_mb": s.min_memory_mb,
                "requires_gpu": s.requires_gpu,
                "max_shards_limit": s.max_shards_limit,
                **compute_origin_fields(s),  # 2026-09-18 · 算力归属 (加法字段)
            })
        return {
            "total": len(items),
            "categories": all_categories(),
            "items": items,
        }
    except Exception as e:
        logger.exception("task_catalog 失败: %s", e)
        return {"total": 0, "categories": [], "items": [], "error": str(e)}


# ════════════════════════════════════════════════════════════════════
# 2026-05-26 · P0 NCE · 客户端崩溃上报 endpoint
#
# 客户端 panic 时落盘 ~/.qianshou/last_panic.json
# 下次启动 POST 这个 endpoint · 入 we_client_crashes 表 (admin 可查)
# 不要求鉴权 (panic 时 token 可能已坏 · 但限速 · 防刷)
# ════════════════════════════════════════════════════════════════════

from fastapi import Request

# 内存简单限速 (P0 · 防恶意刷接口 · 5min 100 次/IP)
_CRASH_RATE_LIMIT: dict[str, list[float]] = {}
_CRASH_RATE_WINDOW_S = 300
_CRASH_RATE_MAX = 100


def _rate_limited(ip: str) -> bool:
    import time as _t
    now = _t.time()
    arr = _CRASH_RATE_LIMIT.setdefault(ip, [])
    # 清掉窗口外的
    while arr and arr[0] < now - _CRASH_RATE_WINDOW_S:
        arr.pop(0)
    if len(arr) >= _CRASH_RATE_MAX:
        return True
    arr.append(now)
    return False


@router.post("/client/crash-report", summary="客户端崩溃 (panic) 上报")
async def report_client_crash(req: Request) -> dict[str, Any]:
    """
    Body schema (来自 Rust crash_reporter::CrashReport):
      {
        "client_version": "v8.0.15",
        "os": "macos",
        "arch": "aarch64",
        "location": "src/comm/v8_ws.rs:123",
        "payload": "panic message",
        "captured_at_ms": 1748000000000,
        "backtrace": "可选 · RUST_BACKTRACE=1 时填"
      }

    入库 we_client_crashes (没该表则只 log · 不阻塞客户端)
    """
    from platform_v8.api.client_ip import client_ip

    ip = client_ip(req)
    if _rate_limited(ip):
        return {"ok": False, "error": "rate_limited"}

    try:
        # Cap bytes before parsing JSON. Truncating parsed fields alone does
        # not prevent an anonymous request from exhausting server memory.
        raw = bytearray()
        async for chunk in req.stream():
            raw.extend(chunk)
            if len(raw) > 32 * 1024:
                return {"ok": False, "error": "body_too_large"}
        body = json.loads(raw)
        if not isinstance(body, dict):
            raise ValueError("expected JSON object")
    except Exception as e:
        return {"ok": False, "error": f"bad_json: {e}"}

    # 字段长度限制 (防恶意上报 GB 级 payload)
    def _trunc(v: Any, max_len: int) -> str:
        s = str(v or "")
        return s[:max_len] if len(s) > max_len else s

    record = {
        "ip": ip,
        "ua": (req.headers.get("User-Agent") or "")[:200],
        "client_version": _trunc(body.get("client_version"), 64),
        "os": _trunc(body.get("os"), 32),
        "arch": _trunc(body.get("arch"), 32),
        "location": _trunc(body.get("location"), 512),
        "payload": _trunc(body.get("payload"), 4096),
        "captured_at_ms": int(body.get("captured_at_ms") or 0),
        "backtrace": _trunc(body.get("backtrace"), 8192),
    }

    # 落 log (admin 可 grep) · 后续可上表
    logger.warning(
        "client_crash · ver=%s os=%s arch=%s loc=%s · payload=%s",
        record["client_version"], record["os"], record["arch"],
        record["location"], record["payload"][:120],
    )

    # 试着入表 (表不存在/字段不对就 silently skip · 不阻塞客户端)
    try:
        from platform_v8.storage.db import session_scope
        from sqlalchemy import text as _text
        with session_scope() as s:
            s.execute(_text("""
                INSERT INTO we_client_crashes
                  (ip, ua, client_version, os, arch, location, payload, captured_at_ms, backtrace, received_at)
                VALUES
                  (:ip, :ua, :ver, :os, :arch, :loc, :payload, :ts, :bt, NOW())
            """), {
                "ip": record["ip"], "ua": record["ua"],
                "ver": record["client_version"], "os": record["os"], "arch": record["arch"],
                "loc": record["location"], "payload": record["payload"],
                "ts": record["captured_at_ms"], "bt": record["backtrace"],
            })
            s.commit()  # session_scope 不自动 commit · 必须显式
    except Exception as e:
        # 表可能没建 · log 里有 · 但 warn 一下让 admin 知道入库失败
        logger.warning("we_client_crashes 入库失败 (log 里有原始数据): %s", e)

    return {"ok": True}
