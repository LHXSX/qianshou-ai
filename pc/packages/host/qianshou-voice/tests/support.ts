/** Owned deterministic audio and native-process fixtures; no model download or microphone. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TtsAssets } from '../src/tts-config.ts'
import type { VoiceEngineOptions } from '../src/types.ts'

/** Build canonical audio for byte-level admission tests. */
export function wav(samples = 1600): Buffer {
  const data = Buffer.alloc(44 + samples * 2)
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22)
  data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28)
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36)
  data.writeUInt32LE(samples * 2, 40)
  for (let sample = 0; sample < samples; sample++) data.writeInt16LE(Math.round(Math.sin(sample / 10) * 5000), 44 + sample * 2)
  return data
}

/** A real subprocess fixture with caller-owned output and deterministic cancellation evidence. */
export async function engineFixture(body = 'fs.writeFileSync(output + ".txt", "千手语音测试");') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-voice-test-'))
  const binary = join(root, 'recognizer.cjs'), model = join(root, 'model.bin'), marker = join(root, 'started.json')
  await writeFile(model, 'test fixture; not model weights', { mode: 0o600 })
  await writeFile(binary, `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2), input = args[args.indexOf('-f') + 1], output = args[args.indexOf('-of') + 1];
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid,input,output,secret:process.env.QIANSHOU_VOICE_TEST_SECRET??null}));
${body}\n`, { mode: 0o700 })
  const options: VoiceEngineOptions = { binary, model, timeoutMs: 10000, threads: 1, maxResultBytes: 1024, maxProcessOutputBytes: 4096 }
  return { root, marker, options }
}

/** Worker behaviors selected per fixture; `normal` answers with a valid 24 kHz WAV. */
export type TtsWorkerMode = 'normal' | 'canonical' | 'startup-hang' | 'malformed' | 'exit' | 'error' | 'noise' | 'escape'
  | 'oversize' | 'invalid-wav' | 'symlink'

/** One line appended by the fake worker per observable event. */
export interface TtsWorkerEvent { event: 'start' | 'request'; pid: number; root: string; text?: string; output?: string; secret?: string | null; overlap?: number }

/** A real JSONL subprocess standing in for the Python worker; text `hang` never answers, `slow` answers after 150 ms. */
export async function ttsFixture(mode: TtsWorkerMode = 'normal') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tts-test-'))
  const python = join(root, 'fake-python.cjs'), worker = join(root, 'worker.py'), model = join(root, 'model'), marker = join(root, 'events.jsonl')
  await mkdir(join(model, 'speech_tokenizer'), { recursive: true })
  await Promise.all(['config.json', 'model.safetensors', 'speech_tokenizer/model.safetensors'].map(file => writeFile(join(model, file), '{}')))
  await writeFile(worker, '# test worker; not the pinned script', { mode: 0o600 })
  await writeFile(python, `#!${process.execPath}
const fs = require('node:fs');
const rl = require('node:readline');
const root = process.argv[process.argv.indexOf('--output-dir') + 1];
const mode = ${JSON.stringify(mode)};
const record = value => fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid,root,...value})+'\\n');
record({event:'start',secret:process.env.QIANSHOU_VOICE_TEST_SECRET??null});
let active=0;
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
if(mode!=='startup-hang') emit({type:'ready'});
rl.createInterface({input:process.stdin}).on('line', async line=>{
 const m=JSON.parse(line); active++;
 record({event:'request',text:m.text,output:m.outputPath,overlap:active});
 if(m.text==='hang') { setInterval(()=>{},100); return; }
 if(m.text==='slow') await new Promise(r=>setTimeout(r,150));
 if(mode==='malformed') {process.stdout.write('bad json\\n'); return;}
 if(mode==='exit') {process.exit(1);}
 if(mode==='error') {emit({id:m.id,ok:false,error:'SECRET_DIAGNOSTIC'});return;}
 if(mode==='noise') {process.stdout.write('x'.repeat(17000));return;}
 const bytes=Buffer.alloc(mode==='oversize'?20000:4844);
 bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
 bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
 bytes.writeUInt32LE(mode==='invalid-wav'?16000:24000,24);bytes.writeUInt32LE(48000,28);
 bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);
 if(mode==='symlink') fs.symlinkSync(${JSON.stringify(worker)},m.outputPath);
 else fs.writeFileSync(m.outputPath,bytes,{mode:0o600});
 active--;emit({id:m.id,ok:true,path:mode==='escape'?'/tmp/unowned.wav':mode==='canonical'?fs.realpathSync(m.outputPath):m.outputPath});
});
`, { mode: 0o700 })
  const assets: TtsAssets = { python, worker, model }
  const events = async (): Promise<TtsWorkerEvent[]> => existsSync(marker)
    ? (await readFile(marker, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as TtsWorkerEvent) : []
  return { root, assets, marker, events }
}
