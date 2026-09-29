"""OSS 病毒 + 敏感词异步扫描 · §5.6 护栏⑤

设计要点:
- complete 上传后异步触发 (不阻塞用户)
- 扫描通过: 任务可发布
- 扫描命中: 冻结文件 + 通知 admin · 任务发布拒绝

实现:
- 病毒扫: ClamAV (本地 clamd · 通过 clamd-python 调用) · 未装则 stub 返 clean
- 敏感词扫: 文本文件用 regex 扫身份证 / 手机号 / 银行卡 / 关键词
- 命中即落 we_audit (action=oss.scan_hit) · 高优先级

异步策略:
- 同步快路径 (< 5s): API 调用方等待 (单文件 < 50MB)
- 异步慢路径 (> 5s): 投入 worker 队列 (大文件) · 这里只放接口 stub
"""
from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from typing import Literal, Optional

logger = logging.getLogger("services.oss_scan")

ScanVerdict = Literal["clean", "infected", "suspicious", "skipped", "error"]


# ── 扫描结果结构 ─────────────────────────────────────────────
@dataclass
class ScanResult:
    """单次扫描结果。"""
    object_key: str
    verdict: ScanVerdict
    threats: list[str] = field(default_factory=list)        # 病毒签名 / 敏感类型
    sensitive_matches: list[dict] = field(default_factory=list)  # [{kind, count}]
    scanned_at: float = 0.0
    duration_ms: int = 0
    scanner: str = ""                                       # clamav / regex / stub
    error: str = ""

    @property
    def is_safe(self) -> bool:
        # An unavailable/disabled scanner has not established that the bytes
        # are safe.  In particular, skipped must never satisfy a publication
        # review gate even if the worker finished processing the scan job.
        return self.verdict == "clean"

    def to_dict(self) -> dict:
        return {
            "object_key": self.object_key,
            "verdict": self.verdict,
            "threats": self.threats,
            "sensitive_matches": self.sensitive_matches,
            "scanned_at": self.scanned_at,
            "duration_ms": self.duration_ms,
            "scanner": self.scanner,
            "error": self.error,
        }


# ── 敏感词正则表 (中国合规典型项) ─────────────────────────────
SENSITIVE_PATTERNS = {
    "id_card": re.compile(r"\b[1-9]\d{5}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b"),
    "bank_card": re.compile(r"\b\d{16,19}\b"),  # 简单匹配 16-19 位数字
    "mobile_cn": re.compile(r"\b1[3-9]\d{9}\b"),
    "email": re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b"),
}

# 关键词黑名单 (示例 · 实际由 admin 配置)
SENSITIVE_KEYWORDS = {"机密", "绝密", "内部资料", "禁止外传"}


# ── ClamAV 扫描 (病毒) ───────────────────────────────────────
def _scan_with_clamav(file_bytes: bytes, object_key: str) -> ScanResult:
    """调本地 clamd 扫病毒。需要先 brew install clamav + 启动 freshclam + clamd。

    若 clamd 未运行 · 返 verdict=skipped + scanner=stub。
    """
    started = time.time()
    try:
        import clamd  # type: ignore
    except ImportError:
        logger.debug("[SCAN] clamd python lib 未装 · 病毒扫跳过")
        return ScanResult(
            object_key=object_key,
            verdict="skipped",
            scanner="stub",
            scanned_at=started,
            duration_ms=int((time.time() - started) * 1000),
        )

    try:
        cd = clamd.ClamdUnixSocket()  # 默认 /var/run/clamav/clamd.ctl
        from io import BytesIO
        result = cd.instream(BytesIO(file_bytes))
        # clamd 返回 {'stream': ('FOUND', 'EICAR-Test-File')} 或 ('OK', None)
        status, sig = result.get("stream", ("ERROR", "no_result"))
        verdict: ScanVerdict
        threats = []
        if status == "OK":
            verdict = "clean"
        elif status == "FOUND":
            verdict = "infected"
            threats = [sig or "unknown"]
        else:
            verdict = "error"

        return ScanResult(
            object_key=object_key,
            verdict=verdict,
            threats=threats,
            scanner="clamav",
            scanned_at=started,
            duration_ms=int((time.time() - started) * 1000),
        )
    except Exception as e:
        logger.warning("[SCAN] ClamAV 调用失败 · 降级 stub: %s", e)
        return ScanResult(
            object_key=object_key,
            verdict="skipped",
            scanner="stub",
            scanned_at=started,
            duration_ms=int((time.time() - started) * 1000),
            error=str(e)[:200],
        )


