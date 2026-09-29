"""
Platform v8 · 纯 v8 FastAPI 后端 (已完全舍弃 v1 simple_server)

启动:
    uvicorn platform_v8.api.app:app --host 0.0.0.0 --port 8000 --reload

设计要点:
  1. lifespan: 启动时 init_db + init_kv · 关闭时清理
  2. middleware: CORS + trace_id + access log (统一格式)
  3. router 挂载: 每个 Domain 一个 router
  4. 异常处理: 统一返 {"ok": false, "code": ..., "message": ..., "trace_id": ...}
"""
from __future__ import annotations
import logging
import os
import time
import uuid

from contextlib import asynccontextmanager

# ── 日志: 一开就配 (uvicorn 默认 root logger 没 handler, 我们自己加) ──
logging.basicConfig(
    level=os.environ.get("V8_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-5s %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
# 用 starlette 的 HTTPException · 同时 catch FastAPI 显式抛的 + 框架自动 404/405 等
from starlette.exceptions import HTTPException

from platform_v8 import __version__
from platform_v8.api import api_key_guard
from platform_v8.api.errors import ErrorCode, status_to_code
from platform_v8.storage import db as db_mod
from platform_v8.storage import kv as kv_mod
from platform_v8.services.auth import config as auth_config
from platform_v8.api.v8 import ops as ops_router
from platform_v8.api.v8 import auth as auth_router
from platform_v8.api.v8 import workers as workers_router
from platform_v8.api.v8 import capabilities as capabilities_router  # QS-21 · 只读 Registry 反查
from platform_v8.api.v8 import ws as ws_router
from platform_v8.api.v8 import workloads as workloads_router
from platform_v8.api.v8 import economy as economy_router
from platform_v8.api.v8 import subscriptions as subscriptions_router
from platform_v8.api.v8 import payment as payment_router  # S3-T2 · 充值订单
from platform_v8.api.v8 import admin as admin_router
from platform_v8.api.v8 import scripts as scripts_router
from platform_v8.api.v8 import templates as templates_router
from platform_v8.api.v8 import files as files_router
from platform_v8.api.v8 import events as events_router
from platform_v8.api.v8 import legal_research as legal_research_router
from platform_v8.api.v8.dashboard_api import router as dashboard_router
from platform_v8.api.v8.billing_stubs import router as billing_router
from platform_v8.engine import lifecycle as engine_lifecycle

logger = logging.getLogger(__name__)




# ── lifespan: startup / shutdown ─────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio as _asyncio

    logger.info("v8 backend 启动 · v%s", __version__)
    # 方案 B · 配套契约 fail-fast（防文件级错配半残）
    from platform_v8.runtime_contract import assert_runtime_contract
    assert_runtime_contract()
    auth_config.validate_production_auth_config()
    # 启动: 初始化 db + kv (失败 fail-fast)
    db_mod.init_db(echo=bool(os.environ.get("V8_DB_ECHO")))
    # 仅部署期环境变量可创建/重置管理员，源码中不保存任何管理员密码。
    from platform_v8.services.auth.admin_bootstrap import ensure_admin_from_env
    ensure_admin_from_env()
    if auth_config.is_production():
        schema_status = db_mod.auth_schema_healthcheck()
        if schema_status.get("auth_schema") != "ok":
            raise RuntimeError(
                "生产认证数据库迁移未完成: "
                + schema_status.get("detail", "unknown schema error")
            )
    kv_mod.init_kv()
    # 注册 engine hook (节点上线 auto-queue · 链路 4+ 用)
    engine_lifecycle.init_engine()
    from platform_v8.services.media_channel import consumer_loop
    # Admission still requires live signed preflight and real operator proofs.
    # Run only when an actual metadata service is configured; no empty polling.
    if os.getenv("V8_MEDIA_SERVICE_BASE_URL"):
        app.state.media_consumer_task = _asyncio.create_task(consumer_loop())
    from platform_v8.services import media_research
    if media_research.enabled():
        app.state.media_research_task = _asyncio.create_task(media_research.consumer_loop())
    from platform_v8.services import media_research_tasks
    if media_research_tasks.enabled():
        app.state.media_research_dispatch_task = _asyncio.create_task(media_research_tasks.consumer_loop())
    # Archive normalization is workload-backed: recover jobs left in
    # NORMALIZING after a restart before accepting new dispatch work.
    try:
        from platform_v8.services.archive_normalization_jobs import (
            recover_pending_normalizations,
        )
        app.state.archive_recovery_task = _asyncio.create_task(
            recover_pending_normalizations()
        )
    except Exception as _e:
        logger.warning("archive normalization recovery failed: %s", _e)

    # 2026-05-28 · skill v2 自动注册 · 扫 skills/<pack>/manifest.json (v2.0) → task_registry
    # 设计文档: skills/SKILL_SPEC_V2.md
    # v1 manifest 自动跳过(不阻止启动 · 让 _TASKS hardcode 兜底)
    # v2 校验失败的 pack 跳过 + log error · 不阻止启动
    try:
        from platform_v8.engine.skill_loader import load_skills_to_registry
        _skill_stats = load_skills_to_registry()
        logger.info(
            "skill_loader · 注册 %d 个 v2 task · v1 跳过 %d pack · 错误 %d",
            _skill_stats.get("registered", 0),
            _skill_stats.get("v1_skipped", 0),
            _skill_stats.get("v2_pack_errors", 0) + _skill_stats.get("tool_register_errors", 0),
        )
    except Exception as _e:
        logger.warning("skill_loader · 启动注册失败 (仍可启动 · _TASKS hardcode 兜底): %s", _e)

    # W0-7 (2026-05-26) · 业务模块注册扩展点 (frame_router handler + task_registry)
    # 每个 SESSION/PULL 业务都在这里调 install()
    # 必须在 ws.py 接到第一个 tunnel_* 帧之前完成
    try:
        from platform_v8.services.proxy import registry as proxy_registry
        proxy_registry.install()
    except Exception as _e:
        logger.warning("services.proxy.registry · install 失败 (隐蔽业务可能不可用): %s", _e)

    # W2-4 (2026-05-26) · GEO 监测业务 · 注册 task_type=geo_query + 订阅 shard.completed
    # mode=PULL · 节点抢 → 跑 geo_query.py → aggregator_hook 跑 NLP 写 observations
    try:
        from platform_v8.services.geo import install as install_geo
        install_geo()
    except Exception as _e:
        logger.warning("services.geo · install 失败 (GEO 监测可能不可用): %s", _e)

    # W4 (2026-05-26) · 采集子系统接统一引擎 · 注册 task_type=crawl_subtask
    # mode=PULL · 节点 pull_worker 抢 → 跑 crawl_subtask.py → aggregator_hook 反写老表
    try:
        from platform_v8.services.crawl import install as install_crawl
        install_crawl()
    except Exception as _e:
        logger.warning("services.crawl · install 失败 (老 HTTP 链路仍能跑): %s", _e)

    # 2026-05-23 P0-2 · 启动 sweeper 后台任务 · 30s 扫一次 stuck workload
    _sweeper_task = _asyncio.create_task(engine_lifecycle._sweeper_loop())
    app.state.sweeper_task = _sweeper_task
    # 2026-05-25 NCE P2 · 启动 hw_score cron · 每 24h 跑一次 (flag 控 · 默认 OFF · 不跑空 loop 也 OK)
    _hw_cron_task = _asyncio.create_task(engine_lifecycle._hw_score_cron_loop())
    app.state.hw_cron_task = _hw_cron_task
    # 2026-05-25 P0 · 启动心跳超时 reaper · 30s 扫一次 · last_seen 超 60s 的 ONLINE 节点强制 OFFLINE
    # 修 BUG: 进程重启 / ws 断连漏 mark_offline → DB 永远 ONLINE
    _hb_reaper_task = _asyncio.create_task(engine_lifecycle._heartbeat_reaper_loop())
    app.state.hb_reaper_task = _hb_reaper_task
    # 2026-05-25 NCE P3 · 启动 rep_score cron · 每 24h 跑一次 4 子分重算 (flag 控)
    _rep_cron_task = _asyncio.create_task(engine_lifecycle._rep_score_cron_loop())
    app.state.rep_cron_task = _rep_cron_task
    # 2026-06-02 M2 横扩 · 送达确认 reaper · 6s 扫一次 · 仅 leader 跑 (gw_multi OFF 时 no-op)
    #   召回"已派发但未确认送达节点 socket"的分片(跨进程 route_push 丢帧)· 丢帧恢复 ~90s→~20s
    _deliv_reaper_task = _asyncio.create_task(engine_lifecycle._delivery_reaper_loop())
    app.state.deliv_reaper_task = _deliv_reaper_task
    # Result verification owns a dedicated bounded executor.  Its first poll
    # recovers persisted VERIFYING rows left by a process restart.
    from platform_v8.services.result_verification_jobs import (
        verification_worker_loop,
    )
    app.state.result_verification_task = _asyncio.create_task(
        verification_worker_loop()
    )
    # Paid adapter purchases stay closed until v8_063 is present and this
    # idempotent refund sweep completes once. It also refunds old pending
    # holds while the explicit purchase feature flag is switched off.
    from platform_v8.services.workers.order_adapter_products import (
        expiry_refund_worker_loop,
    )
    app.state.order_adapter_refund_task = _asyncio.create_task(
        expiry_refund_worker_loop()
    )
    # 2026-06-02 M2 · 网关横扩跨进程协调 (flag gw_multi · 默认 OFF · OFF 时两循环空转)
    #   subscriber: 收跨网关定向/广播帧 → 本地 send
    #   leader_renew: 续租 leader 锁 · 仅 leader 跑 sweeper/reaper (防多进程重复)
    try:
        from platform_v8.engine import gateway as _gateway
        from platform_v8.engine import lifecycle as _lifecycle
        # L1 单一权威: 注册派发作业处理器 · leader 收到非leader委派后回调执行
        _gateway.register_leader_job_handler(_lifecycle._leader_job_dispatch)
        app.state.gw_subscriber_task = _asyncio.create_task(_gateway.subscriber_loop())
        app.state.gw_leader_task = _asyncio.create_task(_gateway.leader_renew_loop())
        logger.info("gateway · M2 协调任务已启动 (gw=%s · 等待 gw_multi flag · leader_job 已注册)",
                    _gateway.gateway_id())
    except Exception as _e:
        logger.warning("gateway · M2 协调任务启动失败 (单进程不受影响): %s", _e)
    # 2026-05-25 NCE P4.19 · 事件总线 + shard.completed 订阅 (实时重派 PENDING)
    # 修 BUG: aggregator publish shard.completed 但没人 subscribe · 实时重派失效
    try:
        from platform_v8.services.economy import event_bus
        event_bus.init_bus()

        async def _on_shard_completed(evt):
            try:
                wid = evt.payload.get("workload_id")
                if not wid:
                    return
                # 失败重派不要把刚失败节点当 prefer，否则会继续喂坏节点烧 attempts
                prefer = evt.payload.get("worker_id")
                if str(evt.payload.get("outcome") or "") == "failure":
                    prefer = None
                await engine_lifecycle.on_shard_completed_redispatch(
                    wid,
                    idle_worker_id=prefer,
                )
            except Exception as _e:
                # 2026-08-10 · 曾是 debug 级：lifecycle 缺函数导致每次回调 AttributeError,
                # 实时重派静默失效 7 天无人知。这条必须可见。
                logger.warning("event_bus shard.completed handler fail: %r", _e)

        # subscribe 只登记 callable，不校验被调属性是否存在 → 这里先自检一次,
        # 缺失时立刻暴露（runtime_contract 亦已把它列为必需属性）。
        if not hasattr(engine_lifecycle, "on_shard_completed_redispatch"):
            raise AttributeError(
                "engine.lifecycle 缺 on_shard_completed_redispatch · 实时重派不可用"
            )
        event_bus.subscribe("shard.completed", _on_shard_completed)
        logger.info(
            "event_bus · shard.completed → lifecycle.on_shard_completed_redispatch 订阅成功"
        )
    except Exception as _e:
        logger.warning("event_bus 初始化失败 (实时重派降级到 30s sweeper): %s", _e)
    # OSS 对象存储初始化（无痛 · 环境变量不配就走本地回退）
    try:
        from platform_v8.services.oss_provider import configure_oss, load_oss_config_from_env
        configure_oss(load_oss_config_from_env())
        logger.info("v8 OSS provider 初始化完成")
    except Exception:
        logger.info("v8 OSS provider 初始化跳过（环境变量未配）")

    # 2026-05-26 · IP 代理池 · 启动 session janitor (10s 扫一次 · 关空闲 session)
    try:
        from platform_v8.services.proxy import gateway as _pg
        app.state.proxy_janitor_task = _asyncio.create_task(_pg.janitor_loop(10))
        logger.info("proxy gateway · janitor 已启动")
    except Exception as _e:
        logger.warning("proxy gateway janitor 启动失败 (静默): %s", _e)

    logger.info("v8 backend 启动完成 · 监听请求")
    yield
    # 关闭 · 取消所有后台任务
    # 2026-05-28 fix · asyncio.CancelledError 在 Py 3.8+ 不是 Exception 子类 · 必须显式抓
    #                  之前漏抓 → uvicorn 报 "Application shutdown failed. Exiting." + traceback
    _archive_recovery = getattr(app.state, "archive_recovery_task", None)
    if _archive_recovery is not None and not _archive_recovery.done():
        _archive_recovery.cancel()
        try:
            await _archive_recovery
        except (Exception, _asyncio.CancelledError):
            pass
    try:
        from platform_v8.services.archive_normalization_jobs import (
            shutdown_archive_normalization_jobs,
        )
        await shutdown_archive_normalization_jobs()
    except (Exception, _asyncio.CancelledError):
        logger.warning("archive normalization executor shutdown failed")

    for _attr in ("sweeper_task", "hw_cron_task", "hb_reaper_task", "rep_cron_task",
                  "proxy_janitor_task", "gw_subscriber_task", "gw_leader_task",
                  "result_verification_task", "order_adapter_refund_task", "media_consumer_task", "media_research_task", "media_research_dispatch_task"):
        _t = getattr(app.state, _attr, None)
        if _t is not None and not _t.done():
            _t.cancel()
            try:
                await _t
            except (Exception, _asyncio.CancelledError):
                pass
    try:
        from platform_v8.services.result_verification_jobs import (
            shutdown_verification_jobs,
        )
        await shutdown_verification_jobs()
    except (Exception, _asyncio.CancelledError):
        logger.warning("result verification executor shutdown failed")
    # 关闭事件总线 (consumer 协程)
    try:
        from platform_v8.services.economy import event_bus
        await event_bus.shutdown_bus()
    except (Exception, _asyncio.CancelledError):
        pass
    logger.info("v8 backend 关闭")


# ── FastAPI app (纯 v8) ──────────────────────────────
app = FastAPI(
    title="Platform v8 · 算力平台统一架构",
    version=__version__,
    description="一套链路 · 一套表 · 一套协议",
    lifespan=lifespan,
)
logger.info("✓ v8 app 启动 (纯 v8 模式 · 无 legacy)")


# ── CORS ─────────────────────────────────────────────
# 根治 2026-05-26 · Tauri WebKit (tauri://localhost / https://tauri.localhost) 不在
# 默认白名单 → fetch 跨域被 block → 客户端"智能能力"等页 Load failed
# 解决: 不论 env 配置如何, 永远附加 Tauri scheme · 同时支持 regex 兜底
_env_origins = os.environ.get("V8_CORS_ORIGINS", "").split(",")
# Credentials include the web refresh cookie; never reflect an arbitrary
# origin via a wildcard configuration. Public deployments must list origins.
_env_origins = [o.strip() for o in _env_origins if o.strip() and o.strip() != "*"]
# Tauri 桌面客户端来源 (mac/linux: tauri://localhost · win: https://tauri.localhost)
_tauri_origins = ["tauri://localhost", "https://tauri.localhost"]
_all_origins = list(dict.fromkeys(_env_origins + _tauri_origins))  # 去重保序

app.add_middleware(
    CORSMiddleware,
    allow_origins=_all_origins,
    # 同时用 regex 兜底 · 万一未来 Tauri scheme 变了不至于全死
    # 匹配: tauri://* · https://tauri.localhost · http://localhost:*  (dev)
    allow_origin_regex=r"^(tauri://[^/]+|https?://(tauri\.localhost|localhost(:\d+)?|127\.0\.0\.1(:\d+)?|192\.168\.\d{1,3}\.\d{1,3}(:\d+)?|10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?))$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
logger.info("✓ CORS · allow_origins=%s + tauri_regex", _all_origins)


# ── Prometheus metrics (S1-T4 · 2026-06-07) ──────────
# 暴露 /metrics 给 Prometheus scraper · nginx 仅内网放行 (生产配置:location /metrics { allow 127.0.0.1; deny all; })
# 自动 metrics: http_requests_total / http_request_duration_seconds / 5xx counters
# 自定义 metrics 通过 services/ops/metrics.py 注册 (后续 PR 添加 派发延迟/丢帧/在线节点 gauge)
try:
    import inspect

    from prometheus_fastapi_instrumentator import Instrumentator
    from platform_v8.services.observability import prometheus_registry

    _metrics_registry = prometheus_registry()
    _instrumentator_kwargs = {
        "should_group_status_codes": True,
        "should_ignore_untemplated": True,
        "excluded_handlers": ["/healthz", "/readyz", "/livez", "/metrics"],
    }
    if (
        _metrics_registry is not None
        and "registry" in inspect.signature(Instrumentator).parameters
    ):
        _instrumentator_kwargs["registry"] = _metrics_registry
    Instrumentator(
        **_instrumentator_kwargs,
    ).instrument(app).expose(app, endpoint="/metrics", include_in_schema=False)
    logger.info("✓ Prometheus metrics 暴露在 /metrics (注意 nginx 仅内网放行)")
except ImportError:
    logger.warning("prometheus_fastapi_instrumentator 未安装 · 跳过 metrics 暴露")
except Exception as exc:
    logger.error("Prometheus instrumentator 初始化失败 (静默): %s", exc)


# ── Middleware: trace_id + access log ────────────────


@app.middleware("http")
async def limit_api_key_concurrency(request: Request, call_next):
    """在鉴权查库前限制单个 API Key 的活跃请求数。"""
    authorization = request.headers.get("authorization", "")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.startswith(("qs_", "qsk_")):
        return await call_next(request)

    lease = api_key_guard.acquire(token)
    if lease is None:
        return JSONResponse(
            status_code=429,
            content={
                "ok": False,
                "code": "RATE_LIMITED",
                "message": "API Key 并发请求过高，请降低并发并稍后重试",
            },
            headers={"Retry-After": "1"},
        )
    try:
        return await call_next(request)
    finally:
        api_key_guard.release(lease)


@app.middleware("http")
async def trace_and_log(request: Request, call_next):
    # 注入 trace_id (优先用客户端传的)
    trace_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex
    request.state.trace_id = trace_id

    started = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        elapsed_ms = (time.perf_counter() - started) * 1000
        logger.exception("v8.access · trace=%s %s %s 500 %.1fms",
                         trace_id, request.method, request.url.path, elapsed_ms)
        raise

    elapsed_ms = (time.perf_counter() - started) * 1000
    response.headers["X-Request-ID"] = trace_id
    logger.info("v8.access · trace=%s %s %s %d %.1fms",
                trace_id, request.method, request.url.path,
                response.status_code, elapsed_ms)
    return response


# ── 统一异常返回 ─────────────────────────────────────
@app.exception_handler(HTTPException)
async def http_exc_handler(request: Request, exc: HTTPException):
    if exc.status_code == 400:
        logger.warning(
            "v8.http_exc · %s %s detail=%s",
            request.method,
            request.url.path,
            exc.detail,
        )
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "ok": False,
            "code": status_to_code(exc.status_code).value,
            "message": str(exc.detail),
            "trace_id": getattr(request.state, "trace_id", ""),
        },
    )


@app.exception_handler(RequestValidationError)
async def validation_exc_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={
            "ok": False,
            "code": ErrorCode.VALIDATION_ERROR.value,
            "message": "请求参数校验失败",
            "errors": exc.errors(),
            "trace_id": getattr(request.state, "trace_id", ""),
        },
    )


