"""AI 工具中央注册 (V2)

每个 tool 是一个 async 函数 · 带:
  - JSON Schema (供 LLM 看 · OpenAI tool calling 标准)
  - 权限矩阵 (roles + risk_level)
  - 审计 (自动写 we_audit)
  - 速率限制
  - 沙箱执行
"""
from __future__ import annotations
import logging
import time
from functools import wraps
from typing import Any, Callable, Awaitable

from . import audit as ai_audit
from . import guard as ai_guard


# ─────────────────────────────────────────────────────
# v8 兼容层: 代替 v1 persistence.get_repository
# 让原代码里 `_gr() / repo._session_factory` 能照跳
# ─────────────────────────────────────────────────────
class _V8RepoShim:
    """仿 persistence.Repository 接口· 让上层 ai_tools 代码不需要改"""
    _ready = True

    @property
    def _session_factory(self):
        from platform_v8.storage.db import session_scope
        # session_scope() 返一个 context manager· 原代码用法 `with sf() as s:` 能准
        # 这里返 callable· 会被调 · 调后返一个 context manager
        return session_scope


_v8_repo_shim = _V8RepoShim()


def _get_repo_v8():
    """v1 persistence.get_repository() 的 v8 替代"""
    return _v8_repo_shim

logger = logging.getLogger("backend.ai_tools")


# ─────────────────────────────────────────────────────
# 工具注册表
# ─────────────────────────────────────────────────────
TOOL_REGISTRY: dict[str, dict] = {}


def ai_tool(
    name: str,
    *,
    description: str = "",
    risk: str = "low",
    roles: list[str] | None = None,
    schema: dict | None = None,
):
    """装饰器: 注册一个 AI 工具

    用法:
        @ai_tool("query_nodes", description="查在线节点", risk="low")
        async def query_nodes(user, args):
            ...
    """
    def deco(fn: Callable[..., Awaitable[Any]]):
        @wraps(fn)
        async def wrapper(user: dict, args: dict, **ctx) -> dict:
            t0 = time.time()
            user_id = int(user.get("id", 0) or 0)
            user_role = str(user.get("role", "")).lower()
            user_balance = float(user.get("balance", 0) or 0)
            session_id = str(ctx.get("session_id", ""))

            # 1. 综合 guard
            allow, err, risk_lvl = ai_guard.guard_tool_call(
                user_id=user_id, user_role=user_role,
                user_balance=user_balance, tool_name=name, args=args,
            )
            if not allow:
                ai_audit.log_audit(
                    user_id=user_id, role=user_role, session_id=session_id,
                    tool_name=name, args=args, ok=False,
                    error_code="guard_blocked", error_msg=err,
                    latency_ms=int((time.time()-t0)*1000), risk_level=risk_lvl,
                )
                from platform_v8.api.errors import ErrorCode
                return {"ok": False, "error": err, "code": ErrorCode.GUARD_BLOCKED.value}

            # 2. 沙箱执行
            try:
                result = await fn(user, args)
                ok, err_code, err_msg = True, None, None
            except PermissionError as exc:
                result, ok, err_code, err_msg = None, False, "permission", str(exc)
            except ValueError as exc:
                result, ok, err_code, err_msg = None, False, "bad_args", str(exc)
            except Exception as exc:
                result, ok, err_code, err_msg = None, False, "internal", str(exc)
                logger.exception("[ai_tool:%s] crashed", name)

            elapsed = int((time.time()-t0)*1000)

            # 3. 审计
            ai_audit.log_audit(
                user_id=user_id, role=user_role, session_id=session_id,
                tool_name=name, args=args, result=result, ok=ok,
                error_code=err_code, error_msg=err_msg,
                latency_ms=elapsed, risk_level=risk_lvl,
            )

            return {"ok": ok, "result": result, "error": err_msg, "code": err_code,
                    "latency_ms": elapsed}

        # 注册
        TOOL_REGISTRY[name] = {
            "fn": wrapper,
            "name": name,
            "description": description or (fn.__doc__ or "").strip().split("\n")[0],
            "risk": risk,
            "roles": roles or [],
            "schema": schema or {},
        }
        return wrapper
    return deco


def get_openai_schema_for_all() -> list[dict]:
    """生成给 LLM 看的工具 schema 列表 (OpenAI tool calling 标准)"""
    out = []
    for meta in TOOL_REGISTRY.values():
        if meta["schema"]:
            out.append({
                "type": "function",
                "function": {
                    "name": meta["name"],
                    "description": meta["description"],
                    "parameters": meta["schema"],
                },
            })
    return out


