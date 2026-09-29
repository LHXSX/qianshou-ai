"""
应用模块 bundle 发布 SOP（qs-app-bundle/v1）
=============================================

在服务器上执行（需要 /opt/edge/.env 的 DB + 对象存储凭证）：

    cd /opt/edge && set -a && source .env && set +a && \
    ./venv/bin/python platform_v8/scripts/marketplace/publish_app_bundles.py

做四件事（幂等，可重复跑）：
  1. 读 we_apps × we_app_versions 里所有 launch_kind='workload' 的应用
  2. 为每个应用生成 bundle.json（内嵌任务脚本源码 + task_registry 真实依赖声明）
  3. 通过后端 oss_provider 上传到对象存储 marketplace/apps/{slug}/{version}/bundle.json
     （dl.qianshousuanli.com 的对象 key 即 URL 路径）
  4. 回写 we_app_versions.sha256 / size_bytes（客户端 Provision 用它做完整性校验）

deep_link / webview 应用没有脚本包：script_bundle_url 置 NULL（客户端不走 Provision 下载）。

bundle.json schema 见 apps/eco-client/docs/开发者文档/01_应用模块规范.md。
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, "/opt/edge")

from sqlalchemy import create_engine, text  # noqa: E402

TASKS_DIR = Path("/opt/edge/platform_v8/scripts/tasks")
BUNDLE_SCHEMA = "qs-app-bundle/v1"
DL_BASE = "https://dl.qianshousuanli.com"


def _engine():
    dsn = (
        f"postgresql+psycopg2://{os.environ['POSTGRES_USER']}:{os.environ['POSTGRES_PASSWORD']}"
        f"@{os.environ.get('POSTGRES_HOST', '127.0.0.1')}:{os.environ.get('POSTGRES_PORT', '5432')}"
        f"/{os.environ['POSTGRES_DB']}"
    )
    return create_engine(dsn)


def _required_software(task_type: str) -> list[str]:
    try:
        from platform_v8.engine.task_registry import get_spec
        return list(get_spec(task_type).required_software)
    except Exception:
        return []


def build_bundle(app: dict) -> bytes | None:
    """组 bundle.json 字节流；任务脚本缺失返回 None。"""
    script_path = TASKS_DIR / f"{app['task_type']}.py"
    if not script_path.exists():
        print(f"  !! 任务脚本不存在: {script_path}")
        return None
    src = script_path.read_bytes()
    bundle = {
        "schema": BUNDLE_SCHEMA,
        "slug": app["slug"],
        "version": app["version"],
        "task_type": app["task_type"],
        "runtime": "python3",
        "entry": f"{app['task_type']}.py",
        "files": [{
            "path": f"{app['task_type']}.py",
            "content_b64": base64.b64encode(src).decode(),
            "sha256": hashlib.sha256(src).hexdigest(),
            "size": len(src),
        }],
        "requires": {"software": _required_software(app["task_type"])},
        "sandbox_network": app["sandbox_network"] or "none",
        "built_at": datetime.now(timezone.utc).isoformat(),
    }
    return json.dumps(bundle, ensure_ascii=False, indent=1).encode()


def main() -> None:
    from platform_v8.services.oss_provider import configure_oss
    provider = configure_oss()
    eng = _engine()

    with eng.begin() as conn:
        rows = conn.execute(text("""
            SELECT a.slug, a.task_type, a.launch_kind, a.sandbox_network,
                   v.id AS version_id, v.version, v.script_bundle_url
              FROM we_apps a JOIN we_app_versions v ON v.app_id = a.id
             ORDER BY a.slug
        """)).mappings().all()

        published, skipped = [], []
        for app in rows:
            app = dict(app)
            print(f"== {app['slug']} {app['version']} ({app['launch_kind']}) ==")

            if app["launch_kind"] != "workload" or not app["task_type"]:
                conn.execute(text(
                    "UPDATE we_app_versions SET script_bundle_url = NULL WHERE id = :vid"
                ), {"vid": app["version_id"]})
                skipped.append(app["slug"])
                print("  -> 非 workload 形态，script_bundle_url 置 NULL")
                continue

            payload = build_bundle(app)
            if payload is None:
                skipped.append(app["slug"])
                continue

            sha = hashlib.sha256(payload).hexdigest()
            key = f"marketplace/apps/{app['slug']}/{app['version']}/bundle.json"
            provider.put_bytes(key, payload, content_type="application/json")
            # bucket 私有；bundle 走对象级 public-read（与 releases/latest.json 同策略）
            provider._internal.put_object_acl(
                Bucket=provider.bucket, Key=key, ACL="public-read",
            )
            conn.execute(text("""
                UPDATE we_app_versions
                   SET script_bundle_url = :url, sha256 = :sha, size_bytes = :size
                 WHERE id = :vid
            """), {"url": f"{DL_BASE}/{key}", "sha": sha,
                   "size": len(payload), "vid": app["version_id"]})
            published.append((app["slug"], sha[:12], len(payload)))
            print(f"  -> {DL_BASE}/{key}  sha256={sha[:12]}…  {len(payload)}B")

    print("\n===== 结果 =====")
    for slug, sha, size in published:
        print(f"  published  {slug:<22} {sha}…  {size}B")
    for slug in skipped:
        print(f"  skipped    {slug}")
    print("\n验收: curl -sI https://dl.qianshousuanli.com/marketplace/apps/<slug>/<ver>/bundle.json → 200")


if __name__ == "__main__":
    main()