@app.exception_handler(Exception)
async def unhandled_exc_handler(request: Request, exc: Exception):
    trace_id = getattr(request.state, "trace_id", "")
    logger.exception("v8.unhandled · trace=%s err=%s", trace_id, exc)
    return JSONResponse(
        status_code=500,
        content={
            "ok": False,
            "code": ErrorCode.INTERNAL_ERROR.value,
            "message": "服务器内部错误",
            "trace_id": trace_id,
        },
    )


# ── 挂 router (每个 Domain 一个 · 后续链路按此模式加) ──
app.include_router(ops_router.router)
app.include_router(auth_router.router)
app.include_router(workers_router.router)
app.include_router(capabilities_router.router)  # QS-21
app.include_router(ws_router.router)
app.include_router(workloads_router.router)
from platform_v8.api.v8 import workload_acceptance as workload_acceptance_router
app.include_router(workload_acceptance_router.router)
app.include_router(economy_router.router)
from platform_v8.api.v8 import media as media_router
app.include_router(media_router.router)
from platform_v8.api.v8 import media_research as media_research_router
app.include_router(media_research_router.router)
from platform_v8.api.v8 import media_research_tasks as media_research_tasks_router
app.include_router(media_research_tasks_router.router)
# S3-T2 · 2026-06-07 · 充值订单 (admin_manual 模式可立即用; wechat/alipay 待真接入)
app.include_router(payment_router.router)
app.include_router(subscriptions_router.router)
app.include_router(payment_router.admin_router)
app.include_router(admin_router.router)
app.include_router(scripts_router.router)
from platform_v8.api.v8 import demo as demo_router  # 律所阅卷 web demo (真实运行)
app.include_router(demo_router.router)
app.include_router(templates_router.router)
app.include_router(files_router.router)
app.include_router(files_router.public_router)
app.include_router(events_router.router)
app.include_router(legal_research_router.router)

