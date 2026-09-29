"""artifact.v1 · 大文件结果协议 (Native 视频/音频等)

节点不再把二进制塞进 Base64/WebSocket · 改为:
  1. 本地落盘 → 流式 PUT OSS
  2. WS 只回报本 manifest (几百字节)

output_ref 存本 manifest 的 JSON 字符串 · 聚合器据此取 object_key 拉文件。
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from pydantic import BaseModel, Field, field_validator

logger = logging.getLogger(__name__)

ARTIFACT_SCHEMA = "artifact.v1"
MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB
# 无 artifact 时允许的最大 inline (防再次塞进 WS 大 Base64)
MAX_INLINE_WITHOUT_ARTIFACT = 256 * 1024

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
# Windows / 路径危险字符 · 其余（含中文、·、[]、【】）保留，便于结果页还原源名
_UNSAFE_FILENAME_CHARS = re.compile(r'[\x00-\x1f\x7f<>:"/\\|?*]')
_MULTI_SPACE = re.compile(r"\s+")


def normalize_artifact_filename(raw: str | None, *, max_len: int = 200) -> str:
    """规范化产物文件名：去路径、去控制符，保留 Unicode 可读名。

    放宽旧白名单（曾拒绝「视频压缩 · …」「[BraveDown]…」导致借调卡 PENDING）。
    """
    name = (raw or "").replace("\x00", "").strip()
    name = name.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    name = _UNSAFE_FILENAME_CHARS.sub("_", name)
    name = _MULTI_SPACE.sub(" ", name).strip(" .")
    if not name or name in {".", ".."}:
        return "output.bin"
    if len(name) > max_len:
        stem, dot, ext = name.rpartition(".")
        if dot and 1 <= len(ext) <= 15 and stem:
            keep = max_len - 1 - len(ext)
            name = f"{stem[:keep]}.{ext}" if keep > 0 else name[:max_len]
        else:
            name = name[:max_len]
    return name


class ArtifactV1(BaseModel):
    """节点回报 / 落库用的产物清单。"""

    schema_version: str = Field(default=ARTIFACT_SCHEMA, alias="schema")
    object_key: str
    filename: str
    size_bytes: int = Field(..., ge=0, le=MAX_ARTIFACT_BYTES)
    content_type: str = "application/octet-stream"
    sha256: str
    result_id: str
    # Immutable storage version returned by PUT. Required for independently
    # verified media tasks; legacy/general artifacts may omit it.
    object_version_id: str | None = None
    # 可选溯源 · 便于校验路径前缀
    shard_id: str = ""
    workload_id: str = ""
    account_id: int | None = None

    model_config = {"populate_by_name": True}

    @field_validator("sha256")
    @classmethod
    def _sha_hex(cls, v: str) -> str:
        v = (v or "").strip().lower()
        if not _SHA256_RE.match(v):
            raise ValueError("sha256 must be 64 hex chars")
        return v

    @field_validator("filename")
    @classmethod
    def _safe_filename(cls, v: str) -> str:
        name = normalize_artifact_filename(v)
        if not name:
            raise ValueError("invalid filename")
        return name

    @field_validator("object_key")
    @classmethod
    def _object_key(cls, v: str) -> str:
        key = (v or "").strip().lstrip("/")
        if not key or ".." in key or key.startswith("http"):
            raise ValueError("invalid object_key")
        return key

    @field_validator("object_version_id")
    @classmethod
    def _version_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not re.fullmatch(r"[A-Za-z0-9_.~+-]{1,200}", value) or value == "null":
            raise ValueError("invalid object_version_id")
        return value

    def to_storage_ref(self) -> str:
        """写入 we_shards.output_ref 的紧凑 JSON。"""
        return self.model_dump_json(by_alias=True)


def expected_object_key_prefix(
    *,
    account_id: int,
    workload_id: str,
    shard_id: str,
    result_id: str,
) -> str:
    """服务端生成的目录前缀 · 节点不可自拟路径。"""
    return (
        f"v8/account-{account_id}/workload-{workload_id}/"
        f"shard-{shard_id}/result/{result_id}/"
    )


def build_object_key(
    *,
    account_id: int,
    workload_id: str,
    shard_id: str,
    result_id: str,
    filename: str,
) -> str:
    """生成完整 object_key。"""
    # object_key 再收紧一层：空白 → _，避免 URL/签名边界问题；中文等 Unicode 仍保留
    safe = normalize_artifact_filename(filename, max_len=180)
    safe = re.sub(r"\s+", "_", safe)
    return expected_object_key_prefix(
        account_id=account_id,
        workload_id=workload_id,
        shard_id=shard_id,
        result_id=result_id,
    ) + safe


def parse_artifact_ref(output_ref: str | None) -> ArtifactV1 | None:
    """从 shard.output_ref 解析 artifact.v1 · 非本协议返回 None。"""
    if not output_ref or not isinstance(output_ref, str):
        return None
    text = output_ref.strip()
    if not text.startswith("{"):
        return None
    try:
        data = json.loads(text)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    schema = data.get("schema") or data.get("schema_version")
    if schema != ARTIFACT_SCHEMA:
        return None
    try:
        return ArtifactV1.model_validate(data)
    except Exception as exc:
        logger.warning("artifact.parse · invalid: %s", exc)
        return None


def validate_artifact_against_context(
    art: ArtifactV1,
    *,
    account_id: int,
    workload_id: str,
    shard_id: str,
) -> None:
    """校验 manifest 与任务上下文一致 · 失败抛 ValueError。"""
    if art.shard_id and art.shard_id != shard_id:
        raise ValueError("artifact.shard_id mismatch")
    if art.workload_id and art.workload_id != workload_id:
        raise ValueError("artifact.workload_id mismatch")
    if art.account_id is not None and art.account_id != account_id:
        raise ValueError("artifact.account_id mismatch")
    prefix = expected_object_key_prefix(
        account_id=account_id,
        workload_id=workload_id,
        shard_id=shard_id,
        result_id=art.result_id,
    )
    if not art.object_key.startswith(prefix):
        raise ValueError("artifact.object_key outside server-issued prefix")
    if art.size_bytes > MAX_ARTIFACT_BYTES:
        raise ValueError("artifact exceeds 2GiB limit")


def artifact_to_public_dict(art: ArtifactV1) -> dict[str, Any]:
    """聚合器 / API 用的统一字典。"""
    result = {
        "status": "ok",
        "schema": ARTIFACT_SCHEMA,
        "object_key": art.object_key,
        "filename": art.filename,
        "size_bytes": art.size_bytes,
        "content_type": art.content_type,
        "sha256": art.sha256,
        "result_id": art.result_id,
        "_is_artifact": True,
    }
    # Keep the immutable object version and supplied context through public
    # projections. Legacy manifests retain their optional-field contract.
    if art.object_version_id is not None:
        result["object_version_id"] = art.object_version_id
    if art.shard_id:
        result["shard_id"] = art.shard_id
    if art.workload_id:
        result["workload_id"] = art.workload_id
    if art.account_id is not None:
        result["account_id"] = art.account_id
    return result
