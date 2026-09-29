"""RT-B unit tests: runtime_match + plugin shard_assign frame."""
from __future__ import annotations

from platform_v8.services import runtime_match as rm


def test_normalize_cap_names_mixed():
    assert rm.normalize_cap_names(["fs.read", {"name": "json"}, "fs.read", {"id": "net.http"}]) == [
        "fs.read", "json", "net.http",
    ]


def test_publish_capabilities_reject_bad():
    try:
        rm.validate_capabilities_for_publish(["bad name with spaces"])
        assert False, "should raise"
    except ValueError:
        pass
    try:
        rm.validate_capabilities_for_publish(["fs.read"])
        assert False, "demo name should fail"
    except ValueError:
        pass
    assert "doc.ocr" in rm.validate_capabilities_for_publish(["doc.ocr", "llm.text.complete"])


def test_runtime_api_major_match():
    assert rm.runtime_api_compatible("1.0.0", "1.2.3")
    assert not rm.runtime_api_compatible("1.0.0", "2.0.0")
    assert rm.runtime_api_compatible("", "1.0.0")  # loose
    assert rm.HOST_API_VERSION == "1.0.0"


def test_flatten_hello_caps_flat_and_nested():
    flat = rm.flatten_runtime_caps({
        "runtime_api": "1.0.0",
        "implemented": ["doc.ocr", "llm.text.complete"],
        "stubbed": ["media.transcribe"],
        "supported_executors": ["python3", "plugin.v1"],
        "dispatch_covered": 23,
    })
    assert flat["runtime_api"] == "1.0.0"
    assert "doc.ocr" in flat["implemented"]
    assert flat["dispatch_covered"] == 23
    assert "plugin.v1" in flat["supported_executors"]

    nested = rm.flatten_runtime_caps({
        "runtime": {"api": "1.1.0", "implemented": ["doc.pdf.text"]},
        "supported_executors": ["plugin.v1"],
        "dispatch_covered": True,
    })
    assert nested["runtime_api"] == "1.1.0"
    assert nested["implemented"] == ["doc.pdf.text"]
    assert nested["dispatch_covered"] == len(rm.KNOWN_CAPABILITY_NAMES)


def test_match_runtime_plugin_executor():
    worker_caps = {
        "runtime_api": "1.0.0",
        "implemented": ["doc.ocr", "llm.text.complete"],
        "stubbed": ["media.transcribe"],
        "supported_executors": ["plugin.v1", "python3"],
    }
    ok, reason = rm.match_runtime(
        required_caps=["doc.ocr", "media.transcribe"],
        required_runtime_api="1.2.0",
        worker_or_caps=worker_caps,
        allow_stubbed=True,
        require_executor="plugin.v1",
    )
    assert ok, reason

    ok2, _ = rm.match_runtime(
        required_caps=["doc.ocr"],
        required_runtime_api="1.0.0",
        worker_or_caps={"implemented": ["doc.ocr"], "supported_executors": ["python3"]},
        require_executor="plugin.v1",
    )
    assert not ok2


def test_sanitize_plugin_block():
    assert rm.sanitize_plugin_block({"entry": "main"}) is None
    p = rm.sanitize_plugin_block({
        "code_url": "https://www.qianshousuanli.com/p.js",
        "entry": "run",
        "capabilities": ["doc.ocr"],
        "allowRemote": False,
        "budget": 1.5,
    })
    assert p is not None
    assert p["code_url"].startswith("https://")
    assert p["entry"] == "run"
    assert p["capabilities"] == ["doc.ocr"]
    assert p["allowRemote"] is False