from platform_v8.api.v8 import users as users_router
app.include_router(users_router.router)

from platform_v8.api.v8 import admin_fe as admin_fe_router
app.include_router(admin_fe_router.router)

from platform_v8.api.v8 import oss as oss_router
app.include_router(oss_router.router)

from platform_v8.api.v8 import models as models_router
app.include_router(models_router.router)

from platform_v8.api.v8 import my as my_router
app.include_router(my_router.router)

from platform_v8.api.v8 import admin_v2 as admin_v2_router
app.include_router(admin_v2_router.router)

# 管理员企业界面的技能目录管理（此前模块存在但未挂载，接口不可达）。
from platform_v8.api.v8 import admin_scripts as admin_scripts_router
app.include_router(admin_scripts_router.router)

# AI 模块
from platform_v8.api.v8 import ai as ai_router
app.include_router(ai_router.router)
# 2026-06-01 · /api/v1/* OpenAI 兼容入口(节点 AI 脚本 llm_chat/llm_extract/embedding 用·限流控成本)
app.include_router(ai_router.v1_router)

# 工具包 + 客户端更新
from platform_v8.api.v8 import bundles as bundles_router
app.include_router(bundles_router.router)

# 技能集下发 (节点装完 tier 后拉 skill zip)
from platform_v8.api.v8 import skills as skills_router
app.include_router(skills_router.router)

