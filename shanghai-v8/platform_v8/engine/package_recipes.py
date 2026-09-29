"""Package Recipe 注册表 · 混合包 → 原子 task_type 分流.

新产品接入: register_recipe(PackageRecipe(...)) 或在 _BUILTIN 加一条.
不改编排核心; package_digest slicer 只消费本表.
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from typing import Callable

logger = logging.getLogger(__name__)

IMAGE_EXTS = {"png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"}
TEXT_EXTS = {"txt", "md", "markdown", "csv", "json", "log", "text", "eml"}
DOCX_EXTS = {"docx"}
DOC_EXTS = {"doc"}
XLSX_EXTS = {"xlsx", "xls"}
PDF_EXTS = {"pdf"}
ZIP_EXTS = {"zip"}


@dataclass(frozen=True)
class FileEntry:
    name: str
    ext: str
    size: int = 0
    index: int = 0
    mime: str = ""
    # 可选: 服务端已探测的 PDF 是否有文字层
    pdf_has_text: bool | None = None


@dataclass(frozen=True)
class FileRoute:
    task_type: str
    input_kind: str = "single_file"
    reason: str = ""
    # True → 不派发, 聚合时直接记失败项
    skip: bool = False
    error: str = ""


Classifier = Callable[[FileEntry], FileRoute]


@dataclass
class PackageRecipe:
    recipe_id: str
    description: str
    classify: Classifier
    aggregator: str = "package_merge"
    max_entries: int = 200
    max_zip_depth: int = 2
    # False → submit 层拒绝（预留配方未上线）
    ready: bool = True


_RECIPES: dict[str, PackageRecipe] = {}


def register_recipe(recipe: PackageRecipe, *, overwrite: bool = False) -> None:
    if recipe.recipe_id in _RECIPES and not overwrite:
        logger.warning("package_recipes · recipe=%s 已存在 · 跳过", recipe.recipe_id)
        return
    _RECIPES[recipe.recipe_id] = recipe
    logger.info("package_recipes · 注册 recipe=%s", recipe.recipe_id)


def get_recipe(recipe_id: str) -> PackageRecipe | None:
    return _RECIPES.get(recipe_id)


def list_recipes() -> list[PackageRecipe]:
    return list(_RECIPES.values())


def ext_of(name: str) -> str:
    base = name.rsplit("/", 1)[-1]
    if "." not in base:
        return ""
    return base.rsplit(".", 1)[-1].lower()


def _law_materials_classify(entry: FileEntry) -> FileRoute:
    ext = (entry.ext or ext_of(entry.name)).lower()
    if ext in IMAGE_EXTS:
        return FileRoute("ocr_image", reason=f"ext={ext}")
    if ext in PDF_EXTS:
        if entry.pdf_has_text is True:
            return FileRoute("pdf_to_text", reason="pdf_text_layer")
        # 探测失败或明确无字 → OCR (召回优先)
        return FileRoute("pdf_ocr", reason="pdf_scan_or_unknown")
    if ext in DOCX_EXTS:
        return FileRoute("docx_to_text", reason=f"ext={ext}")
    if ext in DOC_EXTS:
        return FileRoute("doc_to_text", reason=f"ext={ext}")
    if ext in XLSX_EXTS:
        return FileRoute("sheet_to_text", reason=f"ext={ext}")
    if ext in TEXT_EXTS:
        return FileRoute("plain_text_read", reason=f"ext={ext}")
    if ext in ZIP_EXTS:
        return FileRoute(
            "",
            skip=True,
            error="nested zip should be expanded by slicer",
            reason="nested_zip",
        )
    return FileRoute(
        "",
        skip=True,
        error=f"unsupported type: .{ext or '?'}",
        reason="unsupported",
    )


def _stub_classify(entry: FileEntry) -> FileRoute:
    return FileRoute(
        "",
        skip=True,
        error=f"recipe not implemented for {entry.name}",
        reason="stub",
    )


def _boot_builtins() -> None:
    register_recipe(PackageRecipe(
        recipe_id="law_materials",
        description="律所证据材料: 图/PDF/Word/表格/纯文本 → 识别文本",
        classify=_law_materials_classify,
        ready=True,
    ), overwrite=True)
    register_recipe(PackageRecipe(
        recipe_id="invoice_pack",
        description="发票包(预留)",
        classify=_stub_classify,
        ready=False,
    ), overwrite=True)
    register_recipe(PackageRecipe(
        recipe_id="media_pack",
        description="媒体包(预留)",
        classify=_stub_classify,
        ready=False,
    ), overwrite=True)


_boot_builtins()


# ── PDF 文字层轻量探测 ─────────────────────────────────────────
_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def probe_pdf_info(
    source: bytes | str | os.PathLike[str],
    *,
    min_chars: int = 40,
    sample_pages: int = 3,
) -> tuple[bool | None, int | None]:
    """探测 PDF: (has_text, page_count).

    source: bytes 或本地文件路径(大文件请走路径,避免整文件进内存)
    has_text: True=有文字层 · False=像扫描件 · None=无法探测
    page_count: 总页数 · 探测失败为 None
    """
    data: bytes | None
    path: str | None
    if isinstance(source, (bytes, bytearray)):
        data = bytes(source)
        path = None
        if not data or not data.startswith(b"%PDF"):
            return None, None
    else:
        path = str(source)
        data = None
        try:
            with open(path, "rb") as f:
                magic = f.read(5)
        except Exception:
            return None, None
        if not magic.startswith(b"%PDF"):
            return None, None

    try:
        import fitz  # PyMuPDF
    except Exception:
        if data is None:
            try:
                with open(path, "rb") as f:  # type: ignore[arg-type]
                    sample = f.read(200_000)
            except Exception:
                return None, None
        else:
            sample = data[:200_000]
        try:
            textish = sample.decode("latin-1", errors="ignore")
        except Exception:
            return None, None
        cjk = len(re.findall(r"[\u4e00-\u9fff]", textish))
        ascii_words = len(re.findall(r"[A-Za-z]{3,}", textish))
        has = True if (cjk + ascii_words > 80) else None
        return has, None
    try:
        if path is not None:
            doc = fitz.open(path)
        else:
            doc = fitz.open(stream=data, filetype="pdf")
        page_count = int(len(doc))
        chars = 0
        has: bool | None = False
        for i, page in enumerate(doc):
            if i >= sample_pages:
                break
            chars += len((page.get_text("text") or "").strip())
            if chars >= min_chars:
                has = True
                break
        doc.close()
        return has, page_count if page_count > 0 else None
    except Exception as exc:
        logger.debug("probe_pdf_info failed: %s", exc)
        return None, None


def probe_pdf_has_text(
    source: bytes | str | os.PathLike[str],
    *,
    min_chars: int = 40,
    max_pages: int = 3,
) -> bool | None:
    """兼容旧接口 · True=有文字层 · False=像扫描件 · None=无法探测."""
    has, _ = probe_pdf_info(source, min_chars=min_chars, sample_pages=max_pages)
    return has
