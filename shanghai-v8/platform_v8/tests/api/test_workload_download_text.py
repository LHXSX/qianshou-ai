import json

from platform_v8.api.v8 import workloads


def test_ordered_concat_download_uses_text_instead_of_summary():
    raw = json.dumps({
        "status": "ok",
        "task_type": "pdf_to_text",
        "text": "第一份 PDF 正文\n\n第二份 PDF 正文",
        "summary_text": "按顺序合并 1 个分片 · 共 20 字符",
    }, ensure_ascii=False)

    result = workloads._human_text_from_manifest(
        raw,
        "pdf_to_text",
        owner_id=11,
    )

    assert result == ("第一份 PDF 正文\n\n第二份 PDF 正文\n", ".txt")


def test_ordered_concat_download_resolves_nested_object_key(monkeypatch):
    object_key = "v8/account-11/shard/result/output.json"
    raw = json.dumps({
        "status": "ok",
        "task_type": "pdf_to_text",
        "text": object_key,
        "summary_text": "按顺序合并 1 个分片 · 共 44 字符",
    }, ensure_ascii=False)
    monkeypatch.setattr(
        workloads,
        "_human_text_from_object_key",
        lambda key, task_type, *, owner_id: ("真实 PDF 正文\n", ".txt")
        if key == object_key and task_type == "pdf_to_text" and owner_id == 11
        else None,
    )

    result = workloads._human_text_from_manifest(
        raw,
        "pdf_to_text",
        owner_id=11,
    )

    assert result == ("真实 PDF 正文\n", ".txt")


def test_strip_inline_binaries_drops_images_keeps_contract():
    raw = json.dumps({
        "status": "ok",
        "task_type": "image_compress",
        "result_images_b64": {"a.jpg": "aaaa" * 40},
        "compressed_count": 1,
    })
    out = json.loads(workloads._strip_inline_binaries(raw))
    assert "result_images_b64" not in out
    assert out["task_type"] == "image_compress"
    assert out["compressed_count"] == 1


def test_aggregator_manifest_detected_for_zip_files():
    raw = json.dumps({
        "status": "ok",
        "schema_version": "v1",
        "task_type": "image_compress",
        "download_url": "http://192.168.2.215:8000/api/v8/oss/local/download/v8/account-1/results/x.zip",
        "preview_url": "http://192.168.2.215:8000/api/v8/oss/local/download/v8/account-1/results/x/preview.jpg",
        "summary": {"download_kind": "zip", "total_files": 1},
    })
    assert workloads._looks_like_aggregator_manifest(raw)


def test_artifact_v1_is_not_aggregator_manifest():
    raw = json.dumps({
        "schema": "artifact.v1",
        "object_key": "v8/account-1/a.json",
        "filename": "results.json",
    })
    assert not workloads._looks_like_aggregator_manifest(raw)


def test_hash_lines_merge_payload_is_aggregator_manifest():
    raw = json.dumps({
        "status": "ok",
        "schema_version": "v1",
        "task_type": "hash_batch",
        "result_lines": ["abc\tline"],
        "results": [{"hash": "abc", "input": "line"}],
    })
    assert workloads._looks_like_aggregator_manifest(raw)


def test_empty_lines_merge_is_not_aggregator_manifest():
    raw = json.dumps({
        "status": "ok",
        "task_type": "hash_batch",
        "result_lines": [],
        "summary_text": "合并 1 个分片 · 共 0 条结果",
    })
    assert not workloads._looks_like_aggregator_manifest(raw)


def test_public_result_token_unwraps_json_artifact(monkeypatch):
    envelope = json.dumps({
        "schema": "artifact.v1",
        "object_key": "v8/account-1/x/output.json",
        "filename": "output.json",
        "content_type": "application/json",
    })
    inner = {"capability": "crypto.hash", "results": [{"digest": "ff", "filename": "a"}]}
    monkeypatch.setattr(
        "platform_v8.engine.aggregators.zip_files._download_object_bytes",
        lambda key, **kw: json.dumps(inner).encode(),
    )
    monkeypatch.setattr(workloads, "_resolve_result_token", lambda t, owner_id: t)
    out = json.loads(workloads._public_result_token(envelope, owner_id=1))
    assert out["results"][0]["digest"] == "ff"
    assert out.get("schema") != "artifact.v1"


def test_owned_local_download_url_requires_account_namespace():
    url = (
        "http://192.168.2.215:8000/api/v8/oss/local/download/"
        "v8/account-1/results/x.zip?expires=1&sig=ab"
    )
    assert workloads._owned_local_download_url(url, owner_id=1) == url
    assert workloads._owned_local_download_url(url, owner_id=2) is None
    assert workloads._owned_local_download_url("https://evil.example/x.zip", owner_id=1) is None
