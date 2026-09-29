"""Prepare two isolated CPython 3.12.10 environments from exact pinned wheels.

This optional first step never installs into an existing interpreter.  Use
`--download` to fetch only lock-listed public URLs into the new root, or give
an existing complete `--wheelhouse`.  Every wheel is SHA256-checked before pip.
No source assembly, service start, or H3 GPU job occurs here.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
from urllib.parse import unquote, urlsplit
from urllib.request import Request, urlopen


KIT = Path(__file__).resolve().parent
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="backslashreplace")
ALLOWED_HOSTS = {"files.pythonhosted.org", "download-r2.pytorch.org", "github.com"}
CAPABILITIES = {(7, 5), (8, 0), (8, 6), (8, 9), (9, 0), (12, 0)}
SHA = re.compile(r"[0-9a-f]{64}\Z")


def reject(message: str) -> None:
    raise RuntimeError(message)


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def physical(path: Path, *, exists: bool) -> Path:
    if not path.is_absolute():
        reject("路径必须为绝对路径")
    for part in (path, *path.parents):
        if part.exists() and (part.is_symlink() or getattr(part, "is_junction", lambda: False)()):
            reject("路径含链接或 junction")
    if exists and not path.exists():
        reject("所需路径不存在")
    return path.resolve(strict=exists)


def read_locks() -> tuple[dict, dict]:
    dep = json.loads((KIT / "dependencies.lock.json").read_text(encoding="utf-8"))
    wheel = json.loads((KIT / "python-wheels.lock.json").read_text(encoding="utf-8"))
    if (dep.get("schemaVersion") != 2 or wheel.get("schemaVersion") != 1 or
            dep.get("scope") != wheel.get("scope") or
            wheel.get("target") != {"python": "3.12.10", "implementation": "CPython", "platform": "win_amd64"}):
        reject("依赖/来源锁 schema 或目标平台不符")
    if dep.get("apiPython") != "3.12.10" or dep.get("comfyPython") != "3.12.10":
        reject("Python 固定版本不符")
    all_keys = set()
    for mode, field in (("api", "apiResolved"), ("comfy", "comfyResolved")):
        expected = {name + "==" + version for name, version in dep[field].items()}
        actual = wheel["profiles"][mode]
        if len(actual) != len(expected) or set(actual) != expected:
            reject("wheel profile 与完整依赖闭包不一致")
        all_keys.update(expected)
    if set(wheel["wheels"]) != all_keys:
        reject("wheel 来源集合不等于两个固定依赖闭包")
    filenames = set()
    for key, row in wheel["wheels"].items():
        filename, url, expected = row["filename"], row["url"], row["sha256"]
        parsed = urlsplit(url)
        if (parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS or
                parsed.username or parsed.password or parsed.query or parsed.fragment or
                unquote(Path(parsed.path).name) != filename):
            reject("wheel 来源不是固定公开文件 URL")
        if (not filename.endswith(".whl") or filename != Path(filename).name or
                "\\" in filename or filename in filenames or not SHA.fullmatch(expected)):
            reject("wheel 文件名或 SHA256 不合法")
        filenames.add(filename)
    return dep, wheel


def require_base_python(path: Path) -> Path:
    path = physical(path, exists=True)
    if not path.is_file() or path.stat().st_nlink != 1:
        reject("基础 Python 须为普通单链接文件")
    probe = (
        "import json,platform,sys;"
        "print(json.dumps({'version':platform.python_version(),"
        "'implementation':platform.python_implementation(),"
        "'platform':sys.platform,'machine':platform.machine().lower(),"
        "'bits':64 if sys.maxsize>2**32 else 32}))"
    )
    result = subprocess.run([str(path), "-B", "-I", "-c", probe],
                            capture_output=True, text=True, timeout=15, check=False)
    if result.returncode:
        reject("基础 Python 无法运行")
    facts = json.loads(result.stdout)
    if facts != {"version": "3.12.10", "implementation": "CPython",
                 "platform": "win32", "machine": "amd64", "bits": 64}:
        reject("需要 Windows x64 CPython 3.12.10")
    return path


def verify_wheelhouse(directory: Path, wheel_lock: dict) -> None:
    directory = physical(directory, exists=True)
    if not directory.is_dir():
        reject("wheelhouse 不是目录")
    expected_names = {row["filename"] for row in wheel_lock["wheels"].values()}
    actual_names = {path.name for path in directory.iterdir() if path.suffix == ".whl"}
    if actual_names != expected_names:
        reject("wheelhouse 文件集合与锁不符")
    for row in wheel_lock["wheels"].values():
        path = directory / row["filename"]
        if not path.is_file() or path.is_symlink() or path.stat().st_nlink != 1:
            reject("wheel 文件缺失、链接或多重硬链接")
        if digest(path) != row["sha256"]:
            reject("wheel 原字节 SHA256 不符: " + row["filename"])


def download_wheels(directory: Path, wheel_lock: dict) -> None:
    directory.mkdir()
    for row in wheel_lock["wheels"].values():
        target = directory / row["filename"]
        temporary = target.with_suffix(".download")
        if target.exists() or temporary.exists():
            reject("新 wheelhouse 已含文件；拒绝覆盖")
        h = hashlib.sha256()
        # PyTorch's official R2 host rejects urllib's default User-Agent with
        # 403 on this Windows host; a pip-style header leaves the locked URL
        # and SHA256 unchanged.
        request = Request(
            row["url"], headers={"User-Agent": "pip/25.0 python/3.12 win_amd64"})
        with urlopen(request, timeout=60) as response, temporary.open("xb") as output:
            if urlsplit(response.url).scheme != "https":
                reject("wheel 下载未保持 HTTPS")
            for chunk in iter(lambda: response.read(4 * 1024 * 1024), b""):
                output.write(chunk)
                h.update(chunk)
            output.flush()
            os.fsync(output.fileno())
        if h.hexdigest() != row["sha256"]:
            reject("下载 wheel 的原字节 SHA256 不符: " + row["filename"])
        os.replace(temporary, target)
    verify_wheelhouse(directory, wheel_lock)


def copy_verified_wheels(source: Path, destination: Path, wheel_lock: dict) -> None:
    destination.mkdir()
    for row in wheel_lock["wheels"].values():
        from_file = source / row["filename"]
        to_file = destination / row["filename"]
        with from_file.open("rb") as reader, to_file.open("xb") as writer:
            shutil.copyfileobj(reader, writer, 4 * 1024 * 1024)
            writer.flush()
            os.fsync(writer.fileno())
        if digest(to_file) != row["sha256"]:
            reject("复制 wheel 的原字节 SHA256 不符: " + row["filename"])
    verify_wheelhouse(destination, wheel_lock)


def pip_requirements(profile: list[str], wheels: dict) -> str:
    return "".join(key + " --hash=sha256:" + wheels[key]["sha256"] + "\n"
                   for key in sorted(profile))


def clean_python_env() -> dict[str, str]:
    env = os.environ.copy()
    for name in ("PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE", "PYTHONSTARTUP"):
        env.pop(name, None)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONNOUSERSITE"] = "1"
    return env


def receipt_function(name: str):
    source = KIT / "prepared_env_receipt.py"
    namespace: dict = {"__name__": "prepared_env_receipt"}
    exec(compile(source.read_bytes(), str(source), "exec"), namespace)
    return namespace[name]


def run_checked(command: list[str], *, log: Path) -> None:
    result = subprocess.run(command, capture_output=True, text=True,
                            encoding="utf-8", errors="replace", check=False,
                            env=clean_python_env())
    with log.open("a", encoding="utf-8") as stream:
        stream.write(Path(command[0]).name + " " + command[1] + "\n")
        stream.write(result.stdout + result.stderr + "\n")
    if result.returncode:
        reject("隔离环境创建或核验失败；新目录保留供检查，详情见 prepare.log")


def check_cuda(python: Path, gpu_index: int | None, log: Path) -> None:
    code = (
        "import importlib.metadata,sageattention,torch,triton,sys; "
        "sys.stdout.reconfigure(encoding='utf-8',errors='backslashreplace'); "
        "assert callable(getattr(sageattention,'sageattn',None)); "
        "assert importlib.metadata.version('triton-windows')=='3.5.1.post24' "
        "and triton.__version__=='3.5.1'; "
        "assert torch.version.cuda=='13.0' and torch.cuda.is_available(); "
        "n=torch.cuda.device_count(); i=int(sys.argv[1]) if sys.argv[1]!='auto' else (0 if n==1 else -1); "
        "assert 0<=i<n and tuple(torch.cuda.get_device_capability(i)) in " + repr(CAPABILITIES) + "; "
        "print('CUDA 13.0 / SageAttention 候选通过; GPU index='+str(i))"
    )
    run_checked([str(python), "-I", "-B", "-c", code,
                 "auto" if gpu_index is None else str(gpu_index)], log=log)


def prepare(args: argparse.Namespace) -> None:
    source_check = subprocess.run(
        [sys.executable, "-I", "-B", str(KIT / "tests" / "verify_package.py"), "--skip-import"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        check=False, env=clean_python_env(),
    )
    if source_check.returncode:
        reject("canonical 源码清单未通过，拒绝准备 Python 环境")
    dep, wheel_lock = read_locks()
    base = require_base_python(args.base_python)
    root = physical(args.root, exists=False)
    if root.exists():
        reject("环境准备目录须全新；拒绝覆盖")
    if root.is_relative_to(KIT.parents[1]) or KIT.is_relative_to(root):
        reject("隔离环境目录须在源码仓库之外")
    if not root.parent.is_dir():
        reject("环境准备目录的父目录须已存在")
    if args.wheelhouse is not None:
        wheelhouse = physical(args.wheelhouse, exists=True)
        verify_wheelhouse(wheelhouse, wheel_lock)
    root.mkdir()
    log = root / "prepare.log"
    try:
        if args.download:
            wheelhouse = root / "wheels"
            download_wheels(wheelhouse, wheel_lock)
        else:
            copy_verified_wheels(wheelhouse, root / "wheels", wheel_lock)
            wheelhouse = root / "wheels"
        assert wheelhouse is not None
        for mode in ("api", "comfy"):
            env_dir = root / mode
            run_checked([str(base), "-I", "-B", "-m", "venv", str(env_dir)], log=log)
            python = env_dir / "Scripts" / "python.exe"
            if not python.is_file():
                reject("隔离 Python 未生成")
            requirement_file = root / (mode + "-requirements.txt")
            requirement_file.write_text(
                pip_requirements(wheel_lock["profiles"][mode], wheel_lock["wheels"]),
                encoding="utf-8",
            )
            run_checked([str(python), "-I", "-B", "-m", "pip", "--isolated", "install", "--no-input", "--no-index",
                         "--find-links", str(wheelhouse), "--no-deps", "--no-compile",
                         "--only-binary=:all:", "--require-hashes", "-r", str(requirement_file)],
                        log=log)
            run_checked([str(python), "-I", "-B", "-m", "pip", "check"], log=log)
            # Exact complete closure, including no unexpected site packages,
            # is checked by the canonical preflight during source installation.
        check_cuda(root / "comfy" / "Scripts" / "python.exe", args.gpu_index, log)
        receipt = receipt_function("write_receipt")(
            root, KIT / "dependencies.lock.json", KIT / "python-wheels.lock.json")
    except Exception:
        (root / "needs-inspection.txt").write_text(
            "隔离环境未通过；保留原样供诊断，不要把此目录作为安装参数。\n", encoding="utf-8")
        raise
    print("隔离 Python 环境已准备；请用于 install_windows.py 的 --api-python 与 --comfy-python")
    print(root / "api" / "Scripts" / "python.exe")
    print(root / "comfy" / "Scripts" / "python.exe")
    print("私有准备回执:", receipt)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True, help="全新隔离环境目录")
    parser.add_argument("--base-python", type=Path, required=True,
                        help="已安装的 Windows x64 CPython 3.12.10")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--download", action="store_true", help="只按固定公开 URL 下载全部 wheel")
    source.add_argument("--wheelhouse", type=Path, help="现存且完整的 128 wheel 目录")
    parser.add_argument("--gpu-index", type=int, help="多 GPU 时选择候选设备索引")
    args = parser.parse_args()
    try:
        prepare(args)
    except (RuntimeError, OSError, ValueError, KeyError, AssertionError,
            subprocess.SubprocessError) as error:
        print("环境准备拒绝: " + str(error), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    if not sys.flags.isolated:
        print("请以 python -I -B 启动环境准备器，隔离外部 PYTHONPATH", file=sys.stderr)
        raise SystemExit(2)
    main()
