#!/usr/bin/env python3
"""Return the self-contained app graph used by every platform package."""
import json
from pathlib import Path
import re

APP_ROOT = Path(__file__).resolve().parent.parent
IMPORT = re.compile(r'''(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']''')
ASSETS = ("index.html", "renderer.js", "style.css", "preload.cjs")
UPDATER_FILES = ("entry.mjs", "runner.mjs", "window.html", "style.css", "renderer.js", "preload.cjs", "public-key.pem", "THIRD_PARTY_NOTICES.txt", "BUILD_MANIFEST.json")


def app_files():
    """Reject unresolved runtime imports; exclude stale chunks and workspace dependencies."""
    lib = APP_ROOT / "lib"
    assets = (*ASSETS, *("updater/" + name for name in UPDATER_FILES))
    visited = set(assets)
    for asset in assets:
        if not (lib / asset).is_file():
            raise RuntimeError(f"Missing companion asset: {asset}")
    pending = ["main.js", "peer.js", "executor.js"]
    while pending:
        name = pending.pop()
        if name in visited:
            continue
        visited.add(name)
        source = lib / name
        for target in IMPORT.findall(source.read_text()):
            if target.startswith("./"):
                resolved = (source.parent / target).resolve()
                if not resolved.is_relative_to(lib.resolve()) or not resolved.is_file():
                    raise RuntimeError(f"Invalid bundled import {name}: {target}")
                pending.append(resolved.relative_to(lib.resolve()).as_posix())
            elif target != "electron" and not target.startswith("node:"):
                raise RuntimeError(f"NOT_SELF_CONTAINED: {name} imports {target}")
    return sorted(visited)


if __name__ == "__main__":
    print(json.dumps(app_files()))
