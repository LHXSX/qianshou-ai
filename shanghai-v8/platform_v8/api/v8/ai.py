"""
v8 AI 路由 · /api/v8/ai/* + /api/v8/chat/*

整合自 v1 的 ai_agent.py 和 ai_context.py · 改为 v8 风格 (用 get_current_account)

含:
  POST /api/v8/ai/agent/chat        多轮 Agent 对话 (tool calling)
  GET  /api/v8/ai/agent/tools       看可用 tools 列表
  GET  /api/v8/ai/agent/audit       管理员看审计日志
  GET  /api/v8/ai/agent/audit/stats 我的 AI 使用统计
  POST /api/v8/ai/agent/tool/{name} 直接调一个 tool (测试)
  GET  /api/v8/ai/context           LLM 决策上下文 (一次拿全)
  GET  /api/v8/ai/context/brief     简化版上下文 (省 token)
  POST /api/v8/chat/completions     OpenAI 兼容 LLM 入口
"""
from __future__ import annotations
import json
import logging
import os
import re
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from uuid import uuid4 as _uuid4

from platform_v8.api.deps import get_current_account
from platform_v8.core import Account

# import 时触发 perception 模块加载 → 3 个感知 tool 通过 @ai_tool 装饰器自动注册到 TOOL_REGISTRY
# (perception_query_metric / perception_snapshot / perception_anomalies)
# 任何 import 失败不应阻塞 ai router 启动 · 故包 try/except + warn
try:
    from platform_v8.services.ai import perception as _ai_perception  # noqa: F401
except Exception as _exc:
    logging.getLogger("v8.ai").warning("perception tools 注册失败 (3 个感知 tool 将不可用): %s", _exc)

logger = logging.getLogger("v8.ai")
router = APIRouter(prefix="/api/v8", tags=["v8-ai"])


def _role_str(account_or_role) -> str:
    """统一把 AccountRole enum / str / None 规范成小写字符串值.

    Python 3.11+ 起 str(AccountRole.ENTERPRISE) → 'AccountRole.ENTERPRISE' 而非 'enterprise'.
    用 .value 拿真实字符串 · 老调用方传 str 也兼容.
    """
    if account_or_role is None:
        return "personal"
    # Account dataclass · 拿 role 属性
    role = getattr(account_or_role, "role", account_or_role)
    if role is None:
        return "personal"
    # AccountRole(str, Enum) · 用 .value 拿小写
    val = getattr(role, "value", None)
    if val is not None:
        return str(val).lower()
    return str(role).lower()


# ════════════════════════════════════════════════════════════════════
# /api/v8/ai/agent/*
# ════════════════════════════════════════════════════════════════════
@router.get("/ai/agent/tools", summary="可用 AI tools 列表")
async def list_tools(current: Account = Depends(get_current_account)) -> dict:
    """看当前用户能调用的 tools"""
    from platform_v8.services.ai import tools as ai_tools
    user_role = _role_str(current)
    tools = ai_tools.get_tools_for_user(user_role)
    return {
        "user_id": current.id, "role": user_role,
        "total_available": len(tools),
        "tools": [t["function"] for t in tools],
    }


@router.post("/ai/agent/tool/{tool_name}", summary="直接调一个 tool (测试)")
async def invoke_tool(tool_name: str, request: Request,
                      current: Account = Depends(get_current_account)) -> dict:
    """直接调一个 tool (测试/调试用 · 正常走 chat endpoint)"""
    from platform_v8.services.ai import tools as ai_tools
    meta = ai_tools.TOOL_REGISTRY.get(tool_name)
    if not meta:
        raise HTTPException(404, f"tool '{tool_name}' not found")

    try:
        body = await request.json()
    except Exception:
        body = {}

    user_dict = {
        "id": int(current.id),
        "username": str(current.username),
        "role": _role_str(current),
        "balance": float(current.balance or 0),
    }
    return await meta["fn"](user_dict, body)


