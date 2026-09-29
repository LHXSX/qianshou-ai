"""
Post-process · workload 全 shard DONE 聚合后的"服务器侧"二段处理钩子

设计动机 (2026-06-11 · 律所「智能阅卷」链路):
  节点段:  图片 → OCR → 文字          (重活·分布式·跑在群众节点 ocr venv)
  服务器段: 文字 → AI 提炼 → Excel      (用服务器自己的 LLM key·绝不下发节点)

为什么放服务器:
  1. 密钥安全:平台 DeepSeek key 留在服务器 env (AI_SCRIPT_API_KEY)·节点拿不到
  2. 汇总需全局视角:跨页/跨片的时间线/证据/争议焦点要看全文·不适合分片
  3. 复用 scripts/tasks/case_digest.py (与节点同一份代码·subprocess 真跑)

触发方式 (opt-in · 不影响普通 ocr_image 用法):
  workload.spec.params["post_process"] == "case_digest"
  其余 params:
    digest_case_type  案由 (借贷纠纷/劳动争议/...)
    digest_tags       自定义抽取标签 (逗号分隔)

产物落地:
  Excel 上传 OSS · WorkloadResult.output_ref = object_key (下载端按需 presign·不过期)
  inline_output = AI 提炼摘要文本 (前端结果预览直接看)
  metadata.pipeline = [OCR, AI 提炼, Excel] 全链路状态 (办公楼一条龙展示)

失败兜底:
  任何一步抛错 → 记 warning · 原样返回 base_result (OCR 文字结果不丢)
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

from platform_v8.core import Workload, Shard, WorkloadResult

logger = logging.getLogger(__name__)

_ROOT = Path(__file__).resolve().parents[1]          # platform_v8/
_SCRIPT_DIGEST = _ROOT / "scripts" / "tasks" / "case_digest.py"

_MAX_CHARS = 80_000
_TIMEOUT_DIGEST_S = 180
_XLSX_CT = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


# ── 公开入口 ──────────────────────────────────────────────────────
def maybe_run(workload: Workload, shards: list[Shard],
              base_result: WorkloadResult) -> WorkloadResult:
    """聚合后调用 · 按 spec.params.post_process 决定是否跑服务器侧二段。

    永远返回一个 WorkloadResult:成功 = 富化后的结果 · 失败 = 原样 base_result。
    本函数是阻塞的 (subprocess + http)·调用方需放线程池。
    """
    params = dict(getattr(workload.spec, "params", {}) or {})
    kind = (params.get("post_process") or "").strip()
    if kind != "case_digest":
        return base_result

    try:
        return _run_case_digest(workload, shards, base_result, params)
    except Exception as exc:
        logger.warning("post_process.case_digest · workload=%s 失败 (回落 OCR 结果): %s",
                       workload.id, exc)
        # 把失败原因挂进 metadata · 前端能看出"AI 提炼这步没成"
        meta = dict(base_result.metadata or {})
        meta["post_process"] = {"kind": "case_digest", "status": "failed",
                                "error": str(exc)[:300]}
        base_result.metadata = meta
        return base_result


# ── case_digest 二段实现 ──────────────────────────────────────────
def _run_case_digest(workload: Workload, shards: list[Shard],
                     base_result: WorkloadResult, params: dict) -> WorkloadResult:
    ocr_text = _collect_ocr_text(shards)
    if not ocr_text:
        raise RuntimeError("上游 OCR 未产出文字 (result_text 为空)")
    if len(ocr_text) > _MAX_CHARS:
        ocr_text = ocr_text[:_MAX_CHARS]

    endpoint, model, key = _llm_cfg()
    if not key:
        raise RuntimeError("服务器未配置 AI key (AI_SCRIPT_API_KEY)")

    with tempfile.TemporaryDirectory() as outdir:
        digest = _exec_digest(ocr_text, params, endpoint, model, key, outdir)
        excel_key = _upload_excel(workload, outdir)

    sm = digest.get("summary") or {}
    summary_text = digest.get("summary_text") or ""
    ocr_chars = len(ocr_text)
    ocr_ms = int(base_result.elapsed_ms or 0)
    digest_ms = int(digest.get("elapsed_ms") or 0)

    pipeline = [
        {"step": "ocr", "label": "节点 OCR 识别", "status": "done",
         "detail": {"chars": ocr_chars, "shards": len(shards)}, "elapsed_ms": ocr_ms},
        {"step": "map", "label": "服务器 AI 分块阅卷", "status": "done",
         "detail": {"chunks": sm.get("chunks_processed"), "failed": sm.get("chunks_failed")}},
        {"step": "reduce", "label": "汇总 Reduce", "status": "done",
         "detail": {"events": sm.get("events_found"), "evidence": sm.get("evidence_found")}},
        {"step": "excel", "label": "生成 Excel 阅卷报告",
         "status": "done" if excel_key else "skipped"},
    ]

    meta = dict(base_result.metadata or {})
    meta.update({
        "post_process": {"kind": "case_digest", "status": "ok"},
        "pipeline": pipeline,
        "ocr_chars": ocr_chars,
        "digest_summary": sm,
        "ran_on": "server",        # 节点段=OCR · 此段=服务器
    })

    summary = (
        f"AI 阅卷完成 · {sm.get('events_found', 0)} 个时间点 · "
        f"{sm.get('evidence_found', 0)} 条证据 · OCR {ocr_chars:,} 字"
    )
    inline = summary_text or json.dumps(digest.get("digest", {}), ensure_ascii=False)

    logger.info("post_process.case_digest · workload=%s OCR=%d字 digest=%dms excel=%s",
                workload.id, ocr_chars, digest_ms, bool(excel_key))

    return WorkloadResult(
        output_ref=excel_key or base_result.output_ref,
        inline_output=inline,
        summary=summary,
        elapsed_ms=ocr_ms + digest_ms,
        metadata=meta,
    )


def _collect_ocr_text(shards: list[Shard]) -> str:
    """从各 OCR 分片回报里抽 result_text · 按 index 顺序拼成全文 (带【第N页】标记)。"""
    parts: list[str] = []
    for sh in sorted(shards, key=lambda s: (s.index if s.index is not None else 0)):
        ref = sh.output_ref
        if not ref:
            continue
        try:
            data = json.loads(ref)
        except Exception:
            # 纯文本回报 · 直接用
            parts.append(str(ref))
            continue
        if isinstance(data, dict):
            txt = data.get("result_text") or data.get("text") or ""
            if txt:
                parts.append(txt)
    return "\n\n".join(p for p in parts if p.strip())


def _llm_cfg() -> tuple[str, str, str]:
    base = (os.environ.get("AI_SCRIPT_BASE_URL") or "https://api.deepseek.com/v1").rstrip("/")
    endpoint = base + "/chat/completions"
    model = os.environ.get("AI_SCRIPT_MODEL") or "deepseek-chat"
    key = os.environ.get("AI_SCRIPT_API_KEY") or ""
    return endpoint, model, key


def _exec_digest(text: str, params: dict, endpoint: str, model: str,
                 key: str, outdir: str) -> dict:
    """subprocess 真跑 case_digest.py (与节点同一份代码)·出 JSON + Excel。"""
    if not _SCRIPT_DIGEST.exists():
        raise RuntimeError(f"脚本未部署: {_SCRIPT_DIGEST}")
    ec_params = {
        "endpoint": endpoint, "model": model, "api_key": key,
        "case_type": params.get("digest_case_type") or params.get("case_type") or "通用",
        "tags": params.get("digest_tags") or params.get("tags") or "",
        "emit_excel": True, "chunk_chars": 8000, "retry": 1, "timeout": 90,
    }
    modules = params.get("digest_modules") or params.get("modules")
    if modules and modules != "all":
        ec_params["modules"] = [modules] if isinstance(modules, str) else modules

    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["EC_PARAMS"] = json.dumps(ec_params, ensure_ascii=False)
    env["EC_OUTPUT_DIR"] = outdir
    proc = subprocess.run(
        [sys.executable, str(_SCRIPT_DIGEST)],
        input=text, text=True, capture_output=True, env=env,
        timeout=_TIMEOUT_DIGEST_S,
    )
    out = (proc.stdout or "").strip()
    if not out:
        raise RuntimeError(f"case_digest 无输出 · stderr={(proc.stderr or '')[:400]}")
    result = json.loads(out.split("\n")[-1])
    if result.get("status") != "ok":
        raise RuntimeError(f"case_digest 失败: {result.get('error', '未知')}")
    return result


def _upload_excel(workload: Workload, outdir: str) -> str:
    """把 outdir/阅卷报告.xlsx 传到 OSS · 返回 object_key (下载端按需 presign)。

    无 Excel (节点没 openpyxl / 脚本没出表) → 返回 "" · 不致命。
    """
    xlsx = Path(outdir) / "阅卷报告.xlsx"
    if not xlsx.exists():
        logger.info("post_process · workload=%s 无 Excel 产物 · 仅回 JSON", workload.id)
        return ""
    data = xlsx.read_bytes()

    from platform_v8.services.oss_provider import get_oss_provider
    provider = get_oss_provider()
    object_key = f"v8/account-{workload.owner_id}/{workload.id}/result/case-review-report.xlsx"
    presigned = provider.presign_put(object_key, content_type=_XLSX_CT, expires=3600)

    url = presigned.url if hasattr(presigned, "url") else (
        presigned.get("url") if isinstance(presigned, dict) else str(presigned))
    headers = (getattr(presigned, "headers", None)
               or (presigned.get("headers") if isinstance(presigned, dict) else None)
               or {"Content-Type": _XLSX_CT})

    req = urllib.request.Request(url, data=data, method="PUT", headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        if resp.status not in (200, 201, 204):
            raise RuntimeError(f"OSS PUT 失败 · http {resp.status}")
    logger.info("post_process · workload=%s Excel 上传 OSS · key=%s size=%d",
                workload.id, object_key, len(data))
    return object_key
