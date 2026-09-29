"""Stage one independent Windows qs_new4 canonical installation.

The command never changes a running service, Python environment, model file,
remote, or existing installation.  It only accepts a new installation root.
Private paths and receipts stay under that root, outside this source kit.
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import socket
import subprocess
import sys


KIT = Path(__file__).resolve().parent
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="backslashreplace")
SCOPE = "qs_new4/E_light4_sage"
SLOT_KINDS = (None, "z", "seedvr", "h3")
VENDORS = ("comfyui", "kjnodes", "layerstyle", "videohelpersuite")
MODEL_FILES = {
    "unet": ("diffusion_models", "minimax_h3_fl2va_int8_convrot.safetensors"),
    "clip": ("text_encoders", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"),
    "videoVae": ("vae", "minimax_h3_video_vae_fp16.safetensors"),
    "audioVae": ("vae", "minimax_h3_audio_vae_fp32.safetensors"),
    "lora": ("loras", "minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors"),
}


def fail(message: str) -> None:
    raise RuntimeError(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def physical(path: Path, *, existing: bool) -> Path:
    path = Path(path)
    if not path.is_absolute():
        fail("所有路径须为绝对路径")
    for part in (path, *path.parents):
        if part.exists() and (part.is_symlink() or getattr(part, "is_junction", lambda: False)()):
            fail("拒绝符号链接或 junction 路径")
    if existing and not path.exists():
        fail("所需路径不存在")
    return path.resolve(strict=existing)


def ordinary_file(path: Path) -> Path:
    path = physical(path, existing=True)
    if not path.is_file() or path.stat().st_nlink != 1:
        fail("需要现存普通单链接文件")
    return path


def ordinary_dir(path: Path) -> Path:
    path = physical(path, existing=True)
    if not path.is_dir():
        fail("需要现存物理目录")
    return path


def check_new_root(root: Path) -> Path:
    root = physical(root, existing=False)
    if root.exists():
        fail("安装目录已存在；安装器拒绝覆盖或自动清理")
    ordinary_dir(root.parent)
    if root.is_relative_to(KIT.parents[1]) or KIT.is_relative_to(root):
        fail("安装目录须在源码仓库之外")
    return root


def check_slot(path: Path, initialize: bool) -> Path:
    path = physical(path, existing=False)
    ordinary_dir(path.parent)
    lock = path.with_name(path.name + ".lock")
    if path.exists() != lock.exists():
        fail("GPU slot 的 state/lock 仅存在其一；拒绝修复或清除")
    if path.exists():
        if initialize:
            fail("GPU slot 已存在；拒绝重新初始化")
        ordinary_file(path)
        ordinary_file(lock)
        if lock.stat().st_size < 1:
            fail("GPU slot lock 为空")
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, ValueError):
            fail("GPU slot state 无法读取；保持原样")
        if not isinstance(state, dict) or state.get("occupant", "invalid") not in SLOT_KINDS:
            fail("GPU slot state 未知；保持原样")
    elif not initialize:
        fail("GPU slot 不存在；新电脑须显式使用 --initialize-gpu-slot")
    return path


def initialize_slot(path: Path) -> None:
    """Create both leaves once.  Never repair or rewrite an existing guard."""
    lock = path.with_name(path.name + ".lock")
    with path.open("xb") as stream:
        stream.write(b'{"occupant":null}\n')
        stream.flush()
        os.fsync(stream.fileno())
    try:
        with lock.open("xb") as stream:
            stream.write(b"\0")
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        # The state remains for inspection.  A retry will refuse the partial pair.
        raise


def check_port(port: int) -> None:
    if not 1024 <= port <= 65535:
        fail("服务端口须在 1024..65535")
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.5)
        if probe.connect_ex(("127.0.0.1", port)) == 0:
            fail("候选端口已有监听进程；拒绝切换")


def check_interpreter(path: Path, version: str) -> None:
    result = subprocess.run(
        [str(path), "-B", "-I", "-c",
         "import platform,sys;print(platform.python_implementation()+' '+platform.python_version()+' '+str(sys.maxsize>2**32)+' '+sys.platform+' '+platform.machine().lower())"],
        capture_output=True, text=True, timeout=15, check=False,
    )
    if result.returncode or result.stdout.strip() != "CPython " + version + " True win32 amd64":
        fail("候选 Python 不是固定 Windows x64 CPython 版本 " + version)


def check_git_executable(path: Path, git_lock: dict) -> Path:
    git = physical(path, existing=True)
    if (not git.is_file() or git.name.casefold() != "git.exe" or
            git.parent.name.casefold() != "bin" or
            git.parent.parent.name.casefold() != "mingw64"):
        fail("Git 引擎须为现存物理 git.exe")
    if sha256(git) != git_lock["observedSha256"]:
        fail("Git 可执行文件原字节 SHA256 与固定来源锁不符")

    def require_official_links() -> tuple[str, int, int, int, int, int]:
        # The pinned Git for Windows engine has exactly these four NTFS links.
        # Reject extra aliases that could permit an unnoticed write elsewhere.
        names = ("git.exe", "git-upload-pack.exe", "git-receive-pack.exe",
                 "git-upload-archive.exe")
        identities = set()
        for name in names:
            sibling = physical(git.parent / name, existing=True)
            if not sibling.is_file():
                fail("Git 官方四硬链接布局不完整")
            stat = sibling.stat()
            if stat.st_nlink != 4:
                fail("Git 官方四硬链接数量不符")
            identities.add((stat.st_dev, stat.st_ino, stat.st_size,
                            stat.st_ctime_ns, stat.st_mtime_ns))
        if len(identities) != 1:
            fail("Git 官方四硬链接物理身份不一致")
        return (str(git), *identities.pop())

    identity = require_official_links()
    git_env = {key: value for key, value in os.environ.items()
               if not key.upper().startswith("GIT_")}
    version = subprocess.run([str(git), "--version"], env=git_env,
                             capture_output=True, text=True, encoding="utf-8",
                             errors="replace", timeout=15, check=False)
    if (version.returncode or version.stdout.strip() !=
            "git version " + git_lock["observedVersion"]):
        fail("Git 可执行文件版本与固定来源锁不符")
    if require_official_links() != identity or sha256(git) != git_lock["observedSha256"]:
        fail("Git 版本核验期间物理身份或原字节发生变化")
    return git


def assembly_environment(git: Path, api_python: Path, comfy_python: Path,
                         ffmpeg: Path) -> dict[str, str]:
    """Select the pinned Git engine for source assembly, without ambient Git config."""
    env = os.environ.copy()
    for name in list(env):
        upper = name.upper()
        if (upper.startswith(("GIT_", "H3_", "GPU_", "CUDA_", "NVIDIA_")) or
                upper in {"PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE", "PYTHONSTARTUP"}):
            env.pop(name, None)

    def system_directory(name: str) -> Path:
        buffer = ctypes.create_unicode_buffer(32768)
        length = getattr(ctypes.windll.kernel32, name)(buffer, len(buffer))
        if length <= 0 or length >= len(buffer):
            fail("无法定位 Windows 系统目录")
        return ordinary_dir(Path(buffer.value))

    directories = (git.parent, ffmpeg.parent, api_python.parent,
                   comfy_python.parent, system_directory("GetSystemDirectoryW"),
                   system_directory("GetWindowsDirectoryW"))
    selected: list[str] = []
    seen: set[str] = set()
    for directory in directories:
        candidate = ordinary_dir(directory)
        key = os.path.normcase(str(candidate))
        if key not in seen:
            selected.append(str(candidate))
            seen.add(key)
    env["PATH"] = os.pathsep.join(selected)
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONNOUSERSITE"] = "1"
    return env


def checked_process(argv: list[str], *, cwd: Path | None = None,
                    env: dict[str, str] | None = None, log: Path | None = None) -> None:
    if env is None:
        env = os.environ.copy()
        for name in ("PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE", "PYTHONSTARTUP"):
            env.pop(name, None)
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env["PYTHONNOUSERSITE"] = "1"
    result = subprocess.run(argv, cwd=cwd, env=env, capture_output=True,
                            text=True, encoding="utf-8", errors="replace", check=False)
    if log is not None:
        with log.open("a", encoding="utf-8") as stream:
            script = next((Path(part).name for part in argv[1:] if part.endswith(".py")), argv[1])
            stream.write("$ " + Path(argv[0]).name + " " + script + "\n")
            stream.write(result.stdout + result.stderr + "\n")
    if result.returncode:
        fail("装配或核验失败；部分新目录保留供检查，详情见私有 install.log")


def write_json(path: Path, value: dict) -> None:
    raw = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    with path.open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def set_status(root: Path, status: str, detail: str = "") -> None:
    path = root / "private" / "install-state.json"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"schemaVersion": 1, "scope": SCOPE,
                                     "status": status, "detail": detail},
                                    ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def discover_models(models_dir: Path) -> dict[str, Path]:
    """Locate exactly one physical file for each fixed graph loader basename."""
    by_name = {filename.casefold(): role for role, (_category, filename) in MODEL_FILES.items()}
    hits: dict[str, Path] = {}
    directory_count = file_count = 0
    for current, dirs, files in os.walk(models_dir, topdown=True, followlinks=False):
        directory_count += 1
        if directory_count > 10000 or len(Path(current).relative_to(models_dir).parts) > 16:
            fail("模型目录扫描超出固定上限")
        for dirname in dirs:
            child = Path(current) / dirname
            if child.is_symlink() or getattr(child, "is_junction", lambda: False)():
                fail("模型目录含链接或 junction")
        dirs.sort()
        for filename in files:
            file_count += 1
            if file_count > 100000:
                fail("模型文件扫描超出固定上限")
            role = by_name.get(filename.casefold())
            if role is None:
                continue
            candidate = ordinary_file(Path(current) / filename)
            if not candidate.is_relative_to(models_dir):
                fail("模型文件越出指定模型根")
            if role in hits:
                fail("固定图模型文件名不唯一: " + role)
            hits[role] = candidate
    if set(hits) != set(MODEL_FILES):
        fail("固定图五个模型文件缺失: " + ", ".join(sorted(set(MODEL_FILES) - set(hits))))
    return hits


def model_yaml(models: dict[str, Path]) -> str:
    # YAML block scalars avoid escapes in Windows paths.  Keep weights in their
    # physical tree; this private file is frozen by the runtime.
    categories: dict[str, list[Path]] = {}
    for role, (category, _filename) in MODEL_FILES.items():
        parent = models[role].parent
        if parent not in categories.setdefault(category, []):
            categories[category].append(parent)
    lines = ["canonical_models:"]
    for name, parents in categories.items():
        lines.append(f"  {name}: |")
        lines.extend("    " + str(parent) for parent in parents)
    return "\n".join(lines) + "\n"


def copy_control(root: Path) -> None:
    control = root / "control"
    (control / "tests").mkdir(parents=True)
    (control / "comfy").mkdir()
    sources = {
        KIT / "launch_windows.py": control / "launch_windows.py",
        KIT / "prepared_env_receipt.py": control / "prepared_env_receipt.py",
        KIT / "tests" / "preflight_runtime.py": control / "tests" / "preflight_runtime.py",
        KIT / "dependencies.lock.json": control / "dependencies.lock.json",
        KIT / "python-wheels.lock.json": control / "python-wheels.lock.json",
        KIT / "comfy" / "vendor-lock.json": control / "comfy" / "vendor-lock.json",
        KIT / "manifest.json": control / "manifest.json",
    }
    for source, target in sources.items():
        ordinary_file(source)
        with source.open("rb") as reader, target.open("xb") as writer:
            shutil.copyfileobj(reader, writer, 4 * 1024 * 1024)
            writer.flush()
            os.fsync(writer.fileno())
        if sha256(source) != sha256(target):
            fail("受控启动文件复制后摘要不符")


def receipt_function(name: str):
    source = KIT / "prepared_env_receipt.py"
    namespace: dict = {"__name__": "prepared_env_receipt"}
    exec(compile(source.read_bytes(), str(source), "exec"), namespace)
    return namespace[name]


def install(args: argparse.Namespace) -> None:
    if os.name != "nt":
        fail("该安装流程只支持 Windows")
    root = check_new_root(args.root)
    api_python = ordinary_file(args.api_python)
    comfy_python = ordinary_file(args.comfy_python)
    if api_python == comfy_python:
        fail("API 与 Comfy 的不同版本环境须使用不同 Python 解释器")
    models_dir = ordinary_dir(args.models_dir)
    if models_dir.is_relative_to(KIT.parents[1]):
        fail("模型目录不得位于源码仓库内")
    models = discover_models(models_dir)
    if any("\n" in str(p) or "\r" in str(p) for p in (root, models_dir)):
        fail("路径不能含换行")
    slot = check_slot(args.gpu_slot_file, args.initialize_gpu_slot)
    if slot.is_relative_to(root) or slot.is_relative_to(KIT.parents[1]):
        fail("GPU slot 须在安装目录和源码仓库之外，供同机服务共享")
    if not args.machine_label.strip() or len(args.machine_label) > 100:
        fail("机器标签缺失或过长")
    if args.api_port == args.comfy_port:
        fail("API 与 Comfy 端口不能相同")
    check_port(args.api_port)
    check_port(args.comfy_port)
    ffmpeg = ordinary_file(args.ffmpeg)
    dependency_lock = json.loads((KIT / "dependencies.lock.json").read_text(encoding="utf-8"))
    if dependency_lock.get("scope") != SCOPE or dependency_lock.get("schemaVersion") != 2:
        fail("Python 依赖锁版本或 scope 不符")
    check_interpreter(api_python, dependency_lock["apiPython"])
    check_interpreter(comfy_python, dependency_lock["comfyPython"])
    if sha256(ffmpeg) != dependency_lock["externalExecutables"]["ffmpeg"]["observedSha256"]:
        fail("ffmpeg 可执行文件原字节 SHA256 与固定来源锁不符")
    git = check_git_executable(args.git_exe, dependency_lock["externalExecutables"]["git"])
    assembly_env = assembly_environment(git, api_python, comfy_python, ffmpeg)
    for vendor in VENDORS:
        source = getattr(args, vendor + "_source")
        if source is not None:
            ordinary_dir(source)

    manifest = json.loads((KIT / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("scope") != SCOPE:
        fail("源码 scope 不符")
    checked_process([sys.executable, "-I", "-B", str(KIT / "tests" / "verify_package.py"),
                     "--skip-import"], env=assembly_env)
    prepared_root = api_python.parents[2]
    if prepared_root.is_relative_to(KIT.parents[1]):
        fail("准备 Python 环境必须位于源码仓库之外")
    prepared_receipt = prepared_root / "prepare-receipt.json"
    prepared_sha256 = receipt_function("verify_receipt")(
        prepared_receipt, KIT / "dependencies.lock.json", KIT / "python-wheels.lock.json",
        api_python, comfy_python)

    root.mkdir()  # atomic refusal of another installation in this slot
    private = root / "private"
    private.mkdir()
    log = private / "install.log"
    set_status(root, "assembling")
    try:
        api = root / "source" / "api"
        comfy = root / "source" / "comfy"
        api.parent.mkdir()
        checked_process([sys.executable, "-I", "-B", str(KIT / "h3_api" / "assemble.py"),
                         "--target", str(api)], env=assembly_env, log=log)
        command = [sys.executable, "-I", "-B", str(KIT / "comfy" / "assemble_comfy.py"),
                   "--output", str(comfy)]
        for vendor in VENDORS:
            source = getattr(args, vendor + "_source")
            if source is not None:
                command.extend(["--" + vendor + "-source", str(source)])
        checked_process(command, env=assembly_env, log=log)
        checked_process([sys.executable, "-I", "-B", str(KIT / "tests" / "verify_package.py"),
                         "--skip-import", "--comfy-assembled", str(comfy)],
                        env=assembly_env, log=log)
        set_status(root, "source-verified")

        data = private / "data"
        for relative in ("input/LocalAPI", "output/MiniMax_H3/LocalAPI",
                         "adapter/jobs", "workflows", "temp", "user"):
            (data / relative).mkdir(parents=True, exist_ok=False)
        with (comfy / "extra_model_paths.yaml").open("x", encoding="utf-8") as stream:
            stream.write(model_yaml(models))
        if args.initialize_gpu_slot:
            initialize_slot(slot)
        copy_control(root)
        control_files = (
            "launch_windows.py", "prepared_env_receipt.py", "tests/preflight_runtime.py",
            "dependencies.lock.json",
            "python-wheels.lock.json", "comfy/vendor-lock.json", "manifest.json",
        )
        config = {
            "schemaVersion": 1, "scope": SCOPE,
            "sourceManifestSha256": sha256(KIT / "manifest.json"),
            "controlSha256": {name: sha256(root / "control" / Path(name))
                               for name in control_files},
            "modelPathConfigSha256": sha256(comfy / "extra_model_paths.yaml"),
            "apiRoot": str(api), "comfyRoot": str(comfy),
            "apiPython": str(api_python), "comfyPython": str(comfy_python),
            "preparedReceiptPath": str(prepared_receipt),
            "preparedReceiptSha256": prepared_sha256,
            "ffmpeg": str(ffmpeg), "gitExe": str(git),
            "modelsDir": str(models_dir),
            "gpuSlotFile": str(slot), "machineLabel": args.machine_label,
            "apiPort": args.api_port, "comfyPort": args.comfy_port,
            "gpuIndex": args.gpu_index,
            "inputRoot": str(data / "input"), "outputRoot": str(data / "output"),
            "adapterRoot": str(data / "adapter"),
            "workflowDir": str(data / "workflows"),
            "tempRoot": str(data / "temp"), "userRoot": str(data / "user"),
        }
        write_json(private / "config.json", config)
        set_status(root, "configured")
        checked_process([str(api_python), "-I", "-B", str(root / "control" / "launch_windows.py"),
                         "check"], env=assembly_env, log=log)
        set_status(root, "preflight-passed")
    except Exception as error:
        set_status(root, "needs-inspection", type(error).__name__)
        raise
    print("独立安装和静态自检通过；服务未启动，也未执行 GPU 作业")
    print("启动入口:", root / "control" / "launch_windows.py")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True, help="全新独立安装目录")
    parser.add_argument("--api-python", type=Path, required=True)
    parser.add_argument("--comfy-python", type=Path, required=True)
    parser.add_argument("--models-dir", type=Path, required=True,
                        help="现有模型类别目录的父目录，含 unet/clip/vae/loras 等")
    parser.add_argument("--gpu-slot-file", type=Path, required=True)
    parser.add_argument("--initialize-gpu-slot", action="store_true",
                        help="只供全新设备：state/lock 均不存在时一次性创建")
    parser.add_argument("--machine-label", required=True)
    parser.add_argument("--api-port", type=int, required=True)
    parser.add_argument("--comfy-port", type=int, required=True)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--git-exe", type=Path, required=True,
                        help="已核原字节与版本的 Git for Windows 引擎 git.exe")
    parser.add_argument("--gpu-index", type=int)
    for vendor in VENDORS:
        parser.add_argument("--" + vendor + "-source", type=Path,
                            help="已核来源的公开 vendor Git clone；省略则从固定公开 origin 拉取")
    args = parser.parse_args()
    try:
        install(args)
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as error:
        print("安装拒绝: " + str(error), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    if not sys.flags.isolated:
        print("请以 python -I -B 启动安装器，隔离外部 PYTHONPATH", file=sys.stderr)
        raise SystemExit(2)
    main()
