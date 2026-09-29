#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# V8.2 RFC · ONNX 模型上传到 qianshousuanli.com/by OSS · 镜像源准备
# ════════════════════════════════════════════════════════════════════════════
#
# 当前主源 = modelscope.cn(国内 CDN · 实测速度 200+/s · 可用)
# 本脚本用途 = 把 4 个 RapidOCR 文件上传到 qianshousuanli.com/by OSS 作为镜像
#              → 万一 modelscope 挂了走自家 CDN
#              → 可控的 sha256 + 可追踪的访问日志
#
# 前置: ossutil(阿里云 OSS 工具) 已装 · 配置好 AccessKey
#
# 用法:
#   1. 拿到 OSS AccessKey:
#      export OSS_ENDPOINT="oss-cn-hangzhou.aliyuncs.com"
#      export OSS_BUCKET="qianshou-compute"           # TODO: 切换到新 bucket
#      export OSS_ACCESS_KEY_ID="LTAI***"
#      export OSS_ACCESS_KEY_SECRET="***"
#      export OSS_PREFIX="v1/onnx/rapid_ocr_v1"       # 跟 manifest 里的 URL 对齐
#
#   2. 运行:
#      ./platform_v8/scripts/upload_onnx_to_oss.sh
#
#   3. 验证(可选):
#      curl -I "https://qianshousuanli.com/by/v1/onnx/rapid_ocr_v1/ch_PP-OCRv4_det_mobile.onnx"
#
# 上传完成后:
#   把 qianshousuanli.com/by 作为 fallback_urls 的第一个(或主 url 切到 qianshousuanli.com/by)
#   bundles.py::_ONNX_MODELS_REGISTRY 已预留位置

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="${REPO_ROOT}/.local_models/rapid_ocr_v1"

# ─── 检查源文件存在 ────────────────────────────────────────
if [[ ! -d "$SRC" ]]; then
    echo "ERROR · 源目录不存在: $SRC"
    echo "请先从 modelscope 拉模型 · 见 docs/节点执行层重构_任务大类骨架_RFC_2026-06-11.md"
    exit 1
fi

REQUIRED_FILES=(
    "ch_PP-OCRv4_det_mobile.onnx"
    "ch_ppocr_mobile_v2.0_cls_mobile.onnx"
    "ch_PP-OCRv4_rec_mobile.onnx"
    "ppocr_keys_v1.txt"
)
for f in "${REQUIRED_FILES[@]}"; do
    if [[ ! -s "$SRC/$f" ]]; then
        echo "ERROR · 源文件缺失或为空: $SRC/$f"
        exit 1
    fi
done
echo "✓ 4 个源文件就绪"

# ─── 检查环境变量 ────────────────────────────────────────
: "${OSS_ENDPOINT:?ERROR · 未设置 OSS_ENDPOINT}"
: "${OSS_BUCKET:?ERROR · 未设置 OSS_BUCKET}"
: "${OSS_ACCESS_KEY_ID:?ERROR · 未设置 OSS_ACCESS_KEY_ID}"
: "${OSS_ACCESS_KEY_SECRET:?ERROR · 未设置 OSS_ACCESS_KEY_SECRET}"
OSS_PREFIX="${OSS_PREFIX:-v1/onnx/rapid_ocr_v1}"

echo "✓ OSS 配置: $OSS_BUCKET @ $OSS_ENDPOINT · prefix=$OSS_PREFIX"

# ─── 检查 ossutil 已装 ────────────────────────────────────
if ! command -v ossutil >/dev/null 2>&1; then
    if ! command -v ossutil64 >/dev/null 2>&1; then
        cat <<EOF
ERROR · ossutil 未装 · 装一下:
  macOS:   brew install ossutil
  Linux:   curl -L https://gosspublic.alicdn.com/ossutil/1.7.18/ossutil64 -o /usr/local/bin/ossutil && chmod +x /usr/local/bin/ossutil
EOF
        exit 1
    fi
    OSSUTIL=ossutil64
else
    OSSUTIL=ossutil
fi

# ─── 上传 ────────────────────────────────────────────────
echo
echo "── 开始上传 ──"
for f in "${REQUIRED_FILES[@]}"; do
    SIZE_MB=$(du -m "$SRC/$f" | cut -f1)
    DEST="oss://${OSS_BUCKET}/${OSS_PREFIX}/${f}"
    echo "▶ ${f} (${SIZE_MB}MB) → ${DEST}"
    "$OSSUTIL" cp -f \
        -e "$OSS_ENDPOINT" \
        -i "$OSS_ACCESS_KEY_ID" \
        -k "$OSS_ACCESS_KEY_SECRET" \
        "$SRC/$f" "$DEST"
    echo "✓ 上传完成 · sha256=$(shasum -a 256 "$SRC/$f" | cut -d' ' -f1 | head -c 16)..."
done

echo
echo "── 完成 ──"
echo "建议验证:"
echo "  curl -sI https://qianshousuanli.com/by/${OSS_PREFIX}/ch_PP-OCRv4_det_mobile.onnx | head -1"
echo
echo "下一步:把 qianshousuanli.com/by 加进 bundles.py _ONNX_MODELS_REGISTRY 的"
echo "fallback_urls 顶部(或替换主 url · 看你的稳定性策略)"
