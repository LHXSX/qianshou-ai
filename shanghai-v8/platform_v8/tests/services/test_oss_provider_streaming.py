from __future__ import annotations

import hashlib
import io

import pytest

from platform_v8.services.oss_provider import (
    AliyunOSSProvider,
    LocalFallbackProvider,
    OSSConfig,
    S3CompatibleProvider,
    StreamIntegrityError,
)


class _Body(io.BytesIO):
    pass


class _FakeS3:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def get_object(self, *, Bucket, Key):
        return {"Body": _Body(self.objects[Key])}

    def put_object(self, **kwargs):
        self.objects[kwargs["Key"]] = kwargs["Body"].read()
        return {}


def _s3_provider() -> S3CompatibleProvider:
    provider = object.__new__(S3CompatibleProvider)
    provider.config = OSSConfig(provider="s3", prefix="")
    provider.bucket = "test"
    provider._internal = _FakeS3()
    return provider


def _memory_aliyun(monkeypatch) -> tuple[AliyunOSSProvider, dict[str, bytes]]:
    provider = AliyunOSSProvider(OSSConfig(
        provider="aliyun",
        endpoint="https://oss.example.test",
        bucket="test",
        access_key_id="test-id",
        access_key_secret="test-secret",
    ))
    objects: dict[str, bytes] = {}

    def _iter(key, *, chunk_size=1024 * 1024):
        body = objects[key]
        for offset in range(0, len(body), chunk_size):
            yield body[offset:offset + chunk_size]

    def _put(key, source, *, size_bytes, content_type):
        body = source.read()
        assert len(body) == size_bytes
        objects[key] = body
        return key

    monkeypatch.setattr(provider, "iter_object", _iter)
    monkeypatch.setattr(provider, "_put_fileobj", _put)
    return provider, objects


@pytest.mark.parametrize("provider_kind", ["local", "aliyun", "s3"])
def test_three_providers_stream_write_and_copy(
    provider_kind, tmp_path, monkeypatch,
):
    if provider_kind == "local":
        provider = LocalFallbackProvider(
            storage_root=str(tmp_path),
            base_url="https://local.example.test",
        )
        backing = None
    elif provider_kind == "aliyun":
        provider, backing = _memory_aliyun(monkeypatch)
    else:
        provider = _s3_provider()
        backing = provider._internal.objects

    body = (b"streaming-result-" * 20_000) + b"done"
    digest = hashlib.sha256(body).hexdigest()
    written = provider.write_stream(
        "v8/account-1/source.bin",
        (body[:12345], body[12345:]),
        max_size=len(body),
        expected_size=len(body),
        expected_sha256=digest,
    )
    assert written.size_bytes == len(body)
    assert written.sha256 == digest

    copied = provider.copy_object(
        "v8/account-1/source.bin",
        "v8/account-1/canonical.bin",
        max_size=len(body),
        expected_size=len(body),
        expected_sha256=digest,
        chunk_size=64 * 1024,
    )
    assert copied.sha256 == digest
    assert b"".join(provider.iter_object(
        "v8/account-1/canonical.bin",
    )) == body
    if backing is not None:
        assert backing["v8/account-1/canonical.bin"] == body


def test_stream_gates_size_hash_and_limit_before_destination_write(tmp_path):
    provider = LocalFallbackProvider(
        storage_root=str(tmp_path),
        base_url="https://local.example.test",
    )
    body = b"abcdef"
    with pytest.raises(StreamIntegrityError, match="size mismatch"):
        provider.write_stream(
            "v8/account-1/size.bin",
            (body,),
            expected_size=len(body) + 1,
        )
    with pytest.raises(StreamIntegrityError, match="sha256 mismatch"):
        provider.write_stream(
            "v8/account-1/hash.bin",
            (body,),
            expected_size=len(body),
            expected_sha256="0" * 64,
        )
    with pytest.raises(StreamIntegrityError, match="maximum"):
        provider.write_stream(
            "v8/account-1/limit.bin",
            (body,),
            max_size=len(body) - 1,
        )
    assert not provider.object_exists("v8/account-1/size.bin")
    assert not provider.object_exists("v8/account-1/hash.bin")
    assert not provider.object_exists("v8/account-1/limit.bin")
