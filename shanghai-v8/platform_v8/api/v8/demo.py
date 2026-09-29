"""
v8 demo router · 公开演示端点(真实运行,非模拟)

GET  /api/v8/demo/case-digest/status     演示能力探测(AI key / OCR)
GET  /api/v8/demo/case-digest/sample     返回样例卷宗文本
POST /api/v8/demo/case-digest            真跑 case_digest.py(真实 DeepSeek)
POST /api/v8/demo/case-digest/from-images  图片 OCR → case_digest 全链路

设计:
  - 真实运行 = subprocess 调真实 scripts/tasks/*.py(与节点同一份代码)
  - LLM 走真实 DeepSeek(key 从 env AI_SCRIPT_API_KEY)
  - 产物 Excel 以 base64 回传(演示页可直接下载)
  - 真实运行入口默认关闭；需显式开启且登录后才可调用
"""
from __future__ import annotations

import base64
import json
import logging
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from platform_v8.api.deps import get_current_account
from platform_v8.core import Account

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v8/demo", tags=["demo"])

_ROOT = Path(__file__).resolve().parents[2]
_SCRIPT_DIGEST = _ROOT / "scripts" / "tasks" / "case_digest.py"
_SCRIPT_OCR = _ROOT / "scripts" / "tasks" / "ocr_image.py"


_MAX_CHARS = 40_000
_MAX_IMAGES = 8
_MAX_IMAGE_BYTES = 8 * 1024 * 1024
_TIMEOUT_DIGEST_S = 150
_TIMEOUT_OCR_S = 120

_SAMPLE = """【第1页】民间借贷纠纷案卷
原告:张明,男,1980年生,住沈阳市和平区。
被告:李强,男,1985年生,住沈阳市皇姑区。
2024年3月15日,张明与李强签订《借款协议》,约定张明向李强出借人民币50万元,借款期限一年,年利率12%,到期日2025年3月14日。
【第2页】证据一:借条一张,载明"今借到张明人民币伍拾万元整,2024年3月15日,李强(签字)"。
证据二:银行转账记录,显示2024年3月15日张明账户向李强账户转账500000元。
【第3页】担保:王伟为本笔借款提供连带责任保证,签署《保证合同》。
2024年9月,李强归还本金10万元,有微信转账记录为证。此后未再还款。
【第4页】2025年3月到期后,张明多次催讨未果。被告李强辩称借款实际只收到40万元,且利息约定过高。
张明诉请:判令李强归还本金40万元及利息,王伟承担连带清偿责任。"""


class CaseDigestReq(BaseModel):
    text: str = Field(..., description="卷宗文字(上游 OCR 输出)")
    case_type: str = Field(default="通用")
    tags: str = Field(default="", description="自定义标签,逗号分隔")


def _demo_ai_enabled() -> bool:
    return os.environ.get("V8_DEMO_AI_POST_ENABLED", "").strip().lower() in {
        "1", "true", "yes", "on",
    }


def _require_demo_ai_enabled() -> None:
    if not _demo_ai_enabled():
        raise HTTPException(status_code=503, detail="AI 演示尚未开放")


def _deepseek_cfg() -> tuple[str, str, str]:
    base = (os.environ.get("AI_SCRIPT_BASE_URL") or "https://api.deepseek.com/v1").rstrip("/")
    endpoint = base + "/chat/completions"
    model = os.environ.get("AI_SCRIPT_MODEL") or "deepseek-chat"
    key = os.environ.get("AI_SCRIPT_API_KEY") or ""
    return endpoint, model, key


def _ocr_available() -> bool:
    try:
        import paddleocr  # noqa: F401
        return True
    except Exception:
        pass
    try:
        import pytesseract  # noqa: F401
        from PIL import Image  # noqa: F401
        return True
    except Exception:
        return False


def _run_script(script: Path, *, stdin: str = "", params: dict | None = None,
                outdir: str = "", timeout: int = 120) -> dict:
    if not script.exists():
        raise HTTPException(status_code=500, detail=f"脚本未部署: {script.name}")
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    if params is not None:
        env["EC_PARAMS"] = json.dumps(params, ensure_ascii=False)
    if outdir:
        env["EC_OUTPUT_DIR"] = outdir
    try:
        proc = subprocess.run(
            [sys.executable, str(script)],
            input=stdin, text=True, capture_output=True,
            env=env, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail=f"{script.stem} 超时")
    out = (proc.stdout or "").strip()
    if not out:
        logger.warning("demo.%s · 无 stdout · stderr=%s", script.stem, (proc.stderr or "")[:500])
        raise HTTPException(status_code=500, detail=f"{script.stem} 无输出")
    try:
        result = json.loads(out.split("\n")[-1])
    except Exception:
        raise HTTPException(status_code=500, detail=f"{script.stem} 结果解析失败")
    if result.get("status") != "ok":
        raise HTTPException(status_code=502,
                            detail=f"{script.stem} 失败: {result.get('error', '未知')}")
    return result


def _digest_params(case_type: str, tags: str) -> dict:
    endpoint, model, key = _deepseek_cfg()
    return {
        "endpoint": endpoint, "model": model, "api_key": key,
        "case_type": case_type or "通用",
        "tags": tags or "",
        "emit_excel": True, "chunk_chars": 8000, "retry": 1, "timeout": 90,
    }