# enterprise-client 假数据页占位 stub (invoices / members / projects /
# scheduled-tasks / webhooks / api-keys) · 等真实业务实现时各自独立 router 覆盖
from platform_v8.api.v8 import enterprise_stub as enterprise_stub_router
app.include_router(enterprise_stub_router.router)

# 2026-07 · 企业开发者 API Key CRUD (/api/v8/developer/keys)
# 方案 B · 挂载前再验 storage/engine 配套（developer 强依赖 DeveloperTaskRepo）
from platform_v8.runtime_contract import assert_runtime_contract as _assert_runtime_contract
_assert_runtime_contract()
from platform_v8.api.v8 import developer as developer_router
app.include_router(developer_router.router)

# 2026-08 · 产品级稳定 API（对外契约与引擎解耦）
from platform_v8.api.v8 import product_v1 as product_v1_router
app.include_router(product_v1_router.router)

# 2026-05-23 P1-1 · 公开统计端点 (官网 Home/BetaProgram 用 · 无 auth · 全脱敏)
from platform_v8.api.v8 import public_stats as public_stats_router
app.include_router(public_stats_router.router)

# 2026-05-24 · crawl 任务 URL 白名单 admin (合规管控)
from platform_v8.api.v8 import crawl_admin as crawl_admin_router
app.include_router(crawl_admin_router.router)

