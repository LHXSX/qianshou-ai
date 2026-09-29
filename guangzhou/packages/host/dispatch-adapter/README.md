---
description: "Connect an autonomous Qianshou node to dispatch control frames through an injected transport session."
kind: "package-reference"
---

# Qianshou dispatch control adapter

English | [中文](README.zh.md)

## Summary

Provide a small, transport-neutral control-plane facade for an autonomous contributing agent. It composes the existing `NodeSessionConnector` for one authenticated session, forwards redacted heartbeats and capability metadata, delivers validated task invitations, and reports bounded progress and result manifests. It retains no credentials and never transfers media bytes, prices work, submits paid jobs or settles payments.

## Table of Contents

- [Use this package](#use-this-package)
- [Control-plane boundary](#control-plane-boundary)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>

## Use this package

Create `DispatchControlAdapter` with a deployment-owned `NodeSessionConnector`. Call `connect()` with the ephemeral access token and initial heartbeat, subscribe with `onTaskOffer()`, and use `publishHeartbeat()`, `reportProgress()` and `reportResult()` for control frames. The connector still owns endpoint allow-lists, TLS and the physical WebSocket, HTTP or QUIC implementation.

<a id="control-plane-boundary"></a>

## Control-plane boundary

The adapter composes existing `node-protocol`, `node-session` and `node-transport` contracts. Incoming offers have already passed parser validation; signature verification and node authorization remain deployment or dispatch-service responsibilities. Result reports contain only names, byte counts and SHA-256 digests. Input retrieval, output upload and task execution remain node-side adapters. Shanghai therefore sees scheduling metadata and control frames only.

<a id="model-experience"></a>

## Model Experience

This package exposes no model tools. An agent may use a separate resident loop and executor registry to act on an admitted offer; those packages decide policy and local execution independently.

<a id="known-limitations-and-deferred-work"></a>

## Known Limitations and Deferred Work

- No concrete network transport or production endpoint is included; this is an injectable seam.
- No lease reservation, quote, payment, settlement, input download or artifact upload API is defined here.
- The adapter cannot prove a remote dispatch service's signature or account authorization; those checks must precede `coordinateTask`.

<a id="dev-note"></a>

## Dev Note

Keep this package small. Do not add a convenience HTTP client, archive loader, model runtime or media relay. New protocol fields require a versioned upstream contract and fixtures in `compute-core` first.
