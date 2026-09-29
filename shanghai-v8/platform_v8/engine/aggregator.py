"""
Aggregator · shard 完成后聚合 + workload 状态推进 + ledger 闭环

设计要点 (考虑全链路):
  1. on_shard_done 被 ws.py 的 shard_result 处理调用 (worker 报结果)
  2. 检查 workload 所有 shard 状态:
     全 DONE → 聚合 output_ref → workload.DONE + reward + escrow_release
     部分失败 + 重试用完 → workload.FAILED + refund
     还没到齐 → 留着等其他 shard
  3. 链路 4 的 ledger 模块在这里被串起来 (reward / refund / escrow_release)
  4. 全程同一事务 (workload 推进 + ledger 写) · 不一致就 rollback
"""
from __future__ import annotations
import asyncio
import logging
import time
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session
from sqlalchemy import select, text

from platform_v8.core import (
    Workload, Shard, WorkloadStatus, WorkloadResult, ShardStatus,
)
from platform_v8.storage import db as db_mod
from platform_v8.storage.repo import (
    WorkloadRepo, ShardRepo, WorkerRepo, AuditRepo, ResultVerificationRepo,
    workload_buyer_acceptances_t,
)
from platform_v8.services.economy import ledger as ledger_svc
from platform_v8.services.observability import record_lifecycle_event
from platform_v8.engine import broker
from platform_v8.services import film_text_compat as text_compat

logger = logging.getLogger(__name__)
_RETRY_WORKER_EXCLUSION_SECONDS = 900


def _result_delivery_error(result: WorkloadResult) -> str:
    """Return a fail-closed reason when an aggregator produced no deliverable."""
    soft_failure = _soft_failure_message(result.output_ref)
    if soft_failure:
        return soft_failure
    try:
        payload = __import__("json").loads(result.output_ref or "")
    except Exception:
        payload = None
    if isinstance(payload, dict) and payload.get("status") == "failed":
        return str(payload.get("error") or "聚合未生成可交付结果")
    if not result.output_ref and not result.inline_output:
        return "聚合未生成可交付结果"
    return ""


