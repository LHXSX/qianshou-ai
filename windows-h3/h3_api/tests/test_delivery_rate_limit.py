"""No-GPU checks for the fixed five-second MP4 byte budget."""
from __future__ import annotations

import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from uuid import uuid4


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "workbench"))
from recipe_identity import RecipeIdentityError
from workbench_node import delivery_command, trim_delivery


class FixedDeliveryRateLimit(unittest.TestCase):
    def test_crf_and_conservative_vbv_audio_budget_are_fixed(self):
        command = delivery_command("source.mp4", "delivery.mp4", "ffmpeg")
        # Check each codec option directly: unrelated ffmpeg flags also take
        # arguments and cannot be safely parsed by alternating pairs.
        for option, value in (("-crf", "14"), ("-maxrate:v", "16M"),
                              ("-bufsize:v", "16M"), ("-b:a", "192k"),
                              ("-c:v", "libx264"), ("-c:a", "aac"),
                              ("-vf", "trim=end_frame=120,setpts=PTS-STARTPTS"),
                              ("-af", "atrim=end=5,asetpts=PTS-STARTPTS")):
            self.assertEqual(command[command.index(option) + 1], value)
        self.assertIn("-n", command)
        self.assertEqual(command[-1], "delivery.mp4")
        # The nominal five-second VBV envelope is 12,000,000 video bytes;
        # AAC's target adds 120,000 bytes. MP4 overhead has >4 MiB margin.
        self.assertLess((16_000_000 * 5 + 16_000_000 + 192_000 * 5) // 8,
                        16 * 1024 * 1024 - 4 * 1024 * 1024)

    def test_post_encode_hard_cap_rejects_oversize(self):
        root = Path(os.environ["H3_CANONICAL_TEST_ROOT"])
        self.assertTrue(root.is_absolute() and root.is_dir())
        directory = root / ("delivery-byte-cap-" + uuid4().hex)
        directory.mkdir()
        good = directory / "good.mp4"
        bad = directory / "oversize.mp4"
        good.write_bytes(b"small synthetic output")
        with bad.open("xb") as stream:
            stream.truncate(16 * 1024 * 1024 + 1)
        with patch("workbench_node.subprocess.run") as run:
            trim_delivery("source.mp4", good, "ffmpeg")
            self.assertEqual(run.call_count, 1)
            with self.assertRaisesRegex(RecipeIdentityError, "media limit"):
                trim_delivery("source.mp4", bad, "ffmpeg")


if __name__ == "__main__":
    unittest.main()
