"""
result_store.py — 任务结果对象存储（可插拔）

默认使用本地磁盘存储，生产环境可替换为 MinIO / S3。
接口层完全稳定：无论底层是磁盘还是对象存储，上层代码不变。

存储路径：data/results/<task_id>/<subtask_id>/<filename>
访问方式：GET /api/v1/results/<task_id>/<subtask_id>/<filename>  （带过期签名 token）

用法示例：
    store = ResultStore()
    # 节点上报结果时上传
    ref = await store.put(task_id=1, subtask_id=5, filename="output.json", data=b"{...}")
    # 企业端下载
    url = store.sign_url(ref, expires_in=3600)
"""

import hashlib
import hmac
import json
import os
import time
import uuid
from pathlib import Path
from typing import Optional

_ROOT = Path(os.environ.get("EC_RESULT_DIR", "data/results"))
_SIGN_SECRET = os.environ.get("EC_RESULT_SIGN_SECRET", "").strip()
_MAX_SIZE_MB = int(os.environ.get("EC_RESULT_MAX_MB", "100"))

# ── MinIO / S3 配置（设置后自动使用，不设则回退本地磁盘）──────────────────────
# 使用方式：设置环境变量即可切换，代码层不需要改动
#   EC_S3_ENDPOINT=http://minio:9000
#   EC_S3_ACCESS_KEY=minioadmin
#   EC_S3_SECRET_KEY=minioadmin
#   EC_S3_BUCKET=edgecompute-results
#   EC_S3_REGION=us-east-1
_S3_ENDPOINT  = os.environ.get("EC_S3_ENDPOINT", "").strip()
_S3_KEY       = os.environ.get("EC_S3_ACCESS_KEY", "").strip()
_S3_SECRET    = os.environ.get("EC_S3_SECRET_KEY", "").strip()
_S3_BUCKET    = os.environ.get("EC_S3_BUCKET", "edgecompute-results").strip()
_S3_REGION    = os.environ.get("EC_S3_REGION", "us-east-1").strip()
_USE_S3       = bool(_S3_ENDPOINT and _S3_KEY and _S3_SECRET)

def _s3_client():
    """懒加载 boto3 S3 客户端。只有配置了 EC_S3_ENDPOINT 才会初始化。"""
    try:
        import boto3  # type: ignore
        return boto3.client(
            "s3",
            endpoint_url=_S3_ENDPOINT or None,
            aws_access_key_id=_S3_KEY,
            aws_secret_access_key=_S3_SECRET,
            region_name=_S3_REGION,
        )
    except ImportError:
        raise RuntimeError("boto3 未安装，请 pip install boto3 以使用 S3/MinIO 后端")


class ResultRef:
    """对结果文件的引用（可序列化）。"""

    def __init__(self, task_id: int, subtask_id: int, filename: str, size: int, sha256: str):
        self.task_id = task_id
        self.subtask_id = subtask_id
        self.filename = filename
        self.size = size
        self.sha256 = sha256

    @property
    def path_key(self) -> str:
        return f"{self.task_id}/{self.subtask_id}/{self.filename}"

    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "subtask_id": self.subtask_id,
            "filename": self.filename,
            "size": self.size,
            "sha256": self.sha256,
            "path_key": self.path_key,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "ResultRef":
        return cls(
            task_id=d["task_id"],
            subtask_id=d["subtask_id"],
            filename=d["filename"],
            size=d.get("size", 0),
            sha256=d.get("sha256", ""),
        )


