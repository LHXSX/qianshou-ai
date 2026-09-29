# Mac drawn video candidate

English | [中文](README.zh.md)

`createMacDrawnVideoExecutor` is a source-level `ComputeExecutor` factory for a five-second beach cycling motion template on macOS. It draws 120 AppKit frames at 1280×720 and 24 fps, encodes H.264/yuv420p with FFmpeg, then checks the stream, duration, frame count, full decode, file size and SHA-256. It uses no model, network request, or task-supplied code.

The task accepts exactly `title` (1–16 characters) and `subtitle` (1–32 characters). Both go into a private owner-only JSON file read by a fixed Swift program; file inputs and other parameters are refused. This is a drawn scene with moving waves, bicycle wheels and rider, not general text-to-video generation. An owner-selected installation must provide the exact capability ID/version, absolute paths to Swift, FFmpeg and FFprobe, and a runtime limit. The factory does not register itself, install a market package, enable intake or authorize a task.

The output reference points into the private attempt workspace. Its path is temporary and must be consumed before workspace cleanup. A conversation link such as `[播放视频](/absolute/persisted/video.mp4)` is valid only after an authorized result consumer has copied and verified the MP4 at that persistent path. Passing this executor locally does not establish Shanghai dispatch, market review, signing, pricing, owner approval or settlement.
