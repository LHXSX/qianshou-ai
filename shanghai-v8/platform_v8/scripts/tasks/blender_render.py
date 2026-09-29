#!/usr/bin/env python3
"""blender_render — Blender 帧渲染 (后台命令行) · 需 Blender CLI"""
import base64, json, sys, time, subprocess, tempfile, os, glob, shutil

def _find_blender() -> str:
    """在已知路径里找 Blender 可执行文件，不依赖 PATH。
    返回绝对路径，找不到抛 FileNotFoundError。
    """
    home = os.path.expanduser("~")
    qs = os.path.join(home, ".qianshou", "runtime", "system_bin", "render")

    candidates = []
    if sys.platform == "win32":
        # 递归扫描 render 目录，适配版本子目录 (blender-4.2.0-windows-x64/blender.exe)
        if os.path.isdir(qs):
            for root, dirs, files in os.walk(qs):
                for f in files:
                    if f.lower() == "blender.exe":
                        candidates.append(os.path.join(root, f))
        for d in glob.glob(r"C:\Program Files\Blender Foundation\Blender *"):
            candidates.append(os.path.join(d, "blender.exe"))
    elif sys.platform == "darwin":
        if os.path.isdir(qs):
            for root, dirs, files in os.walk(qs):
                for f in files:
                    if f == "Blender" and "MacOS" in root:
                        candidates.append(os.path.join(root, f))
        candidates.append("/Applications/Blender.app/Contents/MacOS/Blender")
    else:  # linux
        candidates = [
            os.path.join(qs, "blender"),
            "/usr/bin/blender",
            "/snap/bin/blender",
        ]

    # 最后兜底: 系统 PATH
    w = shutil.which("blender")
    if w:
        candidates.append(w)

    for p in candidates:
        if p and os.path.isfile(p):
            return p

    # 诊断信息
    searched = "\n  ".join(candidates[:8])
    raise FileNotFoundError(f"Blender 未安装 · 搜索路径:\n  {searched}\n请装 render tier")

def main():
    t0 = time.time()
    try:
        raw = sys.stdin.buffer.read()
        if raw[:1] in (b"{",b"["):
            obj = json.loads(raw); blend_bytes = base64.b64decode(obj.get("blend_b64",""))
            p = obj.get("params", {})
        else:
            blend_bytes = raw; p = {}
        # EC_PARAMS 优先 (frames_chunked 切片器把每片帧区间写在这里) · 覆盖 stdin 内嵌 params
        # 这样 URL/裸 .blend 输入也能拿到本片该渲的帧段 · 实现真正的分帧渲染农场
        try:
            ec = json.loads(os.environ.get("EC_PARAMS", "{}")) or {}
        except Exception:
            ec = {}
        if isinstance(ec, dict):
            p = {**p, **ec}
        frame_start = max(1, int(p.get("frame_start", 1)))
        frame_end = max(frame_start, int(p.get("frame_end", 1)))
        if frame_end - frame_start + 1 > 300:
            raise ValueError("单任务最多渲染 300 帧")
        if len(blend_bytes) > 512 * 1024 * 1024:
            raise ValueError(".blend 超过 512MiB 上限")
        engine = p.get("engine", "CYCLES")  # CYCLES / BLENDER_EEVEE
        with tempfile.NamedTemporaryFile(suffix=".blend", delete=False) as f:
            f.write(blend_bytes); blend = f.name
        out_dir = tempfile.mkdtemp()
        blender_bin = _find_blender()
        cmd = [blender_bin, "--disable-autoexec", "-b", blend, "-E",engine,"-o",f"{out_dir}/frame_####","-F","PNG",
               "-s",str(frame_start),"-e",str(frame_end),"-a"]
        r = subprocess.run(cmd, capture_output=True, timeout=1800)
        if r.returncode != 0:
            print(json.dumps({"status":"failed","task_type":"blender_render",
                "error":r.stderr.decode()[:300] or "blender 未安装",
                "summary_text":"❌ 节点未装 Blender · brew install blender 或 apt install blender"})); return 1
        frames = sorted(os.listdir(out_dir))
        images = []
        for fn in frames[:10]:  # 最多 10 帧 base64 回传
            with open(os.path.join(out_dir,fn),"rb") as f:
                images.append({"frame":fn, "image_b64":base64.b64encode(f.read()).decode()})
        elapsed = int((time.time()-t0)*1000)
        os.unlink(blend)
        shutil.rmtree(out_dir, ignore_errors=True)
        print(json.dumps({
            "status":"ok","schema_version":"v1","task_type":"blender_render",
            "elapsed_ms":elapsed,
            "summary":{"frames_rendered":len(frames),"engine":engine,
                       "frame_range":[frame_start,frame_end],"input_bytes":len(blend_bytes)},
            "result_images":images,
            "summary_text":f"✅ Blender 渲染完成\n🎬 引擎: {engine}\n🎞 渲染 {len(frames)} 帧 ({frame_start} - {frame_end})\n⏱ 用时: {elapsed/1000:.1f}s\n💾 输入 .blend: {len(blend_bytes)//1024} KB",
        }, ensure_ascii=False))
        return 0
    except FileNotFoundError:
        print(json.dumps({"status":"failed","task_type":"blender_render","error":"blender CLI 未安装"})); return 1
    except Exception as e:
        print(json.dumps({"status":"failed","task_type":"blender_render","error":str(e)})); return 1

if __name__ == "__main__": sys.exit(main())