# 2026-05-25 · NCE 节点能力评估系统 admin (feature flags / hw_score / 信誉调整 / 派单审计)
# 全部 nce_* feature flag 默认 OFF · 上线后通过 admin API 灰度开启
from platform_v8.api.v8 import admin_nce as admin_nce_router
app.include_router(admin_nce_router.router)

# OCR runtime / 签名客户端更新通知（管理员发布后通过 WS 推给在线节点）。
from platform_v8.api.v8 import admin_runtime_updates as admin_runtime_updates_router
app.include_router(admin_runtime_updates_router.router)

# Qianshou desktop policy is separate from legacy OCR/client broadcast.
from platform_v8.api.v8 import desktop_update_policy as desktop_update_policy_router
app.include_router(desktop_update_policy_router.router)

# 2026-05-26 fix · 之前漏 mount · 节点 owner 端 NCE 接口 404 → 客户端 rep_main fallback 0 → 误显示 "🚫封禁"
from platform_v8.api.v8 import my_nce as my_nce_router
app.include_router(my_nce_router.router)

# 2026-05-26 · IP 代理池 (节点出租闲置 IP · 给爬虫 / GEO 监测 / SEO 客户)
from platform_v8.api.v8 import proxy as proxy_router
from platform_v8.api.v8 import admin_proxy as admin_proxy_router
app.include_router(proxy_router.router)
app.include_router(admin_proxy_router.router)

