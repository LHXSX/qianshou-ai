---
description: "Provider-neutral commercial contracts for subscriptions, task budgets, payment intents, refunds and node earnings."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-billing-contract

English | [中文](README.zh.md)

## Summary

A small, pure-data boundary for Qianshou commercial state. It validates versioned subscription entitlements, task budget authorizations, quote confirmations, idempotent payment intents, refund/webhook events and node earnings ledger entries. It performs no network I/O, payment, entitlement grant, refund, settlement or task submission.

## Table of Contents

- [Use this package](#use-this-package)
- [Architecture boundary](#architecture-boundary)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Call the `parse*` functions at an adapter boundary and persist the returned immutable records in an account or platform store. Amounts are integer CNY minor units (fen); timestamps are canonical UTC ISO strings. Every write adapter should reuse the supplied idempotency key and retain provider event IDs and payload digests for deduplication.

## Architecture boundary

The contracts deliberately separate a quote confirmation, a task budget authorization and a payment intent. A successful payment event does not by itself authorize task execution; a scheduler must verify account ownership, quote freshness, budget status and policy. Node earnings are append-only accounting facts with explicit reversal links. Webhook records contain opaque provider references and a digest, never raw provider payloads or credentials.

Future adapters can implement Apple StoreKit, Google Play Billing, a web payment provider, a subscription service and a platform ledger behind these contracts. Those adapters own signature verification, server receipts, idempotency storage, entitlement policy, currency conversion policy, refund handling and payout compliance. No provider API is invented here.

## Model Experience

This package contributes no model tools, prompts or agent actions. A host may expose read-only entitlement and payment state through an authenticated UI. User approval and payment UX remain in platform adapters.

## Known Limitations and Deferred Work

- Only CNY is admitted until multi-currency accounting and rounding rules are specified.
- Contracts are process-independent records; durable stores, transaction isolation and reconciliation jobs remain platform work.
- StoreKit, Play Billing, web checkout, tax, payouts and real webhook signature verification are intentionally absent.

### Dev Note

Keep this package transport-free. Do not add fetch calls, SDK imports, card data, receipt blobs or automatic spending decisions. Add a new versioned contract when semantics change rather than silently widening an existing record.
