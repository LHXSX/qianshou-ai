"""Loopback-only source attestation for the fixed qs_new4 H3 graph.

Importing this custom node registers a read-only route. It does not run a model,
create an output, or modify the Comfy job queue.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import sys

from aiohttp import web
import folder_paths
import nodes
from comfy.cli_args import args
from server import PromptServer

from .attestor import SourceAttestor, SourceIdentityError, loopback_request_ok


if os.name != "nt":
    raise RuntimeError("H3 canonical source attestor requires Windows")
if not sys.dont_write_bytecode:
    raise RuntimeError("H3 canonical Comfy must start with Python -B")
if args.listen not in ("127.0.0.1", "::1"):
    raise RuntimeError("H3 canonical Comfy must bind one loopback address")
if PromptServer.instance is None:
    raise RuntimeError("Comfy PromptServer is unavailable")

_COMFY_ROOT = Path(os.path.abspath(Path(__file__).parents[2]))
_MANIFEST = os.environ.get("H3_CANONICAL_MANIFEST_PATH", "")
_ATTESTOR = SourceAttestor(_COMFY_ROOT, Path(_MANIFEST), nodes.NODE_CLASS_MAPPINGS)
_ATTESTOR.verify_custom_node_roots(folder_paths.get_folder_paths("custom_nodes"))
_ATTESTOR.verify_prompt_handler(PromptServer.instance)


def _guard_prompt_submission(expected_process_token: str) -> None:
    """Comfy server calls this synchronously immediately before queue.put."""
    _ATTESTOR.verify_prompt_handler(PromptServer.instance, _guard_prompt_submission)
    if nodes.NODE_CLASS_MAPPINGS is not _ATTESTOR.registry:
        raise SourceIdentityError("Comfy node registry was replaced")
    _ATTESTOR.verify_custom_node_roots(folder_paths.get_folder_paths("custom_nodes"))
    _ATTESTOR.guard_submission(expected_process_token)
    _ATTESTOR.verify_prompt_handler(PromptServer.instance, _guard_prompt_submission)
    if nodes.NODE_CLASS_MAPPINGS is not _ATTESTOR.registry:
        raise SourceIdentityError("Comfy node registry was replaced")
    _ATTESTOR.verify_custom_node_roots(folder_paths.get_folder_paths("custom_nodes"))


PromptServer.instance.qs_h3_register_prompt_guard(_guard_prompt_submission)
_ATTESTOR.verify_prompt_handler(PromptServer.instance, _guard_prompt_submission)


@PromptServer.instance.routes.post("/qs-h3/v1/source-attestation")
async def source_attestation(request: web.Request) -> web.Response:
    transport = request.transport
    peer = transport.get_extra_info("peername") if transport else None
    local = transport.get_extra_info("sockname") if transport else None
    listener = getattr(PromptServer.instance, "address", None)
    if (not isinstance(listener, str) or not peer or not local
            or not loopback_request_ok(listener, local[0], peer[0])):
        return web.json_response({"code": "loopback_required"}, status=403)
    try:
        raw = await request.content.read(4097)
        if len(raw) > 4096 or not request.content.at_eof():
            return web.json_response({"code": "invalid_request"}, status=400)
        body = json.loads(raw.decode("utf-8"))
    except (UnicodeError, ValueError):
        return web.json_response({"code": "invalid_request"}, status=400)
    try:
        _ATTESTOR.verify_prompt_handler(PromptServer.instance, _guard_prompt_submission)
        if nodes.NODE_CLASS_MAPPINGS is not _ATTESTOR.registry:
            raise SourceIdentityError("Comfy node registry was replaced")
        _ATTESTOR.verify_custom_node_roots(folder_paths.get_folder_paths("custom_nodes"))
        result = await asyncio.to_thread(_ATTESTOR.attest, body)
        _ATTESTOR.verify_prompt_handler(PromptServer.instance, _guard_prompt_submission)
        if nodes.NODE_CLASS_MAPPINGS is not _ATTESTOR.registry:
            raise SourceIdentityError("Comfy node registry was replaced")
        _ATTESTOR.verify_custom_node_roots(folder_paths.get_folder_paths("custom_nodes"))
    except SourceIdentityError:
        return web.json_response({"code": "source_identity_changed"}, status=409)
    except Exception:
        # No local file path or inventory detail crosses the route.
        return web.json_response({"code": "source_attestation_unavailable"}, status=503)
    return web.json_response({**result, "queueAdmissionGuardVersion": 1})


NODE_CLASS_MAPPINGS = {}
