"""
所有 enum 类型 · 全平台共用
"""
from __future__ import annotations
from enum import Enum


# ── Workload (任务) ──────────────────────────────────
class WorkloadStatus(str, Enum):
    """任务生命周期状态机"""
    NORMALIZING = "NORMALIZING"    # archive 正在服务端安全归一化，尚不可调度
    CREATED = "CREATED"            # 刚提交 · 未 plan
    PLANNED = "PLANNED"            # 已分片 · 已选 worker
    RUNNING = "RUNNING"            # 至少 1 个 shard 在跑
    AGGREGATING = "AGGREGATING"    # 所有 shard 完成 · 等聚合
    DONE = "DONE"                  # 聚合完成 · 用户可查
    QUARANTINED = "QUARANTINED"    # 结果待人工审核，禁止自动结算
    FAILED = "FAILED"              # 永久失败 (重试用完)
    CANCELLED = "CANCELLED"        # 用户取消
    WAITING_FOR_WORKERS = "WAITING_FOR_WORKERS"  # 没 worker · 排队等


# ── Shard (分片) ─────────────────────────────────────
class ShardStatus(str, Enum):
    """分片生命周期"""
    PENDING = "PENDING"            # 刚生成 · 未派发
    DISPATCHED = "DISPATCHED"      # 派给 worker · 待 ack (ONESHOT/SESSION 用)
    LEASED = "LEASED"              # W1 · PULL 模式 · 节点 lease 但未 ack 跑 (有 lease_expires_at)
    RUNNING = "RUNNING"            # worker 已 ack · 跑中
    VERIFYING = "VERIFYING"        # worker 已交结果 · 服务端持久化验证中
    DONE = "DONE"                  # worker 提交结果
    FAILED = "FAILED"              # 跑挂 · 可能重试
    CANCELLED = "CANCELLED"        # workload 取消时连带取消


# ── Shard 调度模式 (W1 · 跟 task_registry.TaskMode 对齐) ─────
class ShardMode(str, Enum):
    """调度模式 · planner 按 mode 路由到不同 dispatcher"""
    ONESHOT = "oneshot"   # 现有 53 task · broker.push (server 主动派给指定 worker)
    SESSION = "session"   # IP 代理 / CDN · session_dispatcher.open_tunnel (长连双向)
    PULL = "pull"         # 爬虫 / GEO · pull_dispatcher · 节点主动 PullRequest 来抢


# ── Worker (节点) ────────────────────────────────────
class WorkerStatus(str, Enum):
    """工作节点状态"""
    ONLINE = "ONLINE"              # 在线 · 空闲 · 可接活
    BUSY = "BUSY"                  # 在线 · 满载 · 暂不派活
    OFFLINE = "OFFLINE"            # 离线 · 不派活
    MAINTENANCE = "MAINTENANCE"    # 维护中 · 不接新活


# ── Account (账号) ───────────────────────────────────
class AccountRole(str, Enum):
    """账号角色"""
    PERSONAL = "personal"
    ENTERPRISE = "enterprise"
    CHANNEL = "channel"            # 渠道商
    ADMIN = "admin"


class AccountStatus(str, Enum):
    """账号状态"""
    ACTIVE = "active"
    SUSPENDED = "suspended"        # 被 ai_guard 暂停
    DELETED = "deleted"


# ── Ledger (账本) ────────────────────────────────────
class LedgerType(str, Enum):
    """账本条目类型 (替代 v1+v2 的 escrow + transactions + settlements 三表)"""
    ESCROW_HOLD = "ESCROW_HOLD"          # 提任务时锁钱
    ESCROW_RELEASE = "ESCROW_RELEASE"    # 任务完成时解锁
    REWARD = "REWARD"                    # 节点奖励
    REFUND = "REFUND"                    # 任务失败退款
    WITHDRAW = "WITHDRAW"                # 用户提现
    DEPOSIT = "DEPOSIT"                  # 用户充值
    PLATFORM_FEE = "PLATFORM_FEE"        # 平台抽成
    SUBSCRIPTION_PURCHASE = "SUBSCRIPTION_PURCHASE"  # 人民币余额购买订阅
    ORDER_ADAPTER_PURCHASE = "ORDER_ADAPTER_PURCHASE"  # 人民币余额购买接单技能包
    RISK_POOL = "RISK_POOL"              # 风险池注入


# ── Task Type · 任务业务类型 ─────────────────────────
class TaskKind(str, Enum):
    """任务大分类 (内部调度策略用)"""
    AI_TRAINING = "AI_TRAINING"
    AI_INFERENCE = "AI_INFERENCE"
    IMAGE_RECOGNITION = "IMAGE_RECOGNITION"
    VIDEO_RENDERING = "VIDEO_RENDERING"
    SCIENTIFIC_COMPUTING = "SCIENTIFIC_COMPUTING"
    HASH_CALCULATION = "HASH_CALCULATION"
    DATA_PROCESSING = "DATA_PROCESSING"


# ── Runtime (worker 端运行时) ───────────────────────
class Runtime(str, Enum):
    """worker 跑任务用的运行时"""
    PYTHON3 = "python3"
    NODE = "node"
    BASH = "bash"
    SHELL = "shell"
    WASM = "wasm"
    OLLAMA = "ollama"              # 本地 LLM
    SKILL = "skill"                # 调用已装的 skill bundle


# ── Audit (审计动作) ────────────────────────────────
class AuditAction(str, Enum):
    """审计日志动作类型"""
    LOGIN = "auth.login"
    LOGOUT = "auth.logout"
    REGISTER = "auth.register"
    PASSWORD_CHANGE = "auth.password_change"
    WORKLOAD_SUBMIT = "workload.submit"
    WORKLOAD_CANCEL = "workload.cancel"
    WORKER_REGISTER = "worker.register"
    WORKER_ONLINE = "worker.online"
    WORKER_OFFLINE = "worker.offline"
    LEDGER_WRITE = "ledger.write"
    ADMIN_ACTION = "admin.action"
