"""AI 专属安全防护 (V2)

8 层防御中的 L5 (AI 层):
  - Prompt Injection 检测
  - Honeypot Tools (诱捕逃逸的 LLM)
  - Output Sanitizer (敏感信息脱敏)
  - Rate Limit (用户级 + tool 级)
  - Cost Cap (token 上限)
"""
from __future__ import annotations
import logging
import re
import time
from typing import Any
from collections import defaultdict, deque

logger = logging.getLogger("backend.ai_guard")


# ─────────────────────────────────────────────────────
# Prompt Injection 检测模式
# ─────────────────────────────────────────────────────
INJECTION_PATTERNS = [
    re.compile(r"ignore\s+(all|previous|above)\s+instructions?", re.I),
    re.compile(r"forget\s+(everything|all|prior)", re.I),
    re.compile(r"you\s+are\s+now\s+(DAN|free|jailbroken|unrestricted)", re.I),
    re.compile(r"system\s*[:：]\s*you\s+(are|must|should)", re.I),
    re.compile(r"<\|im_(start|end)\|>", re.I),
    re.compile(r"###\s*(system|admin|root)\s*[:：]", re.I),
    re.compile(r"act\s+as\s+(an?\s+)?(admin|root|developer|god|hacker)", re.I),
    re.compile(r"pretend\s+you\s+(have|are)", re.I),
    re.compile(r"reveal\s+(your|the)\s+(system\s+)?prompt", re.I),
    re.compile(r"print\s+(your|the)\s+instructions", re.I),
    # 中文
    re.compile(r"忽略.*?(以上|之前|上面|所有).*?(指令|规则|限制)"),
    re.compile(r"你现在(是|扮演).*?(管理员|root|无限制|没有限制)"),
    re.compile(r"输出.*?(系统|你的).*?(提示|prompt)"),
]


def detect_prompt_injection(text: str) -> tuple[bool, str | None]:
    """检测 prompt injection · 返回 (有威胁, 命中模式)"""
    if not text or len(text) > 10000:
        return False, None
    for pat in INJECTION_PATTERNS:
        m = pat.search(text)
        if m:
            return True, m.group(0)[:50]
    return False, None


# ─────────────────────────────────────────────────────
# Honeypot Tools (诱捕)
# AI 不应该调这些 · 调了 = 100% prompt injection 攻陷
# ─────────────────────────────────────────────────────
HONEYPOT_TOOLS = {
    "transfer_balance_to_admin",
    "export_all_user_data",
    "delete_all_tasks",
    "grant_admin_role",
    "show_password_hash",
    "disable_audit_log",
}


def is_honeypot_tool(tool_name: str) -> bool:
    return tool_name in HONEYPOT_TOOLS


def alert_honeypot_triggered(user_id: int, tool_name: str, args: dict) -> None:
    """诱捕触发 · 紧急告警 + 自动封号"""
    logger.error(
        "🚨 HONEYPOT TRIGGERED: user_id=%s tool=%s args=%s · 即将封号",
        user_id, tool_name, args,
    )
    # TODO: 写一条紧急 audit · 邮件通知 admin
    # TODO: 暂停 user_id (we_accounts.status = 'suspended')


# ─────────────────────────────────────────────────────
# Output Sanitizer (PII 脱敏)
# ─────────────────────────────────────────────────────
SANITIZE_PATTERNS = [
    # 中国手机号
    (re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"), lambda m: m.group(0)[:3] + "****" + m.group(0)[-4:]),
    # 邮箱
    (re.compile(r"([\w.+-]+)@([\w-]+\.[\w.-]+)"), lambda m: m.group(1)[:2] + "***@" + m.group(2)),
    # 身份证
    (re.compile(r"(?<!\d)\d{17}[\dxX](?!\w)"), lambda m: m.group(0)[:6] + "********" + m.group(0)[-4:]),
    # 银行卡 (16-19 位连续数字)
    (re.compile(r"(?<!\d)\d{16,19}(?!\d)"), lambda m: m.group(0)[:4] + "****" + m.group(0)[-4:]),
]


def sanitize_output(text: str) -> str:
    """LLM 输出过 PII 脱敏 (返给用户前)"""
    if not text:
        return text
    out = text
    for pat, replacer in SANITIZE_PATTERNS:
        out = pat.sub(replacer, out)
    return out


# ─────────────────────────────────────────────────────
# Rate Limit (用户级 · 内存 sliding window)
# ─────────────────────────────────────────────────────
_user_call_window: dict[int, deque] = defaultdict(deque)
_user_call_lock_window = 60  # 60 秒滑动窗口
_user_call_max_per_window = 30  # 单用户 30 次/分钟


def check_rate_limit(user_id: int) -> tuple[bool, str | None]:
    """检查用户是否超 rate limit"""
    now = time.time()
    win = _user_call_window[user_id]
    # 清掉过期
    while win and now - win[0] > _user_call_lock_window:
        win.popleft()
    if len(win) >= _user_call_max_per_window:
        return False, f"超过速率限制 ({_user_call_max_per_window} 次/分钟)"
    win.append(now)
    return True, None


# ─────────────────────────────────────────────────────
# Tool 风险矩阵
# ─────────────────────────────────────────────────────
RISK_LEVELS = {
    "low":      0,  # 无门槛 (query 类)
    "mid":      1,  # 配额检查 (submit/update)
    "high":     2,  # 二次确认 (delete/admin)
    "critical": 3,  # admin + 紧急告警 (transfer/grant_admin)
}


def check_risk(user_role: str, user_balance: float, risk_level: str, args: dict) -> tuple[bool, str | None]:
    """风险门限检查"""
    lvl = RISK_LEVELS.get(risk_level, 0)
    if lvl >= 3 and user_role != "admin":
        return False, f"操作风险等级 critical · 仅 admin 可调用"
    if lvl >= 2 and user_role not in ("admin", "enterprise"):
        return False, f"操作风险等级 high · 需 enterprise+ 权限"
    # mid 级: 检查预算
    if lvl >= 1:
        budget = float(args.get("budget", 0) or 0)
        if budget > user_balance * 0.5:
            return False, f"单次预算 {budget} 超余额 50% (余 {user_balance})"
    return True, None


# ─────────────────────────────────────────────────────
# 综合 guard (主入口)
# ─────────────────────────────────────────────────────
def guard_tool_call(
    *, user_id: int, user_role: str, user_balance: float,
    tool_name: str, args: dict,
) -> tuple[bool, str | None, str]:
    """综合检查 · 返回 (allow, error_msg, risk_level)"""
    # 1. Honeypot 拦截
    if is_honeypot_tool(tool_name):
        alert_honeypot_triggered(user_id, tool_name, args)
        return False, "工具不存在 (honeypot triggered)", "critical"

    # 2. Rate limit
    ok, err = check_rate_limit(user_id)
    if not ok:
        return False, err, "low"

    # 3. 风险 + 权限
    from .tools import TOOL_REGISTRY
    tool_meta = TOOL_REGISTRY.get(tool_name, {})
    risk = tool_meta.get("risk", "low")
    ok, err = check_risk(user_role, user_balance, risk, args)
    if not ok:
        return False, err, risk

    return True, None, risk


def guard_user_prompt(user_id: int, prompt: str) -> tuple[bool, str | None]:
    """检查 user message · 拦 prompt injection"""
    threat, pattern = detect_prompt_injection(prompt)
    if threat:
        logger.warning("[ai_guard] prompt injection user=%s pattern=%s", user_id, pattern)
        return False, f"输入含可疑模式 · 已拦截 (匹配: {pattern[:30]})"
    return True, None
