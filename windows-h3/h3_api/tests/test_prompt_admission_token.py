"""No-network graph admission token contract for canonical Comfy."""
from __future__ import annotations

import importlib
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
import uuid


API_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API_ROOT))


class PromptAdmissionToken(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        base = os.environ.get("H3_CANONICAL_TEST_ROOT")
        if not base or not Path(base).is_absolute() or not sys.dont_write_bytecode:
            raise RuntimeError("Set absolute H3_CANONICAL_TEST_ROOT and run Python -B")
        root = Path(base) / ("prompt-admission-" + uuid.uuid4().hex)
        comfy_root = root / "comfy"
        input_root = root / "input" / "LocalAPI"
        output_root = root / "output" / "MiniMax_H3" / "LocalAPI"
        workflow_root = root / "workflows"
        jobs_root = root / "jobs"
        for folder in (comfy_root, input_root, output_root, workflow_root, jobs_root):
            folder.mkdir(parents=True)
        values = {"H3_COMFY_BASE": "http://127.0.0.1:8190",
                  "H3_COMFY_ROOT": str(comfy_root),
                  "H3_ADAPTER_INPUT_ROOT": str(input_root),
                  "H3_ADAPTER_OUTPUT_ROOT": str(output_root),
                  "H3_WORKFLOW_DIR": str(workflow_root),
                  "H3_JOBS_DIR": str(jobs_root)}
        with patch.dict(os.environ, values):
            cls.comfy = importlib.import_module("local_h3.comfy")

    def test_only_explicit_current_process_token_is_sent(self):
        graph = {"1": {"class_type": "Synthetic"}}
        with patch.object(self.comfy, "http_json",
                          return_value={"prompt_id": "synthetic", "node_errors": {}}) as send:
            self.assertEqual(self.comfy.submit_graph(
                graph, client_id="h3api-synthetic",
                qs_h3_expected_process_token="a" * 64), "synthetic")
            route, body = send.call_args.args
            self.assertEqual(route, "/prompt")
            self.assertEqual(body, {
                "client_id": "h3api-synthetic", "prompt": graph,
                "qs_h3_expected_process_token": "a" * 64,
            })
            self.assertEqual(send.call_args.kwargs["timeout"], 90)

    def test_missing_or_malformed_token_cannot_reach_prompt(self):
        with patch.object(self.comfy, "http_json") as send:
            with self.assertRaises(TypeError):
                self.comfy.submit_graph({})
            for value in (None, "", "not-a-token", "A" * 64):
                with self.subTest(value=value), self.assertRaises(RuntimeError):
                    self.comfy.submit_graph({}, qs_h3_expected_process_token=value)
            send.assert_not_called()

    def test_comfy_identity_rejection_never_yields_prompt_receipt(self):
        body = json.dumps({"error": {"type": "qs_h3_source_identity_changed"}}).encode("utf-8")
        rejected = HTTPError("http://127.0.0.1:8190/prompt", 409, "identity changed",
                             {}, io.BytesIO(body))
        with patch.object(self.comfy.urllib.request, "urlopen", side_effect=rejected):
            with self.assertRaisesRegex(RuntimeError, "H3_COMFY_PROCESS_IDENTITY_CHANGED"):
                self.comfy.submit_graph({}, client_id="h3api-synthetic",
                                        qs_h3_expected_process_token="a" * 64)


if __name__ == "__main__":
    unittest.main()