def get_tools_for_user(user_role: str) -> list[dict]:
    """根据用户角色返回 ta 能调用的工具 schema"""
    role_order = {"personal": 0, "enterprise": 1, "channel": 1, "admin": 99}
    user_level = role_order.get(user_role, 0)
    out = []
    for meta in TOOL_REGISTRY.values():
        # admin 通吃
        if user_role == "admin":
            pass
        # 工具未限制角色 = 所有人可用
        elif not meta["roles"]:
            pass
        # 工具限角色 · 检查
        elif user_role not in meta["roles"]:
            continue
        if meta["schema"]:
            out.append({
                "type": "function",
                "function": {
                    "name": meta["name"],
                    "description": meta["description"],
                    "parameters": meta["schema"],
                },
            })
    return out


# ═════════════════════════════════════════════════════
# 8 个核心 tools 注册
# ═════════════════════════════════════════════════════

@ai_tool(
    name="query_nodes",
    description="查询在线节点总数和本人节点的硬件能力",
    risk="low",
    schema={"type": "object", "properties": {}},
)
async def query_nodes(user, args):
    """所有用户可调 · 全局只返回汇总，本人节点可看设备画像。"""
    try:
        from sqlalchemy import text as _t
        repo = _get_repo_v8()
        sf = repo._session_factory
        with sf() as s:
            # Device IDs, software inventory and exact hardware are owner data.
            # Use the same ONLINE/BUSY freshness cutoff for aggregate and own list.
            totals = s.execute(_t("""
                SELECT status, COUNT(*)
                  FROM we_workers
                 WHERE status IN ('ONLINE', 'BUSY')
                   AND last_seen > NOW() - INTERVAL '60 seconds'
                 GROUP BY status
            """)).fetchall()
            rows = s.execute(_t("""
                SELECT id, name, status,
                       (capabilities->>'cpu_cores')::int AS cpu_cores,
                       (capabilities->>'memory_gb')::float AS memory_gb,
                       capabilities->>'tier' AS tier,
                       capabilities->>'os' AS cpu,
                       capabilities->'accelerators' AS accs,
                       load
                  FROM we_workers
                 WHERE status IN ('ONLINE', 'BUSY')
                   AND last_seen > NOW() - INTERVAL '60 seconds'
                   AND owner_id = :owner_id
                 ORDER BY last_seen DESC
                 LIMIT 20
            """), {"owner_id": int(user.get("id") or 0)}).fetchall()
        by_status = {str(status): int(count) for status, count in totals}
        return {
            "source": "v8",
            "total_online": sum(by_status.values()),
            "available": by_status.get("ONLINE", 0),
            "busy": by_status.get("BUSY", 0),
            "nodes": [{
                "id": str(r[0]),
                "name": r[1] or (str(r[0]) or "")[:8] + "***",
                "cpu_cores": r[3] or 0, "memory_gb": r[4] or 0,
                "tier": r[5] or "basic", "cpu": r[6] or "unknown",
                "accelerators": r[7] if isinstance(r[7], list) else [],
                "load_rate": float(r[8] or 0),
            } for r in rows],
        }
    except Exception as e:
        return {"nodes": [], "error": str(e)}


@ai_tool(
    name="query_my_tasks",
    description="查询当前用户的任务历史 (最近 N 条)",
    risk="low",
    schema={
        "type": "object",
        "properties": {
            "limit": {"type": "integer", "default": 10, "description": "返回数量 · 默认 10"},
            "status": {"type": "string", "enum": ["all", "completed", "failed", "running"]},
        },
    },
)
async def query_my_tasks(user, args):
    """仅返回当前用户自己的任务 (we_workloads · admin 看全部)"""
    try:
        from sqlalchemy import text as _t
        repo = _get_repo_v8()
        sf = repo._session_factory
        user_id = int(user.get("id", 0) or 0)
        if user_id <= 0:
            return {"items": [], "error": "no user context"}
        limit = max(1, min(int(args.get("limit", 10)), 50))
        status_filter = str(args.get("status", "all")).lower()
        is_admin = str(user.get("role", "")).lower() in ("admin", "superadmin")

        where = ""
        params: dict = {"lim": limit}
        if not is_admin:
            where += " AND owner_id = :uid"
            params["uid"] = user_id
        if status_filter != "all":
            st_map = {"completed": "DONE", "failed": "FAILED", "running": "RUNNING"}
            params["st"] = st_map.get(status_filter, status_filter.upper())
            where += " AND status = :st"

        with sf() as s:
            rows = s.execute(_t(f"""
                SELECT id, name, (spec->>'task_type') AS type,
                       status, progress, created_at
                  FROM we_workloads
                 WHERE 1=1 {where}
                 ORDER BY created_at DESC
                 LIMIT :lim
            """), params).fetchall()
        return {
            "source": "v8",
            "count": len(rows),
            "scope": "all (admin)" if is_admin else f"owner aid={user_id}",
            "items": [{
                "id": str(r[0]), "name": r[1], "type": r[2], "status": r[3],
                "progress": float(r[4] or 0),
                "created_at": r[5].isoformat() if r[5] else None,
            } for r in rows],
        }
    except Exception as e:
        return {"items": [], "error": str(e)}