@router.post("/ai/pipeline/chat", summary="(v1 兼容) AI 管线 · 登录后强制 SSE")
async def pipeline_chat(request: Request, current: Account = Depends(get_current_account)):
    """兼容旧版前端的 SSE 地址，统一要求登录并走 Agent 路径。"""
    try:
        body = await request.json()
    except Exception:
        body = {}
    body["stream"] = True

    # request.json() 已缓存同一个 dict；原地设 stream 可供 agent_chat 再次读取。
    return await agent_chat(request, current)


@router.post("/ai/agent/chat", summary="多轮 Agent 对话 (含 tool calling)")
async def agent_chat(request: Request,
                     current: Account = Depends(get_current_account)):
    """多轮 Agent 对话 · 支持 LLM tool calling 闭环"""
    from platform_v8.services.ai import tools as ai_tools
    from platform_v8.services.ai.guard import guard_user_prompt, sanitize_output

    try:
        body = await request.json()
    except Exception:
        body = {}
    messages = list(body.get("messages") or [])
    if not messages:
        raise HTTPException(400, "messages required")
    model = str(body.get("model") or "deepseek-chat")
    max_turns = max(1, min(int(body.get("max_turns") or 5), 10))
    # 2026-05-27 · 前端 (web-portal / enterprise-portal) 发 stream=true 期待 SSE。
    # 后端需要包个最小 SSE 结果集·详见 return 处。
    stream_mode = bool(body.get("stream"))

    user_dict = {
        "id": int(current.id),
        "username": str(current.username),
        "role": _role_str(current),
        "balance": float(current.balance or 0),
    }

    # 1. Prompt injection 拦截
    last_user_msg = ""
    for m in reversed(messages):
        if m.get("role") == "user":
            last_user_msg = str(m.get("content", ""))
            break
    ok, err = guard_user_prompt(current.id, last_user_msg)
    if not ok:
        from platform_v8.api.errors import ErrorCode
        return {"ok": False, "error": err, "code": ErrorCode.PROMPT_INJECTION.value}

    # 2. 拉 AI context (感知层)
    context_summary = ""
    try:
        ctx = await _build_ai_context_brief(current)
        context_summary = json.dumps(ctx, ensure_ascii=False)[:2000]
    except Exception as e:
        logger.warning("ai_context failed: %s", e)

    # 3. 构造 system prompt
    sys_prompt = (
        f"你是千手 AI Agent · 帮助用户调度分布式算力 / 管理任务 / 查询状态。\n\n"
        f"当前用户: {user_dict['username']} (role={user_dict['role']}, balance={user_dict['balance']} EDG)\n"
        f"系统快照: {context_summary}\n\n"
        f"你可以使用工具来感知系统状态、派发任务、查询历史等。"
        f"工具调用是真实操作 · 高风险操作 (派发/取消) 需要让用户确认后再调。"
        f"回答简洁、有帮助 · 优先用中文 · 涉及数值/状态用具体数据。"
    )

    full_messages = [{"role": "system", "content": sys_prompt}] + messages
    tools = ai_tools.get_tools_for_user(user_dict["role"])

    # 4. 多轮 tool calling 循环
    tool_calls_executed = []
    final_text = ""
    for turn in range(max_turns):
        try:
            llm_resp = await _call_llm(full_messages, tools, model)
        except Exception as e:
            logger.exception("LLM call failed")
            from platform_v8.api.errors import ErrorCode
            return {"ok": False, "error": f"LLM 调用失败: {e}",
                    "code": ErrorCode.LLM_ERROR.value, "turns_done": turn}

        choice = (llm_resp.get("choices") or [{}])[0]
        msg = choice.get("message", {})
        tool_calls = msg.get("tool_calls") or []

        if not tool_calls:
            final_text = msg.get("content") or ""
            full_messages.append({"role": "assistant", "content": final_text})
            break

        full_messages.append({
            "role": "assistant",
            "content": msg.get("content") or "",
            "tool_calls": tool_calls,
        })

        for tc in tool_calls:
            fn = (tc.get("function") or {})
            tname = fn.get("name", "")
            try:
                targs = json.loads(fn.get("arguments") or "{}")
            except Exception:
                targs = {}
            meta = ai_tools.TOOL_REGISTRY.get(tname)
            if not meta:
                tresult = {"ok": False, "error": f"unknown tool {tname}"}
            else:
                tresult = await meta["fn"](user_dict, targs, session_id=f"chat-{turn}")
            tool_calls_executed.append({
                "tool": tname, "args": targs, "result": tresult,
            })
            full_messages.append({
                "role": "tool",
                "tool_call_id": tc.get("id", ""),
                "name": tname,
                "content": json.dumps(tresult, ensure_ascii=False)[:4000],
            })

    final_text = sanitize_output(final_text)
    result_dict = {
        "ok": True,
        "message": final_text,
        "tools_called": tool_calls_executed,
        "turns_used": len(tool_calls_executed) if tool_calls_executed else 1,
        "model": model,
        "interaction_id": _uuid4().hex,
    }

    # 2026-05-27 · stream=true · 包为最小 SSE 结果集
    # 两个前端解析器(web-portal/useAIChat.ts + enterprise-portal/aiPipelineService.ts)都走
    #   data: {"content": "...", "interaction_id": "..."}\n\n  +  data: [DONE]\n\n
    # 后端不唯真流(调 LLM 已同步跑完) · 仅解决 'AI 不回复' 问题
    if stream_mode:
        async def emit_sse():
            chunk = {
                "stage": "done",
                "content": result_dict["message"],
                "interaction_id": result_dict["interaction_id"],
                "tools_called": result_dict["tools_called"],
                "turns_used": result_dict["turns_used"],
                "model": result_dict["model"],
            }
            yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
            yield "event: done\ndata: [DONE]\n\n"
        return StreamingResponse(
            emit_sse(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )
    return result_dict


@router.get("/ai/agent/audit/stats", summary="我的 AI 使用统计")
async def my_audit_stats(days: int = 7,
                         current: Account = Depends(get_current_account)) -> dict:
    from platform_v8.services.ai import audit as ai_audit
    return ai_audit.stats_by_user(user_id=int(current.id), days=max(1, min(days, 90)))


@router.get("/ai/agent/audit", summary="审计日志查询 (admin 看全部·其他人看自己)")
async def list_audit(limit: int = 50, tool_name: str = "", risk_level: str = "",
                     current: Account = Depends(get_current_account)) -> dict:
    from platform_v8.services.ai import audit as ai_audit
    user_role = _role_str(current)
    filter_user_id = None if user_role == "admin" else int(current.id)
    items = ai_audit.query_audit(
        user_id=filter_user_id,
        tool_name=tool_name or None,
        risk_level=risk_level or None,
        limit=max(1, min(limit, 200)),
    )
    return {"count": len(items), "items": items,
            "scope": "all" if user_role == "admin" else "self"}


# ════════════════════════════════════════════════════════════════════
# /api/v8/ai/context · LLM 决策上下文
# ════════════════════════════════════════════════════════════════════
@router.get("/ai/context", summary="LLM 决策上下文 (一次拿全)")
async def get_ai_context(current: Account = Depends(get_current_account)) -> dict[str, Any]:
    return await _build_ai_context(current)


@router.get("/ai/context/brief", summary="简化版上下文 (省 token)")
async def get_ai_context_brief(current: Account = Depends(get_current_account)) -> dict[str, Any]:
    return await _build_ai_context_brief(current)


async def _build_ai_context(account: Account) -> dict[str, Any]:
    """构造完整 AI context (v8 数据源)"""
    from platform_v8.storage.db import session_scope
    from sqlalchemy import text as _t

    user_info = {
        "id": int(account.id),
        "username": str(account.username),
        "email": str(account.email or ""),
        "balance": float(account.balance or 0),
        "total_earnings": float(getattr(account, "total_earnings", 0) or 0),
        "status": str(account.status or "active"),
    }

    nodes_online: list[dict[str, Any]] = []
    nodes_offline: list[dict[str, Any]] = []
    pending = running = completed_today = failed_today = 0
    skills_summary: dict[str, Any] = {}

    try:
        with session_scope() as s:
            online_cutoff = datetime.utcnow() - timedelta(seconds=60)
            # Ordinary accounts may see their own device inventory only.
            # The old unfiltered query exposed every contributor's hardware.
            owner_filter = "" if account.is_admin else "WHERE owner_id = :owner_id"
            rows = s.execute(_t(f"""
                SELECT id, name, status,
                       (capabilities->>'cpu_cores')::int AS cpu_cores,
                       (capabilities->>'memory_gb')::float AS memory_gb,
                       capabilities->>'tier' AS tier,
                       capabilities->>'cpu_brand' AS cpu_brand,
                       capabilities->>'gpu_vendor' AS gpu_vendor,
                       capabilities->>'gpu_model' AS gpu_model,
                       load, last_seen
                FROM we_workers
                {owner_filter}
            """), {} if account.is_admin else {"owner_id": int(account.id)}).fetchall()
            for r in rows:
                is_online = (r[2] == "ONLINE" and r[10] and r[10] >= online_cutoff)
                item = {
                    "id": str(r[0]), "name": r[1] or "",
                    "tier": r[5] or "basic",
                    "cpu_brand": r[6] or "",
                    "cpu_cores": int(r[3] or 0),
                    "memory_gb": float(r[4] or 0),
                    "gpu_vendor": r[7] or "none",
                    "gpu_model": r[8] or "",
                    "load_rate": float(r[9] or 0),
                }
                (nodes_online if is_online else nodes_offline).append(item)
    except Exception as e:
        logger.warning("v8 nodes query failed: %s", e)

    try:
        today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        with session_scope() as s:
            pending = s.execute(_t(
                "SELECT COUNT(*) FROM we_workloads WHERE status IN ('CREATED','PLANNED','WAITING_FOR_WORKERS')"
            )).scalar() or 0
            running = s.execute(_t(
                "SELECT COUNT(*) FROM we_workloads WHERE status IN ('RUNNING','AGGREGATING')"
            )).scalar() or 0
            completed_today = s.execute(_t(
                "SELECT COUNT(*) FROM we_workloads WHERE status='DONE' AND created_at >= :t"
            ), {"t": today_start}).scalar() or 0
            failed_today = s.execute(_t(
                "SELECT COUNT(*) FROM we_workloads WHERE status='FAILED' AND created_at >= :t"
            ), {"t": today_start}).scalar() or 0
    except Exception as e:
        logger.debug("task stats failed: %s", e)

    try:
        with session_scope() as s:
            rows = s.execute(_t("""
                SELECT task_type, spec->>'tier' AS tier FROM we_templates LIMIT 100
            """)).fetchall()
            all_types = [r[0] for r in rows]
            by_tier: dict[str, int] = {}
            for r in rows:
                t = r[1] or "basic"
                by_tier[t] = by_tier.get(t, 0) + 1
            skills_summary = {
                "total": len(all_types),
                "by_tier": by_tier,
                "all_types": sorted(set(all_types)),
            }
    except Exception as e:
        logger.debug("skills failed: %s", e)

    rewards_summary: dict[str, Any] = {}
    try:
        with session_scope() as s:
            row = s.execute(_t("""
                SELECT COALESCE(SUM(amount), 0), COUNT(*)
                FROM we_ledger WHERE account_id = :uid AND amount > 0
            """), {"uid": int(account.id)}).fetchone()
            if row:
                rewards_summary = {
                    "total_earnings_edg": float(row[0] or 0),
                    "transaction_count": int(row[1] or 0),
                }
    except Exception:
        pass

    return {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "user": user_info,
        "nodes": {
            "online": nodes_online,
            "offline": nodes_offline,
            "total": len(nodes_online) + len(nodes_offline),
            "online_count": len(nodes_online),
        },
        "tasks": {
            "pending": pending,
            "running": running,
            "completed_today": completed_today,
            "failed_today": failed_today,
        },
        "skills": skills_summary,
        "engine": {"mode": "v8", "available": True, "dispatcher": "v8.broker"},
        "rewards_summary": rewards_summary,
    }


async def _build_ai_context_brief(account: Account) -> dict[str, Any]:
    full = await _build_ai_context(account)
    online = full["nodes"]["online"]
    return {
        "system": {
            "online_nodes": len(online),
            "total_nodes": full["nodes"]["total"],
            "best_node": (
                {"id": online[0]["id"], "tier": online[0]["tier"],
                 "cpu_brand": online[0]["cpu_brand"]}
                if online else None
            ),
            "pending_tasks": full["tasks"]["pending"],
            "running_tasks": full["tasks"]["running"],
            "completed_today": full["tasks"]["completed_today"],
        },
        "user": {
            "balance_edg": full["user"]["balance"],
            "username": full["user"]["username"],
        },
        "available_skills": full["skills"].get("all_types", []),
        "skills_count": full["skills"].get("total", 0),
        "tier_distribution": full["skills"].get("by_tier", {}),
    }


# ════════════════════════════════════════════════════════════════════
# /api/v8/chat/completions · OpenAI 兼容 LLM 入口 (透明转发到 deepseek)
# ════════════════════════════════════════════════════════════════════
@router.post("/chat/completions", summary="OpenAI 兼容 LLM 入口")
async def chat_completions(request: Request,
                           current: Account = Depends(get_current_account)) -> dict:
    """前端 enterprise-client ChatPage 直接调 LLM (不走 agent tool calling)"""
    try:
        body = await request.json()
    except Exception:
        body = {}
    messages = body.get("messages") or []
    if not messages:
        raise HTTPException(400, "messages required")
    model = str(body.get("model") or "deepseek-chat")
    resp = await _call_llm(messages, tools=None, model=model)
    return resp


# ════════════════════════════════════════════════════════════════════
# LLM 调用 (DeepSeek)
# ════════════════════════════════════════════════════════════════════
# 2026-05-27 · 前端 (web-portal/enterprise-portal) 老 bundle 用 ec-* 命名 ·
# DeepSeek 不认 · 在 _call_llm 入口统一 alias 到真模型名
_MODEL_ALIAS = {
    "ec-pipeline": "deepseek-chat",
    "ec-master": "deepseek-chat",
    "ec-orchestra": "deepseek-chat",
    "ec-pro": "deepseek-reasoner",
    "ec-creative": "deepseek-chat",
    "ec-light": "deepseek-chat",
    "hermes": "deepseek-chat",
}


async def _call_llm(messages, tools, model="deepseek-chat"):
    import httpx
    model = _MODEL_ALIAS.get(model, model)
    trust_env = os.environ.get("AI_HTTP_TRUST_ENV", "true").strip().lower() not in {
        "0", "false", "no", "off",
    }
    api_key = (
        os.environ.get("AI_SCRIPT_API_KEY")
        or os.environ.get("DEEPSEEK_API_KEY")
        or os.environ.get("OPENAI_API_KEY", "")
    )
    base_url = (
        os.environ.get("AI_SCRIPT_BASE_URL")
        or os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1")
    )
    payload: dict = {
        "model": model,
        "messages": messages,
        "max_tokens": 2000,
        "temperature": 0.3,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    async with httpx.AsyncClient(timeout=45, trust_env=trust_env) as cli:
        r = await cli.post(f"{base_url}/chat/completions", json=payload, headers=headers)
        r.raise_for_status()
        return r.json()


# ════════════════════════════════════════════════════════════════════
# /api/v1/* · OpenAI 兼容入口 (节点 task_scripts llm_chat/llm_extract/embedding 调用)
# 2026-06-01 · 之前缺失 → 这些 AI 任务调 /api/v1/* 得 404 失败。
#   现加 JSON(非SSE) + 每 IP 限流(控 DeepSeek 成本·默认 60/小时/IP·AI_SCRIPT_RATE_MAX 可调)。
#   embeddings: DeepSeek 无该能力 · 配了 AI_EMBED_BASE_URL 才转发 · 否则 501 明确提示(不再 404)。
# 2026-09-18 · C-1 安全修复：本入口此前**完全免鉴权**（与 /api/v8/chat/completions 同功能却
#   无 Depends）→ 任何人可拿平台密钥白嫖 LLM。现两个端点都要求 get_current_account
#   （与 v8 同一套依赖：v8 access token / v1 老 token / 开发者 qs_* API Key 三选一）。
#   节点脚本的凭据由派发层注入 params["api_key"]（见 engine/assignment_payload.py
#   inject_platform_relay_credential），不在仓库里硬编码明文。
# ════════════════════════════════════════════════════════════════════
v1_router = APIRouter(prefix="/api/v1", tags=["v1-openai-compat"])

_V1_RL: dict[str, list] = {}
_V1_RL_WINDOW = 3600
_V1_RL_MAX = int(os.environ.get("AI_SCRIPT_RATE_MAX", "60"))


def _v1_rate_limited(ip: str) -> bool:
    import time as _t
    now = _t.time()
    arr = _V1_RL.setdefault(ip, [])
    while arr and arr[0] < now - _V1_RL_WINDOW:
        arr.pop(0)
    if len(arr) >= _V1_RL_MAX:
        return True
    arr.append(now)
    return False


def _v1_header_ip(value: str | None) -> str:
    """取 X-Real-IP 的单个地址 · 空值/畸形值返回 ""。

    只接受「单个地址」，不接受逗号链：nginx 用 $remote_addr 覆写该头，
    任何客户端自带的逗号链都会被覆写掉；此处再拒绝链式输入，
    保证即使上游配置退化成追加模式也不会把伪造值当键。
    """
    raw = str(value or "").strip()
    if not raw or "," in raw:
        return ""
    if len(raw) > 45:  # IPv6 最长 45 字符 · 超长一律视为畸形
        return ""
    if not re.fullmatch(r"[0-9A-Fa-f:.]+", raw):
        return ""
    return raw


def _v1_client_ip(request: Request, account_id: int | None = None) -> str:
    """限流键来源 · 必须可信。

    2026-09-18 安全修复 (C-1 放大器)：
      旧实现取 ``X-Forwarded-For`` 的**首值**做限流键，而 nginx 在该 location 下
      用 ``$proxy_add_x_forwarded_for`` 追加 → 客户端可自带
      ``X-Forwarded-For: <随机IP>``，每请求换一个假 IP 即绕过 60/小时护栏。
      实测：70 次带伪造 XFF 的请求全部 200。

    现改为：
      1. 只信 nginx 用 ``$remote_addr`` **覆写**的 ``X-Real-IP``（单值 · 客户端无法伪造）；
      2. 退回 TCP 对端 ``request.client.host``（本机直连 uvicorn 时即真实对端）；
      3. 限流键带 account_id 前缀 → 一个账号耗尽配额不会连带影响其他账号。
    """
    ip = _v1_header_ip(request.headers.get("x-real-ip"))
    if not ip:
        ip = request.client.host if request.client else "?"
    if account_id is None:
        return ip
    return f"acct{account_id}:{ip}"


@v1_router.post("/chat/completions", summary="OpenAI 兼容 chat · 节点 AI 脚本用 · JSON · 每IP限流")
async def v1_chat_completions(request: Request,
                              current: Account = Depends(get_current_account)) -> dict:
    ip = _v1_client_ip(request, current.id)
    if _v1_rate_limited(ip):
        raise HTTPException(429, "AI 调用超过每小时上限 · 请稍后再试")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "invalid json")
    messages = body.get("messages") or []
    if not messages:
        raise HTTPException(400, "messages required")
    model = str(body.get("model") or "deepseek-chat")
    try:
        return await _call_llm(messages, tools=None, model=model)
    except Exception as e:
        raise HTTPException(502, f"upstream LLM error: {str(e)[:140]}")


@v1_router.post("/embeddings", summary="OpenAI 兼容 embeddings · 需配 AI_EMBED_BASE_URL 供应商")
async def v1_embeddings(request: Request,
                        current: Account = Depends(get_current_account)) -> dict:
    ip = _v1_client_ip(request, current.id)
    if _v1_rate_limited(ip):
        raise HTTPException(429, "调用超过每小时上限")
    base = os.environ.get("AI_EMBED_BASE_URL")
    key = os.environ.get("AI_EMBED_API_KEY", "")
    if not base:
        raise HTTPException(501, "embedding 供应商未配置 (需设 AI_EMBED_BASE_URL / AI_EMBED_API_KEY)")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "invalid json")
    import httpx
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    async with httpx.AsyncClient(timeout=45) as cli:
        r = await cli.post(f"{base.rstrip('/')}/embeddings", json=body, headers=headers)
        r.raise_for_status()
        return r.json()
