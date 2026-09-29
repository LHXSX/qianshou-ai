"""Bounded metadata for media generation; no media bytes or download URLs.

Public requests select an immutable, official profile. Device advertisements
and user-supplied parameters cannot define that profile or its price.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MediaMode = Literal["text_to_image", "image_to_image", "image_edit",
                    "text_to_video", "image_to_video", "first_last_frame"]
Quality = Literal["fast", "standard", "clear", "hd"]
Orientation = Literal["square", "landscape", "portrait"]
AssetRole = Literal["reference", "first_frame", "last_frame"]


class StrictMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid", protected_namespaces=())


class MediaAsset(StrictMetadata):
    asset_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.:-]+$")
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    role: AssetRole


class MediaInput(StrictMetadata):
    capability: Literal["image", "video"]
    mode: MediaMode
    prompt: str = Field(min_length=1, max_length=8192)
    negative_prompt: str = Field(default="", max_length=8192)
    quality: Quality
    orientation: Orientation
    seconds: int | None = Field(default=None, strict=True, ge=1, le=120)
    assets: list[MediaAsset] = Field(default_factory=list, max_length=8)
    profile_id: str = Field(pattern=r"^[a-z][a-z0-9_.-]{2,99}$")
    profile_version: int = Field(strict=True, ge=1)

    @model_validator(mode="after")
    def validate_intent(self):
        if len(self.prompt.encode("utf-8")) > 8192 or not self.prompt.strip():
            raise ValueError("media prompt 必须是 1..8192 UTF-8 字节的文本")
        if len(self.negative_prompt.encode("utf-8")) > 8192:
            raise ValueError("media negative_prompt 超过 8192 UTF-8 字节")
        is_video = self.capability == "video"
        if is_video != (self.mode in {"text_to_video", "image_to_video", "first_last_frame"}):
            raise ValueError("media capability 与 mode 不匹配")
        if is_video != (self.seconds is not None):
            raise ValueError("仅 video 必须提供 seconds")
        ids = [asset.asset_id for asset in self.assets]
        if len(ids) != len(set(ids)):
            raise ValueError("media assets 不允许重复 asset_id")
        roles = [asset.role for asset in self.assets]
        if self.mode in {"text_to_image", "text_to_video"} and roles:
            raise ValueError("纯文本模式不接收图片；请明确选定图片模式")
        if self.mode in {"image_to_image", "image_edit"} and (not roles or set(roles) != {"reference"}):
            raise ValueError("图像输入模式必须提供 reference 图片")
        if self.mode == "image_to_video" and roles != ["first_frame"]:
            raise ValueError("image_to_video 必须提供且只提供一张 first_frame")
        if self.mode == "first_last_frame" and sorted(roles) != ["first_frame", "last_frame"]:
            raise ValueError("first_last_frame 必须明确提供首帧和尾帧")
        return self


class OfficialMediaProfile(StrictMetadata):
    """One reviewed parameter combination, never inferred from a tier label."""
    profile_id: str = Field(pattern=r"^[a-z][a-z0-9_.-]{2,99}$")
    profile_version: int = Field(strict=True, ge=1)
    capability: Literal["image", "video"]
    mode: MediaMode
    quality: Quality
    orientation: Orientation
    width: int = Field(strict=True, ge=64, le=4096)
    height: int = Field(strict=True, ge=64, le=4096)
    steps: int = Field(strict=True, ge=1, le=200)
    fps: int | None = Field(default=None, strict=True, ge=1, le=120)
    allowed_seconds: list[int] = Field(default_factory=list, max_length=120)
    input_roles: list[AssetRole] = Field(default_factory=list, max_length=8)
    max_assets: int = Field(strict=True, ge=0, le=8)
    model_id: str = Field(min_length=1, max_length=128)
    model_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    workflow_id: str = Field(min_length=1, max_length=128)
    workflow_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    validation_receipt_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    min_vram_mb: int = Field(strict=True, ge=1024, le=65536)
    min_memory_mb: int = Field(strict=True, ge=1024, le=524288)
    timeout_s: int = Field(strict=True, ge=30, le=3600)
    price_version: int = Field(strict=True, ge=1)
    price_unit: Literal["image", "second"]
    unit_price_yuan: Decimal
    min_charge_yuan: Decimal = Decimal("0")
    enabled: bool = Field(default=False, strict=True)

    @field_validator("unit_price_yuan", "min_charge_yuan")
    @classmethod
    def validate_price(cls, value: Decimal):
        if not value.is_finite() or value < 0:
            raise ValueError("官方媒体价格必须是有限非负金额")
        return value

    @field_validator("allowed_seconds", mode="before")
    @classmethod
    def validate_seconds(cls, value: list[int]):
        if not isinstance(value, list):
            raise ValueError("profile allowed_seconds 必须是数组")
        if any(type(second) is not int or not 1 <= second <= 120 for second in value):
            raise ValueError("profile allowed_seconds 必须是 1..120 的整数")
        if len(value) != len(set(value)):
            raise ValueError("profile allowed_seconds 不允许重复")
        return sorted(value)

    @model_validator(mode="after")
    def validate_combination(self):
        is_video = self.capability == "video"
        if is_video != (self.mode in {"text_to_video", "image_to_video", "first_last_frame"}):
            raise ValueError("profile capability 与 mode 不匹配")
        if is_video != (self.fps is not None and bool(self.allowed_seconds)):
            raise ValueError("video profile 必须限定 fps 和允许秒数；image 不允许 fps/秒数")
        if not is_video and (self.fps is not None or self.allowed_seconds):
            raise ValueError("image profile 不允许 fps/秒数")
        if self.price_unit != ("second" if is_video else "image"):
            raise ValueError("profile 价格单位与能力不匹配")
        if self.unit_price_yuan <= 0:
            raise ValueError("正式媒体 profile 必须有明确正数费率")
        if (self.orientation == "square" and self.width != self.height
                or self.orientation == "landscape" and self.width <= self.height
                or self.orientation == "portrait" and self.width >= self.height):
            raise ValueError("profile 尺寸与 orientation 不匹配")
        expected_roles = {"text_to_image": [], "text_to_video": [],
                          "image_to_image": ["reference"], "image_edit": ["reference"],
                          "image_to_video": ["first_frame"],
                          "first_last_frame": ["first_frame", "last_frame"]}[self.mode]
        if sorted(self.input_roles) != expected_roles:
            raise ValueError("profile 输入角色与 mode 不匹配")
        if self.max_assets < len(expected_roles) or (not expected_roles and self.max_assets):
            raise ValueError("profile max_assets 与输入角色不匹配")
        return self
