"""Source-aware file batch contracts shared by slicing and verification."""
from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


class InputEntryV1(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    source_index: int = Field(ge=0)
    name: str = Field(min_length=1, max_length=512)
    object_key: str = ""
    fetch_ref: str = ""
    size_bytes: int = Field(ge=0)
    sha256: str = ""
    content_type: str = "application/octet-stream"
    selector: dict[str, Any] = Field(default_factory=dict)

    @field_validator("name")
    @classmethod
    def safe_name(cls, value: str) -> str:
        value = value.replace("\\", "/").strip()
        if not value or value.startswith("/") or ".." in value.split("/") or "\x00" in value:
            raise ValueError("unsafe input name")
        return value


class InputManifestV1(BaseModel):
    schema: Literal["input_manifest.v1"] = "input_manifest.v1"
    semantics: Literal[
        "per_item", "single_item", "whole_set", "exact_set", "segmented_item",
    ]
    entries: list[InputEntryV1] = Field(min_length=1)
    total_entries: int = Field(ge=1)

    @field_validator("entries")
    @classmethod
    def unique_entry_ids(cls, entries: list[InputEntryV1]) -> list[InputEntryV1]:
        ids = [item.id for item in entries]
        if len(ids) != len(set(ids)):
            raise ValueError("input entry ids must be unique")
        return entries

    @field_validator("total_entries")
    @classmethod
    def total_is_not_less_than_entries(cls, value: int, info) -> int:
        entries = info.data.get("entries") or []
        if value < len(entries):
            raise ValueError("total_entries cannot be less than supplied entries")
        return value

    def digest(self) -> str:
        raw = json.dumps(
            self.model_dump(mode="json"), sort_keys=True, separators=(",", ":"),
        ).encode()
        return hashlib.sha256(raw).hexdigest()


class ProcessingReceiptItemV1(BaseModel):
    input_id: str
    status: Literal["succeeded", "failed", "rejected"]
    error: str = ""
    outputs: list[dict[str, Any]] = Field(default_factory=list)


class ProcessingReceiptV1(BaseModel):
    schema: Literal["processing_receipt.v1"] = "processing_receipt.v1"
    input_manifest_sha256: str
    items: list[ProcessingReceiptItemV1] = Field(min_length=1)

    @field_validator("items")
    @classmethod
    def unique_input_ids(cls, items: list[ProcessingReceiptItemV1]) -> list[ProcessingReceiptItemV1]:
        ids = [item.input_id for item in items]
        if len(ids) != len(set(ids)):
            raise ValueError("processing receipt input ids must be unique")
        return items

