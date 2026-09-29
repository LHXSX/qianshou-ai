"""
Workloads HTTP router · /api/v8/workloads/*
"""
from __future__ import annotations
import asyncio
import json
import logging
import re
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Query
from fastapi.responses import Response, RedirectResponse, JSONResponse
from sqlalchemy.orm import Session

from platform_v8.api.deps import get_session, get_current_account
from platform_v8.api.rate_limit import rate_limit
from platform_v8.core import Account
from platform_v8.engine.privacy_titles import looks_like_filename, title_for_workload
from platform_v8.protocol.http_schema import (
    SubmitWorkloadRequest, WorkloadOut,
)
from platform_v8.services.workloads import submit as submit_svc
from platform_v8.services.workloads import query as query_svc
from platform_v8.services.workloads import cancel as cancel_svc
from platform_v8.services.workloads import resume as resume_svc
from platform_v8.services.archive_normalization_jobs import (
    start_submitted_workload,
)
from platform_v8.engine import lifecycle as lifecycle_engine

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v8/workloads", tags=["workloads"])

_RESULT_FORBIDDEN = "结果仅派发账户可查看"


def _workload_out(w, caller: Account) -> WorkloadOut:
    """列表/详情可给接单节点看进度，但跨户时抹掉 result。"""
    out = WorkloadOut.model_validate(w)
    if not query_svc.can_read_result(w, caller):
        out.result = None
    return out


def _require_workload(session: Session, workload_id: str, current: Account):
    try:
        return query_svc.get_workload(session, workload_id, caller=current)
    except query_svc.WorkloadNotFound:
        raise HTTPException(status_code=404, detail="任务不存在") from None
    except query_svc.WorkloadAccessDenied:
        raise HTTPException(status_code=403, detail="无权访问") from None


def _require_result_read(w, current: Account) -> None:
    try:
        query_svc.require_result_access(w, current)
    except query_svc.WorkloadResultDenied:
        raise HTTPException(status_code=403, detail=_RESULT_FORBIDDEN) from None


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("X-Forwarded-For")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# ── 结果 output_ref 形态处理 ───────────────────────────────
# 大输出节点回传的是 OSS object_key (如 v8/account-{id}/{shard}/result/...),
# 小输出 / 部分脚本回传的是 inline 文本或 http(s) 直链。企业取结果时:
#   - http(s) URL  → 直接用 / 302
#   - object_key   → 服务端 presign 成 GET URL 再给企业 (避免下成乱码 key)
#   - inline 文本  → 原样
def _looks_like_object_key(token: str) -> bool:
    """判断一个结果 token 是否是 OSS object_key (而非内联文本/URL)。"""
    t = (token or "").strip()
    if not t or t.lower().startswith(("http://", "https://")):
        return False
    # 内联 JSON / 文本通常含空白或以 {/[ 开头
    if t.startswith(("{", "[")) or any(c in t for c in " \t\n\r"):
        return False
    # 已知 object_key 前缀 / 形态 (v8 命名空间 / provider prefix / 含 /result/)
    return (
        t.startswith(("v8/", "wuji/", "tasks/", "account-"))
        or "/result/" in t
        or "/input/" in t
    )


def _presign_object_key(
    object_key: str,
    *,
    owner_id: int,
    expires: int = 604800,
    object_version_id: str | None = None,
) -> str | None:
    """只为当前账号的 object key 生成 GET URL。"""
    try:
        from platform_v8.services.storage_refs import materialize_get_url
        return materialize_get_url(owner_id, object_key, expires,
                                   object_version_id=object_version_id)
    except Exception as exc:
        logger.warning(
            "workloads · owned object_key 签名失败: %s",
            type(exc).__name__,
        )
        return None


def _resolve_result_token(token: str, *, owner_id: int) -> str:
    """单个结果 token → 可用形态 (object_key 转 presigned URL · 其余原样)。"""
    t = (token or "").strip()
    if _locked_media_key(t, owner_id=owner_id):
        return ""
    if _looks_like_object_key(t):
        url = _presign_object_key(t, owner_id=owner_id)
        if url:
            return url
    elif t.lower().startswith(("http://", "https://")):
        # 仅兼容可还原为当前账号 key 的历史 OSS URL；任意 worker URL 不外泄。
        try:
            from platform_v8.services.storage_refs import (
                canonicalize_owned_reference,
                materialize_get_url,
            )
            key = canonicalize_owned_reference(owner_id, t)
            return materialize_get_url(owner_id, key, 604800)
        except Exception:
            return ""
    return t


_MEDIA_CONTENT_PREFIXES = ("image/", "video/", "audio/")
def _locked_media_key(value: str, *, owner_id: int) -> bool:
    """Identify a result in the independently verified evidence namespace."""
    from platform_v8.services.storage_refs import is_protected_media_result_ref
    return is_protected_media_result_ref(value)


def _media_artifact(value: Any) -> bool:
    return (isinstance(value, dict)
            and value.get("schema") == "artifact.v1"
            and isinstance(value.get("content_type"), str)
            and value["content_type"].startswith(_MEDIA_CONTENT_PREFIXES))


def _public_media_metadata(value: dict[str, Any]) -> dict[str, Any]:
    """Expose identity, never an unverified download path or media bytes."""
    return {key: value[key] for key in ("schema", "content_type", "size_bytes", "sha256")
            if key in value} | {"delivery": "verified-media-required"}


_INLINE_BLOB_KEYS = ("result_images_b64", "result_files_b64", "output_b64")