# 2026-05-26 W2 · GEO 监测 (客户 + admin · 用统一引擎跑 PULL 模式 task)
from platform_v8.api.v8 import geo as geo_router
from platform_v8.api.v8 import admin_geo as admin_geo_router
app.include_router(geo_router.router)
app.include_router(admin_geo_router.router)

# 2026-05-26 W7 · B2B 客户合约 admin (大客户签约 / 配额管理 / SLA)
from platform_v8.api.v8 import admin_business as admin_business_router
app.include_router(admin_business_router.router)

# 2026-05-26 W8 · B2B 客户视角 (我的合约 + 我的账单 + 用量摘要 + 申请付款)
from platform_v8.api.v8 import my_business as my_business_router
app.include_router(my_business_router.router)

# 2026-05-22 · 运营位 (开屏弹窗 / banner / 公告 / 活动) · 客户端拉
from platform_v8.api.v8 import op_slots as op_slots_router
from platform_v8.api.v8 import admin_op_slots as admin_op_slots_router
app.include_router(op_slots_router.router)
app.include_router(admin_op_slots_router.router)

# 2026-05-22 · 用户协议同意 (隐私 + 服务条款 + Cookie) · 商用合规
from platform_v8.api.v8 import user_consent as user_consent_router
app.include_router(user_consent_router.router)

