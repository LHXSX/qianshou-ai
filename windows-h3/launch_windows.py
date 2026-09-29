"""Operate one staged canonical installation in the foreground.

This file is copied to <install>/control.  `check` reads and hashes sources and
models without opening a service or submitting a GPU job.  `start-comfy` and
`start-api` require an explicit operator invocation in separate terminals.
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys


CONTROL = Path(__file__).resolve().parent
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="backslashreplace")
INSTALL = CONTROL.parent
CONFIG = INSTALL / "private" / "config.json"
SCOPE = "qs_new4/E_light4_sage"


def reject(message: str) -> None:
    raise RuntimeError(message)


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as reader:
        for block in iter(lambda: reader.read(4 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def physical(path: Path, *, directory: bool) -> Path:
    if not path.is_absolute():
        reject("配置路径非绝对路径")
    for parent in (path, *path.parents):
        if parent.exists() and (parent.is_symlink() or getattr(parent, "is_junction", lambda: False)()):
            reject("配置路径含链接或 junction")
    if directory and not path.is_dir():
        reject("配置目录缺失")
    if not directory and (not path.is_file() or path.stat().st_nlink != 1):
        reject("配置普通文件缺失")
    return path.resolve(strict=True)


def physical_git_engine(path: Path) -> Path:
    # The pinned Git for Windows engine has four official NTFS hard links.
    if (not path.is_absolute() or path.name.casefold() != "git.exe" or
            path.parent.name.casefold() != "bin" or
            path.parent.parent.name.casefold() != "mingw64"):
        reject("Git 引擎路径非绝对物理 git.exe")
    for parent in (path, *path.parents):
        if parent.exists() and (parent.is_symlink() or
                                getattr(parent, "is_junction", lambda: False)()):
            reject("Git 引擎路径含链接或 junction")
    if not path.is_file():
        reject("Git 引擎文件缺失")
    return path.resolve(strict=True)


def config() -> dict:
    physical(CONFIG, directory=False)
    data = json.loads(CONFIG.read_text(encoding="utf-8"))
    if data.get("schemaVersion") != 1 or data.get("scope") != SCOPE:
        reject("安装配置版本或 scope 不符")
    if physical(Path(data["apiRoot"]), directory=True) != INSTALL / "source" / "api":
        reject("API 根与独立安装目录不符")
    if physical(Path(data["comfyRoot"]), directory=True) != INSTALL / "source" / "comfy":
        reject("Comfy 根与独立安装目录不符")
    for key in ("apiPython", "comfyPython", "ffmpeg", "gpuSlotFile"):
        physical(Path(data[key]), directory=False)
    physical_git_engine(Path(data["gitExe"]))
    for key in ("modelsDir", "inputRoot", "outputRoot", "adapterRoot",
                "workflowDir", "tempRoot", "userRoot"):
        physical(Path(data[key]), directory=True)
    if data["apiPort"] == data["comfyPort"]:
        reject("API 与 Comfy 端口冲突")
    for key in ("apiPort", "comfyPort"):
        if type(data[key]) is not int or not 1024 <= data[key] <= 65535:
            reject("安装端口无效")
    if digest(INSTALL / "source" / "api" / "canonical-manifest.json") != data["sourceManifestSha256"]:
        reject("API 安装清单摘要不符")
    if digest(CONTROL / "manifest.json") != data["sourceManifestSha256"]:
        reject("控制清单摘要不符")
    expected_control = {
        "launch_windows.py", "prepared_env_receipt.py", "tests/preflight_runtime.py",
        "dependencies.lock.json",
        "python-wheels.lock.json", "comfy/vendor-lock.json", "manifest.json",
    }
    if set(data["controlSha256"]) != expected_control:
        reject("受控启动/依赖来源文件集合不符")
    for name, expected in data["controlSha256"].items():
        if digest(CONTROL / Path(name)) != expected:
            reject("受控启动/依赖来源文件原字节不符")
    receipt_source = CONTROL / "prepared_env_receipt.py"
    namespace: dict = {"__name__": "prepared_env_receipt"}
    exec(compile(receipt_source.read_bytes(), str(receipt_source), "exec"), namespace)
    namespace["verify_receipt"](
        Path(data["preparedReceiptPath"]), CONTROL / "dependencies.lock.json",
        CONTROL / "python-wheels.lock.json", Path(data["apiPython"]),
        Path(data["comfyPython"]), expected_sha256=data["preparedReceiptSha256"])
    if digest(INSTALL / "source" / "comfy" / "extra_model_paths.yaml") != data["modelPathConfigSha256"]:
        reject("私有模型路径配置原字节改变；请在空队列下重新安装并自测")
    return data


def runtime_env(data: dict) -> dict[str, str]:
    env = os.environ.copy()
    for name in list(env):
        upper = name.upper()
        if (upper.startswith(("H3_", "GPU_", "CUDA_", "NVIDIA_", "HIP_", "ROCR_",
                              "TORCH_", "PYTORCH_", "COMFY_", "HF_", "HUGGINGFACE_",
                              "VHS_", "JOV_", "FFMPEG_", "IMAGEIO_", "GIT_")) or
                upper in {"PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE", "PYTHONSTARTUP",
                          "COLOREDLOGS_AUTO_INSTALL"}):
            env.pop(name, None)

    def system_directory(name: str) -> Path:
        if os.name != "nt":
            reject("仅支持 Windows 运行时")
        buffer = ctypes.create_unicode_buffer(32768)
        length = getattr(ctypes.windll.kernel32, name)(buffer, len(buffer))
        if length <= 0 or length >= len(buffer):
            reject("无法定位 Windows 系统目录")
        return physical(Path(buffer.value), directory=True)

    directories = [Path(data["ffmpeg"]).parent, Path(data["apiPython"]).parent,
                   Path(data["comfyPython"]).parent,
                   system_directory("GetSystemDirectoryW"),
                   system_directory("GetWindowsDirectoryW")]
    search_path: list[str] = []
    seen: set[str] = set()
    for directory in directories:
        resolved = physical(directory, directory=True)
        key = os.path.normcase(str(resolved))
        if key not in seen:
            search_path.append(str(resolved))
            seen.add(key)
    env["PATH"] = os.pathsep.join(search_path)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONNOUSERSITE"] = "1"
    env["H3_INSTANCE"] = "canonical-qs_new4-E_light4_sage"
    # Pinned VideoHelperSuite otherwise compares its bundled imageio binary
    # with PATH candidates and may select a different encoder at runtime.
    env["VHS_FORCE_FFMPEG_PATH"] = data["ffmpeg"]
    env["H3_COMFY_BASE"] = "http://127.0.0.1:" + str(data["comfyPort"])
    env["H3_COMFY_ROOT"] = data["comfyRoot"]
    env["H3_COMFY_MODEL_ROOT"] = data["comfyRoot"]
    env["H3_ADAPTER_INPUT_ROOT"] = str(Path(data["inputRoot"]) / "LocalAPI")
    env["H3_ADAPTER_OUTPUT_ROOT"] = str(Path(data["outputRoot"]) / "MiniMax_H3" / "LocalAPI")
    env["H3_JOBS_DIR"] = str(Path(data["adapterRoot"]) / "jobs")
    env["H3_WORKFLOW_DIR"] = data["workflowDir"]
    env["H3_MACHINE_LABEL"] = data["machineLabel"]
    env["GPU_SLOT_FILE"] = data["gpuSlotFile"]
    env["H3_CANONICAL_MANIFEST_PATH"] = str(INSTALL / "source" / "api" / "canonical-manifest.json")
    env["H3_CANONICAL_CONFIG_PATH"] = str(CONFIG)
    env["H3_CANONICAL_GIT_EXE"] = data["gitExe"]
    return env


def run_gate(data: dict, mode: str, env: dict[str, str]) -> None:
    python = data["apiPython"] if mode == "api" else data["comfyPython"]
    command = [python, "-B", str(CONTROL / "tests" / "preflight_runtime.py"),
               "--mode", mode]
    if mode == "comfy":
        command.extend(["--comfy-root", data["comfyRoot"]])
        if data.get("gpuIndex") is not None:
            command.extend(["--gpu-index", str(data["gpuIndex"])])
    result = subprocess.run(command, cwd=INSTALL, env=env, capture_output=True,
                            text=True, encoding="utf-8", errors="replace", check=False)
    if result.returncode:
        reject(mode + " 依赖/来源/GPU 静态闸拒绝；" + (result.stderr.strip()[-350:] or "查看本机依赖"))
    print(result.stdout.strip())


def full_source_check(data: dict, env: dict[str, str]) -> None:
    code = (
        "import pathlib,sys; "
        "sys.path.insert(0,sys.argv[1]); "
        "from workbench.source_manifest import RuntimeSourceManifest; "
        "print(RuntimeSourceManifest(pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2]),"
        "pathlib.Path(sys.argv[3])).check())"
    )
    command = [data["apiPython"], "-B", "-c", code, data["apiRoot"],
               data["comfyRoot"], str(Path(data["apiRoot"]) / "canonical-manifest.json")]
    result = subprocess.run(command, cwd=INSTALL, env=env, capture_output=True,
                            text=True, encoding="utf-8", errors="replace", check=False)
    if result.returncode or result.stdout.strip() != data["sourceManifestSha256"]:
        reject("API/Comfy 完整运行时源码清单闸拒绝")
    print("完整运行时源码清单 SHA256:", result.stdout.strip())


def model_check(data: dict, env: dict[str, str]) -> None:
    # Same graph/model resolution code as the controlled API, but no Comfy
    # process and no graph submission.  Resolve via both API identity code and
    # the actual pinned Comfy folder_paths parser before accepting five hashes.
    code = (
        "import json,pathlib,sys; "
        "api=pathlib.Path(sys.argv[1]); comfy=pathlib.Path(sys.argv[2]); "
        "sys.path[:0]=[str(api/'workbench'),str(api)]; "
        "import recipe_identity as ri; "
        "x=ri.build_identity(api,comfy,{'entry':api/'workbench'/'workbench_node.py'},"
        "source_manifest_sha256=sys.argv[3],class_origin_sha256='0'*64,"
        "output_root=pathlib.Path(sys.argv[4]),force_hash=True); "
        "names=ri._model_names(ri._reference_graph(api)); roots=ri._model_roots(comfy); "
        "loaders={role:{'category':category,'name':name,'path':str(ri._resolve_model(roots[category],name,role))} "
        "for role,(category,name) in names.items()}; "
        "print(json.dumps({'modelSha256':x.model_sha256,'weightSha256ByRole':x.model_asset_sha256,"
        "'loaders':loaders},sort_keys=True))"
    )
    command = [data["apiPython"], "-B", "-c", code, data["apiRoot"],
               data["comfyRoot"], data["sourceManifestSha256"], data["outputRoot"]]
    result = subprocess.run(command, cwd=INSTALL, env=env, capture_output=True,
                            text=True, encoding="utf-8", errors="replace", check=False)
    if result.returncode:
        reject("固定图五个模型文件路径/字节核验失败")
    measured = json.loads(result.stdout)
    if set(measured["weightSha256ByRole"]) != {"unet", "clip", "videoVae", "audioVae", "lora"}:
        reject("五个模型 loader 角色不全")
    comfy_code = (
        "import json,pathlib,sys; comfy=pathlib.Path(sys.argv[1]); "
        "sys.path.insert(0,str(comfy)); import folder_paths,utils.extra_config; "
        "utils.extra_config.load_extra_path_config(str(comfy/'extra_model_paths.yaml')); "
        "loaders=json.loads(sys.argv[2]); "
        "print(json.dumps({role:folder_paths.get_full_path_or_raise(row['category'],row['name']) "
        "for role,row in loaders.items()},sort_keys=True))"
    )
    comfy_result = subprocess.run(
        [data["comfyPython"], "-B", "-c", comfy_code, data["comfyRoot"],
         json.dumps(measured["loaders"], sort_keys=True)],
        cwd=data["comfyRoot"], env=env, capture_output=True,
        text=True, encoding="utf-8", errors="replace", check=False,
    )
    if comfy_result.returncode:
        reject("Comfy folder_paths 未解析到固定图五个模型")
    comfy_paths = json.loads(comfy_result.stdout)
    if set(comfy_paths) != set(measured["loaders"]):
        reject("Comfy 与 API 的模型角色集合不一致")
    for role, path in comfy_paths.items():
        if os.path.normcase(str(Path(path).resolve(strict=True))) != os.path.normcase(
                str(Path(measured["loaders"][role]["path"]).resolve(strict=True))):
            reject("Comfy 与 API 的固定图模型路径不一致: " + role)
    receipt = {"modelSha256": measured["modelSha256"],
               "weightSha256ByRole": measured["weightSha256ByRole"]}
    destination = INSTALL / "private" / "model-source-receipt.json"
    temporary = destination.with_suffix(".tmp")
    temporary.write_text(json.dumps(receipt, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, destination)
    print("Comfy/API 五个 loader 路径及原字节 SHA256 已核；私有回执已保存")


def require_free_port(port: int) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.5)
        if probe.connect_ex(("127.0.0.1", port)) == 0:
            reject("端口已有监听进程；拒绝覆盖或重启")


def start(data: dict, mode: str, env: dict[str, str]) -> None:
    if mode == "start-comfy":
        require_free_port(data["comfyPort"])
        run_gate(data, "comfy", env)
        full_source_check(data, env)
        command = [data["comfyPython"], "-B", str(Path(data["comfyRoot"]) / "main.py"),
                   "--listen", "127.0.0.1", "--port", str(data["comfyPort"]),
                   "--cache-none", "--input-directory", data["inputRoot"],
                   "--output-directory", data["outputRoot"],
                   "--temp-directory", data["tempRoot"],
                   "--user-directory", data["userRoot"]]
        cwd = data["comfyRoot"]
    else:
        require_free_port(data["apiPort"])
        run_gate(data, "api", env)
        full_source_check(data, env)
        command = [data["apiPython"], "-B", str(Path(data["apiRoot"]) / "workbench" / "workbench_node.py"),
                   "--api-root", data["apiRoot"], "--root", data["comfyRoot"],
                   "--out", data["adapterRoot"], "--listen-port", str(data["apiPort"]),
                   "--serve-authorized-test"]
        cwd = data["apiRoot"]
    print("即将以前台进程启动", mode, "端口", data["comfyPort"] if mode == "start-comfy" else data["apiPort"], flush=True)
    raise SystemExit(subprocess.call(command, cwd=cwd, env=env))


def main() -> None:
    parser = argparse.ArgumentParser(description="canonical 独立安装的静态自检与前台启动")
    parser.add_argument("action", choices=("check", "start-comfy", "start-api"),
                        help="check 自检；start-comfy 启动 Comfy；start-api 启动 API")
    args = parser.parse_args()
    try:
        data = config()
        env = runtime_env(data)
        if args.action == "check":
            run_gate(data, "api", env)
            run_gate(data, "comfy", env)
            full_source_check(data, env)
            model_check(data, env)
            print("静态自检通过；未启动服务或执行 GPU 作业")
        else:
            start(data, args.action, env)
    except (RuntimeError, OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        print("拒绝: " + str(error), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    if not sys.flags.isolated:
        print("请以 python -I -B 启动受控入口，隔离外部 PYTHONPATH", file=sys.stderr)
        raise SystemExit(2)
    main()