def _owned_local_download_url(url: str, *, owner_id: int) -> str | None:
    """Already-signed LAN OSS GET URL that belongs to this account."""
    from urllib.parse import unquote, urlsplit

    t = (url or "").strip()
    if _locked_media_key(t, owner_id=owner_id):
        return None
    try:
        parsed = urlsplit(t)
    except Exception:
        return None
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
        return None
    path = parsed.path or ""
    marker = "/api/v8/oss/local/download/"
    if marker not in path:
        return None
    key = unquote(path.split(marker, 1)[1]).lstrip("/")
    try:
        from platform_v8.services.storage_refs import validate_owned_object_key
        validate_owned_object_key(owner_id, key)
    except Exception:
        return None
    return t


def _resolve_keep_url(token: str, *, owner_id: int) -> str:
    """Presign object keys; keep owned LAN download URLs if re-sign fails."""
    t = (token or "").strip()
    if not t:
        return ""
    resolved = _resolve_result_token(t, owner_id=owner_id)
    if resolved:
        return resolved
    return _owned_local_download_url(t, owner_id=owner_id) or ""


def _strip_inline_binaries(token: str) -> str:
    """Drop inline b64 blobs from shard JSON. Aggregator already has the files."""
    t = (token or "").strip()
    if not (t.startswith("{") or t.startswith("[")):
        return t
    try:
        obj = json.loads(t)
    except Exception:
        return t

    def _walk(node: Any) -> None:
        if isinstance(node, dict):
            for key in _INLINE_BLOB_KEYS:
                node.pop(key, None)
            for val in node.values():
                _walk(val)
        elif isinstance(node, list):
            for val in node:
                _walk(val)

    _walk(obj)
    return json.dumps(obj, ensure_ascii=False)


def _hydrate_json_urls(obj: Any, *, owner_id: int) -> Any:
    if isinstance(obj, dict):
        if _media_artifact(obj):
            return _public_media_metadata(obj)
        for key in ("download_url", "url", "preview_url", "output_url"):
            val = obj.get(key)
            if isinstance(val, str) and val.strip():
                if _locked_media_key(val, owner_id=owner_id):
                    obj.pop(key, None)
                    continue
                resolved = _resolve_keep_url(val, owner_id=owner_id)
                if resolved:
                    obj[key] = resolved
        urls = obj.get("preview_urls")
        if isinstance(urls, list):
            nxt: list[str] = []
            for item in urls:
                if not isinstance(item, str) or not item.strip():
                    continue
                raw = item.strip()
                if _locked_media_key(raw, owner_id=owner_id):
                    continue
                resolved = _resolve_keep_url(raw, owner_id=owner_id)
                # 重签失败时保留原预签名 URL，避免借调预览被清空
                nxt.append(resolved or raw)
            obj["preview_urls"] = nxt
        for key, val in list(obj.items()):
            obj[key] = _hydrate_json_urls(val, owner_id=owner_id)
    elif isinstance(obj, list):
        for index, val in enumerate(obj):
            obj[index] = _hydrate_json_urls(val, owner_id=owner_id)
    return obj


def _public_result_token(token: str, *, owner_id: int, strip_b64: bool = False) -> str:
    t = (token or "").strip()
    if strip_b64:
        t = _strip_inline_binaries(t)
    if _locked_media_key(t, owner_id=owner_id):
        return json.dumps({"delivery": "verified-media-required"})
    if t.startswith("{"):
        try:
            media = json.loads(t)
        except (TypeError, ValueError):
            media = None
        if _media_artifact(media):
            return json.dumps(_public_media_metadata(media), ensure_ascii=False)
    try:
        from platform_v8.engine.aggregators.zip_files import materialize_output_ref
        t = materialize_output_ref(t)
    except Exception:
        pass
    t = _resolve_result_token(t, owner_id=owner_id) or t
    if t.startswith("{") or t.startswith("["):
        try:
            obj = json.loads(t)
        except Exception:
            return t
        _hydrate_json_urls(obj, owner_id=owner_id)
        if (isinstance(obj, dict) and (obj.get("schema") or obj.get("schema_version")) == "artifact.v1"
                and isinstance(obj.get("object_key"), str)):
            signed = _presign_object_key(
                obj["object_key"], owner_id=owner_id,
                object_version_id=obj.get("object_version_id"))
            if signed:
                obj["download_url"] = signed
                if str(obj.get("content_type") or "").startswith(("image/", "video/")):
                    obj["preview_url"] = signed
        if isinstance(obj, dict):
            from platform_v8.engine.aggregators.zip_files import _normalize_capability_json
            obj = _normalize_capability_json(obj)
        return json.dumps(obj, ensure_ascii=False)
    return t


def _looks_like_aggregator_manifest(token: str) -> bool:
    """zip_files / ffmpeg_concat 等已把可下载 URL 写进 workload.result。"""
    t = (token or "").strip()
    if t.lower().startswith(("http://", "https://")):
        return True
    if not (t.startswith("{") or t.startswith("[")):
        return False
    try:
        data = json.loads(t)
    except Exception:
        return False
    if not isinstance(data, dict):
        return False
    schema = str(data.get("schema") or data.get("schema_version") or "")
    if schema == "artifact.v1":
        return False
    for key in ("download_url", "preview_url"):
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            return True
    urls = data.get("preview_urls")
    if isinstance(urls, list) and any(isinstance(u, str) and u.strip() for u in urls):
        return True
    summary = data.get("summary")
    if isinstance(summary, dict) and str(summary.get("download_kind") or "") in {"zip", "audio"}:
        return True
    # lines_merge / manifest_only / numeric_sum 已合并出表格或正文
    if isinstance(data.get("result_lines"), list) and data["result_lines"]:
        return True
    if isinstance(data.get("results"), list) and data["results"]:
        return True
    for key in ("text", "result_text"):
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            return True
    if isinstance(data.get("stats"), dict) and data["stats"]:
        return True
    return False


