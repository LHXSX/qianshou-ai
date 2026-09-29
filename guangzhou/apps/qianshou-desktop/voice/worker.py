"""Sequential local CustomVoice worker; stdin/stdout carry bounded JSONL only."""
import argparse
import contextlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# Delivery tuning (2026-09-13, user picked Serena and asked for faster speech):
# SPEED is a time-stretch factor applied with ffmpeg atempo, which keeps the
# pitch; TARGET_PEAK/MAX_GAIN lift the preset to a consistent loudness without
# clipping (Serena renders ~8 dB quieter than Vivian at the same text).
SPEED = 1.5
TARGET_PEAK = 0.95
MAX_GAIN = 2.5
# Reset sampling per utterance so other jobs do not alter this preset's sound.
VOICE_SEED = 42
VOICE_TEMPERATURE = 0.9
VOICE_TOP_K = 50
VOICE_TOP_P = 1.0
FFMPEG = shutil.which('ffmpeg') or '/opt/homebrew/bin/ffmpeg'
parser = argparse.ArgumentParser()
parser.add_argument('--model', default=str(ROOT/'models/Qwen3-TTS-12Hz-1.7B-CustomVoice-4bit'))
parser.add_argument('--output-dir', required=True)
args = parser.parse_args()
output_root = Path(args.output_dir).resolve(strict=True)
if not output_root.is_dir():
    raise ValueError('The private output directory must already exist')
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_IMPLICIT_TOKEN'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
os.environ['HF_HOME'] = str(ROOT/'hf-isolated')
os.environ['TOKENIZERS_PARALLELISM'] = 'false'

def emit(value):
    print(json.dumps(value,ensure_ascii=False),flush=True)

def loudness_aligned(audio):
    peak = float(abs(audio).max()) if len(audio) else 0.0
    if peak <= 0:
        return audio
    return audio * min(TARGET_PEAK/peak, MAX_GAIN)

def time_stretched(audio, scratch):
    """Apply SPEED with ffmpeg atempo; the scratch path must sit in the private output root."""
    source = scratch.with_name(scratch.stem + '.src.wav')
    with source.open('xb') as handle:
        os.chmod(source,0o600)
        wavfile.write(handle,24000,(np.clip(audio,-1,1)*32767).astype(np.int16))
    try:
        result = subprocess.run(
            [FFMPEG,'-y','-loglevel','error','-i',str(source),'-filter:a',f'atempo={SPEED}',
             '-ar','24000','-ac','1',str(scratch)],
            capture_output=True,timeout=120,
        )
        if result.returncode != 0 or not scratch.exists():
            raise RuntimeError('Speed adjustment failed')
        rate, data = wavfile.read(scratch)
        if rate != 24000 or getattr(data,'ndim',1) != 1:
            raise RuntimeError('Speed adjustment returned an unexpected format')
        return np.asarray(data,dtype=np.float32)/32768.0
    finally:
        source.unlink(missing_ok=True)
        scratch.unlink(missing_ok=True)

with contextlib.redirect_stdout(sys.stderr):
    import mlx.core as mx
    import numpy as np
    from mlx_audio.tts.utils import load_model
    from scipy.io import wavfile
    model = load_model(str(Path(args.model).resolve(strict=True)))
emit({'type':'ready','speed':SPEED,'ffmpeg':Path(FFMPEG).exists()})

while line := sys.stdin.readline(65537):
    request_id = None
    partial = None
    try:
        if len(line) > 65536 or not line.endswith('\n'):
            raise ValueError('Request line exceeds the 64 KiB limit or is incomplete')
        request = json.loads(line)
        if not isinstance(request,dict):
            raise ValueError('Request must be a JSON object')
        request_id = request.get('id')
        if not isinstance(request_id,str) or not 1 <= len(request_id) <= 128:
            raise ValueError('Request id must contain 1–128 characters')
        text = request.get('text')
        speaker = request.get('speaker')
        if not isinstance(text,str) or not 1 <= len(text.strip()) <= 500:
            raise ValueError('Text must contain 1–500 characters; split long replies into sentences')
        if speaker not in ('Vivian','Serena'):
            raise ValueError('Speaker must be Vivian or Serena')
        output_name = request.get('outputPath')
        if not isinstance(output_name,str):
            raise ValueError('outputPath must be a string')
        target = Path(output_name)
        if not target.is_absolute() or target.suffix.lower() != '.wav':
            raise ValueError('outputPath must be an absolute .wav path')
        target = target.resolve()
        if not target.is_relative_to(output_root) or not target.parent.is_dir():
            raise ValueError('outputPath must be within the existing private output directory')
        if target.exists():
            raise ValueError('Refusing to overwrite an existing output')
        started = time.perf_counter()
        instruction = '语气轻松活泼，像和熟悉的朋友聊天，停顿自然，不用播音腔。' if speaker == 'Vivian' else '语气亲切自然，像和熟悉的朋友聊天，停顿自然，不用播音腔。'
        with contextlib.redirect_stdout(sys.stderr):
            mx.random.seed(VOICE_SEED)
            pieces = []
            token_count = 0
            for result in model.generate_custom_voice(text=text, speaker=speaker, language='Chinese', instruct=instruction, temperature=VOICE_TEMPERATURE, top_k=VOICE_TOP_K, top_p=VOICE_TOP_P, max_tokens=512, stream=False, verbose=False):
                mx.eval(result.audio)
                if result.sample_rate != 24000:
                    raise RuntimeError('The model returned an unsupported sample rate')
                token_count += result.token_count
                pieces.append(np.asarray(result.audio,dtype=np.float32).reshape(-1))
        if token_count >= 512:
            raise RuntimeError('Generation reached the token limit; shorten the text and retry')
        if not pieces:
            raise RuntimeError('The model returned no audio')
        audio = np.concatenate(pieces)
        if not np.isfinite(audio).all() or not len(audio) or len(audio)*2+44 > 8*1024**2:
            raise RuntimeError('The model returned invalid or oversized audio')
        audio = loudness_aligned(audio)
        if SPEED != 1.0 and Path(FFMPEG).exists():
            audio = time_stretched(audio, target.with_name(target.stem + '.speed.wav'))
        partial = target.with_suffix('.partial.wav')
        with partial.open('xb') as handle:
            os.chmod(partial,0o600)
            wavfile.write(handle,24000,(np.clip(audio,-1,1)*32767).astype(np.int16))
        partial.rename(target)
        partial = None
        emit({'id':request_id,'ok':True,'path':str(target),'generationSeconds':round(time.perf_counter()-started,3),'audioSeconds':round(len(audio)/24000,3),'tokens':token_count})
    except Exception as error:
        if partial is not None:
            partial.unlink(missing_ok=True)
        emit({'id':request_id,'ok':False,'error':str(error)})