@ai_tool(
    name="get_user_balance",
    description="查当前用户的 EDG 余额 + 本月消费",
    risk="low",
    schema={"type": "object", "properties": {}},
)
async def get_user_balance(user, args):
    # 2026-05-18 v8 收口 · 优先读 we_accounts 实时余额 (不是 token 里的旧值)
    try:
        from sqlalchemy import text as _t
        repo = _get_repo_v8()
        if True:
            uid = int(user.get("id", 0) or 0)
            if uid > 0:
                with repo._session_factory() as s:
                    row = s.execute(_t("""
                        SELECT username, balance, role FROM we_accounts WHERE id = :uid
                    """), {"uid": uid}).fetchone()
                    if row:
                        return {
                            "source": "v8",
                            "user_id": uid,
                            "username": row[0],
                            "balance_edg": float(row[1] or 0),
                            "role": row[2],
                        }
    except Exception:
        pass
    # fallback token
    return {
        "source": "token",
        "user_id": user.get("id"),
        "username": user.get("username"),
        "balance_edg": float(user.get("balance", 0)),
        "role": user.get("role"),
    }


@ai_tool(
    name="query_my_rewards",
    description="查节点拥有者的累计收益 (本月/今日/累计)",
    risk="low",
    schema={"type": "object", "properties": {}},
)
async def query_my_rewards(user, args):
    # v8: 从 we_ledger 汇总用户节点收益
    try:
        from platform_v8.storage.db import session_scope
        from sqlalchemy import text as _t
        uid = int(user.get("id", 0) or 0)
        if uid <= 0:
            return {"summary": {}, "items": []}
        with session_scope() as s:
            row = s.execute(_t("""
                SELECT
                  COALESCE(SUM(amount), 0) AS total,
                  COUNT(*) AS count
                FROM we_ledger
                WHERE account_id = :uid AND amount > 0
            """), {"uid": uid}).fetchone()
        return {
            "source": "v8",
            "summary": {
                "total_earnings_edg": float(row[0] or 0) if row else 0,
                "transaction_count": int(row[1] or 0) if row else 0,
            },
        }
    except Exception as e:
        return {"summary": {}, "error": str(e)}


