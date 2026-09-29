#!/usr/bin/env python3
"""fft_compute — 一维 FFT (傅里叶变换) · 需 NumPy"""
import json, math, os, sys, time, struct

def main():
    t0 = time.time()
    try:
        import numpy as np
    except ImportError:
        print(json.dumps({"status":"failed","task_type":"fft_compute","error":"节点缺 NumPy"})); return 1
    try:
        raw = sys.stdin.read()
        def _parse_floats(text: str) -> list:
            """容忍 CSV 表头 / 逗号分隔：跳过无法 float 的 token。"""
            out = []
            for tok in text.replace(",", " ").split():
                try:
                    out.append(float(tok))
                except ValueError:
                    continue
            return out
        if raw.lstrip().startswith(("{", "[")):
            obj = json.loads(raw)
        else:
            obj = {"signal": _parse_floats(raw)}
        signal = obj.get("signal") or obj.get("data", [])
        if isinstance(signal, str):
            signal = _parse_floats(signal)
        elif isinstance(signal, list) and signal and isinstance(signal[0], str):
            signal = _parse_floats(" ".join(str(x) for x in signal))
        p = obj.get("params", {})
        sample_rate = float(p.get("sample_rate", 1000))
        arr = np.array(signal, dtype=float) if signal else np.array([], dtype=float)
        n = len(arr)
        if n < 2:
            # 文件输入：EC_INPUT_DIR 下 .bin / .wav / 文本
            input_dir = os.environ.get("EC_INPUT_DIR", "")
            blob = b""
            if input_dir and os.path.isdir(input_dir):
                for fname in sorted(os.listdir(input_dir)):
                    fp = os.path.join(input_dir, fname)
                    if os.path.isfile(fp) and fname != "input_manifest.v1.json":
                        with open(fp, "rb") as fh:
                            blob = fh.read()
                        break
            if blob:
                if blob[:4] == b"RIFF" and b"data" in blob:
                    idx = blob.find(b"data")
                    data = blob[idx + 8 :]
                    npts = min(len(data) // 2, 16384)
                    arr = np.array(
                        [struct.unpack_from("<h", data, i * 2)[0] / 32768.0 for i in range(npts)],
                        dtype=float,
                    )
                else:
                    text_vals = _parse_floats(blob.decode("utf-8", errors="ignore"))
                    if len(text_vals) >= 2:
                        arr = np.array(text_vals, dtype=float)
                    else:
                        npts = min(len(blob) // 2, 16384)
                        arr = np.array(
                            [struct.unpack_from("<h", blob, i * 2)[0] / 32768.0 for i in range(npts)],
                            dtype=float,
                        )
            n = len(arr)
        if n < 2:
            print(json.dumps({"status":"failed","task_type":"fft_compute","error":"信号需 ≥ 2 个采样点"})); return 1
        fft = np.fft.rfft(arr)
        freqs = np.fft.rfftfreq(n, d=1/sample_rate)
        mags = np.abs(fft)
        top_k = 10
        top_idx = np.argsort(mags)[-top_k:][::-1]
        elapsed = int((time.time()-t0)*1000)
        print(json.dumps({
            "status":"ok","schema_version":"v1","task_type":"fft_compute",
            "elapsed_ms":elapsed,
            "summary":{"input_samples":n,"sample_rate_hz":sample_rate,
                       "frequency_bins":len(freqs),"nyquist_hz":sample_rate/2,
                       "top_frequencies":[{"freq_hz":round(float(freqs[i]),3),
                                           "magnitude":round(float(mags[i]),3)} for i in top_idx]},
            "result_freqs":freqs[:200].tolist(),
            "result_magnitudes":mags[:200].tolist(),
            "summary_text":f"✅ FFT 计算完成\n📡 采样点: {n}\n🎵 采样率: {sample_rate} Hz · Nyquist: {sample_rate/2:.0f} Hz\n📊 Top 频率:\n" + "\n".join(f"   {round(float(freqs[i]),2)} Hz · 强度 {round(float(mags[i]),1)}" for i in top_idx[:5]),
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({"status":"failed","task_type":"fft_compute","error":str(e)})); return 1

if __name__ == "__main__": sys.exit(main())