def _pack_response(digest_result: dict, outdir: str,
                   *, ocr_result: Optional[dict] = None) -> dict:
    excel_b64 = ""
    xlsx = Path(outdir) / "阅卷报告.xlsx"
    if xlsx.exists():
        excel_b64 = base64.b64encode(xlsx.read_bytes()).decode("ascii")

    pipeline = [
        {"step": "input", "label": "接收卷宗", "status": "done"},
    ]
    if ocr_result:
        pipeline.append({
            "step": "ocr", "label": "OCR 识别", "status": "done",
            "elapsed_ms": ocr_result.get("elapsed_ms"),
            "detail": ocr_result.get("summary"),
        })
    else:
        pipeline.append({"step": "ocr", "label": "OCR 识别", "status": "skipped",
                         "detail": {"reason": "文本直传,跳过 OCR"}})

    sm = digest_result.get("summary") or {}
    pipeline.extend([
        {"step": "map", "label": "AI 分块阅卷", "status": "done",
         "detail": {"chunks": sm.get("chunks_processed"), "failed": sm.get("chunks_failed")}},
        {"step": "reduce", "label": "汇总 Reduce", "status": "done",
         "detail": {"events": sm.get("events_found"), "evidence": sm.get("evidence_found")}},
        {"step": "excel", "label": "生成 Excel", "status": "done" if excel_b64 else "skipped"},
    ])

    total_ms = int(digest_result.get("elapsed_ms") or 0)
    if ocr_result:
        total_ms += int(ocr_result.get("elapsed_ms") or 0)

    return {
        "ok": True,
        "pipeline": pipeline,
        "summary": sm,
        "digest": digest_result.get("digest", {}),
        "summary_text": digest_result.get("summary_text", ""),
        "excel_base64": excel_b64,
        "excel_filename": "阅卷报告.xlsx",
        "elapsed_ms": total_ms,
        "ocr": ocr_result.get("summary") if ocr_result else None,
    }


@router.get("/case-digest/status", summary="演示能力探测")
def status() -> dict:
    _, _, key = _deepseek_cfg()
    enabled = _demo_ai_enabled()
    return {
        "ok": True,
        "ai_ready": enabled and bool(key),
        "enabled": enabled,
        "ocr_ready": _ocr_available(),
        "model": os.environ.get("AI_SCRIPT_MODEL") or "deepseek-chat",
    }


@router.get("/case-digest/sample", summary="演示样例卷宗")
def sample() -> dict:
    return {
        "ok": True,
        "text": _SAMPLE,
        "case_type": "借贷纠纷",
        "tags": "出借人,借款人,借款金额,约定利息,已还金额,担保方式,逾期情况",
    }


@router.post("/case-digest", summary="真实跑一次智能阅卷(DeepSeek)")
def run_case_digest(
    req: CaseDigestReq,
    _current: Account = Depends(get_current_account),
) -> dict:
    _require_demo_ai_enabled()
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text 不能为空")
    if len(text) > _MAX_CHARS:
        raise HTTPException(status_code=400, detail=f"演示文本上限 {_MAX_CHARS} 字")
    _, _, key = _deepseek_cfg()
    if not key:
        raise HTTPException(status_code=503, detail="演示未配置 AI key(AI_SCRIPT_API_KEY)")

    with tempfile.TemporaryDirectory() as outdir:
        result = _run_script(
            _SCRIPT_DIGEST, stdin=text,
            params=_digest_params(req.case_type, req.tags),
            outdir=outdir, timeout=_TIMEOUT_DIGEST_S,
        )
        return _pack_response(result, outdir)


@router.post("/case-digest/from-images", summary="图片 OCR → 智能阅卷(全链路)")
async def run_from_images(
    files: list[UploadFile] = File(..., description="卷宗扫描件/照片"),
    case_type: str = Form(default="通用"),
    tags: str = Form(default=""),
    _current: Account = Depends(get_current_account),
) -> dict:
    _require_demo_ai_enabled()
    if not files:
        raise HTTPException(status_code=400, detail="请上传至少一张图片")
    if len(files) > _MAX_IMAGES:
        raise HTTPException(status_code=400, detail=f"演示最多 {_MAX_IMAGES} 张图片")
    _, _, key = _deepseek_cfg()
    if not key:
        raise HTTPException(status_code=503, detail="演示未配置 AI key(AI_SCRIPT_API_KEY)")
    if not _ocr_available():
        raise HTTPException(status_code=503, detail="演示环境未安装 OCR 引擎(PaddleOCR/Tesseract)")

    with tempfile.TemporaryDirectory() as work:
        indir = Path(work) / "in"
        outdir = Path(work) / "out"
        indir.mkdir()
        outdir.mkdir()
        saved = 0
        for i, uf in enumerate(files):
            raw = await uf.read()
            if not raw:
                continue
            if len(raw) > _MAX_IMAGE_BYTES:
                raise HTTPException(status_code=400, detail=f"单张图片上限 {_MAX_IMAGE_BYTES // 1024 // 1024}MB")
            ext = Path(uf.filename or f"page{i+1}.jpg").suffix.lower()
            if ext not in (".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp"):
                ext = ".jpg"
            (indir / f"page_{i+1:03d}{ext}").write_bytes(raw)
            saved += 1
        if not saved:
            raise HTTPException(status_code=400, detail="图片为空")

        ocr_result = _run_script(
            _SCRIPT_OCR,
            params={"lang": "ch", "preprocess": True, "min_confidence": 0.5},
            outdir=str(outdir), timeout=_TIMEOUT_OCR_S,
        )
        text = (ocr_result.get("result_text") or "").strip()
        if not text:
            raise HTTPException(status_code=502, detail="OCR 未识别出文字")
        if len(text) > _MAX_CHARS:
            text = text[:_MAX_CHARS]

        digest_result = _run_script(
            _SCRIPT_DIGEST, stdin=text,
            params=_digest_params(case_type, tags),
            outdir=str(outdir), timeout=_TIMEOUT_DIGEST_S,
        )
        resp = _pack_response(digest_result, str(outdir), ocr_result=ocr_result)
        resp["ocr_text"] = text
        return resp
