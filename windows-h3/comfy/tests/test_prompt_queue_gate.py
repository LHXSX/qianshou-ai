"""No-service queue-admission controls against an assembled patched server.py.

Set H3_CANONICAL_ASSEMBLED_COMFY to a fresh, source-only assembly. The route
body is extracted without importing Comfy, loading a model, or opening a port.
"""

from __future__ import annotations

import ast
import copy
import logging
import os
from pathlib import Path
import time
import types
import unittest
import uuid


class Request:
    def __init__(self, payload):
        self.payload = copy.deepcopy(payload)
        self.headers = {}

    async def json(self):
        return self.payload


class PromptQueueGateTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        root = os.environ.get("H3_CANONICAL_ASSEMBLED_COMFY", "")
        if not root:
            self.skipTest("source-only assembled Comfy root not provided")
        source = Path(root) / "server.py"
        if not source.is_file() or source.is_symlink():
            self.fail("assembled patched server.py is missing or linked")
        tree = ast.parse(source.read_bytes(), filename=str(source))
        cls = next(node for node in tree.body
                   if isinstance(node, ast.ClassDef) and node.name == "PromptServer")
        init = next(node for node in cls.body
                    if isinstance(node, ast.FunctionDef) and node.name == "__init__")
        matches = [node for node in ast.walk(init)
                   if isinstance(node, ast.AsyncFunctionDef) and node.name == "post_prompt"]
        self.assertEqual(len(matches), 1)
        route = matches[0]
        self.assertTrue(any(isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute)
                            and dec.func.attr == "post" and len(dec.args) == 1 and
                            isinstance(dec.args[0], ast.Constant) and dec.args[0].value == "/prompt"
                            for dec in route.decorator_list))
        self.init_ast = init
        self.assertTrue(any(isinstance(node, ast.Nonlocal) and
                            "qs_h3_prompt_guard" in node.names for node in ast.walk(init)))
        calls = [node for node in ast.walk(route) if isinstance(node, ast.Call)]
        guard_calls = [node for node in calls if isinstance(node.func, ast.Name) and
                       node.func.id == "qs_h3_prompt_guard"]
        puts = [node for node in calls if isinstance(node.func, ast.Attribute) and
                node.func.attr == "put" and isinstance(node.func.value, ast.Attribute) and
                node.func.value.attr == "prompt_queue"]
        self.assertEqual(len(guard_calls), 1)
        self.assertEqual(len(puts), 1)
        self.assertLess(guard_calls[0].lineno, puts[0].lineno)
        self.assertFalse(any(guard_calls[0].lineno < node.lineno < puts[0].lineno
                             for node in ast.walk(route) if isinstance(node, ast.Await)))

        extracted = copy.deepcopy(route)
        extracted.decorator_list = []
        module = ast.fix_missing_locations(ast.Module(body=[extracted], type_ignores=[]))

        async def validate_prompt(*_args):
            return True, None, ["synthetic-output"], {}

        self.queued = []
        self.pre_hook = []

        def trigger(payload):
            self.pre_hook.append("qs_h3_expected_process_token" in payload)
            payload["qs_h3_expected_process_token"] = "injected-by-hook"
            return payload

        fake_server = types.SimpleNamespace(
            number=0,
            trigger_on_prompt=trigger,
            node_replace_manager=types.SimpleNamespace(apply_replacements=lambda _: None),
            prompt_queue=types.SimpleNamespace(put=self.queued.append),
        )
        self.context = {
            "self": fake_server, "logging": logging, "time": time, "uuid": uuid,
            "execution": types.SimpleNamespace(validate_prompt=validate_prompt,
                                               SENSITIVE_EXTRA_DATA_KEYS=()),
            "web": types.SimpleNamespace(json_response=lambda value, status=200: (status, value)),
        }
        exec(compile(module, str(source), "exec", dont_inherit=True), self.context)
        self.route = self.context["post_prompt"]

    def test_core_registration_closure_accepts_once_and_rejects_replacement(self):
        selected = []
        for node in self.init_ast.body:
            if isinstance(node, ast.Assign):
                targets = [target.id if isinstance(target, ast.Name) else
                           target.attr if isinstance(target, ast.Attribute) else ""
                           for target in node.targets]
                if any(name in {"qs_h3_prompt_guard", "qs_h3_register_prompt_guard",
                                "qs_h3_prompt_guard_is"} for name in targets):
                    selected.append(copy.deepcopy(node))
            elif isinstance(node, ast.FunctionDef) and node.name == "register_qs_h3_prompt_guard":
                selected.append(copy.deepcopy(node))
        self.assertEqual(len(selected), 4)
        setup = ast.FunctionDef(
            name="setup_guard", args=ast.arguments(posonlyargs=[],
                                                   args=[ast.arg(arg="self")], vararg=None,
                                                   kwonlyargs=[], kw_defaults=[], kwarg=None,
                                                   defaults=[]),
            body=selected, decorator_list=[], returns=None, type_comment=None,
        )
        module = ast.fix_missing_locations(ast.Module(body=[setup], type_ignores=[]))
        namespace = {}
        exec(compile(module, "<assembled server guard registration>", "exec",
                     dont_inherit=True), namespace)
        holder = types.SimpleNamespace()
        namespace["setup_guard"](holder)
        first = lambda token: token
        holder.qs_h3_register_prompt_guard(first)
        self.assertTrue(holder.qs_h3_prompt_guard_is(first))
        with self.assertRaises(RuntimeError):
            holder.qs_h3_register_prompt_guard(lambda token: token)
        self.assertTrue(holder.qs_h3_prompt_guard_is(first))

    async def test_missing_wrong_stale_or_unregistered_token_never_enters_queue(self):
        current = "a" * 64

        def strict_guard(value):
            if value != current:
                raise RuntimeError("wrong process")

        for token, guard in ((None, strict_guard), ("b" * 64, strict_guard),
                             ("c" * 64, strict_guard), (current, None)):
            with self.subTest(token=token, registered=guard is not None):
                self.context["qs_h3_prompt_guard"] = guard
                payload = {"prompt": {}, "extra_data": {}, "prompt_id": None}
                if token is not None:
                    payload["qs_h3_expected_process_token"] = token
                status, body = await self.route(Request(payload))
                self.assertEqual(status, 409)
                self.assertEqual(body["error"]["type"], "qs_h3_source_identity_changed")
                self.assertEqual(self.queued, [])
                self.assertFalse(self.pre_hook[-1])

    async def test_current_token_admits_once_and_is_removed_before_hooks_and_queue(self):
        current = "a" * 64
        seen = []
        self.context["qs_h3_prompt_guard"] = lambda token: seen.append(token)
        payload = {"prompt": {}, "qs_h3_expected_process_token": current,
                   "extra_data": {"qs_h3_expected_process_token": "nested-copy"}}
        status, body = await self.route(Request(payload))
        self.assertEqual(status, 200)
        self.assertEqual(len(self.queued), 1)
        self.assertEqual(seen, [current])
        self.assertFalse(self.pre_hook[-1])
        self.assertNotIn("qs_h3_expected_process_token", self.queued[0][3])
        self.assertIn("prompt_id", body)


if __name__ == "__main__":
    unittest.main()
