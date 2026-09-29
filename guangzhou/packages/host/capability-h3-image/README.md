---
description: "Optional H3 image reference fixture proving the generic node-owned capability seam; not a product capability."
kind: "package-reference"
---

# H3 image capability reference fixture (optional)

English | [中文](README.zh.md)

## Summary

This package is not a default Qianshou product capability and does not provide H3, image, or any model. It is an optional reference fixture for verifying the generic seam: a node-owned capability is advertised by the node agent, matched by exact version at dispatch, and invoked through a node-local executor. The fixture declares `image.generate@1.0.0`, shapes a bounded prompt, adapts an injected local renderer, and returns a workspace-contained SHA-256 output reference.

## Table of Contents

- [Usage](#usage)
- [Model experience](#model-experience)
- [Known limitations](#known-limitations)
- [Dev Note](#dev-note)

<a id="usage"></a>

## Usage

Use `createH3ImageExecutor` only for tests or node-adapter development, with permissions granted by a verified install plan and a renderer owned by that node. Register the result in `ComputeExecutorRegistry`. The renderer owns local model invocation and writes only inside the controlled workspace path supplied in the request. Qianshou does not install, host, or promise this capability.

<a id="model-experience"></a>

## Model experience

The test agent can discover an exact capability/version from a node advertisement, produce a stable prompt envelope, report `prepare` and `complete`, and hand the artifact service a digest reference without copying image bytes through the host control plane. This does not mean Qianshou provides image generation.

<a id="known-limitations"></a>

## Known limitations

No model weights, H3 SDK, hosted API, market transport, billing, or package loader is included. H3 remains a non-product reference; a real capability must be installed, self-tested and advertised by its node. The dispatch center must never infer a capability from hardware alone.

<a id="development-note"></a>

## Dev Note

Keep this fixture declarative and dependency-light, and keep it out of default profiles and Web bundles. Add platform adapters as separate node-owned packages and preserve autonomous execution, cancellation, controlled workspace, and exact version selection. Adding image, video or another capability should add a node adapter and advertisement, not a dispatch-core branch.
