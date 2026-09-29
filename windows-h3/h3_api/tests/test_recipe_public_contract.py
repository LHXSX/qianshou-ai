"""Pure no-GPU controls for the canonical public/private recipe split."""
from __future__ import annotations

from dataclasses import replace
from pathlib import Path
import sys
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "workbench"))
from recipe_identity import RecipeIdentity, RecipeIdentityError


def identity() -> RecipeIdentity:
    return RecipeIdentity(
        graph_sha256="a" * 64,
        model_sha256="b" * 64,
        model_set_sha256="b" * 64,
        source_sha256="c" * 64,  # old private source set; never in public recipe
        source_manifest_sha256="d" * 64,
        class_origin_sha256="e" * 64,
        model_asset_sha256={},
        model_asset_mtime_ns={},
    )


class PublicRecipeContract(unittest.TestCase):
    def test_paths_private_source_and_frame_do_not_change_public_recipe(self):
        first = identity()
        public = first.public_identity()
        self.assertEqual(public, first.identity_for("1" * 64, "2" * 64))
        self.assertEqual(public, first.identity_for("3" * 64, "4" * 64))
        self.assertEqual(public, replace(first, source_sha256="f" * 64,
                                         model_asset_mtime_ns={"unet": 123}).public_identity())
        for secret_fragment in ("C" + ":", "/" + "opt/", "firstFrame", "negativeSha"):
            self.assertNotIn(secret_fragment, repr(public))

    def test_each_public_input_changes_recipe_sha(self):
        baseline = identity()
        expected = baseline.public_identity()["executionRecipeSha256"]
        for field in ("graph_sha256", "model_sha256", "source_manifest_sha256", "class_origin_sha256"):
            changed = replace(baseline, **{field: "f" * 64})
            self.assertNotEqual(changed.public_identity()["executionRecipeSha256"], expected)

    def test_private_digest_shape_still_required(self):
        with self.assertRaises(RecipeIdentityError):
            identity().identity_for("not-a-sha", "2" * 64)


if __name__ == "__main__":
    unittest.main()
