#!/usr/bin/env bash
# 千手节点 · 一键安装（读 release.json · asset-mirror 下 dmg）
#   curl -fsSL https://qianshousuanli.com/downloads/latest/install.sh | bash
set -euo pipefail

ORIGIN="${QIANSHOU_ORIGIN:-https://qianshousuanli.com}"
MANIFEST="$ORIGIN/downloads/latest/release.json"

echo ""
echo "  ⚡ 千手节点 · 一键安装"
echo "  ────────────────────────"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$OS-$ARCH" in
  darwin-arm64|darwin-aarch64) PLAT=macos-arm64 ;;
  darwin-x86_64)               PLAT=macos-intel ;;
  *) echo "  ❌ 暂仅支持 macOS · 请打开 $ORIGIN/download.html"; exit 1 ;;
esac

echo "  📦 平台: $PLAT"
read -r URL NAME VER <<< "$(curl -fsSL "$MANIFEST" | PLAT="$PLAT" ORIGIN="$ORIGIN" python3 - <<'PY'
import json, os, sys
d = json.load(sys.stdin)
plat = os.environ["PLAT"]
origin = os.environ["ORIGIN"]
prod = next((p for p in d.get("products", []) if p.get("id") == "qianshou-standard"), d["products"][0])
dl = next((x for x in prod.get("downloads", []) if x.get("platform") == plat and x.get("available") is not False), None)
if not dl:
    sys.exit("no pkg for " + plat)
url = dl["url"].replace("https://dl.qianshousuanli.com/releases/", origin + "/api/v8/oss/asset-mirror/releases/")
print(url, dl.get("name", ""), prod.get("version", d.get("version", "")))
PY
)"
echo "  📌 版本: v$VER"
echo "  📁 包:   $NAME"
echo ""

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
PKG="$TMP/$NAME"
echo "  ⬇  下载中..."
curl -fL --progress-bar "$URL" -o "$PKG"
[ -s "$PKG" ] || { echo "  ❌ 下载失败"; exit 1; }
echo "  ✓  $(du -h "$PKG" | awk '{print $1}')"
MNT="$TMP/mnt"
mkdir -p "$MNT"
hdiutil attach "$PKG" -nobrowse -quiet -mountpoint "$MNT"
if [ -w /Applications ]; then cp -R "$MNT"/*.app /Applications/; else sudo cp -R "$MNT"/*.app /Applications/; fi
hdiutil detach "$MNT" -quiet || true
sudo xattr -cr /Applications/千手节点.app 2>/dev/null || true
sudo codesign --deep --force --sign - /Applications/千手节点.app 2>/dev/null || true
echo "  ✅ 安装完成 · open '/Applications/千手节点.app'"
echo ""
