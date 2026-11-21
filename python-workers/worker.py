"""常驻 JSONL worker。stdout 仅用于协议，推理日志使用 stderr。"""
import contextlib
import json
import os
from pathlib import Path
import sys
import threading
import time
import shutil
import tempfile

from worker_limits import MEMORY_LIMIT_EXIT, current_worker_memory_mb, is_memory_limit_error, start_worker_limits


def watch_parent(parent):
    """不用阻塞式 stdin 线程，避免 Windows 原生库/子进程继承 stdio 锁。"""
    if os.name == "nt":
        import ctypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        handle = kernel.OpenProcess(0x100000, False, parent)
        if handle:
            kernel.WaitForSingleObject(handle, 0xFFFFFFFF)
            os._exit(0)
        if ctypes.get_last_error() == 87:  # ERROR_INVALID_PARAMETER，父进程已退出。
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


def configure_bounded_onnx():
    from mineru.model.runtime import onnx

    configure_threads = onnx.configure_ort_threads

    def configure(options, **kwargs):
        configure_threads(options, **kwargs)
        # 不缓存不同尺寸的推理缓冲，避免扫描件逐页处理时耗尽 Windows 提交量。
        options.enable_cpu_mem_arena = False

    onnx.configure_ort_threads = configure


def pdf_page_count(path):
    from pypdfium2 import PdfDocument

    with PdfDocument(path) as document:
        return len(document)


@contextlib.contextmanager
def pdf_segment(path, output_path, page_range):
    from pypdfium2 import PdfDocument

    first, last = page_range
    with tempfile.TemporaryDirectory(prefix="pdf-part-", dir=Path(output_path).parent) as directory:
        target = Path(directory) / "pages.pdf"
        with PdfDocument(path) as document, PdfDocument.new() as segment:
            if not 1 <= first <= last <= len(document) <= 1000 or last - first >= 20:
                raise ValueError("PDF 分段页码无效")
            segment.import_pages(document, pages=list(range(first - 1, last)))
            segment.save(target)
        yield target