def _result_as_json_or_text(token: str) -> Any:
    t = (token or "").strip()
    if t.startswith("{") or t.startswith("["):
        try:
            return json.loads(t)
        except Exception:
            return t
    return t


def _human_text_from_object_key(
    object_key: str,
    task_type: str,
    *,
    owner_id: int,
) -> tuple[str, str] | None:
    """读取聚合 manifest 指向的正文对象，供文本任务下载。

    聚合器会把大正文放在 OSS，manifest 的 ``text`` 字段只留下 object_key。
    下载接口应交付正文而不是把内部 key 或摘要当成用户结果。
    """
    del task_type  # 保留任务类型参数，方便后续按脚本合同扩展。
    if not _looks_like_object_key(object_key):
        return None
    signed = _presign_object_key(object_key, owner_id=owner_id)
    if not signed:
        return None
    try:
        from platform_v8.services.url_safety import URLPolicy, safe_open
        with safe_open(
            signed,
            policy=URLPolicy(timeout=20, max_response_bytes=64 * 1024 * 1024),
        ) as response:
            text = response.read().decode("utf-8")
    except Exception as exc:
        logger.warning("workloads · 读取文本结果对象失败: %s", type(exc).__name__)
        return None
    return (text if text.endswith("\n") else text + "\n", ".txt")


# 2026-09-18 · 曾经这里另有一份 _human_text_from_manifest 定义，但文件后面
# （约 713 行）还有一份同名定义会把它整个遮蔽，于是下面两个传 owner_id 的调用点
# 稳定抛 TypeError: unexpected keyword argument 'owner_id'（GET /download 直接 500）。
# 现统一为后文唯一一份实现（已补回 owner_id 语义），本处只留归一辅助函数。
def _is_empty_result_shell(raw: str) -> bool:
    """已落库结果是否「认得出形状但没有答案」的空壳。

    判据收敛到 services/result_envelope.is_empty_result_shell（单一口径），
    本函数只做转调，避免 Web 端 / 开发者接口各自长出一份判据。
    """
    from platform_v8.services.result_envelope import is_empty_result_shell
    return is_empty_result_shell(raw)


def _normalize_result_envelope(raw: str) -> str:
    """读路径：把非 JSON 形状的已落库结果包装成平台合法信封。

    纯文本 output_ref（全库 DONE 285 条）落库时聚合层认不出来，会被合并成
    "results":[] / "result_text":"" 的空壳；读取端于是展示空白。
    这里只做形状归一：合法 JSON 逐字节原样返回，纯文本补成信封，空保持空。
    共用实现见 services/result_envelope.py（单一口径）。
    """
    from platform_v8.services.result_envelope import normalize_result_envelope
    return normalize_result_envelope(raw)


# ── POST /workloads · 提交 ──────────────────────────
# 2026-05-25 P3 · dependencies 式 rate_limit · 30 次/分钟/uid 防恶意刷烧 budget
@router.post("", response_model=WorkloadOut, status_code=201, summary="提交任务",
             dependencies=[Depends(rate_limit("submit_workload", per_minute=30, key="uid"))])
