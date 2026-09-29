# Windows H3 source kit: license scope

Copyright 2026 Qianshou project contributors.

The Qianshou-authored API, GPU slot, installer, launch and verification code,
source-attestation node, documentation, tests, and source-kit metadata in this
directory are offered under the Apache License, Version 2.0. See [LICENSE](LICENSE).
The `origin.license` field of each `manifest.json` file record identifies its
actual license; this notice does not override a record marked with a different
license.

The following material keeps its own license:

- `comfy/custom_nodes/h3_benchmark_sampler/`: GPL-3.0-or-later, with its own
  `LICENSE` and `COPYING` files. Its copyright and license text are preserved.
- `comfy/patches/comfyui-0.30.0.patch` and
  `comfy/additions/comfy/minimax_lora_guard.py`: GPL-3.0 changes to ComfyUI.
- `comfy/patches/kjnodes-1.3.9.patch`: GPL-3.0 changes to ComfyUI-KJNodes.
- The pinned upstream source trees assembled later: ComfyUI, KJNodes and
  VideoHelperSuite are GPL-3.0; LayerStyle is MIT. Their source, notices and
  license files come from the pinned upstream commits. Exact origins, commits,
  trees and license hashes are in `comfy/vendor-lock.json`.

Model weights, FFmpeg, Python, wheels and the vendor Git trees are not included
in this source kit. Their own distribution terms apply when obtained separately.
The SHA-256 manifest and source attestation describe reproducible source bytes;
they do not replace any license or prove a Windows GPU run.

This kit's license does not apply to the separate Shanghai V8 engine.
