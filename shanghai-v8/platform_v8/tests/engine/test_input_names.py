"""Tests for shard input filename resolution."""
from platform_v8.engine.slicers.input_names import resolve_entry_name


def test_object_key_basename_beats_generic_input_name():
    name = resolve_entry_name(
        "v8/account-11/direct/abc-sample.png",
        {},
        index=0,
        params={"input_name": "sample.png"},
    )
    assert name.endswith(".png")
    assert "sample" in name


def test_generic_input_zero_uses_object_key_ext():
    name = resolve_entry_name(
        "v8/account-11/direct/4ec0ac00-sample.png",
        {"name": "input-0"},
        index=0,
        params={},
    )
    assert name == "4ec0ac00-sample.png"


def test_content_type_extends_generic_stem():
    name = resolve_entry_name(
        "v8/account-11/direct/deadbeef",
        {"name": "input-0", "content_type": "image/png"},
        index=0,
        params={},
    )
    assert name.endswith(".png")


def test_params_input_name_used_when_batch_missing():
    name = resolve_entry_name(
        "v8/x/y",
        {},
        index=0,
        params={"input_name": "clip.mp4"},
    )
    assert name == "clip.mp4"


def test_singular_input_name_does_not_stamp_later_files():
    used: set[str] = set()
    first = resolve_entry_name(
        "v8/account-1/unassigned/input/5b20eb2a05d44938-321.txt",
        {},
        index=0,
        params={"input_name": "321.txt"},
        used=used,
    )
    second = resolve_entry_name(
        "v8/account-1/unassigned/input/89583c2001cf4e93-123.txt",
        {},
        index=1,
        params={"input_name": "321.txt"},
        used=used,
    )
    assert first == "321.txt"
    assert second != first
    assert "123.txt" in second


def test_duplicate_basenames_are_uniquified():
    used: set[str] = set()
    a = resolve_entry_name("v8/a/readme.txt", {"name": "readme.txt"}, index=0, used=used)
    b = resolve_entry_name("v8/b/readme.txt", {"name": "readme.txt"}, index=1, used=used)
    assert a == "readme.txt"
    assert b == "readme-1.txt"