def submit_endpoint(
    body: SubmitWorkloadRequest,
    request: Request,
    bg: BackgroundTasks,
    response: Response,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    try:
        workload = submit_svc.submit_workload(
            session,
            submit_svc.SubmitInput(
                owner_id=current.id,
                name=body.name,
                spec_dict=body.spec.model_dump(),
                budget=body.budget,
                quote_token=body.quote_token,
                request_id=body.request_id,
                trace_id=getattr(request.state, "trace_id", None),
                ip=_client_ip(request),
                # S2-T2/T3 · 普通用户禁高危 runtime/code_url; admin 可绕过
                is_admin=current.is_admin,
            ),
        )
    except submit_svc.SubmitWorkloadError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # PDF/材料 demo 常把真实文件名当 name · 入库换成专业代号
    # Workload 是 dataclass，不能 session.add
    if looks_like_filename(getattr(workload, "name", None) or body.name):
        from platform_v8.storage.repo import WorkloadRepo
        final_name = title_for_workload(workload)
        WorkloadRepo.update_name(session, str(workload.id), final_name)
        session.commit()
        workload.name = final_name

    status_name = getattr(workload.status, "name", str(workload.status))
    if status_name == "NORMALIZING":
        response.status_code = 202
    bg.add_task(_async_wrap, start_submitted_workload, workload.id)

    return WorkloadOut.model_validate(workload)


async def _async_wrap(coro_func, *args):
    """BackgroundTasks 调 async function 的 wrapper"""
    try:
        await coro_func(*args)
    except Exception:
        logger.exception("background task 异常")


# ── GET /workloads · 列表 ───────────────────────────
@router.get("", response_model=list[WorkloadOut], summary="列任务 (admin 看全部 · 用户看自己发的+自己节点接到的)")
def list_endpoint(
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
    status: str | None = Query(default=None, description="按 status 过滤 (CREATED/PLANNED/RUNNING/DONE/FAILED/CANCELED)"),
    owner_id: int | None = Query(default=None, description="仅 admin 有效 · 按 owner 过滤"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    workloads = query_svc.list_workloads(
        session, caller=current, status=status, owner_id=owner_id,
        limit=limit, offset=offset,
    )
    return [_workload_out(w, current) for w in workloads]


# ── GET /workloads/{id} · 详情 ──────────────────────
@router.get("/{workload_id}", response_model=WorkloadOut, summary="任务详情")
def get_endpoint(
    workload_id: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    w = _require_workload(session, workload_id, current)
    return _workload_out(w, current)


@router.get(
    "/{workload_id}/media-view-grant",
    summary="获取已验收任务媒体的短期查看授权",
    dependencies=[Depends(rate_limit("workload_media_view_grant", per_minute=120, key="uid"))],
)
def get_workload_media_view_grant(
    workload_id: str,
    asset_id: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    """Authorize only the finished owner's independently attested media.

    Shanghai signs control metadata; Guangzhou serves the exact COS bytes.
    This path covers ordinary chat/workload orders as well as developer tasks.
    """
    from platform_v8.storage.repo import (ResultVerificationRepo, ShardRepo,
                                          WorkloadRepo)
    from platform_v8.services import media_view_grants
    from platform_v8.services.workers import task_adapter_evidence_storage

    if not re.fullmatch(r"[a-f0-9]{64}", asset_id):
        raise HTTPException(status_code=400, detail="媒体引用无效")
    workload = WorkloadRepo.by_id(session, workload_id)
    if (workload is None or int(workload.owner_id) != int(current.id)):
        raise HTTPException(status_code=404, detail="媒体结果不存在")
    if workload.status.value != "DONE" or workload.result is None:
        raise HTTPException(status_code=409, detail="任务尚未完成")
    shards = ShardRepo.by_workload(session, str(workload.id))
    verification_rows = {
        str(shard.id): ResultVerificationRepo.current(session, str(shard.id))
        for shard in shards
    }
    asset = media_view_grants.attested_asset(
        workload, shards, asset_id, verification_rows,
    )
    if asset is None:
        raise HTTPException(status_code=404, detail="媒体结果不存在或尚未核验")
    try:
        bucket = task_adapter_evidence_storage.provider().bucket
        grant = media_view_grants.issue(
            account_id=int(current.id), task_id=str(workload.id),
            asset_id=asset_id, bucket=bucket, asset=asset,
        )
    except (task_adapter_evidence_storage.EvidenceStorageUnavailable,
            media_view_grants.MediaViewUnavailable) as exc:
        raise HTTPException(status_code=503, detail="媒体交付服务尚未就绪") from exc
    return JSONResponse({"ok": True, "grant": grant},
                        headers={"Cache-Control": "private, no-store",
                                 "Pragma": "no-cache"})


# ── DELETE /workloads/{id} · 取消 ───────────────────
@router.delete("/{workload_id}", response_model=WorkloadOut, summary="取消任务 (退款)")
def cancel_endpoint(
    workload_id: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    try:
        w = cancel_svc.cancel_workload(session, workload_id, caller=current)
    except cancel_svc.CancelError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return WorkloadOut.model_validate(w)


# ── POST /workloads/{id}/resume · 断点续跑 ───────────
@router.post(
    "/{workload_id}/resume",
    summary="断点续跑：保留已完成分片，重跑未完成分片",
)
async def resume_workload_endpoint(
    workload_id: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    """打开历史中断/失败任务后继续：已 DONE 的分片不动，CANCELLED/FAILED 复活重派。"""
    try:
        w, meta = resume_svc.resume_workload(session, workload_id, caller=current)
        session.commit()
    except resume_svc.ResumeError as exc:
        msg = str(exc)
        code = 404 if "不存在" in msg else (403 if "无权" in msg else 400)
        raise HTTPException(status_code=code, detail=msg) from exc

    report = await lifecycle_engine.redispatch_pending(workload_id)
    return {
        "ok": True,
        "workload_id": workload_id,
        "status": getattr(w.status, "value", str(w.status)),
        "progress": w.progress,
        **meta,
        "dispatch": report,
    }


# ── POST /workloads/{id}/stop-nodes · 强制停节点 ─────
@router.post(
    "/{workload_id}/stop-nodes",
    summary="强制通知节点停止本任务分片（已取消任务也可补发）",
)
def stop_nodes_endpoint(
    workload_id: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
    reason: str = Query(default="force_stop_nodes", max_length=120),
):
    """补发 shard_cancel · 把残留 DISPATCHED/RUNNING 标 CANCELLED。

    典型场景：DELETE 取消后推送丢帧、节点仍在跑；或运维二次清场。
    """
    try:
        return cancel_svc.stop_workload_nodes(
            session, workload_id, caller=current, reason=reason or "force_stop_nodes",
        )
    except cancel_svc.CancelError as exc:
        msg = str(exc)
        if "不存在" in msg:
            raise HTTPException(status_code=404, detail=msg) from exc
        if "无权" in msg:
            raise HTTPException(status_code=403, detail=msg) from exc
        raise HTTPException(status_code=400, detail=msg) from exc


# ── POST /workloads/{id}/shards/{shard_id}/redispatch · 手动重派 ──
@router.post(
    "/{workload_id}/shards/{shard_id}/redispatch",
    summary="手动重新派发卡住的分片（排除当前节点，优先已成功节点）",
)
async def redispatch_shard_endpoint(
    workload_id: str,
    shard_id: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    """用户在任务页看到某分片卡住时，可一键重派。

    - 排除当前执行节点（避免再次派回卡死节点）
    - 优先派给本任务已成功完成其它分片的节点
    - 仍受调度器在线候选池约束
    重派仅发布人 / admin，接单节点不能改别人的排单。
    """
    from platform_v8.storage.repo import WorkloadRepo as _WLRepo
    w = _WLRepo.by_id(session, str(workload_id).strip())
    if w is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    if w.owner_id != current.id and not current.is_admin:
        raise HTTPException(status_code=403, detail="无权访问")

    result = await lifecycle_engine.manual_redispatch_shard(workload_id, shard_id)
    if not result.get("ok"):
        code = int(result.get("code") or 400)
        raise HTTPException(status_code=code, detail=result.get("error") or "重派失败")
    return result


# ── GET /workloads/{id}/shards · 列分片 ─────────────
@router.get("/{workload_id}/shards", summary="任务分片详情")
def list_shards_endpoint(
    workload_id: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    w = _require_workload(session, workload_id, current)
    can_result = query_svc.can_read_result(w, current)

    from platform_v8.storage.repo import ShardRepo, workers_t
    from sqlalchemy import select as _select

    shards = ShardRepo.by_workload(session, workload_id)
    worker_ids = sorted({str(sh.worker_id) for sh in shards if sh.worker_id})
    name_by_id: dict[str, str] = {}
    if worker_ids:
        rows = session.execute(
            _select(workers_t.c.id, workers_t.c.name).where(workers_t.c.id.in_(worker_ids))
        ).all()
        for r in rows:
            wid = str(r.id)
            name_by_id[wid] = (r.name or wid[:12])

    # 编排摘要：切片策略 / 输入形态（WorkloadSpec dataclass + 首片 metadata）
    spec = getattr(w, "spec", None)
    params = dict(getattr(spec, "params", None) or {}) if spec is not None else {}
    first_md = (shards[0].metadata if shards and isinstance(shards[0].metadata, dict) else {}) or {}
    strategy = first_md.get("slice_strategy") or "—"
    done_n = sum(1 for sh in shards if getattr(sh.status, "value", str(sh.status)) in ("DONE", "SUCCEEDED", "COMPLETED"))
    running_n = sum(1 for sh in shards if getattr(sh.status, "value", str(sh.status)) == "RUNNING")
    failed_n = sum(1 for sh in shards if getattr(sh.status, "value", str(sh.status)) == "FAILED")

    def _slice_label(md: dict) -> str:
        sm = md.get("slice_meta") if isinstance(md.get("slice_meta"), dict) else {}
        if not sm:
            return "整片"
        if "page_pct_start" in sm and "page_pct_end" in sm:
            a = float(sm.get("page_pct_start") or 0) * 100
            b = float(sm.get("page_pct_end") or 0) * 100
            return f"页区间 {a:.0f}%–{b:.0f}%"
        if "page_start" in sm or "page_end" in sm:
            return f"页 {sm.get('page_start', '?')}–{sm.get('page_end', '?')}"
        if "part_index" in sm:
            return f"分包 #{sm.get('part_index')}"
        return "切片"

    def _st(sh) -> str:
        return getattr(sh.status, "value", str(sh.status))

    return {
        "workload_id": workload_id,
        "workload_status": w.status.value if hasattr(w.status, "value") else str(w.status),
        "total": len(shards),
        "orchestration": {
            "task_type": getattr(spec, "task_type", None) or first_md.get("task_type"),
            "input_kind": getattr(spec, "input_kind", None) or first_md.get("input_kind"),
            "max_shards": getattr(spec, "max_shards", None),
            "slice_strategy": strategy,
            "input_name": params.get("input_name") if can_result else None,
            "input_size": params.get("input_size") if can_result else None,
            "done": done_n,
            "running": running_n,
            "failed": failed_n,
            "pending": max(0, len(shards) - done_n - running_n - failed_n),
        },
        "shards": [{
            "id": sh.id,
            "index": sh.index,
            "total": sh.total,
            "status": _st(sh),
            "worker_id": sh.worker_id,
            "worker_name": name_by_id.get(str(sh.worker_id)) if sh.worker_id else None,
            "output_ref": sh.output_ref if can_result else None,
            "attempts": sh.attempts,
            "elapsed_ms": sh.elapsed_ms,
            "error": sh.error,
            "slice_label": _slice_label(sh.metadata if isinstance(sh.metadata, dict) else {}),
            "slice_meta": (sh.metadata or {}).get("slice_meta") if isinstance(sh.metadata, dict) else None,
            "slice_strategy": (sh.metadata or {}).get("slice_strategy") if isinstance(sh.metadata, dict) else None,
            "dispatched_at": sh.dispatched_at.isoformat() if sh.dispatched_at else None,
            "started_at": sh.started_at.isoformat() if getattr(sh, "started_at", None) else None,
            # Only a CAS-accepted progress frame observes this worker/attempt.
            "progress_at": sh.progress_at.isoformat() if getattr(sh, "progress_at", None) else None,
            "completed_at": sh.completed_at.isoformat() if sh.completed_at else None,
        } for sh in shards],
    }


@router.get("/{workload_id}/result", summary="任务结果聚合 (合并所有 shard output)")
async def workload_result(
    workload_id: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
) -> dict[str, Any]:
    """取任务最终结果 · 合并 shard output_ref。仅派发账户 / admin。

    workload_id 必须用 str（与 GET /{id}、/shards 一致）。标注 UUID 时 SQLAlchemy
    会生成 ``id = :p::UUID``，Ally/LAN 等 varchar 主键库会 500
    （``operator does not exist: character varying = uuid``）。
    """
    from platform_v8.storage.repo import ShardRepo, WorkerRepo
    wid = str(workload_id).strip()
    try:
        w = query_svc.get_workload(session, wid, caller=current)
    except query_svc.WorkloadNotFound:
        raise HTTPException(status_code=404, detail="workload not found")
    except query_svc.WorkloadAccessDenied:
        raise HTTPException(status_code=403, detail="forbidden")
    _require_result_read(w, current)

    shards = ShardRepo.by_workload(session, wid)
    owner_id = int(w.owner_id)
    # 分片 output 给编排摘要；内联 b64 已由 zip_files 等聚合器落成 download/preview URL，不再回传。
    parts = sorted(shards, key=lambda s: s.index)
    resolved = [(p.index, p.status, _public_result_token(
        p.output_ref or "", owner_id=owner_id, strip_b64=True,
    ), p.elapsed_ms)
                for p in parts]
    combined = "\n".join(out for (_, _, out, _) in resolved if out)
    # QS-18 阶段①：结果自证执行者（契约 result.schema.json executor 节）。纯加法：推不出就不写该键，
    # 绝不默认 node；分片级各给一块，workload 级只在所有分片同一执行者时给。
    from platform_v8.services.executor_block import build_executor_blocks
    executor, shard_executors = build_executor_blocks(
        w.spec.task_type, parts, lambda worker_id: WorkerRepo.by_id(session, worker_id),
    )

    agg = ""
    if w.result is not None:
        agg = (w.result.output_ref or w.result.inline_output or "").strip()
    # 2026-09-18 · 纯文本形状的已落库聚合结果先归一成信封再判形状，
    # 否则 _looks_like_aggregator_manifest 认不出来、只能退回分片拼接。
    # 合法 JSON 经此调用逐字节不变。
    agg = _normalize_result_envelope(agg)
    # 2026-09-18 · 已落库聚合可能是「空壳」（聚合层丢弃纯文本分片后的产物）：
    # 形状合法但 results/result_text 都是空，正文其实在分片里。
    # 用分片派生文本接管；JSON 且正文非空的任务不受影响。
    from platform_v8.services.result_envelope import reconcile_with_shard_texts
    agg = reconcile_with_shard_texts(agg, [out for (_, _, out, _) in resolved if out])
    if _looks_like_aggregator_manifest(agg):
        result_token = _public_result_token(agg, owner_id=owner_id)
    else:
        result_token = combined

    def _status_value(st: Any) -> str:
        return st.value if hasattr(st, "value") else str(st)

    return {
        "workload_id": wid,
        "status": _status_value(w.status),
        "completed_shards": w.completed_shards,
        "total_shards": w.total_shards,
        "result": _result_as_json_or_text(result_token),
        **({"executor": executor} if executor is not None else {}),
        "shards": [{
            "index": idx,
            "status": _status_value(st),
            "output": _result_as_json_or_text(_normalize_result_envelope(out)),
            "elapsed_ms": el,
            **({"executor": shard_executors[idx]} if idx in shard_executors else {}),
        } for (idx, st, out, el) in resolved],
    }


def _unwrap_media_manifest(raw: str, *, owner_id: int) -> str | None:
    """ffmpeg_concat / artifact.v1 等聚合器在无 zip 时会把 manifest JSON 写入 output_ref。
    若其中有可下载 URL / object_key · 解出供 302 / 预览（兼容已落库的旧结果）。"""
    t = (raw or "").strip()
    if not (t.startswith("{") or t.startswith("[")):
        return None
    try:
        d = json.loads(t)
    except Exception:
        return None
    if not isinstance(d, dict):
        return None
    # artifact.v1 · 节点上传的二进制产物
    schema = d.get("schema") or d.get("schema_version")
    if schema == "artifact.v1" and isinstance(d.get("object_key"), str) and d["object_key"].strip():
        if _media_artifact(d):
            return None
        signed = _presign_object_key(
            d["object_key"].strip(), owner_id=owner_id,
            object_version_id=d.get("object_version_id"))
        if signed:
            return signed
    for key in ("download_url", "output_url", "url", "output_ref"):
        u = d.get(key)
        if isinstance(u, str) and u.strip().lower().startswith(("http://", "https://")):
            return u.strip()
        if isinstance(u, str) and _looks_like_object_key(u.strip()):
            signed = _presign_object_key(u.strip(), owner_id=owner_id)
            if signed:
                return signed
    segs = d.get("segments")
    if isinstance(segs, list):
        urls = [
            str(s.get("url")).strip()
            for s in segs
            if isinstance(s, dict)
            and isinstance(s.get("url"), str)
            and str(s.get("url")).strip().lower().startswith(("http://", "https://"))
        ]
        if urls:
            return urls[0]
    return None


def _human_text_from_manifest(
    raw: str,
    task_type: str = "",
    *,
    owner_id: int | None = None,
) -> tuple[str, str] | None:
    """把聚合 JSON 转成用户可读文本下载 · 返回 (text, ext) 或 None。

    解决 OCR/校验/哈希等「预览有正文、下载却是空 results JSON」的体验问题。

    owner_id 为可选关键字参数（2026-09-18 合并同名双定义时补回）：正文指向
    OSS object_key 时需要它做归属校验与 presign；不传则退回只认内联正文，
    因此历史调用方行为不变。
    """
    try:
        data = json.loads((raw or "").strip())
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None

    # 1) 显式正文
    for key in ("result_text", "result_caption"):
        text = data.get(key)
        if isinstance(text, str) and text.strip():
            return text.strip() + "\n", ".txt"

    # 1b) raw 兼容 / object_key 正文（原被遮蔽定义里的能力，合并时保留）
    for key in ("text", "summary_text"):
        text = data.get(key)
        if not isinstance(text, str) or not text.strip():
            continue
        if key == "summary_text":
            # summary_text 只是摘要，仅在没有任何结构化正文时才用（见第 6 步）
            continue
        if owner_id is not None and _looks_like_object_key(text):
            got = _human_text_from_object_key(text, task_type, owner_id=owner_id)
            if got:
                return got
        return text.strip() + "\n", ".txt"

    # 2) OCR pages → 可读正文
    pages = data.get("pages")
    if isinstance(pages, list) and pages:
        chunks: list[str] = []
        for page in pages:
            if not isinstance(page, dict):
                continue
            header = page.get("filename") or f"第{page.get('page', '?')}页"
            lines = []
            for ld in page.get("line_detail") or []:
                if isinstance(ld, dict) and ld.get("text"):
                    lines.append(str(ld["text"]))
            if not lines and page.get("text"):
                lines.append(str(page["text"]))
            if lines:
                chunks.append(f"【{header}】\n" + "\n".join(lines))
        if chunks:
            return "\n\n".join(chunks) + "\n", ".txt"

    # 3) result_lines
    lines = data.get("result_lines")
    if isinstance(lines, list) and lines:
        body = "\n".join(str(x) for x in lines if str(x).strip())
        if body.strip():
            return body + "\n", ".txt"

    # 4) base64 / image_caption / 通用 results 抽字段
    results = data.get("results")
    if not isinstance(results, list):
        results = data.get("result")
    if isinstance(results, list) and results:
        if task_type == "image_caption" or any(
            isinstance(x, dict) and x.get("caption") for x in results[:3]
        ):
            out_lines = []
            for item in results:
                if not isinstance(item, dict):
                    continue
                caption = str(item.get("caption") or "").strip()
                if caption:
                    out_lines.append(f"{item.get('filename') or '图片'}: {caption}")
            if out_lines:
                return "\n".join(out_lines) + "\n", ".txt"
        if task_type.startswith("base64"):
            out_lines = []
            for item in results:
                if not isinstance(item, dict):
                    continue
                val = item.get("base64") or item.get("decoded") or item.get("value")
                if val is not None:
                    out_lines.append(str(val))
            if out_lines:
                return "\n".join(out_lines) + "\n", ".txt"
        # OCR-ish dicts already handled via pages; dump JSONL for structured results
        try:
            body = "\n".join(json.dumps(x, ensure_ascii=False) for x in results)
            if body.strip():
                return body + "\n", ".jsonl"
        except Exception:
            pass

    # 5) rows → JSON array file
    rows = data.get("rows")
    if isinstance(rows, list) and rows:
        return json.dumps(rows, ensure_ascii=False, indent=2) + "\n", ".json"

    # 6) summary_text 兜底（至少不是空壳 results）
    summary_text = data.get("summary_text")
    if isinstance(summary_text, str) and summary_text.strip():
        # 仅当 results 明显为空时用 summary，避免抢走结构化下载
        empty_results = not (isinstance(data.get("results"), list) and data.get("results"))
        empty_lines = not (isinstance(data.get("result_lines"), list) and data.get("result_lines"))
        if empty_results and empty_lines:
            return summary_text.strip() + "\n", ".txt"

    return None


def _caption_text_from_manifest(raw: str, *, owner_id: int | None = None) -> str | None:
    """把 image_caption 聚合 JSON 转成用户可读文本下载。"""
    got = _human_text_from_manifest(raw, "image_caption")
    if got:
        return got[0]
    return None


# ── GET /workloads/{id}/download · 直接下载结果 ────────────
# 2026-05-20 · enterprise-portal Results.vue 调这个 endpoint
# 返回:
#   - workload.result.output_ref 是 http(s):// → 302 重定向到 OSS
#   - workload.result.output_ref 是 JSON / 文本 → 直接当 attachment 下载
@router.get("/{workload_id}/download", summary="下载任务结果 (web 端用)")
def workload_download(
    workload_id: str,
    session: Session = Depends(get_session),
    current: Account = Depends(get_current_account),
):
    """企业 web 端"下载结果"按钮调本 endpoint。

    workload_id 用 str，避免 varchar 主键库上 UUID 绑定导致 500（同 /result）。
    """
    wid = str(workload_id).strip()
    try:
        w = query_svc.get_workload(session, wid, caller=current)
    except query_svc.WorkloadNotFound:
        raise HTTPException(status_code=404, detail="workload not found")
    except query_svc.WorkloadAccessDenied:
        raise HTTPException(status_code=403, detail="forbidden")
    _require_result_read(w, current)
    if w.result is None:
        raise HTTPException(status_code=404, detail="结果还没生成")

    raw = (w.result.output_ref or w.result.inline_output or "").strip()
    if not raw:
        raise HTTPException(status_code=404, detail="结果还没生成")

    # 2026-09-18 · 纯文本形状归一成信封；合法 JSON 逐字节不变。
    raw = _normalize_result_envelope(raw)

    # 2026-09-18 · 空壳（results/result_text 皆空，正文在分片里）→ 用分片正文，
    # 否则下载出来只是 summary_text 那句元信息。空分片时保持原状（仍 404 语义）。
    if _is_empty_result_shell(raw):
        from platform_v8.services.result_envelope import reconcile_with_shard_texts
        from platform_v8.storage.repo import ShardRepo
        _owner = int(w.owner_id)
        raw = reconcile_with_shard_texts(raw, [
            _public_result_token(s.output_ref or "", owner_id=_owner)
            for s in sorted(ShardRepo.by_workload(session, str(w.id)),
                            key=lambda s: s.index)
        ])

    task_type = getattr(w.spec, "task_type", "") or ""

    # 图片描述没有二进制产物；下载应是可读 caption 文本，而不是内部聚合 JSON。
    if task_type == "image_caption":
        raw = _caption_text_from_manifest(raw, owner_id=int(w.owner_id)) or raw

    # 0) 媒体聚合 / artifact.v1 manifest JSON → 解出真实 URL
    # Versioned artifact media must be signed from its own manifest before any
    # generic URL handling; its evidence bucket differs from the default OSS.
    from platform_v8.protocol.artifact import parse_artifact_ref
    exact_artifact = parse_artifact_ref(raw)
    if exact_artifact is not None:
        if exact_artifact.content_type.startswith(_MEDIA_CONTENT_PREFIXES):
            raise HTTPException(status_code=409, detail="媒体结果须通过独立核验后的查看授权获取")
        signed = _presign_object_key(
            exact_artifact.object_key, owner_id=int(w.owner_id),
            object_version_id=exact_artifact.object_version_id)
        if not signed:
            raise HTTPException(status_code=409, detail="结果归档版本暂不可下载")
        return RedirectResponse(url=signed, status_code=302)
    unwrapped = _unwrap_media_manifest(raw, owner_id=int(w.owner_id))
    if unwrapped:
        raw = unwrapped
    if _locked_media_key(raw, owner_id=int(w.owner_id)):
        raise HTTPException(status_code=409, detail="媒体结果须通过独立核验后的查看授权获取")

    # 0b) 文本聚合 manifest → 正文。尤其是 ordered_concat，summary_text 只是摘要，
    #     不能替代用户下载的完整文本。
    task_type = str(getattr(getattr(w, "spec", None), "task_type", "") or "")
    human_text = _human_text_from_manifest(
        raw,
        task_type,
        owner_id=int(w.owner_id),
    )
    if human_text:
        raw, manifest_ext = human_text
    else:
        manifest_ext = ""

    # 1) OSS / HTTP 直链 → 302 重定向
    if raw.lower().startswith(("http://", "https://")):
        # 只兼容能还原为当前账号 object key 的历史 OSS URL。
        first_url = raw.split(";")[0].strip()
        local = _owned_local_download_url(first_url, owner_id=int(w.owner_id))
        try:
            from platform_v8.services.storage_refs import (
                canonicalize_owned_reference,
                materialize_get_url,
            )
            key = canonicalize_owned_reference(int(w.owner_id), first_url)
            signed = materialize_get_url(int(w.owner_id), key, 604800)
        except Exception as exc:
            # LAN zip_files 已经签发 /oss/local/download/…，IP host 可能不在 trusted_hosts。
            if local:
                return RedirectResponse(url=local, status_code=302)
            logger.warning(
                "workloads · 拒绝非 owned 结果 URL: %s",
                type(exc).__name__,
            )
            raise HTTPException(
                status_code=409,
                detail="结果引用不是当前账号可验证的对象",
            ) from exc
        return RedirectResponse(url=signed, status_code=302)

    # 1b) object_key 形态 (大输出节点回传) → 服务端 presign 成 GET URL → 302
    #     output_ref 可能是多个 key 用 ; 分隔 · 取第一个 presign
    first_token = raw.split(";")[0].strip()
    if _looks_like_object_key(first_token):
        signed = _presign_object_key(first_token, owner_id=int(w.owner_id))
        if signed:
            return RedirectResponse(url=signed, status_code=302)
        # presign 失败 · 回落:把 key 当文本返回 (至少能看到 key 去人工排查)

    # 1c) 结构化聚合 JSON → 优先导出可读正文 / JSONL（OCR、哈希、校验、Base64）
    preferred_ext = None
    if first_token.startswith("{") or first_token.startswith("["):
        human = _human_text_from_manifest(raw, task_type)
        if human:
            raw, preferred_ext = human

    # 2) inline JSON / 文本 → 直接当 attachment 返回
    # 文件名用任务名 · 兜底 result.json
    from urllib.parse import quote as _urlquote
    raw_name = (w.name or "result").strip() or "result"
    # ASCII 兜底名 (老浏览器用) · 非 ASCII 字符替成 _
    ascii_name = "".join(c if (c.isascii() and (c.isalnum() or c in "-_.()[]")) else "_" for c in raw_name)[:80] or "result"
    # 简单判断内容类型
    looks_json = raw.startswith("{") or raw.startswith("[")
    ext = manifest_ext or (".json" if looks_json else ".txt")
    content_type = "application/json; charset=utf-8" if looks_json else "text/plain; charset=utf-8"
    # RFC 5987 编码 · 现代浏览器优先用 filename* · 老浏览器用 filename
    # HTTP header 必须 latin-1 · 中文文件名必须 percent-encode
    quoted = _urlquote(f"{raw_name}{ext}", safe="")
    disposition = f"attachment; filename=\"{ascii_name}{ext}\"; filename*=UTF-8''{quoted}"
    body = raw.encode("utf-8")
    return Response(
        content=body,
        media_type=content_type,
        headers={
            "Content-Disposition": disposition,
            "Content-Length": str(len(body)),
        },
    )
