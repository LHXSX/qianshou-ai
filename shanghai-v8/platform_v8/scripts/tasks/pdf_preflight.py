"""PDF 转文本/OCR 的可复用预检与路由。

预检只读取元数据和少量页面的文本层，不上传正文也不把正文写日志。调度端可
使用返回的 ``total_pages`` 做精确页切片；节点端再次调用同一逻辑以便在旧任务
或没有预检结果时保持正确的自动路由。
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from io import BytesIO
from typing import Any, Literal


Route = Literal["text", "ocr"]


@dataclass(frozen=True)
class PdfPreflight:
    total_pages: int
    sampled_pages: int
    text_chars: int
    chars_per_page: float
    encrypted: bool
    route: Route
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def inspect_pdf(
    pdf_bytes: bytes,
    *,
    password: str = "",
    text_density_threshold: float = 24.0,
    sample_pages: int = 3,
) -> PdfPreflight:
    """检查 PDF 页数、加密状态与文本密度并选择 text/ocr 路径。

    ``text`` 表示优先 PyMuPDF/MarkItDown 的可搜索文本路径；``ocr`` 表示
    PP-OCRv6 路径。不能解析或密码不正确时抛 ValueError，调用者应将任务标
    为可解释的业务失败，而不是将坏文件下发给所有节点重试。
    """
    try:
        import fitz  # type: ignore
    except ImportError as exc:
        raise RuntimeError("PDF 预检需要 PyMuPDF (fitz)") from exc

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as exc:
        raise ValueError(f"无法解析 PDF: {exc}") from exc

    try:
        encrypted = bool(doc.needs_pass)
        if encrypted and (not password or not doc.authenticate(password)):
            raise ValueError("PDF 已加密，需提供有效 password")
        total_pages = len(doc)
        if total_pages <= 0:
            raise ValueError("PDF 不含可处理页面")
        count = min(total_pages, max(1, sample_pages))
        # 首/中/尾页抽样，避免只取封面导致文本型文档被误判。
        indexes = sorted({round(i * (total_pages - 1) / max(1, count - 1)) for i in range(count)})
        chars = sum(len((doc[i].get_text() or "").strip()) for i in indexes)
        density = chars / len(indexes)
        if density >= text_density_threshold:
            route: Route = "text"
            reason = f"抽样文本密度 {density:.1f} 字/页，优先文本层提取"
        else:
            route = "ocr"
            reason = f"抽样文本密度 {density:.1f} 字/页，转 PP-OCRv6"
        return PdfPreflight(
            total_pages=total_pages,
            sampled_pages=len(indexes),
            text_chars=chars,
            chars_per_page=round(density, 2),
            encrypted=encrypted,
            route=route,
            reason=reason,
        )
    finally:
        doc.close()
