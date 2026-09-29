"""Resolve on-disk input filenames for shard manifests.

Slicers historically defaulted to ``input-0`` when ``params.input_batch``
was absent. Sidecar then preferred that manifest name over the object-key
URL leaf, so media scripts that filter by extension saw zero inputs.

Prefer, in order: explicit batch name (non-generic) → params.input_names[i]
(or params.input_name only for index 0) → object_key / ref basename →
content_type extension on generic stem → ``input-{index}``.

``params.input_name`` is the first-file display hint from the client. Using it
for every multi_file entry made text_diff (and any 2+ file job) stage two
inputs as the same basename and overwrite.
"""
from __future__ import annotations

import re
from urllib.parse import unquote, urlparse

_GENERIC = re.compile(r"^input-\d+$", re.IGNORECASE)

_CT_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-matroska": ".mkv",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "application/pdf": ".pdf",
    "text/csv": ".csv",
    "application/json": ".json",
    "text/plain": ".txt",
}


def _leaf(ref: str) -> str:
    raw = (ref or "").strip()
    if not raw:
        return ""
    path = urlparse(raw).path if "://" in raw else raw
    path = unquote(path.split("?")[0].split("#")[0])
    leaf = path.rstrip("/").split("/")[-1].strip()
    return leaf


def _has_ext(name: str) -> bool:
    n = (name or "").rsplit("/", 1)[-1]
    if "." not in n or n.startswith("."):
        return False
    ext = n.rsplit(".", 1)[-1]
    return bool(ext) and ext.isalnum() and len(ext) <= 8


def _is_generic(name: str) -> bool:
    return not name or bool(_GENERIC.match(name.strip()))


def uniquify_filename(name: str, used: set[str]) -> str:
    """Keep basenames unique inside one shard directory (avoid overwrite)."""
    raw = (name or "").strip() or "input"
    if raw not in used and raw.lower() != "input_manifest.v1.json":
        used.add(raw)
        return raw
    if "." in raw and not raw.startswith("."):
        stem, ext = raw.rsplit(".", 1)
        ext = "." + ext
    else:
        stem, ext = raw, ""
    n = 1
    while True:
        cand = f"{stem}-{n}{ext}"
        if cand not in used:
            used.add(cand)
            return cand
        n += 1


def resolve_entry_name(
    ref: str,
    entry: dict | None = None,
    *,
    index: int = 0,
    params: dict | None = None,
    used: set[str] | None = None,
) -> str:
    """Pick a filename that preserves a usable extension when possible."""
    entry = entry or {}
    params = params or {}
    explicit = str(entry.get("name") or "").strip()
    if explicit and not _is_generic(explicit) and _has_ext(explicit):
        name = explicit
    elif explicit and not _is_generic(explicit):
        # Non-generic but extensionless — still prefer object leaf if richer.
        leaf = _leaf(str(entry.get("object_key") or ref))
        name = leaf if _has_ext(leaf) else explicit
    else:
        names = params.get("input_names")
        hint = ""
        if isinstance(names, list) and index < len(names):
            hint = str(names[index] or "").strip()
        elif index == 0:
            # Singular input_name is only the first file's display hint.
            hint = str(params.get("input_name") or "").strip()
        if hint and _has_ext(hint):
            name = hint.rsplit("/", 1)[-1]
        else:
            leaf = _leaf(str(entry.get("object_key") or ref))
            if leaf and _has_ext(leaf):
                name = leaf
            elif leaf and not _is_generic(leaf):
                ct = str(entry.get("content_type") or "").split(";")[0].strip().lower()
                ext = _CT_EXT.get(ct, "")
                name = leaf + ext if ext and not _has_ext(leaf) else leaf
            else:
                stem = explicit if explicit else f"input-{index}"
                ct = str(entry.get("content_type") or "").split(";")[0].strip().lower()
                ext = _CT_EXT.get(ct, "")
                if ext and not _has_ext(stem):
                    name = f"{stem}{ext}"
                elif hint:
                    name = hint.rsplit("/", 1)[-1]
                else:
                    name = stem
    if used is not None:
        return uniquify_filename(name, used)
    return name