@ai_tool(
    name="submit_task",
    description="派发一个分布式算力任务 · 仅 enterprise+ · 需提供 task_type + 预算 (EDG)",
    risk="mid",
    roles=["enterprise", "channel", "admin"],
    schema={
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "任务名 (可选 · 默认 AI-<type>-<ts>)"},
            "task_type": {"type": "string", "description": "如 word_count / dedup_lines / llm_chat / image_resize · 看 query_skills"},
            "params": {"type": "object", "description": "任务参数 dict"},
            "inline_input": {"type": "string", "description": "输入文本 (默认为空)"},
            "input_url": {"type": "string", "description": "输入 URL (与 inline_input 二选一)"},
            "max_shards": {"type": "integer", "default": 1, "description": "最大分片数"},
            "timeout_s": {"type": "integer", "default": 60, "description": "超时秒数"},
            "budget": {"type": "string", "description": "预算 EDG (字符串 · 默认 1.0)"},
            "dry_run": {"type": "boolean", "description": "只返回 payload 不真提交"},
        },
        "required": ["task_type"],
    },
)
async def submit_task(user, args):
    """真实派发任务 — in-process httpx 调本机 POST /api/v8/workloads · 走完整链路 (扣费 + 调度 + 节点 pull)

    v8 重写 (2026-05-24): 从 v1 /api/v1/tasks 迁移到 /api/v8/workloads · 令 AI 真正能派任务。
    """
    import os
    import httpx

    user_id = int(user.get("id", 0) or 0)
    user_role = str(user.get("role", "personal"))
    if user_id <= 0:
        return {"ok": False, "error": "no user context"}

    # 签 5 分钟 v8 agent token (in-process 调本机 backend)
    try:
        from platform_v8.services.auth.token import _sign as v8_sign
        short_token = v8_sign(
            account_id=user_id, role=user_role,
            kind="access", ttl_s=300,
        )
    except Exception as exc:
        return {"ok": False, "error": f"v8 token 签发失败: {exc}"}

    task_type = str(args.get("task_type") or args.get("type") or "").strip()
    if not task_type:
        return {"ok": False, "error": "task_type 必填 (如 word_count / llm_chat / dedup_lines)"}

    # 构 v8 SubmitWorkloadRequest
    spec: dict = {
        "kind": str(args.get("kind") or "DATA_PROCESSING"),
        "task_type": task_type,
        "runtime": str(args.get("runtime") or "python3"),
        "max_shards": int(args.get("max_shards") or 1),
        "redundancy_factor": int(args.get("redundancy_factor") or 1),
        "timeout_s": int(args.get("timeout_s") or 60),
        "params": args.get("params") or {},
        "requirements": args.get("requirements") or {},
    }
    # input 默认为 inline (LLM 容易造) · 允许透传 code_url / input_url
    if args.get("inline_input") is not None:
        spec["input_kind"] = "inline"
        spec["inline_input"] = str(args["inline_input"])
    elif args.get("input_url"):
        spec["input_kind"] = "url"
        spec["input_url"] = str(args["input_url"])
    else:
        spec["input_kind"] = "inline"
        spec["inline_input"] = ""

    if args.get("code_url"):
        spec["code_url"] = str(args["code_url"])
    else:
        spec["code_url"] = f"https://www.qianshousuanli.com/api/v8/scripts/{task_type}.py"

    payload = {
        "name": str(args.get("name") or f"AI-{task_type}-{int(time.time())}"),
        "spec": spec,
        "budget": str(args.get("budget") or "1.0"),
    }

    if args.get("dry_run"):
        return {"ok": True, "dry_run": True, "would_submit": payload}

    base = os.environ.get("BACKEND_INTERNAL_URL", "http://127.0.0.1:8000")
    url = f"{base}/api/v8/workloads"
    headers = {
        "Authorization": f"Bearer {short_token}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=15) as cli:
            r = await cli.post(url, json=payload, headers=headers)
            if r.status_code >= 400:
                return {
                    "ok": False,
                    "http_status": r.status_code,
                    "error": r.text[:400],
                    "would_submit": payload,
                }
            data = r.json()
            return {
                "ok": True,
                "task_id": data.get("id"),
                "task_name": data.get("name"),
                "status": data.get("status"),
                "created_at": data.get("created_at"),
                "message": f"任务 {data.get('id')} 已派发 · 节点会在 5s 内拉取 · 用 query_my_tasks 看进度",
            }
    except Exception as exc:
        return {"ok": False, "error": f"submit failed: {exc}", "would_submit": payload}


@ai_tool(
    name="cancel_task",
    description="取消某个任务 · 仅可取消自己派的且未完成的 · task_id 为 UUID 字符串",
    risk="mid",
    roles=["enterprise", "channel", "admin"],
    schema={
        "type": "object",
        "properties": {
            "task_id": {"type": "string", "description": "任务 UUID (从 query_my_tasks 拿)"},
        },
        "required": ["task_id"],
    },
)
async def cancel_task(user, args):
    """真实取消任务 — in-process httpx 调本机 DELETE /api/v8/workloads/{uuid}

    v8 重写 (2026-05-24): 从 v1 /api/v1/tasks/{int} 迁移到 /api/v8/workloads/{uuid}。
    """
    import os
    import httpx

    user_id = int(user.get("id", 0) or 0)
    user_role = str(user.get("role", "personal"))
    task_id = args.get("task_id") or args.get("workload_id")
    if user_id <= 0 or not task_id:
        return {"ok": False, "error": "user_id 或 task_id 缺失"}

    try:
        from platform_v8.services.auth.token import _sign as v8_sign
        short_token = v8_sign(
            account_id=user_id, role=user_role,
            kind="access", ttl_s=300,
        )
    except Exception as exc:
        return {"ok": False, "error": f"v8 token 签发失败: {exc}"}

    base = os.environ.get("BACKEND_INTERNAL_URL", "http://127.0.0.1:8000")
    url = f"{base}/api/v8/workloads/{task_id}"
    headers = {"Authorization": f"Bearer {short_token}"}

    try:
        async with httpx.AsyncClient(timeout=10) as cli:
            r = await cli.delete(url, headers=headers)
            if r.status_code >= 400:
                return {"ok": False, "http_status": r.status_code, "error": r.text[:300]}
            data = r.json() if r.text else {}
            return {
                "ok": True,
                "task_id": task_id,
                "cancelled": True,
                "new_status": data.get("status"),
                "message": f"任务 {task_id} 已取消 · 退还未结算余额",
            }
    except Exception as exc:
        return {"ok": False, "error": f"cancel failed: {exc}"}


@ai_tool(
    name="query_skills",
    description=(
        "查询平台可用脚本/技能 (从 we_script_catalog 读 active 脚本 · 当前 64 个)。"
        "可按 category 过滤 (ai/text/image/data/crypto/video/audio/doc/net/encoding/render/ocr/general) "
        "或 search 模糊搜索 task_type/name/description。"
    ),
    risk="low",
    schema={
        "type": "object",
        "properties": {
            "category": {
                "type": "string",
                "description": "分类过滤 · ai/text/image/data/crypto/video/audio/doc/net/encoding/render/ocr/general",
            },
            "search": {"type": "string", "description": "在 task_type/name/description 中模糊匹配"},
            "limit": {"type": "integer", "default": 30, "description": "返回数量上限 · 默认 30"},
        },
    },
)
async def query_skills(user, args):
    """v8 重写 (2026-05-24): 改读 we_script_catalog · 让 LLM 看到 64 个真实可用脚本"""
    try:
        from platform_v8.storage.db import session_scope
        from sqlalchemy import text as _t

        category_filter = (args.get("category") or "").strip() or None
        search = (args.get("search") or "").strip().lower()
        limit = int(args.get("limit") or 30)
        limit = max(1, min(limit, 100))

        params: dict = {}
        where = ["status = 'active'"]
        if category_filter:
            where.append("category = :cat")
            params["cat"] = category_filter
        if search:
            where.append("(LOWER(task_type) LIKE :q OR LOWER(name) LIKE :q OR LOWER(description) LIKE :q)")
            params["q"] = f"%{search}%"
        params["lim"] = limit

        items: list[dict] = []
        by_category: dict[str, int] = {}
        total = 0
        with session_scope() as s:
            # 总数 + 分类分布 (永远全 catalog 维度 · 让 LLM 知道全局)
            for row in s.execute(_t("""
                SELECT category, COUNT(*) FROM we_script_catalog
                WHERE status='active' GROUP BY category ORDER BY 2 DESC
            """)).fetchall():
                by_category[row[0]] = int(row[1])
            total = sum(by_category.values())

            # 过滤后的样本
            rows = s.execute(_t(f"""
                SELECT task_type, name, category, description, tags, used_count
                FROM we_script_catalog
                WHERE {' AND '.join(where)}
                ORDER BY used_count DESC, task_type
                LIMIT :lim
            """), params).fetchall()
            for r in rows:
                items.append({
                    "task_type": r[0],
                    "name": r[1],
                    "category": r[2],
                    "description": (r[3] or "")[:200],
                    "tags": list(r[4] or []),
                    "used_count": int(r[5] or 0),
                })

        return {
            "total_active": total,
            "by_category": by_category,
            "filter": {"category": category_filter, "search": search or None},
            "returned": len(items),
            "items": items,
            "hint": "用 submit_task 提交 · task_type 字段填上面 items 的 task_type",
        }
    except Exception as e:
        return {"items": [], "total_active": 0, "by_category": {}, "error": str(e)}


@ai_tool(
    name="get_system_status",
    description="拉系统完整状态快照 (节点 + 任务 + 余额 + 技能)",
    risk="low",
    schema={"type": "object", "properties": {}},
)
async def get_system_status(user, args):
    nodes = await query_nodes(user, {})
    tasks = await query_my_tasks(user, {"limit": 5})
    bal = await get_user_balance(user, {})
    skills = await query_skills(user, {})
    return {
        "nodes_online": nodes.get("result", nodes).get("total_online", 0),
        "recent_tasks": tasks.get("result", tasks).get("items", [])[:3],
        "balance": bal.get("result", bal).get("balance_edg", 0),
        "skills_total": skills.get("result", skills).get("total", 0),
    }


# 启动日志
logger.info(
    "[ai_tools] V2 注册完成 · %d 个 tools: %s",
    len(TOOL_REGISTRY),
    list(TOOL_REGISTRY.keys()),
)
