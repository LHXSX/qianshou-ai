"""No-network negative controls for direct canonical entry points."""
from __future__ import annotations

from pathlib import Path
import base64
import importlib
import os
import sys
import unittest
from unittest.mock import patch
import uuid


API_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API_ROOT))
sys.path.insert(0, str(API_ROOT / "workbench"))
from workbench_node import (attested_request, normalize_attested_gateway_job,
                            profile, validate_payload)
from recipe_identity import RecipeIdentityError
from runner import request


class FixedEntryGates(unittest.TestCase):
    def test_actual_gateway_handler_passes_float_after_pydantic(self):
        base = os.environ.get("H3_CANONICAL_TEST_ROOT")
        if not base or not Path(base).is_absolute() or not sys.dont_write_bytecode:
            self.fail("Set absolute H3_CANONICAL_TEST_ROOT and run Python -B")
        root = Path(base) / ("gateway-duration-" + uuid.uuid4().hex)
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
            gateway = importlib.import_module("local_h3.app")
        body = gateway.GatewayJobBody(prompt="Synthetic fixed cell", workflow="qs_new4",
                                      preset="landscape_C", seconds=5, steps=4, seed=1)
        seen = []

        class ReachedControlledJob(Exception):
            pass

        def capture(req):
            seen.append(req)
            raise ReachedControlledJob()

        with patch.object(gateway, "_accepted_workflow", return_value="qs_new4"), patch.object(
                gateway.jobs, "create_job", side_effect=capture):
            with self.assertRaises(ReachedControlledJob):
                gateway.create_gateway_job(body, None)
        self.assertEqual(len(seen), 1)
        self.assertIs(type(seen[0]["seconds"]), float)
        self.assertEqual(seen[0]["seconds"], 5.0)
        normalized = normalize_attested_gateway_job(
            seen[0], {"expected": {}, "ownerRuntimeWitnessSha256": "c" * 64})
        self.assertIs(type(normalized["seconds"]), int)
        self.assertEqual(normalized["seconds"], 5)

    def test_gateway_duration_normalization_requires_raw_integer_and_attestation(self):
        first = base64.b64encode(b"\x89PNG\r\n\x1a\nsynthetic").decode("ascii")
        raw = {**profile(5), "prompt": "Synthetic fixed cell", "negative": "",
               "seed": 1, "ref_images": [{"role": "first",
                                         "url": "data:image/png;base64," + first}],
               "expected": {"executionRecipeSha256": "a" * 64,
                            "modelSha256": "b" * 64},
               "ownerRuntimeWitnessSha256": "c" * 64}
        attested = validate_payload(raw)
        # create_gateway_job coerces the already checked integer to float.
        gateway = {**raw, "seconds": float(raw["seconds"])}
        normalized = normalize_attested_gateway_job(gateway, attested)
        self.assertIs(type(normalized["seconds"]), int)
        self.assertEqual(normalized["seconds"], 5)
        self.assertIs(type(gateway["seconds"]), float)
        for invalid in (5.0, 4, 6, True, "5"):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                validate_payload({**raw, "seconds": invalid})
        for invalid in (None, "not-a-sha", 1):
            with self.subTest(witness=invalid), self.assertRaisesRegex(
                    ValueError, "H3_OWNER_RUNTIME_WITNESS_REQUIRED"):
                validate_payload({**raw, "ownerRuntimeWitnessSha256": invalid})
        with self.assertRaisesRegex(RecipeIdentityError, "H3_EXPECTED_IDENTITY_REQUIRED"):
            normalize_attested_gateway_job(gateway, None)
        with self.assertRaises(ValueError):
            normalize_attested_gateway_job({**gateway, "seconds": 4.0}, attested)

    def test_expected_identity_is_mandatory(self):
        with self.assertRaisesRegex(ValueError, "H3_EXPECTED_IDENTITY_REQUIRED"):
            attested_request({"workflow": "qs_new4", "seconds": 5, "steps": 4})

    def test_other_workflow_or_seconds_rejected(self):
        for seconds, workflow in ((3, "qs_new4"), (5, "qs_new8"), (6, "qs_new4")):
            with self.subTest(seconds=seconds, workflow=workflow), self.assertRaises(ValueError):
                profile(seconds, workflow)

    def test_standalone_runner_cannot_post_graph(self):
        with self.assertRaisesRegex(ValueError, "cannot submit graphs"):
            request("http://127.0.0.1:8188", "/prompt", {"graph": {}})


if __name__ == "__main__":
    unittest.main()