def _soft_failure_message(output_ref: str | None) -> str | None:
    """Recognize legacy script JSON that reports failure without status=failed."""
    try:
        payload = __import__("json").loads(output_ref or "")
    except (TypeError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    errors = payload.get("errors")
    if isinstance(errors, list) and errors and not payload.get("pages"):
        messages = [
            str(item.get("error") or "").strip()
            for item in errors if isinstance(item, dict)
        ]
        messages = [message for message in messages if message]
        if messages:
            return "; ".join(messages[:3])
    if str(payload.get("status") or "").lower() == "ok":
        return None
    error = str(payload.get("error") or "").strip()
    if error and not payload.get("output_path") and not payload.get("result_files_b64"):
        return error
    return None


def partial_delivery_settlement(
    budget: Decimal, verified_units: int, failed_units: int,
) -> tuple[Decimal, Decimal]:
    """Return (settled_spend, customer_refund) for a partial delivery."""
    total_units = max(0, int(verified_units)) + max(0, int(failed_units))
    budget = Decimal(str(budget or 0))
    if total_units <= 0 or verified_units <= 0:
        return Decimal("0"), budget
    settled = (
        budget * Decimal(verified_units) / Decimal(total_units)
    ).quantize(Decimal("0.0001"))
    return settled, budget - settled


def _logical_unit_id(shard: Shard) -> str:
    return str((shard.metadata or {}).get("replica_of") or shard.id)


def _verification_gate_error(
    workload: Workload,
    paid_shards: list[Shard],
    verification_rows: list[dict[str, Any]],
    *,
    buyer_acceptance: dict[str, Any] | None = None,
) -> str | None:
    """Fail-closed settlement gate for every physical proof being paid."""
    from platform_v8.services import lan_qa

    lan_relax = lan_qa.relax_verifier_enabled()
    policy = str(
        getattr(getattr(workload, "spec", None), "verification_policy", "")
        or ""
    )
    if policy not in {"semantic", "artifact"}:
        # 旧 workload 默认 quarantine：回落到 task registry.settlement_policy
        try:
            from platform_v8.engine.task_registry import get_spec
            tt = getattr(getattr(workload, "spec", None), "task_type", "") or ""
            policy = str(getattr(get_spec(tt), "settlement_policy", "quarantine") or "quarantine")
        except Exception:
            policy = "quarantine"
    policy = lan_qa.effective_settlement_policy(policy)
    if policy not in {"semantic", "artifact"}:
        return f"unsettleable verification policy: {policy}"
    bound = (getattr(workload.spec, "requirements", None) or {}).get(
        "_reviewed_task_contract")
    buyer_confirmed = (isinstance(bound, dict)
                       and bound.get("result_strategy") == "buyer-confirmed-structure.v1")
    if buyer_confirmed and (
        not isinstance(buyer_acceptance, dict)
        or buyer_acceptance.get("decision") != "accept"
        or int(buyer_acceptance.get("owner_id") or -1) != int(workload.owner_id)
        or buyer_acceptance.get("contract_sha256") != bound.get("contract_sha256")
        or len(paid_shards) != 1
        or bound.get("output_kind") != "inline_json"
        or policy != "semantic"
    ):
        return "buyer acceptance required for structural result"
    by_shard = {str(row["shard_id"]): row for row in verification_rows}
    for shard in paid_shards:
        if shard.status != ShardStatus.DONE:
            return f"paid shard is not DONE: {shard.id}"
        row = by_shard.get(str(shard.id))
        if row is None:
            if lan_relax and shard.output_ref:
                # LAN/验收：runtime_v2 成功但未落 verification 行时临时放行
                continue
            return f"missing verification: {shard.id}"
        if str(row.get("workload_id")) != str(workload.id):
            return f"verification workload mismatch: {shard.id}"
        if str(row.get("worker_id") or "") != str(shard.worker_id or ""):
            return f"verification worker mismatch: {shard.id}"
        if int(row.get("attempt") or -1) != int(shard.attempts):
            return f"verification attempt mismatch: {shard.id}"
        requested = str(row.get("requested_policy") or "")
        if requested != policy and not (
            lan_relax and requested in {"", "quarantine", "artifact", "semantic"}
        ):
            return f"verification policy mismatch: {shard.id}"
        if str(row.get("state") or "") != ResultVerificationRepo.SUCCEEDED:
            if not (lan_relax and shard.output_ref):
                return f"verification incomplete: {shard.id}"
        evidence = dict(row.get("evidence") or {})
        disposition = str(row.get("disposition") or "")
        actual = str(evidence.get("actual_disposition") or {
            "VERIFIED": "semantic",
            "ARTIFACT_VERIFIED": "artifact",
            "QUARANTINED": "quarantine",
        }.get(disposition, ""))
        if policy == "artifact":
            valid_disposition = (
                disposition == "ARTIFACT_VERIFIED"
                and actual == "artifact"
            )
        else:
            valid_disposition = (
                disposition == "VERIFIED"
                and actual == "semantic"
            ) or (
                disposition == "LEGACY_ARTIFACT_VERIFIED"
                and actual == "legacy_artifact"
                and evidence.get("original_policy") == "semantic"
                and bool(evidence.get("downgrade_reason"))
                and bool(evidence.get("adapter_version"))
            )
        if buyer_confirmed:
            valid_disposition = (
                disposition == "QUARANTINED"
                and actual == "structure"
                and evidence.get("semantic_contract") == "buyer-confirmed-structure.v1"
                and evidence.get("reason_code") == "BUYER_ACCEPTANCE_REQUIRED"
                and evidence.get("machine_semantics_verified") is False
                and evidence.get("reviewed_contract_sha256") == bound["contract_sha256"]
                and evidence.get("output_schema_sha256") == bound.get("output_schema_sha256")
                and str(row.get("content_sha256") or "") == buyer_acceptance.get("content_sha256")
            )
        if not valid_disposition and lan_relax and not buyer_confirmed:
            # 仅 LAN/验收：DONE + 有产物时放宽 disposition / QUARANTINED 结算门禁
            valid_disposition = disposition in {
                "ARTIFACT_VERIFIED",
                "LEGACY_ARTIFACT_VERIFIED",
                "VERIFIED",
                "QUARANTINED",
            } and bool(shard.output_ref)
        if not valid_disposition:
            return f"verification disposition mismatch: {shard.id}"
        if evidence.get("adapter_version"):
            from platform_v8.services.legacy_compat import settle_decision

            if (
                not settle_decision(str(shard.worker_id or "")).allows
                and not lan_qa.force_legacy_settle()
            ):
                return f"legacy settlement gate closed: {shard.id}"
        digest = str(row.get("content_sha256") or "").lower()
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            if lan_relax and shard.output_ref:
                continue
            return f"verification digest missing: {shard.id}"
    return None


def _buyer_acceptance_row(session: Session, workload: Workload) -> dict[str, Any] | None:
    bound = (getattr(workload.spec, "requirements", None) or {}).get(
        "_reviewed_task_contract")
    if not isinstance(bound, dict) or bound.get("result_strategy") != "buyer-confirmed-structure.v1":
        return None
    row = session.execute(select(workload_buyer_acceptances_t).where(
        workload_buyer_acceptances_t.c.workload_id == workload.id
    ).with_for_update()).mappings().first()
    return dict(row) if row is not None else None



async def _quarantine_aggregation(workload_id: str, reason: str) -> None:
    def _persist() -> None:
        with db_mod.session_scope() as session:
            WorkloadRepo.by_id_for_update(session, workload_id)
            WorkloadRepo.transition_status(
                session,
                workload_id,
                WorkloadStatus.QUARANTINED,
                expected_statuses=(WorkloadStatus.AGGREGATING,),
                error=f"settlement_quarantine:{reason[:500]}",
            )
            session.commit()

    await asyncio.to_thread(_persist)


def _ocr_payload_has_text(data: dict) -> bool:
    for key in ("result_text", "text", "inline_output", "summary_text"):
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            return True
    pages = data.get("pages")
    if isinstance(pages, list):
        for page in pages:
            if isinstance(page, dict) and str(page.get("text") or "").strip():
                return True
    return False


def _soft_failure_message(output: str | None) -> str | None:
    """识别假成功 JSON: 业务失败却以 ok=True 上报.

    1) V2 skill: 有 error、无 status=ok
    2) OCR: status=ok 但无正文且 errors/pages_failed>0
       (节点 ONNX 把 PDF 当图解码失败时常见)
    """
    if not output:
        return None
    text = output.strip()
    if not text.startswith("{"):
        return None
    try:
        import json as _json
        data = _json.loads(text)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None

    err = data.get("error")
    if err and data.get("status") not in ("ok", "success"):
        return str(err)[:500]

    tt = str(data.get("task_type") or "")
    if tt in ("pdf_ocr", "ocr_image") and not _ocr_payload_has_text(data):
        summary = data.get("summary") if isinstance(data.get("summary"), dict) else {}
        try:
            pages_failed = int(summary.get("pages_failed") or 0)
        except (TypeError, ValueError):
            pages_failed = 0
        errors = data.get("errors")
        first_err = ""
        if isinstance(errors, list) and errors:
            item = errors[0]
            if isinstance(item, dict):
                first_err = str(item.get("error") or item)[:200]
            else:
                first_err = str(item)[:200]
        # 仅在有明确错误/失败页时打回 · 空白页 OCR 出空字不算假成功
        if first_err:
            return first_err[:500]
        if pages_failed > 0:
            return f"ocr_empty pages_failed={pages_failed}"[:500]
    return None


async def on_shard_done(shard_id: str, *,
                        output_ref: str | None = None,
                        inline_output: str | None = None,
                        elapsed_ms: int | None = None,
                        expected_worker_id: str | None = None,
                        expected_attempt: int | None = None,
                        verification: dict[str, Any] | None = None) -> bool:
    """
    worker 报结果 (shard_result · ok=True) 调用本函数

    流程:
      1. mark shard DONE (CAS · 防老 worker 残留 result 覆盖)
      2. 更新节点信誉 (SUCCESS)
      3. 触发 _maybe_finalize_workload (检查 workload 是否全完成)
    
    expected_worker_id: ws 层传 · CAS 校验当前 shard.worker_id 必须匹配 · 不匹配则 mark_done 返回 False (老 worker 残留)
    """
    # 软失败：业务 JSON 带 error 但客户端仍 ok=True → 改走失败重试，避免假 DONE
    soft = _soft_failure_message(inline_output) or _soft_failure_message(output_ref)
    if soft:
        logger.warning(
            "aggregator.on_shard_done · soft-fail → failed · shard=%s err=%s",
            shard_id[:8], soft,
        )
        await on_shard_failed(
            shard_id,
            error=soft,
            expected_worker_id=expected_worker_id,
            failure_class="script_soft_error",
        )
        return

    def _persist():
        with db_mod.session_scope() as s:
            checked = dict(verification or {})
            current = ShardRepo.by_id(s, shard_id)
            workload = WorkloadRepo.by_id(s, current.workload_id) if current else None
            if (
                workload is not None
                and workload.spec.task_type == "audio_transcribe_refine"
                and elapsed_ms is not None
            ):
                from platform_v8.services.economy.task_difficulty import TARGET_MS
                baseline_ms = TARGET_MS.get("audio_transcribe_refine", 180_000)
                if int(elapsed_ms) < max(1_000, baseline_ms // 100):
                    checked["nce_excluded"] = True
                    checked["nce_exclusion_reason"] = "audio_runtime_anomaly"
            ok = ShardRepo.mark_done(s, shard_id,
                                     output_ref=output_ref or inline_output,
                                     elapsed_ms=elapsed_ms,
                                     expected_worker_id=expected_worker_id,
                                     expected_attempt=expected_attempt,
                                     verification=checked)
            sh = ShardRepo.by_id(s, shard_id)
            s.commit()
            return ok, sh

    # 竞速: 先读 race 同伴 · mark_done 后取消败者
    def _race_peers() -> set[str]:
        with db_mod.session_scope() as s:
            cur = ShardRepo.by_id(s, shard_id)
            if cur is None:
                return set()
            return ShardRepo.race_workers_of(cur)

    peers_before = await asyncio.to_thread(_race_peers)

    ok, sh = await asyncio.to_thread(_persist)
    if sh is None:
        logger.warning("aggregator.on_shard_done · shard %s 不存在", shard_id)
        return False
    # 2026-06-24 · mark_done 未生效(CAS 不匹配老 worker / 状态守卫拦截已终态)→ 这帧作废,
    # 不能虚增信誉、不能误触发 finalize。真实结果由当前 owner worker 的帧或重派负责。
    if not ok:
        logger.info("aggregator.on_shard_done · shard %s mark_done 未生效(换worker/已终态/重复)· 忽略本帧",
                    shard_id)
        return False

    # NCE success 延后到 workload 聚合和结算成功后；一个可持有租约的节点
    # 不应凭未验收/不可交付的结果提升信誉。
    if sh.worker_id:
        logger.debug("aggregator.shard_done · verified result pending workload aggregation")

    logger.info("aggregator.shard_done · id=%s workload=%s elapsed=%sms",
                shard_id, sh.workload_id, elapsed_ms)

    await _maybe_finalize_workload(sh.workload_id)

    # P4.19 · 发 shard.completed 事件 · 触发同 workload 残留 PENDING 实时重派 (取代 30s sweeper)
    try:
        from platform_v8.services.economy import event_bus
        event_bus.publish("shard.completed",
                          workload_id=str(sh.workload_id),
                          shard_id=str(shard_id),
                          worker_id=str(sh.worker_id) if sh.worker_id else None,
                          outcome="success")
    except Exception as exc:
        logger.debug("event_bus publish shard.completed skip: %s", exc)
    return True


async def quarantine_shard_result(
    shard_id: str,
    *,
    expected_worker_id: str,
    expected_attempt: int,
    reason_code: str,
) -> bool:
    """Stop automatic delivery and settlement for an unverified result.

    The artifact has passed transport/lease checks, but the task lacks a
    business verifier.  Claiming the workload transition atomically prevents a
    concurrent result from moving it to DONE and paying out before review.
    """
    def _persist() -> bool:
        with db_mod.session_scope() as s:
            shard = ShardRepo.by_id(s, shard_id)
            if shard is None:
                return False
            if (
                str(shard.worker_id or shard.lease_by_node or "") != str(expected_worker_id)
                or int(shard.attempts) != int(expected_attempt)
            ):
                return False
            workload = WorkloadRepo.by_id(s, shard.workload_id)
            if workload is None:
                return False
            claimed = WorkloadRepo.transition_status(
                s,
                workload.id,
                WorkloadStatus.QUARANTINED,
                expected_statuses=(
                    WorkloadStatus.CREATED,
                    WorkloadStatus.PLANNED,
                    WorkloadStatus.RUNNING,
                    WorkloadStatus.WAITING_FOR_WORKERS,
                    WorkloadStatus.AGGREGATING,
                ),
                error=f"result_quarantined:{reason_code}",
            )
            if not claimed:
                return False
            AuditRepo.write(
                s,
                action="workload.quarantined",
                actor_account_id=workload.owner_id,
                actor_kind="system",
                target_kind="workload",
                target_id=str(workload.id),
                detail={
                    "shard_id": str(shard.id),
                    "attempt": int(shard.attempts),
                    "reason_code": reason_code,
                },
            )
            s.commit()
            return True

    quarantined = await asyncio.to_thread(_persist)
    if quarantined:
        record_lifecycle_event(
            "quarantine",
            shard_id=shard_id,
            worker_id=expected_worker_id,
            attempt=expected_attempt,
            reason_code=reason_code,
            outcome="quarantined",
        )
        logger.warning(
            "aggregator.quarantined · shard=%s attempt=%s reason=%s",
            shard_id,
            expected_attempt,
            reason_code,
        )
    return quarantined


def _load_task_type(workload_id) -> str | None:
    if not workload_id:
        return None
    try:
        with db_mod.session_scope() as s:
            wl = WorkloadRepo.by_id(s, workload_id)
            return getattr(getattr(wl, "spec", None), "task_type", None) if wl else None
    except Exception:
        return None


def _capability_feedback_on() -> bool:
    try:
        from platform_v8.services.ops import feature_flags as ff
        return ff.is_enabled("nce_capability_feedback", subject_id=None)
    except Exception:
        return False


def _remaining_capable_count(workload, excluded: set[str]) -> int:
    """估算"还能跑此 workload 且未被该片排除"的在线节点数。
       用于快速失败判定 · 出错一律 fail-open 返 1 (当作还有节点 · 不误杀正常重试)。"""
    try:
        from platform_v8.engine import broker, planner
        online = [str(x) for x in broker.online_worker_ids_for_dispatch()]
        online = [w for w in online if w not in excluded]
        if not online:
            return 0
        cnt = 0
        with db_mod.session_scope() as s:
            for wid in online:
                w = WorkerRepo.by_id(s, wid)
                if w and planner.worker_can_run(w, workload):
                    cnt += 1
        return cnt
    except Exception as exc:
        logger.debug("aggregator._remaining_capable_count · fail-open: %s", exc)
        return 1


def _is_deterministic_native_crash(err_blob: str, exit_code: int | None) -> bool:
    """whisper.cpp GGML_ASSERT 等原生崩溃 · 同机重试几乎必复现。"""
    if exit_code is not None:
        code = exit_code & 0xFFFFFFFF
        if code in {0xC0000409, 3221226505}:
            return True
    low = (err_blob or "").lower()
    return (
        "ggml_assert" in low
        or "ggml-backend.cpp" in low
        or "3221226505" in low
        or "0xc0000409" in low
    )


def _is_single_pinned_failed(workload, failed_worker: str | None) -> bool:
    """requirements.allowed_worker_ids 仅钉 1 台且正是失败节点 → 再重试只会空转。"""
    if not failed_worker or workload is None:
        return False
    try:
        req = getattr(getattr(workload, "spec", None), "requirements", None) or {}
        if isinstance(req, str):
            import json as _json
            req = _json.loads(req)
        if not isinstance(req, dict):
            return False
        allowed = req.get("allowed_worker_ids") or []
        if not isinstance(allowed, (list, tuple)):
            return False
        ids = [str(x) for x in allowed if x]
        return len(ids) == 1 and ids[0] == str(failed_worker)
    except Exception:
        return False


async def on_shard_failed(shard_id: str, *, error: str = "",
                          expected_worker_id: str | None = None,
                          expected_attempt: int | None = None,
                          stderr_tail: str = "",
                          exit_code: int | None = None,
                          python_used: str = "",
                          failure_class: str = "",
                          missing_dep: str = "") -> None:
    """worker 报失败 (shard_result · ok=False)

    expected_worker_id / expected_attempt: ws 层传报告者 assignment · 若该 shard
    已被重派或同一 worker 已进入新 attempt，直接忽略，避免迟到失败帧重置新任务。

    stderr_tail / exit_code / python_used (v8.1.8+):
        节点诊断三件套 · 后端把它们拼进 shard.error · 让平台能看到真实失败原因
        老客户端字段为空 · 完全向后兼容
    """
    feedback_on = _capability_feedback_on()

    # 先读 shard + workload (拿 task_type / 失败节点 / 重试余量) · 再决定重试 or 快速失败
    def _load():
        with db_mod.session_scope() as s:
            sh = ShardRepo.by_id(s, shard_id)
            if sh is None:
                return None, None, None
            wl = WorkloadRepo.by_id(s, sh.workload_id) if sh.workload_id else None
            tt = None
            if wl is not None:
                tt = getattr(getattr(wl, "spec", None), "task_type", None)
            excluded = {str(x) for x in ((sh.metadata or {}).get("excluded_workers") or [])}
            terminal = text_compat.inspect_terminal_failure(s, wl)
            return sh, (wl, tt, terminal), excluded

    sh0, wlinfo, excluded0 = await asyncio.to_thread(_load)
    if sh0 is None:
        return
    # CAS 守卫: 报告者/attempt 已不是当前 assignment → 迟到帧直接忽略。
    if (
        expected_attempt is not None
        and int(sh0.attempts) != int(expected_attempt)
    ):
        logger.warning(
            "aggregator.on_shard_failed · 忽略旧 attempt %s 残留失败 "
            "(shard %s 当前 attempt=%s)",
            expected_attempt, shard_id, sh0.attempts,
        )
        return
    active_reporters = ShardRepo.race_workers_of(sh0)
    if sh0.lease_by_node:
        active_reporters.add(str(sh0.lease_by_node))
    if (
        expected_worker_id is not None
        and str(expected_worker_id) not in active_reporters
    ):
        logger.warning("aggregator.on_shard_failed · 忽略老 worker %s 残留失败 (shard %s 现属 %s)",
                       expected_worker_id, shard_id, sh0.worker_id)
        return

    race_set = ShardRepo.race_workers_of(sh0)
    reporter = str(expected_worker_id) if expected_worker_id is not None else str(sh0.worker_id or '')
    # 竞速中某节点失败: 只把它踢出竞速 · 不动整片 (同伴可能仍在跑)
    if len(race_set) > 1 and reporter:
        peers = {p for p in race_set if p != reporter}
        if peers:
            def _drop_racer():
                with db_mod.session_scope() as s:
                    from sqlalchemy import select as _sel, update as _upd
                    from platform_v8.storage.repo import shards_t as _st
                    # Lock the current assignment, then recheck the same attempt.
                    s.execute(_sel(_st.c.id).where(_st.c.id == shard_id).with_for_update()).first()
                    cur = ShardRepo.by_id(s, shard_id)
                    if (cur is None or cur.status not in (ShardStatus.DISPATCHED, ShardStatus.RUNNING, ShardStatus.LEASED)
                        or cur.attempts != sh0.attempts):
                        return False
                    current_race = ShardRepo.race_workers_of(cur)
                    current_peers = current_race - {reporter}
                    if reporter not in current_race or not current_peers:
                        return False
                    ShardRepo.drop_race_worker(s, shard_id, reporter)
                    if str(cur.worker_id) == reporter:
                        s.execute(
                            _upd(_st).where(_st.c.id == shard_id, _st.c.attempts == cur.attempts,
                                           _st.c.worker_id == cur.worker_id)
                            .values(worker_id=sorted(current_peers)[0])
                        )
                    s.commit()
                    return True
            if not await asyncio.to_thread(_drop_racer):
                return
            # The reporter already returned failure. A shard-id-only cancel
            # could otherwise cancel a newer assignment after this commit.
            logger.info(
                "aggregator.race_drop · shard=%s racer=%s 失败 · 同伴继续 n=%d",
                shard_id, reporter[:8], len(peers),
            )
            return

    workload, task_type, terminal = wlinfo
    failed_worker = (
        str(expected_worker_id)
        if expected_worker_id is not None
        else str(sh0.worker_id) if sh0.worker_id else None
    )
    racer_only = bool(
        failed_worker
        and sh0.worker_id
        and str(failed_worker) != str(sh0.worker_id)
    )

    # 学习型不胜任: 记一次失败 (近窗口达阈 → 该节点该 task_type 进冷却)
    # v8.1.8 · env 类失败是"环境缺东西"(节点正在自愈补齐) · 不是"不胜任" ·
    #   不喂给能力黑名单,否则自愈好了节点也被永久冷却 → 错杀。
    #   只有 resource(硬件不够)/script/timeout/unknown 才算真·不胜任。
    _is_env_failure = failure_class.startswith("env_")
    if feedback_on and failed_worker and task_type and not _is_env_failure and terminal is None:
        try:
            from platform_v8.engine import capability_feedback as cf
            await asyncio.to_thread(cf.record_failure, task_type, failed_worker)
        except Exception as exc:
            logger.debug("capfeedback.record_failure skip: %s", exc)

    # 2026-06-05 · 后端主导自愈: env 失败 → 决策器决定是否下发修复 control
    # (nce_backend_heal flag 门控 · 默认 OFF · 客户端本地自愈是第一道防线 · 此为兜底增强)
    if _is_env_failure and failed_worker:
        try:
            from platform_v8.services.heal import decider as heal
            await heal.maybe_dispatch_heal(
                failed_worker, task_type, failure_class, missing_dep=missing_dep,
            )
        except Exception as exc:
            logger.debug("heal.maybe_dispatch_heal skip: %s", exc)

    # 快速失败判定:
    # 1) 重试余量还在 · 但已无"合格且未排除"的在线节点 → 别再空耗 attempts
    # 2) whisper.cpp GGML 原生崩溃等确定性错误 → 同节点再试无意义 · 1 次后快失败
    # 3) 任务硬钉死唯一 worker 且该 worker 已失败 → 别刷 10 次
    fail_fast = False
    fail_fast_reason = ""
    err_blob = f"{error}\n{stderr_tail}"
    deterministic_crash = _is_deterministic_native_crash(err_blob, exit_code)
    pinned_only = _is_single_pinned_failed(workload, failed_worker)

    if failure_class == 'execution_unknown':
        fail_fast = True
        fail_fast_reason = 'EXECUTION_UNKNOWN: executor outcome must be reconciled; automatic execution retry is disabled'
    elif terminal is not None:
        fail_fast = True
        failure_class = 'app_result_invalid'
        fail_fast_reason = 'FILM_INVALID_APP_RESULT: provider response received and durably rejected; no automatic regeneration'
    elif deterministic_crash or pinned_only:
        fail_fast = True
        if deterministic_crash:
            fail_fast_reason = (
                "确定性原生崩溃(GGML/assert) · 跳过无效重试 · "
                + (error or "native crash")[:400]
            )
        else:
            fail_fast_reason = (
                "任务仅允许唯一节点且该节点已失败 · 跳过无效重试 · "
                + (error or "pinned worker failed")[:400]
            )
    elif feedback_on and failed_worker and sh0.attempts < sh0.max_attempts:
        excl = set(excluded0)
        excl.add(failed_worker)
        remain = await asyncio.to_thread(_remaining_capable_count, workload, excl)
        if remain <= 0:
            fail_fast = True
            fail_fast_reason = (
                f"无更多合格节点可重试 · 已在 {len(excl)} 个节点失败 "
                f"(task={task_type} · 疑似任务/依赖问题或全部合格节点暂不胜任)"
            )

    def _persist():
        with db_mod.session_scope() as s:
            sh = ShardRepo.by_id(s, shard_id)
            if sh is None:
                return None
            if (
                expected_attempt is not None
                and int(sh.attempts) != int(expected_attempt)
            ):
                return None
            current_reporters = ShardRepo.race_workers_of(sh)
            if sh.lease_by_node:
                current_reporters.add(str(sh.lease_by_node))
            if (
                expected_worker_id is not None
                and str(expected_worker_id) not in current_reporters
            ):
                return None
            # A losing racer may report its own failure, but must not reset the
            # owner's still-running assignment.
            if racer_only:
                return None
            if terminal is not None:
                current_workload = WorkloadRepo.by_id(s, sh.workload_id)
                if text_compat.inspect_terminal_failure(s, current_workload) != terminal:
                    s.rollback()
                    return None
            # 该节点跑挂此片 → 记入 excluded_workers · 重派不再选它 (planner 已读取强制)
            if failed_worker and terminal is None:
                try:
                    ShardRepo.exclude_worker_for_retry(
                        s,
                        shard_id,
                        failed_worker,
                        ttl_seconds=_RETRY_WORKER_EXCLUSION_SECONDS,
                    )
                except Exception as exc:
                    logger.debug("retry worker exclusion skip: %s", exc)
            if not fail_fast and sh.attempts < sh.max_attempts:
                # 还能重试 · 重置 PENDING (让 lifecycle 重派 · 会避开 excluded_workers)
                changed = ShardRepo.reset_pending(
                    s,
                    shard_id,
                    expected_worker_id=expected_worker_id,
                    expected_attempt=expected_attempt,
                )
                if not changed:
                    s.rollback()
                    return None
                logger.info("aggregator.shard_retry · id=%s attempts=%d/%d",
                            shard_id, sh.attempts, sh.max_attempts)
            else:
                # 用完次数 或 快速失败 · 标 FAILED (写清晰原因)
                # v8.1.8 · 拼上节点诊断三件套 (老客户端字段空 · 自动跳过)
                base_err = fail_fast_reason if fail_fast else error
                diag_parts: list[str] = []
                if exit_code is not None:
                    diag_parts.append(f"exit={exit_code}")
                if python_used:
                    diag_parts.append(f"python={python_used}")
                if stderr_tail:
                    # stderr 可能很长 · 截到 1500 字符防 we_shards.error 列爆掉
                    tail = stderr_tail[-1500:] if len(stderr_tail) > 1500 else stderr_tail
                    diag_parts.append(f"stderr_tail={tail}")
                final_err = base_err
                if diag_parts:
                    final_err = (final_err + " | " + " | ".join(diag_parts)) if final_err else " | ".join(diag_parts)
                changed = ShardRepo.mark_failed(
                    s,
                    shard_id,
                    error=final_err,
                    failure_class=failure_class,
                    expected_worker_id=expected_worker_id,
                    expected_attempt=expected_attempt,
                )
                if not changed:
                    s.rollback()
                    return None
                logger.warning("aggregator.shard_failed · id=%s attempts=%d %s",
                               shard_id, sh.attempts,
                               "(快速失败·无合格节点)" if fail_fast else "(用完)")
            s.commit()
            return sh

    sh = await asyncio.to_thread(_persist)
    if sh is None:
        return

    # 2026-05-25 · shard FAILED commit 后 → NCE 完整重算 (以免 evaluate_worker 看不到本次 FAILED)
    if sh.worker_id and terminal is None:
        try:
            from platform_v8.services.economy.nce_observer import observe_shard, ShardOutcome
            is_timeout = "timeout" in (error or "").lower() or "超时" in (error or "")
            outcome = ShardOutcome.TIMEOUT if is_timeout else ShardOutcome.FAILURE
            await asyncio.to_thread(observe_shard, sh.worker_id, outcome)
        except Exception as exc:
            logger.warning("nce_observer FAILURE 失败: %s", exc)

    # 若 max_attempts 用完 → 触发 workload 检查
    if fail_fast or sh.attempts >= sh.max_attempts:
        await _maybe_finalize_workload(sh.workload_id)

    # P4.19 · 失败也发 shard.completed (允许同 workload 残留 PENDING 实时重派)
    try:
        from platform_v8.services.economy import event_bus
        event_bus.publish("shard.completed",
                          workload_id=str(sh.workload_id),
                          shard_id=str(shard_id),
                          worker_id=str(sh.worker_id) if sh.worker_id else None,
                          outcome="failure")
    except Exception as exc:
        logger.debug("event_bus publish shard.completed skip: %s", exc)


async def _maybe_finalize_workload(workload_id: str) -> None:
    """
    检查 workload 所有 shard:
      全 DONE       → workload DONE + reward + escrow_release
      有 FAILED 且没 PENDING/RUNNING → workload FAILED + refund
      其它          → 等其他 shard
    """
    def _check():
        with db_mod.session_scope() as s:
            workload = WorkloadRepo.by_id(s, workload_id)
            if workload is None:
                return None, None, None
            if workload.is_terminal:
                return workload, None, None  # 已经处理过 · idempotent

            counts = ShardRepo.count_by_status(s, workload_id)
            shards = ShardRepo.by_workload(s, workload_id)
            return workload, counts, shards

    workload, counts, shards = await asyncio.to_thread(_check)
    if workload is None or counts is None:
        return

    total = sum(counts.values())
    done = counts.get(ShardStatus.DONE.value, 0)
    failed = counts.get(ShardStatus.FAILED.value, 0)
    pending = counts.get(ShardStatus.PENDING.value, 0)
    dispatched = counts.get(ShardStatus.DISPATCHED.value, 0)
    leased = counts.get(ShardStatus.LEASED.value, 0)
    running = counts.get(ShardStatus.RUNNING.value, 0)
    verifying = counts.get(ShardStatus.VERIFYING.value, 0)

    logger.debug("aggregator.check · workload=%s total=%d done=%d failed=%d pending=%d disp=%d running=%d",
                 workload_id, total, done, failed, pending, dispatched, running)

    # 还有未完成的 shard · 等
    if pending + dispatched + leased + running + verifying > 0:
        return

    # 全 DONE → 成功
    if failed == 0 and done == total and total > 0:
        await _finalize_done(workload, shards)
        return

    # 2026-06-11 · 部分成功容忍 (post_process 类任务 / 多页 OCR)
    #   智能阅卷场景:节点段把每页切成 shard 并行 OCR · 1 张挂了不该丢另外 N-1 张的成果 ·
    #   只要有 ≥1 个 DONE 且任务声明了 server-side post_process · 用成功子集走 DONE ·
    #   AI 提炼对 N-1 张依然能出报告 · 失败片数计入 failed_shards 让 UI 透明
    if failed > 0 and done > 0:
        params = workload.spec.params if workload.spec else None
        if isinstance(params, dict) and params.get("post_process"):
            done_shards = [sh for sh in shards if sh.status == ShardStatus.DONE]
            failed_shards = [sh for sh in shards if sh.status == ShardStatus.FAILED]
            logger.info("aggregator.partial_ok · workload=%s post_process=%s done=%d failed=%d · 用成功子集 finalize",
                        workload.id, params.get("post_process"), done, failed)
            await _finalize_done(
                workload,
                done_shards,
                failed_count=failed,
                failed_shards=failed_shards,
            )
            return

    # 有 failed 且没未完成 → workload FAILED + refund
    if failed > 0:
        await _finalize_failed(workload, shards, failed_count=failed, done_count=done)


async def _refresh_workload_progress(
    workload_id: str,
    *,
    status: WorkloadStatus,
    total: int,
    done: int,
    failed: int,
) -> None:
    """运行中刷新 completed_shards / progress · 企业 GET /workloads/{id} 可见时时进度。"""
    if total <= 0:
        return
    progress = round(min(1.0, max(0.0, (done + failed) / float(total))), 4)

    def _bump() -> None:
        with db_mod.session_scope() as s:
            WorkloadRepo.update_status(
                s,
                workload_id,
                status,
                progress=progress,
                total_shards=total,
                completed_shards=done,
                failed_shards=failed,
            )
            s.commit()

    try:
        await asyncio.to_thread(_bump)
    except Exception as exc:
        logger.debug("aggregator.refresh_progress skip · workload=%s · %s", workload_id, exc)


async def _finalize_done(workload: Workload, shards: list[Shard],
                         *, failed_count: int = 0,
                         failed_shards: list[Shard] | None = None) -> None:
    """workload 全 shard 完成 (或部分成功) · 写 result + reward + escrow_release

    failed_count > 0 时表示部分成功(post_process 类任务对 N-1 张 OCR 失败做了容忍)·
    UI 会显示 done_shards/total + failed_shards · 钱包按 done 拿走 reward · 失败片不发钱.

    2026-05-18 · 冗余感知:
      redundancy_factor>1 时 · 先调 anti_cheat 多数派比对
      cheating_nodes 信誉硬罚 · 不发 reward
      aggregator 只用 honest_nodes 的结果合并
    """
    import asyncio as _asyncio
    from platform_v8.services.media_profiles import is_media
    if is_media(workload):
        raise ValueError("正式媒体结果必须由独立广州签名 verdict 进入唯一 revision 结算")
    from platform_v8.engine.aggregators import aggregate as _aggregate
    # Replicas prove one customer-visible logical unit; they are not billed as
    # repeated work.  A unit with at least one accepted result is verified.
    verified_unit_ids = {_logical_unit_id(shard) for shard in shards}
    failed_unit_ids = {
        _logical_unit_id(shard) for shard in (failed_shards or [])
    } - verified_unit_ids
    verified_units = len(verified_unit_ids)
    failed_units = (
        len(failed_unit_ids)
        if failed_shards is not None
        else max(0, int(failed_count))
    )
    total_units = verified_units + failed_units
    settled_budget, partial_refund = partial_delivery_settlement(
        workload.budget, verified_units, failed_units,
    )

    # 原子抢占聚合权。取消或另一条聚合链路先获胜时，绝不能继续交付/结算。
    verification_by_shard: dict[str, dict[str, Any]] = {}

    def _mark_aggregating():
        with db_mod.session_scope() as s:
            locked_workload = WorkloadRepo.by_id_for_update(s, workload.id)
            locked_shards = ShardRepo.by_workload_for_update(s, workload.id)
            verification_rows = ResultVerificationRepo.by_workload_for_update(
                s, workload.id
            )
            paid_ids = {str(sh.id) for sh in shards}
            locked_paid = [
                sh for sh in locked_shards if str(sh.id) in paid_ids
            ]
            gate_error = None
            if len(locked_paid) != len(paid_ids) or locked_workload is None:
                gate_error = "paid shard set changed during finalize"
            else:
                gate_error = _verification_gate_error(
                    locked_workload, locked_paid, verification_rows,
                    buyer_acceptance=_buyer_acceptance_row(s, locked_workload),
                )
            if gate_error:
                if locked_workload is not None:
                    WorkloadRepo.transition_status(
                        s,
                        workload.id,
                        WorkloadStatus.QUARANTINED,
                        expected_statuses=(
                            WorkloadStatus.CREATED,
                            WorkloadStatus.PLANNED,
                            WorkloadStatus.RUNNING,
                            WorkloadStatus.WAITING_FOR_WORKERS,
                        ),
                        error=f"settlement_gate:{gate_error}",
                    )
                s.commit()
                return False, gate_error, {}
            claimed = WorkloadRepo.transition_status(
                s,
                workload.id,
                WorkloadStatus.AGGREGATING,
                expected_statuses=(
                    WorkloadStatus.CREATED,
                    WorkloadStatus.PLANNED,
                    WorkloadStatus.RUNNING,
                    WorkloadStatus.WAITING_FOR_WORKERS,
                ),
            )
            s.commit()
            return claimed, None, {
                str(row["shard_id"]): row for row in verification_rows
            }
    try:
        claimed_aggregation, gate_error, verification_by_shard = (
            await _asyncio.to_thread(_mark_aggregating)
        )
    except Exception as _exc:
        logger.warning("aggregator · 置 AGGREGATING 失败: %s", _exc)
        return
    if not claimed_aggregation:
        if gate_error:
            logger.error(
                "aggregator · workload=%s settlement gate quarantined: %s",
                workload.id, gate_error,
            )
        else:
            logger.info("aggregator · workload=%s 未取得聚合权，跳过", workload.id)
        return

    settlement_gate_shards = list(shards)
    reward_shards = list(shards)

    # 冗余检测 + 反作弊
    cheating_workers: set[str] = set()
    redundancy = max(1, int((workload.spec.redundancy_factor or 1)))
    if redundancy > 1:
        try:
            from platform_v8.services.economy import anti_cheat
            # 按 replica_of (canonical id) 分组 · 同组多数派比对
            groups: dict[str, list[Shard]] = {}
            for sh in shards:
                canon = _logical_unit_id(sh)
                groups.setdefault(canon, []).append(sh)

            kept_shards: list[Shard] = []
            honest_reward_shards: list[Shard] = []
            for canon, group in groups.items():
                verdict = anti_cheat.evaluate_redundant_results(
                    canon, group, verification_by_shard
                )
                if not verdict.has_canonical:
                    raise RuntimeError(
                        f"redundancy group {canon} has no strict majority: "
                        + "; ".join(verdict.reasons)
                    )
                # 写 ReputationEvent.MISMATCH (硬罚) · 不发 reward
                if verdict.cheating_nodes:
                    cheating_workers.update(verdict.cheating_nodes)
                    def _punish():
                        with db_mod.session_scope() as s:
                            anti_cheat.punish_cheaters(s, verdict)
                            s.commit()
                    await _asyncio.to_thread(_punish)
                    logger.warning("anti_cheat · workload=%s canonical=%s 检测 %d 作弊节点: %s",
                                   workload.id, canon, len(verdict.cheating_nodes),
                                   [w[:8] for w in verdict.cheating_nodes])
                # 只保留 honest 的 1 份 (作为聚合输入)
                honest_set = set(verdict.honest_nodes)
                honest_reward_shards.extend(
                    sh for sh in group if sh.worker_id in honest_set
                )
                canonical = next(
                    (sh for sh in group if sh.worker_id in honest_set), None
                )
                if canonical is None:
                    raise RuntimeError(
                        f"redundancy group {canon} canonical shard missing"
                    )
                kept_shards.append(canonical)
            shards = kept_shards  # 给 aggregator 用净化后的 shards
            reward_shards = honest_reward_shards

        except Exception as exc:
            logger.error("anti_cheat fail-closed · workload=%s: %s", workload.id, exc)
            await _quarantine_aggregation(
                workload.id, f"anti_cheat:{type(exc).__name__}:{exc}"
            )
            return

    try:
        result = await _asyncio.to_thread(_aggregate, workload, shards)
    except Exception as exc:
        logger.exception("aggregator.aggregate failed · workload=%s", workload.id)
        await _finalize_failed(
            workload, shards, failed_count=len(shards), done_count=0,
            expected_statuses=(WorkloadStatus.AGGREGATING,),
            error_override=f"聚合异常: {type(exc).__name__}: {exc}",
        )
        return

    # 聚合器返回 status=failed（如 zip_files 无可打包文件）→ 整体 FAILED，勿标 DONE
    try:
        import json as _json
        payload = _json.loads(result.output_ref or "")
    except Exception:
        payload = None
    if isinstance(payload, dict) and payload.get("status") == "failed":
        agg_err = str(payload.get("error") or "聚合失败")[:500]
        detail_errs = payload.get("errors") or []
        if detail_errs and isinstance(detail_errs, list):
            agg_err = f"{agg_err}: {'; '.join(str(x) for x in detail_errs[:3])}"[:500]
        logger.warning(
            "aggregator._finalize_done · aggregate status=failed · workload=%s · %s",
            workload.id, agg_err,
        )
        await _finalize_failed(
            workload, shards,
            failed_count=max(1, len(shards)),
            done_count=0,
            error=agg_err,
        )
        return

    # 2026-06-11 · 服务器侧二段处理钩子 (opt-in · spec.params.post_process)
    #   律所「智能阅卷」: 节点段已 OCR 出文字 → 服务器用平台 LLM key 跑 case_digest → Excel
    #   失败兜底:post_process 内部 try/except · 永远返回一个 result (OCR 结果不丢)
    try:
        from platform_v8.engine import post_process
        result = await _asyncio.to_thread(post_process.maybe_run, workload, shards, result)
    except Exception as exc:
        logger.warning("aggregator.post_process · workload=%s 钩子异常 (用原结果): %s",
                       workload.id, exc)

    delivery_error = _result_delivery_error(result)
    if delivery_error:
        logger.error("aggregator.delivery rejected · workload=%s: %s", workload.id, delivery_error)
        await _finalize_failed(
            workload, shards, failed_count=len(shards), done_count=0,
            expected_statuses=(WorkloadStatus.AGGREGATING,),
            error_override=f"聚合失败: {delivery_error}",
        )
        return

    settlement_started = time.perf_counter()

    def _commit():
        with db_mod.session_scope() as s:
            locked_workload = WorkloadRepo.by_id_for_update(s, workload.id)
            locked_shards = ShardRepo.by_workload_for_update(s, workload.id)
            locked_verifications = ResultVerificationRepo.by_workload_for_update(
                s, workload.id
            )
            gate_ids = {str(sh.id) for sh in settlement_gate_shards}
            locked_paid = [
                shard for shard in locked_shards if str(shard.id) in gate_ids
            ]
            gate_error = None
            if locked_workload is None or len(locked_paid) != len(gate_ids):
                gate_error = "paid shard set changed before settlement"
            else:
                gate_error = _verification_gate_error(
                    locked_workload, locked_paid, locked_verifications,
                    buyer_acceptance=_buyer_acceptance_row(s, locked_workload),
                )
            if gate_error:
                WorkloadRepo.transition_status(
                    s,
                    workload.id,
                    WorkloadStatus.QUARANTINED,
                    expected_statuses=(WorkloadStatus.AGGREGATING,),
                    error=f"settlement_gate:{gate_error}",
                )
                s.commit()
                return None, {}
            from platform_v8.engine.task_registry import (
                TASK_REGISTRY,
                TaskMode,
            )
            from platform_v8.services import lan_qa

            task_spec = TASK_REGISTRY.get(workload.spec.task_type)
            if task_spec is None or task_spec.mode != TaskMode.ONESHOT:
                if not (
                    lan_qa.relax_verifier_enabled()
                    and all(sh.status == ShardStatus.DONE for sh in locked_paid)
                ):
                    WorkloadRepo.transition_status(
                        s,
                        workload.id,
                        WorkloadStatus.QUARANTINED,
                        expected_statuses=(WorkloadStatus.AGGREGATING,),
                        error="settlement_gate:non-oneshot-or-unknown-task",
                    )
                    s.commit()
                    return None, {}
                logger.warning(
                    "aggregator · LAN QA settle unknown/non-oneshot task_type=%s workload=%s",
                    getattr(workload.spec, "task_type", ""),
                    workload.id,
                )
            if not WorkloadRepo.set_spent(
                s,
                workload.id,
                settled_budget,
                expected_status=WorkloadStatus.AGGREGATING,
            ):
                s.rollback()
                raise RuntimeError("failed to atomically set ONESHOT spent")
            claimed_done = WorkloadRepo.transition_status(
                s,
                workload.id,
                WorkloadStatus.DONE,
                expected_statuses=(WorkloadStatus.AGGREGATING,),
                completed_at=datetime.utcnow(),
                progress=1.0,
                total_shards=total_units,
                completed_shards=verified_units,
                failed_shards=failed_units,
            )
            if not claimed_done:
                return None, {}
            WorkloadRepo.update_result(s, workload.id, result)

            # 2. 三方分润 (2026-05-18 · 移植自 super_engine_v2)
            #   client_pool  → 节点 owners (按贡献二次分配)
            #   platform_pool → 平台账号 (admin)
            #   channel_pool → 渠道账号 (没配则并入 platform)
            from platform_v8.services.economy import split as split_svc

            # 收集每节点贡献 (shard 数 / 信誉)
            contribs_map: dict[str, split_svc.NodeContribution] = {}
            for sh in reward_shards:
                if not sh.worker_id:
                    continue
                if sh.worker_id in cheating_workers:
                    continue
                if sh.worker_id in contribs_map:
                    contribs_map[sh.worker_id].shard_count += 1
                    continue
                w = WorkerRepo.by_id(s, sh.worker_id)
                if w is None:
                    logger.warning("aggregator.reward · worker %s 不存在 · 跳过", sh.worker_id)
                    continue
                contribs_map[sh.worker_id] = split_svc.NodeContribution(
                    worker_id=sh.worker_id,
                    owner_id=w.owner_id,
                    shard_count=1,
                    quality=Decimal("1.0"),                # MVP · 没 verifier
                    reputation=Decimal(str(w.reputation or 0.5)),
                    risk=Decimal("1.0"),                   # MVP · 没 anti_cheat
                )

            split_cfg = split_svc.load_config_from_env()
            split_result = split_svc.compute_split(
                settled_budget, list(contribs_map.values()), split_cfg,
            )

            # 等级倍率：节点分润 × tier_multiplier；加价从平台/渠道池拨出（不超发 escrow）
            try:
                from platform_v8.services.economy.tier import boost_node_payouts
                owner_ids = sorted({int(oid) for oid, _ in split_result.node_payouts})
                bal_map: dict[int, float] = {}
                if owner_ids:
                    rows = s.execute(
                        text("SELECT id, balance FROM we_accounts WHERE id = ANY(:ids)"),
                        {"ids": owner_ids},
                    ).mappings().all()
                    for r in rows:
                        bal_map[int(r["id"])] = float(r["balance"] or 0)
                boosted, new_plat, new_chan = boost_node_payouts(
                    list(split_result.node_payouts),
                    bal_map,
                    split_result.platform_pool,
                    split_result.channel_pool,
                )
                if boosted != list(split_result.node_payouts) or new_plat != split_result.platform_pool:
                    logger.info(
                        "tier.boost · workload=%s nodes=%s plat %s→%s chan %s→%s",
                        workload.id,
                        [(oid, str(a)) for oid, a in boosted],
                        split_result.platform_pool, new_plat,
                        split_result.channel_pool, new_chan,
                    )
                split_result.node_payouts = boosted
                split_result.platform_pool = new_plat
                split_result.channel_pool = new_chan
            except Exception as exc:
                logger.warning("tier.boost skip · workload=%s err=%s", workload.id, exc)

            # 派钱: idempotent_suffix 区分 (节点 N / 平台 / 渠道) · 避免冲突
            #   1) 节点 owners (client_pool)
            #   2026-05-21 · owner-level payout 在 owner 内按 worker shard_count 二次拆分,
            #   每个 worker 一条 ledger 记录 (带 shard_id) · 让 /api/v8/workers/{id}/rewards 能查到
            worker_rewards: dict[str, Decimal] = {}  # 用于审计 (compat)
            # 先建 owner_id → [contribs] 索引
            owner_to_contribs: dict = {}
            for c in contribs_map.values():
                owner_to_contribs.setdefault(c.owner_id, []).append(c)
            # 拿每个 worker 对应的一个代表 shard_id (任意一个该 worker 跑的 shard)
            worker_first_shard: dict[str, str] = {}
            for sh in reward_shards:
                if sh.worker_id and sh.worker_id not in worker_first_shard:
                    worker_first_shard[sh.worker_id] = sh.id

            node_basis = ledger_svc.reward_basis_for_task(
                getattr(getattr(workload, "spec", None), "task_type", None)
            )
            for owner_id, amount in split_result.node_payouts:
                if amount <= 0:
                    continue
                contribs_in_owner = owner_to_contribs.get(owner_id, [])
                if not contribs_in_owner:
                    # 兜底: owner 没找到 worker (理论不该发生) · 原方式聚合写
                    ledger_svc.reward(
                        s,
                        worker_owner_id=owner_id,
                        amount=amount,
                        workload_id=workload.id,
                        shard_id=None,
                        note=f"完成 {workload.name} (节点收益 · 65%)",
                        idempotent_suffix=f"node-{owner_id}",
                        basis=node_basis,
                    )
                    worker_rewards[str(owner_id)] = amount
                    continue
                # 按 shard_count 在 owner 内再拆 (保证总和恰好 = amount)
                total_shards = sum(c.shard_count for c in contribs_in_owner) or 1
                allocated = Decimal("0")
                for idx, c in enumerate(contribs_in_owner):
                    if idx == len(contribs_in_owner) - 1:
                        # 最后一个拿剩余 (规避四舍五入造成总和不一致)
                        portion = amount - allocated
                    else:
                        portion = (amount * Decimal(c.shard_count) / Decimal(total_shards)) \
                            .quantize(Decimal("0.0001"))
                    allocated += portion
                    if portion <= 0:
                        continue
                    ledger_svc.reward(
                        s,
                        worker_owner_id=owner_id,
                        amount=portion,
                        workload_id=workload.id,
                        shard_id=worker_first_shard.get(c.worker_id),
                        note=f"完成 {workload.name} (节点 {str(c.worker_id)[:8]} · {c.shard_count} 片)",
                        idempotent_suffix=f"node-{owner_id}-{c.worker_id}",
                        worker_id=c.worker_id,
                        basis=node_basis,
                    )
                    worker_rewards[str(c.worker_id)] = portion

            #   2) 平台账号 (platform_pool)
            if split_result.platform_pool > 0 and split_cfg.platform_account_id:
                ledger_svc.reward(
                    s,
                    worker_owner_id=split_cfg.platform_account_id,
                    amount=split_result.platform_pool,
                    workload_id=workload.id,
                    shard_id=None,
                    note=f"平台抽成 {split_cfg.platform_ratio * 100:.0f}% · {workload.name}",
                    idempotent_suffix="platform",
                    basis="none",
                )

            #   3) 渠道账号 (channel_pool · 0 时已并入 platform)
            if split_result.channel_pool > 0 and split_cfg.channel_account_id:
                ledger_svc.reward(
                    s,
                    worker_owner_id=split_cfg.channel_account_id,
                    amount=split_result.channel_pool,
                    workload_id=workload.id,
                    shard_id=None,
                    note=f"渠道分润 {split_cfg.channel_ratio * 100:.0f}% · {workload.name}",
                    idempotent_suffix="channel",
                    basis="none",
                )

            logger.info("split · workload=%s gmv=%s client=%s platform=%s channel=%s nodes=%d",
                        workload.id,
                        split_result.gmv, split_result.client_pool,
                        split_result.platform_pool, split_result.channel_pool,
                        len(split_result.node_payouts))

            # 3. escrow_release (标记 · 不影响 balance)
            ledger_svc.escrow_release(
                s,
                account_id=workload.owner_id,
                amount=settled_budget,
                workload_id=workload.id,
            )
            if partial_refund > 0:
                resume_n = 0
                try:
                    resume_n = int(
                        (getattr(getattr(workload, "spec", None), "params", None) or {})
                        .get("resume_count") or 0
                    )
                except (TypeError, ValueError):
                    pass
                ledger_svc.refund(
                    s,
                    account_id=workload.owner_id,
                    amount=partial_refund,
                    workload_id=workload.id,
                    reason=(
                        f"部分交付：已验证 {verified_units}/{total_units} 个分片"
                    ),
                    idempotent_key=ledger_svc.settlement_round_key(
                        "partial_refund", str(workload.id), resume_n,
                    ),
                )

            # 4. 审计 (UUID 全转 str · JSON serializable)
            AuditRepo.write(
                s,
                action="workload.done",
                actor_account_id=workload.owner_id,
                actor_kind="system",
                target_kind="workload",
                target_id=str(workload.id),
                detail={
                    "shard_count": len(shards),
                    "verified_units": verified_units,
                    "total_units": total_units,
                    "settled_budget": str(settled_budget),
                    "partial_refund": str(partial_refund),
                    "elapsed_ms": result.elapsed_ms,
                    "reward_total": str(sum(worker_rewards.values())),
                    "reward_by_worker": {str(k): str(v) for k, v in worker_rewards.items()},
                },
            )

            s.commit()
            return result, worker_rewards

    result, worker_rewards = await asyncio.to_thread(_commit)
    if result is None:
        logger.info("aggregator.done · workload=%s lost terminal race", workload.id)
        return
    logger.info("aggregator.done · workload=%s shards=%d reward_total=%s → %d workers",
                workload.id, len(shards),
                sum(worker_rewards.values()), len(worker_rewards))
    record_lifecycle_event(
        "settlement",
        workload_id=workload.id,
        latency_ms=(time.perf_counter() - settlement_started) * 1000,
        outcome="success",
        extra={
            "verified_units": verified_units,
            "total_units": total_units,
            "partial_delivery": failed_units > 0,
        },
    )
    if partial_refund > 0:
        record_lifecycle_event(
            "refund",
            workload_id=workload.id,
            reason_code="PARTIAL_DELIVERY",
            latency_ms=(time.perf_counter() - settlement_started) * 1000,
            outcome="issued",
            extra={
                "verified_units": verified_units,
                "total_units": total_units,
            },
        )

    observed_workers: set[str] = set()
    for shard in reward_shards:
        worker_id = str(shard.worker_id or "")
        if not worker_id or worker_id in observed_workers:
            continue
        observed_workers.add(worker_id)
        verification = (shard.metadata or {}).get("result_verification") or {}
        if verification.get("nce_excluded"):
            logger.warning(
                "nce_observer skipped excluded result · workload=%s worker=%s reason=%s",
                workload.id, worker_id[:8], verification.get("nce_exclusion_reason"),
            )
            continue
        try:
            from platform_v8.services.economy.nce_observer import observe_shard, ShardOutcome
            await asyncio.to_thread(observe_shard, worker_id, ShardOutcome.SUCCESS)
        except Exception as exc:
            logger.warning("nce_observer verified SUCCESS 失败: %s", exc)

    # 开发者 API 可选完成回调。仅在任务已经 commit 为 DONE 后投递，失败绝不能
    # 回滚计算结果或影响节点结算；投递服务还会再次做公网 HTTPS SSRF 校验。
    if workload.spec.task_type == "pdf_to_text":
        try:
            import json as _json
            from platform_v8.services.developer_webhook import deliver_completion
            result_payload = _json.loads(result.output_ref or "{}")
            if isinstance(result_payload, dict):
                await asyncio.to_thread(deliver_completion, workload, result_payload)
        except Exception as exc:
            logger.warning("developer PDF webhook 投递失败 workload=%s: %s", workload.id, exc)

    # 2026-05-18 实时推送 · 通知 owner + admin
    try:
        from platform_v8.api.v8.events import publish_event
        await publish_event("workload.done", {
            "workload_id": str(workload.id),
            "owner_id": workload.owner_id,
            "name": workload.name,
            "status": "DONE",
            "shards": len(shards),
            "elapsed_ms": result.elapsed_ms,
            "reward_total": float(sum(worker_rewards.values())),
        }, owner_id=workload.owner_id)
        # 同时给每个 worker owner publish ledger 事件 (节点端收到立即刷新余额/历史)
        # 注意: 不要在这里 `from ... import WorkerRepo` · 顶层已 import
        # 重复 import 会让 _commit() 内部函数把 WorkerRepo 当 enclosing scope 变量,
        # 导致 _commit 执行时 NameError (free variable 还没赋值 · Python closure 陷阱)
        for wid, amt in worker_rewards.items():
            with db_mod.session_scope() as s:
                w = WorkerRepo.by_id(s, str(wid))
                if w:
                    await publish_event("ledger.added", {
                        "account_id": w.owner_id,
                        "type": "REWARD",
                        "amount": float(amt),
                        "workload_id": str(workload.id),
                    }, owner_id=w.owner_id)
    except Exception as exc:
        logger.warning("workload.done event 发布失败 (静默): %s", exc)


async def _finalize_failed(workload: Workload, shards: list[Shard],
                           *, failed_count: int, done_count: int = 0,
                           expected_statuses: tuple[WorkloadStatus, ...] = (
                               WorkloadStatus.CREATED,
                               WorkloadStatus.PLANNED,
                               WorkloadStatus.RUNNING,
                               WorkloadStatus.WAITING_FOR_WORKERS,
                           ),
                           error_override: str = "") -> None:
    """workload 失败 · refund 退给 owner

    done_count 用于 UI 透明展示 (避免显示 "0/N" 但实际有 N-1 片其实跑完了 ·
    只是没有 post_process 兜底所以整体判 FAILED).
    error: 可选覆盖文案（如聚合器 status=failed）。
    """
    refund_started = time.perf_counter()

    def _commit():
        with db_mod.session_scope() as s:
            error_msg = "; ".join(sh.error for sh in shards if sh.error)[:500]
            final_error = error_override or f"{failed_count}/{len(shards)} 个分片失败: {error_msg}"
            claimed = WorkloadRepo.transition_status(
                s, workload.id, WorkloadStatus.FAILED,
                expected_statuses=expected_statuses,
                error=final_error,
                completed_at=datetime.utcnow(),
                total_shards=len(shards),
                completed_shards=done_count,
                failed_shards=failed_count,
            )
            if not claimed:
                return False

            # refund 全额 (失败的任务全退)
            if workload.budget > 0:
                resume_n = 0
                try:
                    resume_n = int(
                        (getattr(getattr(workload, "spec", None), "params", None) or {})
                        .get("resume_count") or 0
                    )
                except (TypeError, ValueError):
                    pass
                ledger_svc.refund(
                    s,
                    account_id=workload.owner_id,
                    amount=workload.budget,
                    workload_id=workload.id,
                    reason=f"任务失败 ({failed_count}/{len(shards)} 片失败)",
                    idempotent_key=ledger_svc.settlement_round_key(
                        "refund", str(workload.id), resume_n,
                    ),
                )

            AuditRepo.write(
                s,
                action="workload.failed",
                actor_account_id=workload.owner_id,
                actor_kind="system",
                target_kind="workload",
                target_id=workload.id,
                detail={
                    "failed_count": failed_count,
                    "shard_count": len(shards),
                    "refund": str(workload.budget),
                },
            )

            s.commit()
            return True

    committed = await asyncio.to_thread(_commit)
    if not committed:
        logger.info("aggregator.failed · workload=%s lost terminal race", workload.id)
        return
    logger.warning("aggregator.failed · workload=%s failed=%d/%d refund=%s",
                   workload.id, failed_count, len(shards), workload.budget)
    if workload.budget > 0:
        record_lifecycle_event(
            "refund",
            workload_id=workload.id,
            reason_code="WORKLOAD_FAILED",
            latency_ms=(time.perf_counter() - refund_started) * 1000,
            outcome="issued",
            extra={
                "failed_units": failed_count,
                "completed_units": done_count,
            },
        )
