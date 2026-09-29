"""
扫描 worker daemon · §5.6 异步扫描 (ClamAV + 敏感词)

启动:
    python -m platform_v8.workers.scan_worker

环境变量:
    SCAN_POLL_INTERVAL_S  (默认 5)
    SCAN_BATCH_SIZE       (默认 5)
    SCAN_MAX_BYTES        (默认 50 MB · 超大文件只扫前 50 MB)

工作流程:
  while True:
    1. scan_queue.claim_next(N) → 批量拉 pending → 标 scanning
    2. 对每个 job:
       a. provider.presign_get(object_key) → urlopen → bytes
       b. oss_scan.scan_object(key, bytes, content_type=...) → ScanResult
       c. scan_queue.mark_result(job, result.to_dict())
       d. 命中 (infected/suspicious) → write_oss_audit(action=oss.scan_hit)
       e. clean → oss.scan_complete；skipped/error → oss.scan_incomplete
    3. sleep(POLL_INTERVAL_S)

异常:
  - 单 job 失败 → mark_result(error=str(exc)) · 不影响 batch 其他 job
  - DB 整体失败 → 等下一轮 (避免 worker crash 进程)

并发:
  - 单进程跑即可 (claim_next 已把 status 改成 scanning · 同 worker 不重抢)
  - 多 worker 需要 SELECT FOR UPDATE SKIP LOCKED · 当前不支持
"""
from __future__ import annotations
import logging
import os
import signal
import sys
import time
import urllib.request
from typing import Optional

from platform_v8.services import oss_scan, oss_audit, scan_queue
from platform_v8.services.oss_provider import get_oss_provider
from platform_v8.storage.db import init_db, session_scope

logger = logging.getLogger(__name__)

POLL_INTERVAL_S = int(os.environ.get("SCAN_POLL_INTERVAL_S", "5"))
BATCH_SIZE = int(os.environ.get("SCAN_BATCH_SIZE", "5"))
MAX_BYTES = int(os.environ.get("SCAN_MAX_BYTES", str(50 * 1024 * 1024)))
DOWNLOAD_TIMEOUT_S = int(os.environ.get("SCAN_DOWNLOAD_TIMEOUT_S", "30"))

_running = True


def _handle_sigterm(signum, frame):  # type: ignore[no-untyped-def]
    global _running
    logger.info("scan_worker 收到信号 %s · 准备退出", signum)
    _running = False


def _fetch_object_bytes(provider, object_key: str) -> tuple[bytes, str]:
    """从 OSS 拉文件 · 返 (bytes, content_type)"""
    presigned = provider.presign_get(object_key, expires=300)
    url = presigned.url if hasattr(presigned, "url") else str(presigned)
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT_S) as resp:
        # 只读前 MAX_BYTES · 超大文件截断 (敏感词扫足够)
        data = resp.read(MAX_BYTES + 1)
        truncated = len(data) > MAX_BYTES
        if truncated:
            data = data[:MAX_BYTES]
            logger.warning("scan_worker: %s 被截断 (>%s bytes)", object_key, MAX_BYTES)
        content_type = resp.headers.get("Content-Type", "")
    return data, content_type


def _process_one(session, job: scan_queue.ScanJob, provider) -> None:
    """处理单个 job · 异常时 mark_result error"""
    try:
        file_bytes, content_type = _fetch_object_bytes(provider, job.object_key)
        result = oss_scan.scan_object(
            job.object_key,
            file_bytes=file_bytes,
            content_type=content_type,
            enable_virus=job.enable_virus,
            enable_sensitive=job.enable_sensitive,
        )
        scan_queue.mark_result(session, job.job_id, result=result.to_dict())

        # 写 audit
        verdict = result.verdict
        if verdict in ("infected", "suspicious"):
            oss_audit.write_oss_audit(
                session,
                account_id=job.account_id,
                action=oss_audit.ACTION_SCAN_HIT,
                object_key=job.object_key,
                task_id=job.task_id,
                ip="",
                user_agent="scan_worker",
                detail={
                    "job_id": job.job_id,
                    "verdict": verdict,
                    "threats": result.threats,
                    "sensitive_matches": result.sensitive_matches,
                    "scanner": result.scanner,
                },
            )
            logger.warning(
                "scan_worker.HIT · job=%s key=%s verdict=%s threats=%s",
                job.job_id, job.object_key, verdict, result.threats,
            )
        elif verdict == "clean":
            oss_audit.write_oss_audit(
                session,
                account_id=job.account_id,
                action=oss_audit.ACTION_SCAN_COMPLETE,
                object_key=job.object_key,
                task_id=job.task_id,
                ip="",
                user_agent="scan_worker",
                detail={
                    "job_id": job.job_id,
                    "verdict": verdict,
                    "duration_ms": result.duration_ms,
                    "scanner": result.scanner,
                },
            )
        else:
            # Queue status "done" means the attempt finished; it is not a
            # security-pass verdict.  Never audit a skipped/error attempt as
            # scan_complete or let an absent scanner look like approval.
            oss_audit.write_oss_audit(
                session,
                account_id=job.account_id,
                action=oss_audit.ACTION_SCAN_INCOMPLETE,
                object_key=job.object_key,
                task_id=job.task_id,
                ip="",
                user_agent="scan_worker",
                detail={
                    "job_id": job.job_id,
                    "verdict": verdict,
                    "duration_ms": result.duration_ms,
                    "scanner": result.scanner,
                },
            )
            logger.warning("scan_worker.INCOMPLETE · job=%s key=%s verdict=%s",
                           job.job_id, job.object_key, verdict)
        session.commit()
    except Exception as exc:
        session.rollback()
        logger.exception("scan_worker · job %s 处理失败", job.job_id)
        try:
            scan_queue.mark_result(session, job.job_id, error=str(exc)[:500])
            session.commit()
        except Exception:
            session.rollback()


def run_once(session, provider) -> int:
    """跑一批 · 返处理的 job 数"""
    try:
        jobs = scan_queue.claim_next(session, limit=BATCH_SIZE)
        session.commit()
    except Exception:
        session.rollback()
        logger.exception("scan_worker · claim_next 失败")
        return 0

    if not jobs:
        return 0
    logger.info("scan_worker · claimed %d jobs", len(jobs))
    for job in jobs:
        _process_one(session, job, provider)
    return len(jobs)


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s · %(message)s",
    )
    logger.info(
        "scan_worker 启动 · poll=%ds batch=%d max_bytes=%dMB",
        POLL_INTERVAL_S, BATCH_SIZE, MAX_BYTES // (1024 * 1024),
    )
    signal.signal(signal.SIGTERM, _handle_sigterm)
    signal.signal(signal.SIGINT, _handle_sigterm)

    init_db()
    provider = get_oss_provider()
    logger.info("scan_worker · provider=%s", type(provider).__name__)

    idle_streak = 0
    while _running:
        try:
            with session_scope() as session:
                n = run_once(session, provider)
            if n == 0:
                idle_streak += 1
                # 空跑指数退让 (1x → 2x → 4x 最大 4x · 避免 db 压力)
                sleep_s = POLL_INTERVAL_S * min(4, 1 << min(2, idle_streak))
            else:
                idle_streak = 0
                sleep_s = 1  # 有活时快点查
        except Exception:
            logger.exception("scan_worker · 主循环异常 · 等下一轮")
            sleep_s = POLL_INTERVAL_S
        # 可中断的 sleep
        for _ in range(int(sleep_s * 10)):
            if not _running:
                break
            time.sleep(0.1)
    logger.info("scan_worker 退出")
    return 0


if __name__ == "__main__":
    sys.exit(main())