# 2026-05-26 · 广告位招商 (面对广告主 · 收 leads · admin 受理 + 转化追踪)
from platform_v8.api.v8 import advertising as advertising_module
app.include_router(advertising_module.public_router)
app.include_router(advertising_module.admin_router)

# 官网 BetaProgram 企业咨询；与广告位招商线索分表，admin 专属查看。
from platform_v8.api.v8 import enterprise_leads as enterprise_leads_module
app.include_router(enterprise_leads_module.public_router)
app.include_router(enterprise_leads_module.admin_router)



# 2026-05-30 · 运行时 tier 热管理 Admin API (此前 prod 未挂载 → 后台 404)
from platform_v8.api.v8 import admin_runtime as admin_runtime_router
app.include_router(admin_runtime_router.router)

# 2026-05-30 · 脚本市场只读 (企业端 ScriptMarket.vue 调 /script-market/list)
from platform_v8.api.v8 import script_market as script_market_router
app.include_router(script_market_router.router)

# 2026-06-05 · 后端自愈手动下发 Admin API (POST /api/v8/admin/heal/{worker_id})
from platform_v8.api.v8 import admin_heal as admin_heal_router
app.include_router(admin_heal_router.router)

# 2026-06-06 · 任务级技能包 (节点拉定制 runner + admin 创建) · 补全 skill_pack.rs 链路
from platform_v8.api.v8 import skill_packs as skill_packs_router
app.include_router(skill_packs_router.router)
app.include_router(skill_packs_router.admin_router)
from platform_v8.api.v8 import edge as edge_router
app.include_router(edge_router.router)

# ── root ─────────────────────────────────────────────
@app.get("/", tags=["root"])
def root():
    return {
        "name": "platform_v8",
        "version": __version__,
        "docs": "/docs",
        "demo": "/demo",
        "health": "/api/v8/ops/health",
        "ready": "/api/v8/ops/ready",
    }


