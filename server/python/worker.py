"""常驻 JSONL worker。stdout 仅用于协议，推理日志使用 stderr。"""
import contextlib
import json
import os
from pathlib import Path
import sys
import threading
import time
import shutil

def watch_parent():
    """不用阻塞式 stdin 线程，避免 Windows 原生库/子进程继承 stdio 锁。"""
    parent = os.getppid()
    if os.name == "nt":
        import ctypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        handle = kernel.OpenProcess(0x100000, False, parent)
        if handle:
            kernel.WaitForSingleObject(handle, 0xFFFFFFFF)
            os._exit(0)
    else:
        while os.getppid() == parent:
            time.sleep(1)
        os._exit(0)


def respond(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def writable_models(root, supplied_home):
    """随包权重只读，首次使用复制到数据目录，派生模型与锁文件写在副本。"""
    if os.environ.get("LAWVERIFY_PARSER_BUNDLED") != "1":
        return supplied_home
    from filelock import FileLock
    target = root / "mineru"
    target.mkdir(exist_ok=True)
    with FileLock(str(target / "prepare.lock"), timeout=120):
        source = supplied_home / "models"
        for file in source.rglob("*"):
            relative = file.relative_to(source)
            if relative.parts[0] not in {"MinerU-4_models_onnx", "MinerU-4_models_torch"}:
                continue
            if not file.is_file():
                continue
            destination = target / "models" / relative
            if destination.exists() and destination.stat().st_size == file.stat().st_size and destination.stat().st_mtime_ns == file.stat().st_mtime_ns:
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_name(destination.name + ".copying")
            shutil.copy2(file, temporary)
            os.replace(temporary, destination)
    return target


def main():
    root = Path(os.environ["LAWVERIFY_PARSER_ROOT"])
    root.mkdir(parents=True, exist_ok=True)
    temporary = root / "temp"
    temporary.mkdir(exist_ok=True)
    model_home = writable_models(root, Path(os.environ.get("LAWVERIFY_MINERU_HOME", str(root / "mineru"))))
    mac_auto = sys.platform == "darwin" and (model_home / "models/MinerU-4_models_torch").is_dir() and os.environ.get("MINERU_MODEL_ONNX_DEVICE") != "cpu"
    if os.environ.get("LAWVERIFY_PARSER_CPU_FALLBACK") == "1":
        mac_auto = False
    os.environ.update({
        "MINERU_HOME": str(model_home),
        "MINERU_TELEMETRY_DISABLED": "1", "MINERU_MODEL_SOURCE": "local",
        "MINERU_MODEL_SMALL_BACKEND": "auto" if mac_auto else "onnx", "MINERU_INTRA_OP_NUM_THREADS": "4",
        "MINERU_INTER_OP_NUM_THREADS": "1", "OMP_NUM_THREADS": "4",
        "TEMP": str(temporary), "TMP": str(temporary),
        "HF_HOME": str(root / "hf-cache"), "MODELSCOPE_CACHE": str(root / "modelscope-cache"),
    })
    
    
    with contextlib.redirect_stdout(sys.stderr):
        from parsing import Parser, save_result
        try:
            parser = Parser()
        except Exception:
            if not mac_auto:
                raise
            # 加速环境不完整时仅回退一次，使用随包 ONNX CPU 权重。
            os.execvpe(sys.executable, [sys.executable, "-u", __file__], dict(os.environ, LAWVERIFY_PARSER_CPU_FALLBACK="1"))
    threading.Thread(target=watch_parent, daemon=True).start()
    respond({"type": "ready", "device": parser.device, "providers": parser.providers, "version": parser.version, "pid": os.getpid()})
    while True:
        line = sys.stdin.readline(65537)
        if not line or len(line) > 65536:
            return
        job = json.loads(line)
        try:
            if job.get("action") != "parse":
                raise ValueError("不支持的解析操作")
            path = Path(job["inputPath"])
            if not path.is_file() or path.stat().st_size > 512 * 1024 * 1024:
                raise ValueError("原件不存在或超过512MB")
            with contextlib.redirect_stdout(sys.stderr):
                result = parser.parse(path, job.get("mode", "auto"), job.get("fileName"), job.get("mimeType") or "")
                save_result(result, job["outputPath"])
            respond({"id": job["id"], "result": {"outputPath": job["outputPath"], "pid": os.getpid(), "device": parser.device, "providers": parser.providers}})
        except Exception as error:
            # 详细异常保留在本机协议中，调用端按材料保存错误供审核。
            respond({"id": job["id"], "error": str(error)[:1200], "code": "PARSE_FAILED"})


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--word-text":
        from word_blocks import parse_word
        blocks, _ = parse_word(Path(sys.argv[2]))
        respond({"text": "\n\n".join(block["text"] for block in blocks)})
    else:
        main()
