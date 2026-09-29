"""Billing stubs · 律所 App 遗留路径 · 不再伪装成可用计费。

真实余额 / 估价 / 流水请走:
  GET  /api/v8/economy/balance
  POST /api/v8/economy/estimate
  POST /api/v8/economy/quote
  GET  /api/v8/economy/ledger
"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from platform_v8.api.deps import get_current_account
from platform_v8.core import Account

router = APIRouter()

_DEPRECATED = {
    "deprecated": True,
    "message": " /api/billing/* 已废弃 · 请改用 /api/v8/economy/* ",
    "redirect": {
        "balance": "/api/v8/economy/balance",
        "estimate": "/api/v8/economy/estimate",
        "quote": "/api/v8/economy/quote",
        "ledger": "/api/v8/economy/ledger",
        "settings": "/api/v8/economy/settings",
    },
}


@router.get("/api/billing/plans")
async def plans(_account: Account = Depends(get_current_account)):
    return {
        **_DEPRECATED,
        "plans": [],
    }


@router.get("/api/billing/entitlements")
async def entitlements(_account: Account = Depends(get_current_account)):
    return {
        **_DEPRECATED,
        "plan": None,
        "current_period_end": None,
        "entitlements": [],
    }


@router.post("/api/billing/chat/completions")
async def chat_stub(_account: Account = Depends(get_current_account)):
    return {
        **_DEPRECATED,
        "ok": False,
        "code": "BILLING_STUB_DISABLED",
        "choices": [],
    }
