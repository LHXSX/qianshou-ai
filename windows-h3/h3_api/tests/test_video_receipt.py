"""Isolated bounded delivery checks; no encoder, GPU, or network access."""
from __future__ import annotations

import hashlib
import importlib
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
import uuid


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "workbench"))
from recipe_identity import RecipeIdentityError
from workbench_node import read_receipted_video_bytes


class VideoReceipt(unittest.TestCase):
    def setUp(self):
        base = os.environ.get("H3_CANONICAL_TEST_ROOT")
        if not base or not Path(base).is_absolute() or not sys.dont_write_bytecode:
            self.fail("Set an explicit absolute H3_CANONICAL_TEST_ROOT and run Python -B")
        self.root = Path(base) / ("video-receipt-" + uuid.uuid4().hex)
        self.jobs = self.root / "jobs"
        self.id = "synthetic_job"
        self.folder = self.jobs / self.id
        self.folder.mkdir(parents=True)
        self.video = self.folder / "result.mp4"
        self.raw = b"\x00\x00\x00\x18ftypmp42synthetic-video"
        self.video.write_bytes(self.raw)
        self.job = {"id": self.id, "status": "done", "video": str(self.video),
                    "recipe_identity": {"actualAfterFinalDelivery": {
                        "deliverySize": len(self.raw),
                        "deliverySha256": hashlib.sha256(self.raw).hexdigest()}}}

    def test_exact_receipt_downloads_only_verified_bytes(self):
        self.assertEqual(read_receipted_video_bytes(self.jobs, self.id, self.job), self.raw)

    def test_same_size_post_receipt_edit_is_rejected(self):
        self.video.write_bytes(b"X" + self.raw[1:])
        with self.assertRaises(RecipeIdentityError):
            read_receipted_video_bytes(self.jobs, self.id, self.job)

    def test_parent_junction_to_external_identical_bytes_is_rejected(self):
        if os.name != "nt":
            self.skipTest("Windows junction negative control")
        external = self.root / "external"
        external.mkdir()
        (external / "result.mp4").write_bytes(self.raw)
        backup = self.root / "original-job-directory"
        self.folder.rename(backup)
        result = subprocess.run(["cmd", "/d", "/c", "mklink", "/J",
                                 str(self.folder), str(external)],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, "Isolated junction creation failed")
        with self.assertRaises(RecipeIdentityError):
            read_receipted_video_bytes(self.jobs, self.id, self.job)
        self.assertEqual((external / "result.mp4").read_bytes(), self.raw)
        self.assertEqual((backup / "result.mp4").read_bytes(), self.raw)

    def test_missing_receipt_and_oversize_are_rejected(self):
        self.job["recipe_identity"] = {}
        with self.assertRaises(RecipeIdentityError):
            read_receipted_video_bytes(self.jobs, self.id, self.job)
        self.job["recipe_identity"] = {"actualAfterFinalDelivery": {
            "deliverySize": 16 * 1024 * 1024 + 1,
            "deliverySha256": hashlib.sha256(self.raw).hexdigest()}}
        with self.assertRaises(RecipeIdentityError):
            read_receipted_video_bytes(self.jobs, self.id, self.job)

    def test_http_video_route_requires_verified_bytes(self):
        comfy = self.root / "comfy"
        input_root = self.root / "input/LocalAPI"
        output_root = self.root / "output/MiniMax_H3/LocalAPI"
        workflows = self.root / "workflows"
        for folder in (comfy, input_root, output_root, workflows):
            folder.mkdir(parents=True)
        values = {"H3_COMFY_BASE": "http://127.0.0.1:8188",
                  "H3_COMFY_ROOT": str(comfy),
                  "H3_ADAPTER_INPUT_ROOT": str(input_root),
                  "H3_ADAPTER_OUTPUT_ROOT": str(output_root),
                  "H3_JOBS_DIR": str(self.jobs),
                  "H3_WORKFLOW_DIR": str(workflows)}
        with patch.dict(os.environ, values):
            gateway = importlib.import_module("local_h3.app")
        with patch.object(gateway.jobs, "load_job", return_value=self.job):
            gateway.app.state.verified_video_bytes = None
            from fastapi import HTTPException
            with self.assertRaises(HTTPException) as blocked:
                gateway.get_video(self.id)
            self.assertEqual(blocked.exception.status_code, 503)
            gateway.app.state.verified_video_bytes = (
                lambda jid, job: read_receipted_video_bytes(self.jobs, jid, job))
            response = gateway.get_video(self.id)
            self.assertEqual(response.body, self.raw)
            self.assertEqual(response.media_type, "video/mp4")
            self.video.write_bytes(b"X" + self.raw[1:])
            with self.assertRaises(HTTPException) as blocked:
                gateway.get_video(self.id)
            self.assertEqual(blocked.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
