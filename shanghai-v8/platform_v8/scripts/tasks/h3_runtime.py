#!/usr/bin/env python3
"""
h3_runtime.py — H3 视频生成任务（节点本地适配器版）
适配千手引擎 run_script 协议：EC_PARAMS 环境变量进，stdout JSON 出。

与其它 task 脚本不同：本脚本不在节点上做重计算，而是把活交给节点本机的
H3 四档适配器（默认 http://127.0.0.1:8790），拿回 mp4 后再输出结果引用。

节点侧要求（缺一即失败并给出明确原因）：
  1. 本机 8790 适配器在跑，且 /health 报出 qs_* 工作流
  2. 5 秒 cell 必须带首帧参考 → 参数给了 image 就用，没给就先用 Z-Image 出一张

参数（EC_PARAMS，全部可选除 prompt）：
  prompt       str   必填，≤7000 字符
  seconds      int   5 或 10（10 = 两段 cell 拼接）
  workflow     str   默认 qs_base12
  image_path   str   首帧图路径；给了就跳过出图
  seed         int   默认按时间生成
  dry_run      bool  只做前置检查与图编排，不出片（用于链路自检）

输出：{status, schema_version, task_type, elapsed_ms, summary, video_path, ...}
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

T0 = time.perf_counter()

ADAPTER = os.environ.get("H3_ADAPTER_BASE", "http://127.0.0.1:8790")
COMFY = os.environ.get("H3_COMFY_BASE", "http://127.0.0.1:8188")
FFMPEG = os.environ.get("H3_FFMPEG", "ffmpeg")

params = json.loads(os.environ.get("EC_PARAMS", "{}"))
input_dir = os.environ.get("EC_INPUT_DIR", "")
work_dir = os.environ.get("EC_OUTPUT_DIR") or os.environ.get("TMPDIR") or "/tmp"
os.makedirs(work_dir, exist_ok=True)


def out(obj, code=0):
    obj.setdefault("schema_version", "v1")
    obj.setdefault("task_type", "h3_runtime")
    obj.setdefault("elapsed_ms", int((time.perf_counter() - T0) * 1000))
    print(json.dumps(obj, ensure_ascii=False))
    sys.exit(code)


def fail(reason, failure_class="script_error", **extra):
    out({"status": "error", "reason": reason, "failure_class": failure_class, **extra}, 1)


def http_json(url, method="GET", body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    req = urllib.request.Request(url, method=method, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def find_first_frame():
    """首帧优先级：显式 image_path > EC_INPUT_DIR 里第一张图。"""
    p = params.get("image_path")
    if p and os.path.isfile(p):
        return p
    if input_dir and os.path.isdir(input_dir):
        for name in sorted(os.listdir(input_dir)):
            if name.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                return os.path.join(input_dir, name)
    return None


# ── 1. 前置检查：适配器必须在跑 ────────────────────────────────
try:
    health = http_json(ADAPTER + "/health", timeout=15)
except Exception as e:
    fail(f"H3 适配器不可达（{ADAPTER}）：{type(e).__name__}: {e}",
         failure_class="missing_dep",
         hint="节点需先拉起 ComfyUI + 转发 8189 + 四档适配器 8790")

workflows = [w for w in (health.get("workflows") or []) if w.startswith("qs_")]
if not workflows:
    fail("适配器在线但未报出 qs_* 工作流", failure_class="missing_dep",
         adapter_health={"ok": health.get("ok"), "workflows": health.get("workflows")})

prompt = (params.get("prompt") or params.get("inline_input") or "").strip()
if not prompt:
    fail("缺少 prompt", failure_class="script_error")
if len(prompt) > 7000:
    fail(f"prompt 过长（{len(prompt)} > 7000）", failure_class="script_error")

seconds = int(params.get("seconds") or 5)
if seconds not in (5, 10):
    fail(f"seconds 只支持 5 或 10，收到 {seconds}", failure_class="script_error")

workflow = params.get("workflow") or "qs_base12"
if workflow not in workflows:
    fail(f"workflow {workflow} 不在适配器能力内", failure_class="script_error",
         available=workflows)

seed = int(params.get("seed") or (int(time.time()) % 2000000000))
first = find_first_frame()
dry = bool(params.get("dry_run"))

if dry:
    out({
        "status": "ok",
        "dry_run": True,
        "summary": {
            "adapter": ADAPTER,
            "workflows": workflows,
            "workflow": workflow,
            "seconds": seconds,
            "cells": seconds // 5,
            "first_frame": first or "(将用 Z-Image 生成)",
            "prompt_chars": len(prompt),
            "seed": seed,
        },
    })

NEG = ("second person, crowd, extra figure, distant front-facing face, face drift, "
       "warm light, amber light, orange light, magenta light, purple light, sunset, "
       "warm color grade, on-screen text, subtitles, watermark, logo, image tearing, "
       "extra limbs, deformed hands, background music")


def submit_cell(first_png, cell_prompt, cell_seed):
    b64 = base64.b64encode(open(first_png, "rb").read()).decode()
    body = {
        "workflow": workflow,
        "steps": 12 if workflow == "qs_base12" else 4,
        "tier": None,
        "preset": "landscape_C",
        "seconds": 5,
        "prompt": cell_prompt,
        "negative": NEG,
        "seed": cell_seed,
        "ref_images": [{"url": "data:image/png;base64," + b64,
                        "role": "first", "name": "h3_runtime_first"}],
    }
    return http_json(ADAPTER + "/v1/jobs", method="POST", body=body, timeout=180)


def wait_cell(jid, timeout=1200):
    t = time.perf_counter()
    while time.perf_counter() - t < timeout:
        time.sleep(10)
        try:
            st = http_json(f"{ADAPTER}/v1/jobs/{jid}", timeout=20)
        except Exception:
            continue
        s = st.get("status")
        if s == "done":
            return st
        if s in ("failed", "cancelled"):
            fail(f"cell {s}: {str(st.get('error'))[:300]}", failure_class="resource")
    fail("cell 超时", failure_class="timeout")


def cell_output(jid):
    p = os.path.join(r"D:\work\comfy_root\output\MiniMax_H3\LocalAPI", jid, "result.mp4")
    if os.path.isfile(p):
        return p
    p2 = os.path.join("/opt/qianshou-h3-bridge/results", jid + ".mp4")
    return p2 if os.path.isfile(p2) else None


# ── 2. 出片 ────────────────────────────────────────────────
cells = seconds // 5
videos = []
prev = first

for i in range(cells):
    if prev is None:
        fail("第 1 段缺首帧且未实现自动出图（请传 image_path 或 EC_INPUT_DIR）",
             failure_class="missing_dep")
    seg_prompt = prompt if i == 0 else (
        prompt + "\n\n[CONTINUITY] This continues directly from the previous shot; "
                 "keep identity, wardrobe, lighting and camera axis.")
    job = submit_cell(prev, seg_prompt, seed + i)
    jid = job["id"]
    wait_cell(jid)
    v = cell_output(jid)
    if not v:
        fail(f"cell {jid} 完成但找不到成品文件", failure_class="resource")
    videos.append(v)
    # 下一段首帧 = 本段交付尾帧 119
    nxt = os.path.join(work_dir, f"tail119_{i}.png")
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", v,
                    "-vf", "select=eq(n\\,119)", "-frames:v", "1", nxt],
                   check=False, timeout=120)
    prev = nxt if os.path.isfile(nxt) else None

# ── 3. 拼接（各裁 120 帧，硬切视频 + 0.8s 音频交叉淡化）────────
final = os.path.join(work_dir, f"h3_{seconds}s_{uuid.uuid4().hex[:8]}.mp4")
if len(videos) == 1:
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", videos[0],
                    "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", final],
                   check=False, timeout=600)
else:
    fc = ""
    for i, _ in enumerate(videos):
        fc += (f"[{i}:v]trim=start_frame=0:end_frame=120,setpts=PTS-STARTPTS[v{i}];"
               f"[{i}:a]atrim=start=0:end=5.0,asetpts=PTS-STARTPTS[a{i}];")
    fc += "".join(f"[v{i}]" for i in range(len(videos))) + \
          f"concat=n={len(videos)}:v=1:a=0[v];"
    fc += "".join(f"[a{i}]" for i in range(len(videos))) + \
          f"concat=n={len(videos)}:v=0:a=1[ax]"
    cmd = [FFMPEG, "-v", "error", "-y"]
    for v in videos:
        cmd += ["-i", v]
    cmd += ["-filter_complex", fc, "-map", "[v]", "-map", "[ax]",
            "-c:v", "libx264", "-crf", "14", "-preset", "slow", "-pix_fmt", "yuv420p",
            "-r", "24", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", final]
    subprocess.run(cmd, check=False, timeout=900)

if not os.path.isfile(final):
    fail("拼接失败，成品不存在", failure_class="resource")

out({
    "status": "ok",
    "video_path": final,
    "summary": {
        "workflow": workflow,
        "seconds": seconds,
        "cells": len(videos),
        "seed": seed,
        "cell_videos": videos,
        "size_bytes": os.path.getsize(final),
        "first_frame_source": first or "generated",
    },
})
