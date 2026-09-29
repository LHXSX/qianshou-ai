"""Read-only provider metadata for official cloud capabilities.

The bundled manifest is a paused preview. A Guangzhou service may supply
newer metadata over an operator-configured private HTTPS connection. Neither
source authorizes dispatch: Shanghai needs a separate, implemented quote and
submission adapter before a cloud item can be callable.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

_BUNDLED = Path(__file__).with_name("official_cloud_manifest.json")
_CATEGORY = {
    "文字": "text", "图片": "image", "视频": "video", "音频": "audio",
    "演示文稿": "ppt", "办公": "office", "文档": "document", "数据": "data",
    "开发": "development", "设计": "design", "法律": "legal",
}


def _bundled() -> dict[str, Any]:
    return json.loads(_BUNDLED.read_text(encoding="utf-8"))


def _remote() -> dict[str, Any] | None:
    url = os.getenv("V8_OFFICIAL_CAPABILITY_CATALOG_URL", "")
    token = os.getenv("V8_OFFICIAL_CAPABILITY_CATALOG_TOKEN", "")
    ca = os.getenv("V8_OFFICIAL_CAPABILITY_CATALOG_CA_FILE", "")
    if not url:
        return None
    try:
        parts = urlsplit(url)
        if (len(url) > 2048 or parts.scheme != "https" or not parts.hostname
                or parts.username or parts.password or parts.query or parts.fragment
                or parts.path != "/internal/official-capabilities"
                or parts.port not in (None, 443) and os.getenv("V8_ENV") != "staging"
                or not 32 <= len(token) <= 2048
                or ca and not os.path.isfile(ca)):
            return None
        response = httpx.get(
            url, headers={"Authorization": "Bearer " + token},
            timeout=2.0, verify=ca or True, trust_env=False, follow_redirects=False)
        if response.status_code != 200 or len(response.content) > 65536:
            return None
        data = response.json()
        return data if isinstance(data, dict) else None
    except (ValueError, TypeError, httpx.HTTPError):
        return None


def _normalize(item: Any) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    schema = item.get("inputSchema")
    quote = item.get("quote")
    execution = item.get("execution")
    artifact = item.get("artifact")
    required = schema.get("required") if isinstance(schema, dict) else None
    properties = schema.get("properties") if isinstance(schema, dict) else None
    if (item.get("source") != "official" or item.get("providerKind") != "official-cloud"
            or not isinstance(item.get("id"), str)
            or not isinstance(item.get("taskType"), str)
            or not isinstance(item.get("capabilityId"), str)
            or not isinstance(item.get("name"), str)
            or not isinstance(item.get("category"), str)
            or not isinstance(item.get("description"), str)
            or len(item["name"]) > 120 or len(item["description"]) > 2000
            or item.get("schemaVersion") != 1
            or not isinstance(item.get("inputKind"), str)
            or not isinstance(item.get("outputKind"), str)
            or not isinstance(schema, dict) or schema.get("type") != "object"
            or schema.get("additionalProperties") is not False
            or not isinstance(properties, dict) or len(properties) > 32
            or not isinstance(required, list)
            or any(not isinstance(key, str) for key in required)
            or len(required) != len(set(required))
            or any(key not in properties for key in required)
            or not isinstance(quote, dict) or quote.get("currency") != "CNY"
            or quote.get("confirmationRequired") is not True
            or not isinstance(execution, dict)
            or execution.get("mode") != "platform-dispatched"
            or execution.get("providerBinding") != "server-only"
            or not isinstance(artifact, dict) or artifact.get("kind") != "verified-media"
            or not isinstance(item.get("requiredChecks"), list)
            or not isinstance(item.get("missing"), list)):
        return None
    category_zh = item["category"]
    return {
        "task_type": item["taskType"], "capability_id": item["capabilityId"],
        "provider_id": item["id"], "name": item["name"],
        "description": item["description"],
        "category": _CATEGORY.get(category_zh, "other"),
        "category_label_zh": category_zh,
        "accepted_input_kinds": [item["inputKind"]],
        "default_input_kind": item["inputKind"],
        "required_params": required,
        "form_schema_version": "qianshou.official-provider-input.v1",
        "input_schema": schema,
        "params_schema": None, "form_ready": False,
        "output_kind": item["outputKind"],
        "contract_version": f"official-provider.v{item['schemaVersion']}",
        "source": "official_provider_catalog",
        "publisher_kind": "official", "publisher_kinds": ["official"],
        "provider_kind": "official-cloud", "execution_mode": "cloud",
        "availability": "paused", "callable": False,
        "currency": "CNY", "requires_quote": True,
        "execution_quote_path": None, "execution_submit_path": None,
        "provider_quote_entrypoint": quote.get("entrypoint"),
        "required_checks": item["requiredChecks"],
        "missing_checks": item["missing"],
        "upstream_available": item.get("available") is True,
        "artifact": artifact, "products": [],
    }


def list_official_cloud_capabilities() -> list[dict[str, Any]]:
    """Never turn a provider declaration into dispatch authorization."""
    data = _remote() or _bundled()
    if (data.get("ok") is not True or data.get("schemaVersion") != 1
            or not isinstance(data.get("capabilities"), list)
            or len(data["capabilities"]) > 100):
        data = _bundled()
    result = []
    for item in data["capabilities"]:
        normalized = _normalize(item)
        if normalized is not None:
            result.append(normalized)
    return result
