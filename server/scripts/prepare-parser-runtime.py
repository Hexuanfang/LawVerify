"""从 uv 管理的独立 Python 构建项目内可搬移解析环境，不修改系统 Python。"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

project = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument("--output", default=str(project / "server/python/.runtime"))
parser.add_argument("--models", required=True, help="已下载的 MinerU_HOME")
parser.add_argument("--offline", action="store_true")
parser.add_argument("--resume", action="store_true", help="继续本项目内尚未完成的运行环境准备")
args = parser.parse_args()
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
# 仅对上面已经核实的项目内副本解除 uv 管理标记限制。
command = ["uv", "pip", "install", "--python", str(python), "--break-system-packages", "-r", str(project / "server/python/requirements.txt")]
if args.offline:
    command.append("--offline")
subprocess.run(command, check=True, env=environment)
models = Path(args.models).resolve() / "models"
target = output.parent / ".models" / "models"
if not models.is_dir():
    raise SystemExit("模型目录不存在")
shutil.copytree(models, target, dirs_exist_ok=True)
probe = subprocess.run([str(python), "-c", "import sys,importlib.metadata;print(sys.prefix);print(importlib.metadata.version('mineru'))"],
                       check=True, capture_output=True, text=True)
(output / "lawverify-runtime.json").write_text(json.dumps({"platform": sys.platform, "architecture": __import__('platform').machine(),
    "python": sys.version, "engineVersion": probe.stdout.strip().splitlines()[-1]}, ensure_ascii=False, indent=2), encoding="utf-8")
print(probe.stdout)
