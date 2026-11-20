"""从 uv 管理的独立 Python 构建项目内可搬移解析环境，不修改系统 Python。"""
import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

project = Path(__file__).resolve().parents[2]
default_output = project / "tmp/parser-runtime"
parser = argparse.ArgumentParser()
parser.add_argument("--output", default=str(default_output))
model_source = parser.add_mutually_exclusive_group(required=True)
model_source.add_argument("--models", help="已下载的 MinerU_HOME")
model_source.add_argument("--download-models", action="store_true", help="用 MinerU 下载 ONNX 模型")
parser.add_argument("--offline", action="store_true")
parser.add_argument("--resume", action="store_true", help="继续本项目内尚未完成的运行环境准备")
args = parser.parse_args()
if args.download_models and args.offline:
    parser.error("离线准备请使用 --models 指定现有模型")
if sys.platform == "darwin" and platform.machine() == "x86_64":
    raise SystemExit("MinerU 4.2.2 的 DocVortex 和 ONNX Runtime 没有 Intel Mac 的官方构建")
output = Path(args.output).resolve()
if not output.is_relative_to(project) or output == project:
    raise SystemExit("输出必须位于项目目录内")
if output.exists() and not args.resume:
    raise SystemExit("输出目录已存在，请使用新的目录以保留已有运行环境")
base = Path(sys.base_prefix)
if (base / "pyvenv.cfg").exists():
    raise SystemExit("需要 uv 管理的独立 Python 基础环境")
if not output.exists():
    shutil.copytree(base, output, ignore=shutil.ignore_patterns("__pycache__"))
python = output / ("python.exe" if os.name == "nt" else "bin/python3")
actual = subprocess.check_output([str(python), "-c", "import sys;print(sys.prefix)"], text=True).strip()
if Path(actual).resolve() != output:
    raise SystemExit("目标 Python 未正确搬移，停止安装以保护基础环境")
cache = project / "tmp/parser-build-cache"
environment = dict(os.environ, UV_CACHE_DIR=os.environ.get("UV_CACHE_DIR", str(cache)))
if sys.platform == "darwin":
    environment.setdefault("MACOSX_DEPLOYMENT_TARGET", "14.0")
# 仅对上面已经核实的项目内副本解除 uv 管理标记限制。
command = ["uv", "pip", "install", "--python", str(python), "--break-system-packages", "-r", str(project / "python-workers/requirements.txt")]
if args.offline:
    command.append("--offline")
subprocess.run(command, check=True, env=environment)
model_home = project / "python-workers/mineru-home" if output == default_output else output.parent / ".models"
target = model_home / "models"
if args.download_models:
    model_environment = dict(environment, MINERU_HOME=str(model_home), MINERU_TELEMETRY_DISABLED="1",
                             HF_HOME=str(cache / "huggingface"), MODELSCOPE_CACHE=str(cache / "modelscope"))
    subprocess.run([str(python), "-c", "from mineru.kit.commands.models import download_main; download_main()",
                    "MinerU-4_models_onnx", "--source", "huggingface"], check=True, env=model_environment)
else:
    models = Path(args.models).resolve() / "models"
    if not models.is_dir():
        raise SystemExit("模型目录不存在")
    if models.resolve() != target.resolve():
        shutil.copytree(models, target, dirs_exist_ok=True)
probe = subprocess.run([str(python), "-c", "import sys,importlib.metadata;print(sys.prefix);print(importlib.metadata.version('mineru'))"],
                       check=True, capture_output=True, text=True)
(output / "lawverify-runtime.json").write_text(json.dumps({"platform": sys.platform, "architecture": platform.machine(),
    "python": sys.version, "engineVersion": probe.stdout.strip().splitlines()[-1]}, ensure_ascii=False, indent=2), encoding="utf-8")
print(probe.stdout)
