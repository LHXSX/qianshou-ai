"""Standalone Alipay reconciliation command; dry-run unless --apply is explicit.

Cross-checks recent Alipay orders against `alipay.trade.query`, which the官方文档
names as the authoritative source when an async notification is missed
("支付成功与否必须以异步通知或调用 alipay.trade.query 查询结果为准").

Reporting is read-only. `--apply` credits a provider-confirmed order *only* by
calling the existing `mark_paid` writer, so every invariant that guards callbacks
(order lock, amount/currency/gateway cross-check, idempotent ledger key) still
applies. This command never creates, deletes or refunds an order.

Account binding note: the query response does not echo `passback_params`, so the
binding used for a query-driven credit is taken from OUR order row. The
authoritative facts remain the ones inside the signed response — `out_trade_no`,
`trade_status`, `total_amount` — and the row itself was located by the signed
`out_trade_no`. A bad signature is never downgraded to "unknown".
"""
from __future__ import annotations

import argparse
import json

from platform_v8.storage import db
from . import orders as orders_svc
from .alipay import TradeQuery, query_trade
from .common import (PaymentCallback, PaymentConfigError, PaymentRequestUnknown,
                     PaymentVerificationError, account_binding)
from .config import load_alipay_config

GATEWAY = "alipay"


def _verdict(order, answer: TradeQuery) -> str:
    """Classify one order against the provider answer; never credits anything."""
    if not answer.ok:
        return "provider_has_no_order"
    if answer.paid:
        if order.status == "paid":
            return "in_sync" if order.gateway_tx_id == answer.trade_no else "tx_mismatch"
        if answer.total_amount is not None and answer.total_amount != order.amount:
            return "amount_mismatch"
        return "provider_paid_local_unpaid"
    # Provider says the trade is not settled. If we already credited it, that is
    # the dangerous direction and must surface loudly rather than be silently kept.
    return "local_paid_provider_unpaid" if order.status == "paid" else "in_sync"


def reconcile(session, config, *, client=None, limit: int = 200, apply: bool = False) -> dict:
    report = {"mode": "apply" if apply else "dry_run", "gateway": GATEWAY,
              "checked": 0, "mismatches": [], "credits": []}
    for order in orders_svc.list_reconcilable_orders(session, GATEWAY, limit=limit):
        report["checked"] += 1
        try:
            answer = query_trade(order, config, client=client)
        except (PaymentVerificationError, PaymentRequestUnknown) as exc:
            report["mismatches"].append({"order_no": order.order_no, "local": order.status,
                                         "verdict": "query_failed", "detail": str(exc)[:120]})
            continue
        verdict = _verdict(order, answer)
        if verdict == "in_sync":
            continue
        report["mismatches"].append({
            "order_no": order.order_no, "local": order.status, "verdict": verdict,
            "provider_code": answer.code, "provider_sub_code": answer.sub_code,
            "provider_trade_status": answer.trade_status, "provider_trade_no": answer.trade_no,
        })
        if apply and verdict == "provider_paid_local_unpaid":
            callback = PaymentCallback(GATEWAY, order.order_no, answer.trade_no, order.amount,
                                       order.currency, account_binding(order.account_id))
            try:
                orders_svc.mark_paid(session, order.order_no, answer.trade_no,
                                     actor="reconcile:alipay", verified=callback)
                report["credits"].append({"order_no": order.order_no, "trade_no": answer.trade_no})
            except orders_svc.PaymentError as exc:
                report["mismatches"].append({"order_no": order.order_no, "local": order.status,
                                             "verdict": "credit_failed", "detail": str(exc)[:120]})
    return report


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true",
                        help="Credit provider-confirmed orders through mark_paid")
    parser.add_argument("--limit", type=int, default=200, help="Newest orders to check (1..1000)")
    args = parser.parse_args(argv)
    try:
        config = load_alipay_config()
    except PaymentConfigError:
        print(json.dumps({"mode": "apply" if args.apply else "dry_run",
                          "error": "Alipay channel is not configured"}), flush=True)
        return 2
    engine = db.init_db()
    try:
        with db.session_scope() as session:
            report = reconcile(session, config, limit=args.limit, apply=args.apply)
        print(json.dumps(report, ensure_ascii=False), flush=True)
        return 0 if not report["mismatches"] else 1
    finally:
        engine.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
