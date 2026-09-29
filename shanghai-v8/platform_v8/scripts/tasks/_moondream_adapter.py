"""Moondream 0.5B 本地推理适配器。

使用官方 int8 Photon 权重（*.mf），经 moondream==0.0.6 的 ONNX Runtime
本地路径加载。不再走 HuggingFace Transformers 的 2B safetensors 快照。

环境变量:
  EC_MOONDREAM_MODEL_DIR  含 moondream-0_5b-int8.mf（或其它 *.mf）的目录
  EC_MOONDREAM_MODEL_FILE 可选，显式指定 .mf/.bin 文件路径
"""
from __future__ import annotations

import os
from io import BytesIO
from pathlib import Path
from typing import Any


class MoondreamAdapterError(RuntimeError):
    """Moondream 0.5B 本地后端不可用。"""


def _answer_text(value: Any, key: str = "answer") -> str:
    if isinstance(value, dict):
        # caption() 返回 {"caption": ...}；query() 返回 {"answer": ...}
        if key in value:
            value = value.get(key, "")
        elif "caption" in value and key == "answer":
            value = value.get("caption", "")
        elif "answer" in value and key == "caption":
            value = value.get("answer", "")
        else:
            value = value.get(key, "")
    if isinstance(value, str):
        return value.strip()
    if value is None:
        return ""
    return str(value).strip()


def _resolve_weight_file(model_dir: Path) -> Path:
    explicit = (os.environ.get("EC_MOONDREAM_MODEL_FILE") or "").strip()
    if explicit:
        path = Path(explicit).expanduser()
        if not path.is_file():
            raise MoondreamAdapterError(f"EC_MOONDREAM_MODEL_FILE 不存在: {path}")
        return path.resolve()

    preferred = [
        model_dir / "moondream-0_5b-int8.mf",
        model_dir / "moondream-0_5b-int4.mf",
        model_dir / "moondream-0.5b-int8.mf",
        model_dir / "model.mf",
    ]
    for path in preferred:
        if path.is_file():
            return path.resolve()

    # 兼容未解压的 .mf.gz：运行前应 gunzip；这里只给明确错误
    gz = model_dir / "moondream-0_5b-int8.mf.gz"
    if gz.is_file():
        raise MoondreamAdapterError(
            f"发现压缩权重 {gz.name}，请先 gunzip 成 .mf 再运行"
        )

    matches = sorted(model_dir.glob("*.mf")) + sorted(model_dir.glob("*.bin"))
    if len(matches) == 1:
        return matches[0].resolve()
    if matches:
        raise MoondreamAdapterError(
            "模型目录有多个 .mf/.bin，请设置 EC_MOONDREAM_MODEL_FILE 指定其一: "
            + ", ".join(p.name for p in matches)
        )
    raise MoondreamAdapterError(
        f"模型目录缺少 Moondream 0.5B 权重（期望 moondream-0_5b-int8.mf）: {model_dir}"
    )


class MoondreamAdapter:
    """Moondream 0.5B（moondream==0.0.6 + ONNX Runtime）查询接口。"""

    model_name = "moondream-0.5b"

    def __init__(self, model_dir: str, device: str = "auto"):
        if not str(model_dir or "").strip():
            raise MoondreamAdapterError("EC_MOONDREAM_MODEL_DIR 未设置")
        path = Path(model_dir).expanduser()
        if not path.is_dir():
            raise MoondreamAdapterError("EC_MOONDREAM_MODEL_DIR 不是本地模型目录")
        self.model_dir = path.resolve()
        self.device = (device or "auto").strip().lower() or "auto"
        self.weight_file = _resolve_weight_file(self.model_dir)
        self.model_revision = "0.5b-int8"
        self.backend = "mf_onnx"
        self._model: Any = None
        self._photon_error: Exception | None = None
        self._cached_key: bytes | None = None
        self._cached_encoded: Any = None
        self._load_mf()

    def _load_mf(self) -> None:
        try:
            import moondream as md
        except ImportError as exc:
            raise MoondreamAdapterError(
                "未安装 moondream==0.0.6（0.5B 本地推理需要该版本）"
            ) from exc

        # 0.0.6: md.vl(model="/path/to/*.mf")；2.x 的 vl() 不再接受本地 .mf
        try:
            self._model = md.vl(model=str(self.weight_file))
        except TypeError as exc:
            raise MoondreamAdapterError(
                "当前 moondream 包不支持本地 .mf 路径；请安装 moondream==0.0.6"
            ) from exc
        except Exception as exc:
            raise MoondreamAdapterError(
                f"加载 Moondream 0.5B 失败 ({self.weight_file.name}): {exc}"
            ) from exc
        self.backend = "mf_onnx"

    @staticmethod
    def _open_image(image_bytes: bytes):
        from PIL import Image

        image = Image.open(BytesIO(image_bytes))
        image.load()
        if image.mode != "RGB":
            image = image.convert("RGB")
        return image

    def _encode(self, image_bytes: bytes):
        # 同图多次短问时复用 encode，避免 0.5B 重复视觉编码
        key = image_bytes
        if self._cached_key is key or self._cached_key == key:
            return self._cached_encoded
        image = self._open_image(image_bytes)
        encode = getattr(self._model, "encode_image", None)
        encoded = encode(image) if callable(encode) else image
        self._cached_key = key
        self._cached_encoded = encoded
        return encoded

    def caption(self, image_bytes: bytes, length: str = "normal") -> str:
        """官方 caption API；0.5B 比长 JSON 提示稳定得多。"""
        target = self._encode(image_bytes)
        caption_fn = getattr(self._model, "caption", None)
        if callable(caption_fn):
            try:
                result = caption_fn(target, length=length)
            except TypeError:
                result = caption_fn(target)
            answer = _answer_text(result, "caption")
            if answer:
                return answer
        # 回退短问
        return self.query(image_bytes, "Describe this image in one sentence.")

    def query(self, image_bytes: bytes, prompt: str) -> str:
        target = self._encode(image_bytes)
        query = getattr(self._model, "query", None)
        if not callable(query):
            raise RuntimeError("moondream 客户端缺少 query()")
        result = query(target, prompt)
        answer = _answer_text(result, "answer")
        if not answer:
            raise RuntimeError("Moondream 0.5B 返回空结果")
        return answer

    def close(self) -> None:
        self._cached_key = None
        self._cached_encoded = None
        model, self._model = self._model, None
        close = getattr(model, "close", None)
        if callable(close):
            close()


def create_moondream_adapter(
    model_dir: str | None = None, device: str = "auto"
) -> MoondreamAdapter:
    return MoondreamAdapter(
        model_dir=model_dir or os.environ.get("EC_MOONDREAM_MODEL_DIR", ""),
        device=device,
    )