class ResultStore:
    """本地磁盘结果存储（接口兼容 MinIO / S3）。"""

    def __init__(self, root: Optional[Path] = None):
        self._root = root or _ROOT
        self._root.mkdir(parents=True, exist_ok=True)

    # ── 写入 ──────────────────────────────────────────────────────────────────
    def _put_s3(self, task_id: int, subtask_id: int, filename: str, data: bytes) -> ResultRef:
        """上传到 S3/MinIO（当 EC_S3_ENDPOINT 配置时使用）。"""
        import io as _io
        s3 = _s3_client()
        sha = hashlib.sha256(data).hexdigest()
        key = f"{task_id}/{subtask_id}/{filename}"
        s3.upload_fileobj(
            _io.BytesIO(data),
            _S3_BUCKET,
            key,
            ExtraArgs={"ContentType": "application/octet-stream", "Metadata": {"sha256": sha}},
        )
        return ResultRef(task_id, subtask_id, filename, len(data), sha)

    def put_sync(
        self,
        task_id: int,
        subtask_id: int,
        filename: str,
        data: bytes,
    ) -> ResultRef:
        if _USE_S3:
            try:
                return self._put_s3(task_id, subtask_id, filename, data)
            except Exception as e:
                import logging
                logging.getLogger("backend.result_store").warning("S3 上传失败，回退本地磁盘: %s", e)
        """同步写入（Agent 上报时调用）。"""
        if len(data) > _MAX_SIZE_MB * 1024 * 1024:
            raise ValueError(f"结果文件超过 {_MAX_SIZE_MB}MB 限制")

        # 安全文件名
        safe_name = Path(filename).name or f"result_{uuid.uuid4().hex[:8]}.bin"
        dest = self._root / str(task_id) / str(subtask_id)
        dest.mkdir(parents=True, exist_ok=True)
        target = dest / safe_name
        target.write_bytes(data)

        sha = hashlib.sha256(data).hexdigest()
        ref = ResultRef(task_id, subtask_id, safe_name, len(data), sha)

        # 写索引文件
        idx = dest / "index.json"
        entries: dict = {}
        if idx.exists():
            try:
                entries = json.loads(idx.read_text())
            except Exception:
                pass
        entries[safe_name] = ref.to_dict()
        idx.write_text(json.dumps(entries, ensure_ascii=False, indent=2))
        return ref

    async def put(self, task_id: int, subtask_id: int, filename: str, data: bytes) -> ResultRef:
        """异步包装（供 async 上下文使用）。"""
        return self.put_sync(task_id, subtask_id, filename, data)

    # ── 读取 ──────────────────────────────────────────────────────────────────
    def get_bytes(self, task_id: int, subtask_id: int, filename: str) -> Optional[bytes]:
        p = self._root / str(task_id) / str(subtask_id) / Path(filename).name
        return p.read_bytes() if p.exists() else None

    def list_results(self, task_id: int) -> list:
        """列出某任务的所有结果文件（跨所有子任务）。"""
        base = self._root / str(task_id)
        if not base.exists():
            return []
        results = []
        for idx_file in base.glob("*/index.json"):
            try:
                entries = json.loads(idx_file.read_text())
                results.extend(list(entries.values()))
            except Exception:
                pass
        return results

    def list_subtask_results(self, task_id: int, subtask_id: int) -> list:
        idx = self._root / str(task_id) / str(subtask_id) / "index.json"
        if not idx.exists():
            return []
        try:
            return list(json.loads(idx.read_text()).values())
        except Exception:
            return []

    # ── 签名 URL ─────────────────────────────────────────────────────────────
    def sign_url(self, ref: ResultRef, expires_in: int = 3600, base_url: str = "") -> str:
        """生成带 HMAC 签名的临时下载 URL（无需鉴权中间件）。"""
        if len(_SIGN_SECRET) < 32:
            raise RuntimeError("EC_RESULT_SIGN_SECRET is not configured securely")
        exp = int(time.time()) + expires_in
        path_key = ref.path_key
        raw = f"{path_key}:{exp}"
        sig = hmac.new(_SIGN_SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()[:24]
        return f"{base_url}/api/v1/results/{path_key}?exp={exp}&sig={sig}"

    def verify_signed_url(self, path_key: str, exp: str, sig: str) -> bool:
        """校验签名 URL。"""
        if len(_SIGN_SECRET) < 32:
            return False
        try:
            if int(exp) < int(time.time()):
                return False  # 已过期
            raw = f"{path_key}:{exp}"
            expected = hmac.new(_SIGN_SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest()[:24]
            return hmac.compare_digest(expected, sig)
        except Exception:
            return False


# ── 全局单例 ──────────────────────────────────────────────────────────────────
_store_instance: Optional[ResultStore] = None


def get_result_store() -> ResultStore:
    global _store_instance
    if _store_instance is None:
        _store_instance = ResultStore()
    return _store_instance
