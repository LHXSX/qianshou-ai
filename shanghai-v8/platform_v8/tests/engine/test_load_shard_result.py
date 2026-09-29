import json

from platform_v8.engine.aggregators import zip_files


def test_load_shard_result_unwraps_output_json(monkeypatch):
    envelope = json.dumps({
        "schema": "artifact.v1",
        "object_key": "v8/account-1/x/output.json",
        "filename": "output.json",
        "content_type": "application/json",
    })
    inner = {
        "capability": "crypto.hash",
        "results": [{"filename": "a.txt", "digest": "aa", "algorithm": "sha256"}],
    }
    monkeypatch.setattr(
        zip_files,
        "_download_object_bytes",
        lambda key, **kw: json.dumps(inner).encode() if key.endswith("output.json") else b"",
    )
    data = zip_files.load_shard_result(envelope)
    assert data["results"][0]["digest"] == "aa"
    assert data.get("schema") != "artifact.v1"
    assert json.loads(zip_files.materialize_output_ref(envelope))["capability"] == "crypto.hash"


def test_load_shard_result_unwraps_zip_results_json(monkeypatch):
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            "results.json",
            json.dumps({
                "capability": "text.stats",
                "legacyTaskType": "word_count",
                "results": [{
                    "filename": "a.txt",
                    "op": "word_count",
                    "status": "ok",
                    "top": [{"word": "你好", "count": 3}],
                }],
            }),
        )
    zip_bytes = buf.getvalue()

    envelope = json.dumps({
        "schema": "artifact.v1",
        "object_key": "v8/account-1/x/text-stats-word_count-batch.zip",
        "filename": "text-stats-word_count-batch.zip",
        "content_type": "application/zip",
        "size_bytes": len(zip_bytes),
    })
    monkeypatch.setattr(
        zip_files,
        "_download_object_bytes",
        lambda key, **kw: zip_bytes if key.endswith(".zip") else b"",
    )
    data = zip_files.load_shard_result(envelope)
    assert data["capability"] == "text.stats"
    assert data["results"][0]["top"][0]["word"] == "你好"
    assert data.get("schema") != "artifact.v1"
    arts = data.get("artifacts") or []
    assert arts and arts[0].get("object_key", "").endswith(".zip")
    dumped = json.loads(zip_files.materialize_output_ref(envelope))
    assert dumped["legacyTaskType"] == "word_count"


def test_load_shard_result_skips_jpg_without_download(monkeypatch):
    envelope = json.dumps({
        "schema": "artifact.v1",
        "object_key": "v8/account-1/x/a.jpg",
        "filename": "preview.jpg",
        "content_type": "image/jpeg",
    })
    called: list[str] = []
    monkeypatch.setattr(
        zip_files,
        "_download_object_bytes",
        lambda key, **kw: called.append(key) or b"\xff\xd8",
    )
    data = zip_files.load_shard_result(envelope)
    assert data["schema"] == "artifact.v1"
    assert called == []
    assert zip_files.materialize_output_ref(envelope) == envelope


def test_load_shard_result_parses_checksums_txt(monkeypatch):
    envelope = json.dumps({
        "schema": "artifact.v1",
        "object_key": "v8/account-1/x/checksums.sha256.txt",
        "filename": "checksums.sha256.txt",
        "content_type": "text/plain",
    })
    monkeypatch.setattr(
        zip_files,
        "_download_object_bytes",
        lambda key, **kw: b"deadbeef  notes.txt\n",
    )
    data = zip_files.load_shard_result(envelope)
    assert data["capability"] == "crypto.hash"
    assert data["results"][0]["digest"] == "deadbeef"
    assert data["results"][0]["filename"] == "notes.txt"


def test_normalize_unwraps_runtime_envelope():
    inner = zip_files._normalize_capability_json({
        "ok": True,
        "providerId": "official",
        "artifacts": [],
        "raw": {
            "capability": "text.lines",
            "legacyTaskType": "dedup_lines",
            "results": [{"filename": "a.txt", "text": "正文一行", "op": "dedup"}],
        },
    })
    assert inner["capability"] == "text.lines"
    assert inner["results"][0]["text"] == "正文一行"
    dumped = json.loads(zip_files.materialize_output_ref(json.dumps({
        "ok": True,
        "artifacts": [],
        "raw": {"result_lines": ["alpha", "beta"], "task_type": "text_replace"},
    })))
    assert "alpha" in dumped["results"][0]["text"]
    assert dumped["result_text"].startswith("alpha")


def test_alias_result_list_copies_script_result_array():
    out = zip_files._alias_result_list({
        "task_type": "md5_batch",
        "result": [{"input": "a", "hash": "0"}],
    })
    assert out["results"][0]["hash"] == "0"