# ── 敏感词扫描 (regex) ─────────────────────────────────────────
def _scan_sensitive(text_content: str, object_key: str) -> list[dict]:
    """文本敏感信息扫描。

    Returns:
        [{"kind": "id_card", "count": 3}, {"kind": "keyword_机密", "count": 1}]
    """
    matches: list[dict] = []
    if not text_content:
        return matches

    for kind, pattern in SENSITIVE_PATTERNS.items():
        hits = pattern.findall(text_content)
        if hits:
            matches.append({"kind": kind, "count": len(hits)})

    for keyword in SENSITIVE_KEYWORDS:
        if keyword in text_content:
            matches.append({"kind": f"keyword_{keyword}", "count": text_content.count(keyword)})

    return matches


# ── 主入口: 扫单个对象 ────────────────────────────────────────
def scan_object(
    object_key: str,
    file_bytes: Optional[bytes] = None,
    *,
    content_type: str = "",
    enable_virus: bool = True,
    enable_sensitive: bool = True,
) -> ScanResult:
    """扫描单个 OSS 对象。

    Args:
        object_key: OSS 对象 key
        file_bytes: 文件内容 (调用方负责从 OSS 拉取传入)
        content_type: 用于决定是否做敏感词扫 (仅 text/* / json / csv)
        enable_virus: 是否做病毒扫
        enable_sensitive: 是否做敏感词扫

    Returns:
        ScanResult · 包含 verdict + 命中详情
    """
    started = time.time()

    # 文件为空 · 跳过
    if file_bytes is None or len(file_bytes) == 0:
        return ScanResult(
            object_key=object_key,
            verdict="skipped",
            scanner="stub",
            scanned_at=started,
            duration_ms=int((time.time() - started) * 1000),
        )

    # 1. 病毒扫
    virus_result: ScanResult
    if enable_virus:
        virus_result = _scan_with_clamav(file_bytes, object_key)
    else:
        virus_result = ScanResult(object_key=object_key, verdict="skipped", scanner="disabled")

    # 病毒命中 · 直接返 (短路 · 不再做敏感词扫)
    if virus_result.verdict == "infected":
        virus_result.duration_ms = int((time.time() - started) * 1000)
        return virus_result

    # 2. 敏感词扫 (仅文本)
    sensitive_matches: list[dict] = []
    if enable_sensitive and _is_text_content(content_type):
        try:
            text_content = file_bytes.decode("utf-8", errors="replace")
            sensitive_matches = _scan_sensitive(text_content, object_key)
        except Exception as e:
            logger.debug("[SCAN] 文本解码失败 (忽略敏感扫): %s", e)

    # 3. 综合 verdict
    final_verdict: ScanVerdict
    if virus_result.verdict == "error":
        final_verdict = "error"
    elif sensitive_matches:
        final_verdict = "suspicious"
    elif virus_result.verdict in ("clean", "skipped"):
        final_verdict = virus_result.verdict
    else:
        final_verdict = "error"

    return ScanResult(
        object_key=object_key,
        verdict=final_verdict,
        threats=virus_result.threats,
        sensitive_matches=sensitive_matches,
        scanner=f"{virus_result.scanner}+regex" if sensitive_matches else virus_result.scanner,
        scanned_at=started,
        duration_ms=int((time.time() - started) * 1000),
        error=virus_result.error,
    )


def _is_text_content(content_type: str) -> bool:
    """判断 content_type 是不是文本 (决定是否做敏感词扫)。"""
    if not content_type:
        return False
    ct = content_type.lower()
    return (
        ct.startswith("text/")
        or "json" in ct
        or "xml" in ct
        or "csv" in ct
        or "html" in ct
    )


# ── 异步队列接口 ────────────────────────────────────────────────
# 2026-05-21 · 此函数保留为兼容入口 · 真持久化在 platform_v8.services.scan_queue
# 调用方 (oss.py endpoint) 应改用 scan_queue.enqueue(session, ...)
def enqueue_scan(object_key: str, account_id: int, task_id: int | str = 0) -> str:
    """[deprecated] 仅返假 job_id · 真持久化请用 scan_queue.enqueue(session, ...)

    保留是为兼容 (避免破坏不依赖 session 的老调用方)。
    新代码请用 scan_queue 模块。
    """
    import uuid
    job_id = f"scan-{uuid.uuid4().hex[:12]}"
    logger.warning(
        "[SCAN] oss_scan.enqueue_scan 已废弃 · 请改用 scan_queue.enqueue · "
        "本次仅返假 id=%s key=%s account=%s task=%s",
        job_id, object_key, account_id, task_id,
    )
    return job_id