@app.get("/demo", tags=["root"], include_in_schema=False)
def demo_page():
    """点按钮玩 v8 (不用 Swagger UI)"""
    from fastapi.responses import HTMLResponse
    from pathlib import Path
    html_path = Path(__file__).parent.parent / "demo.html"
    if not html_path.exists():
        return HTMLResponse("<h1>demo.html 不存在</h1>", status_code=404)
    return HTMLResponse(html_path.read_text(encoding="utf-8"))


# ── 兼容老 /readyz · /healthz · /livez (docker healthcheck + k8s 用) ──
# 这些 path 老 backend 用的 · v8 必须暴露 · 否则 docker 会把容器标 unhealthy
app.include_router(dashboard_router)
app.include_router(billing_router)

# ── Steam 式应用市场 + 算力出借（v8_037 · 引擎零改）──
from platform_v8.api.v8 import marketplace as marketplace_router
from platform_v8.api.v8 import lending as lending_router
app.include_router(marketplace_router.router)
app.include_router(marketplace_router.admin_router)
from platform_v8.api.v8 import publication_lifecycle as publication_lifecycle_router
app.include_router(publication_lifecycle_router.router)
app.include_router(publication_lifecycle_router.admin_router)
from platform_v8.api.v8 import task_adapter_publications as task_adapter_publications_router
app.include_router(task_adapter_publications_router.router)
app.include_router(task_adapter_publications_router.admin_router)
app.include_router(task_adapter_publications_router.internal_router)
from platform_v8.api.v8 import task_adapter_evidence_sts as task_adapter_evidence_sts_router
app.include_router(task_adapter_evidence_sts_router.router)
from platform_v8.api.v8 import file_downloads as file_downloads_router
app.include_router(file_downloads_router.router)
from platform_v8.api.v8 import task_adapter_publisher_identity as task_adapter_publisher_identity_router
app.include_router(task_adapter_publisher_identity_router.router)
app.include_router(task_adapter_publisher_identity_router.internal_router)
app.include_router(task_adapter_publisher_identity_router.manifest_router)
from platform_v8.api.v8 import order_adapter_products as order_adapter_products_router
app.include_router(order_adapter_products_router.router)
app.include_router(order_adapter_products_router.admin_router)
from platform_v8.api.v8 import order_adapter_remote_challenges as order_adapter_remote_challenges_router
app.include_router(order_adapter_remote_challenges_router.router)
from platform_v8.api.v8 import order_adapter_ws_observations as order_adapter_ws_observations_router
app.include_router(order_adapter_ws_observations_router.router)
app.include_router(lending_router.router)
app.include_router(lending_router.admin_router)

# LAN · 官方 Runtime Release 静态目录（非生产 CDN）
from platform_v8.api.v8 import runtime_releases as runtime_releases_router
app.include_router(runtime_releases_router.router)
try:
    runtime_releases_router.mount_if_configured(app)
except Exception as _rr_exc:
    logger.warning("Runtime releases 静态挂载跳过: %s", _rr_exc)

# 2026-08 · 开放平台（应用即 API · 卖调用次数 · v8_040）
from platform_v8.api.v8.open import routes as open_router
app.include_router(open_router.router)
app.include_router(open_router.mgmt_router)

# 2026-08 · 生态运营台（apps/eco-admin）
from platform_v8.api.v8 import eco_admin as eco_admin_router
app.include_router(eco_admin_router.router)

@app.get("/readyz", tags=["root"], include_in_schema=False)
def _readyz():
    from platform_v8.services.ops import health as _h
    rep = _h.readiness_dict()
    if rep["status"] == "error":
        from fastapi.responses import JSONResponse
        return JSONResponse(rep, status_code=503)
    return rep


@app.get("/healthz", tags=["root"], include_in_schema=False)
def _healthz():
    from platform_v8.services.ops import health as _h
    return _h.liveness()


@app.get("/livez", tags=["root"], include_in_schema=False)
def _livez():
    from platform_v8.services.ops import health as _h
    return _h.liveness()

# Authenticated account-only readonly image catalog
from platform_v8.api.image_model_catalog import router as image_model_catalog_router
app.include_router(image_model_catalog_router)