def main():
    threads = str(start_worker_limits())
    configured_memory = os.environ.get("LAWVERIFY_PARSER_MEMORY_MB", "").strip()
    memory_mb = int(configured_memory) if configured_memory.isdecimal() else 0
    limited = memory_mb > 0
    accelerated = limited and os.environ.get("MINERU_MODEL_ONNX_DEVICE") == "auto"
    threading.Thread(target=watch_parent, args=(os.getppid(),), daemon=True).start()
    root = Path(os.environ["LAWVERIFY_PARSER_ROOT"])
    root.mkdir(parents=True, exist_ok=True)
    temporary = root / "temp"
    temporary.mkdir(exist_ok=True)
    model_home = writable_models(root, Path(os.environ.get("LAWVERIFY_MINERU_HOME", str(root / "mineru"))))
    mac_auto = sys.platform == "darwin" and (model_home / "models/MinerU-4_models_torch").is_dir() and os.environ.get(
        "MINERU_MODEL_ONNX_DEVICE") != "cpu"
    if os.environ.get("LAWVERIFY_PARSER_CPU_FALLBACK") == "1":
        mac_auto = False
    os.environ.update({
        "MINERU_HOME": str(model_home),
        "MINERU_TELEMETRY_DISABLED": "1", "MINERU_MODEL_SOURCE": "local",
        "MINERU_MODEL_SMALL_BACKEND": "auto" if mac_auto else "onnx", "MINERU_INTRA_OP_NUM_THREADS": threads,
        "MINERU_INTER_OP_NUM_THREADS": "1", "OMP_NUM_THREADS": threads,
        "TEMP": str(temporary), "TMP": str(temporary),
        "HF_HOME": str(root / "hf-cache"), "MODELSCOPE_CACHE": str(root / "modelscope-cache"),
    })
    if limited:
        os.environ.update({name: threads for name in ("MINERU_CPU_NUM_THREADS", "MKL_NUM_THREADS",
                            "OPENBLAS_NUM_THREADS", "BLIS_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMEXPR_NUM_THREADS")})
        # 减少同时驻留在内存中的页面和推理中间结果，页码仍由 MinerU 统一生成。
        pdf_window = min(3, max(1, memory_mb // 1024))
        os.environ.update(MINERU_PROCESSING_WINDOW_SIZE=str(pdf_window),
                          MINERU_PDF_RENDER_THREADS=str(min(pdf_window, int(threads))))
    if accelerated:
        from gpu_headroom import gpu_has_headroom

    with contextlib.redirect_stdout(sys.stderr):
        try:
            parser = None
            if not accelerated or gpu_has_headroom():
                from parsing import Parser, save_result
                from mineru.model.runtime.ownership import RuntimeOwner, release_runtime_owner, runtime_owner

                if limited and os.name == "nt" and os.environ.get("MINERU_MODEL_ONNX_DEVICE") == "cpu":
                    configure_bounded_onnx()
                parser = Parser(memory_bounded=limited)
        except Exception as error:
            if limited and is_memory_limit_error(error):
                os._exit(MEMORY_LIMIT_EXIT)
            if accelerated:
                parser = None
            elif not mac_auto:
                raise
            # 加速环境不完整时仅回退一次，使用随包 ONNX CPU 权重。
            else:
                os.execvpe(sys.executable, [sys.executable, "-u", __file__],
                           dict(os.environ, LAWVERIFY_PARSER_CPU_FALLBACK="1"))
    if accelerated and (parser is None or parser.device != "gpu"):
        respond({"type": "startup-error", "code": "PARSER_GPU_BUSY", "error": "GPU 暂无足够资源，切换到 CPU。"})
        return
    document_models = RuntimeOwner()
    respond({"type": "ready", "device": parser.device, "providers": parser.providers, "version": parser.version,
             "memoryMB": current_worker_memory_mb(),
             "pid": os.getpid()})
    while True:
        line = sys.stdin.readline(65537)
        if not line or len(line) > 65536:
            return
        job = json.loads(line)
        try:
            if job.get("action") == "warmup":
                respond({"id": job["id"], "memoryMB": current_worker_memory_mb(), "result": {"pid": os.getpid()}})
                continue
            if job.get("action") == "release-models":
                previous_models, document_models = document_models, RuntimeOwner()
                with contextlib.redirect_stdout(sys.stderr):
                    release_runtime_owner(previous_models)
                respond({"id": job["id"], "memoryMB": current_worker_memory_mb(), "result": {"pid": os.getpid()}})
                continue
            action = job.get("action")
            if action not in ("parse", "pdf-info"):
                raise ValueError("不支持的解析操作")
            path = Path(job["inputPath"])
            if not path.is_file() or path.stat().st_size > 512 * 1024 * 1024:
                raise ValueError("原件不存在或超过512MB")
            if action == "pdf-info" or (job.get("pdfWhole") and 0 < memory_mb < 3072):
                pages = pdf_page_count(path)
                if not 1 <= pages <= 1000:
                    raise ValueError("PDF 页数无效或超过1000页")
                if action == "pdf-info" or pages > 20:
                    respond({"id": job["id"], "memoryMB": current_worker_memory_mb(),
                             "result": {"pdfPages": pages, "engineVersion": parser.version}})
                    continue
            if accelerated:
                with contextlib.redirect_stdout(sys.stderr):
                    allowed = gpu_has_headroom()
                if not allowed:
                    respond({"id": job["id"], "code": "PARSER_GPU_BUSY", "error": "GPU 当前繁忙，切换到 CPU。"})
                    continue
            with contextlib.redirect_stdout(sys.stderr):
                token = runtime_owner.set(document_models)
                try:
                    source = pdf_segment(path, job["outputPath"], job["pdfRange"]) if "pdfRange" in job else contextlib.nullcontext(path)
                    with source as material:
                        page_offset = job["pdfRange"][0] - 1 if "pdfRange" in job else 0
                        save_result(parser.parse(material, job.get("mode", "auto"), job.get("fileName"), job.get("mimeType") or "",
                                                 pdf_scope=job.get("pdfScope"), page_offset=page_offset), job["outputPath"])
                finally:
                    runtime_owner.reset(token)
            respond({"id": job["id"], "memoryMB": current_worker_memory_mb(),
                     "result": {"outputPath": job["outputPath"], "pid": os.getpid(), "device": parser.device,
                                "providers": parser.providers}})
        except Exception as error:
            gpu_error = accelerated and (type(error).__module__.startswith("onnxruntime") or "directml" in str(error).lower())
            if limited and (isinstance(error, MemoryError) or (not gpu_error and is_memory_limit_error(error))):
                code = "PARSER_MEMORY_LIMIT"
                message = "材料解析已达到本机内存上限，请拆分后重试。"
            elif gpu_error:
                code = "PARSER_GPU_FAILED"
                message = "GPU 推理中断，切换到 CPU。"
            else:
                code = "PARSE_FAILED"
                message = str(error)[:1200]
            # 详细异常保留在本机协议中，调用端按材料保存错误供审核。
            respond({"id": job["id"], "memoryMB": current_worker_memory_mb(), "error": message, "code": code})


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--word-text":
        from word_blocks import parse_word

        blocks, _ = parse_word(Path(sys.argv[2]))
        respond({"text": "\n\n".join(block["text"] for block in blocks)})
    else:
        main()
