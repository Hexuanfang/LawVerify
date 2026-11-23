"""进程池协议测试替身，只使用标准库。"""
import json
import os
from pathlib import Path
import sys
import time

print(json.dumps({"type": "ready", "device": "cpu", "version": "test"}), flush=True)
for line in sys.stdin:
    job = json.loads(line)
    disk_backed = os.environ.get("LAWVERIFY_PARSER_DISK_BACKED") == "1"
    if job.get("action") == "pdf-info":
        if int(os.environ["LAWVERIFY_PARSER_MEMORY_MB"]) < int(os.environ.get("LAWVERIFY_TEST_MIN_MEMORY_MB", 0)):
            os._exit(75)
        print(json.dumps({"id": job["id"], "result": {"diskBacked": disk_backed,
              "threads": int(os.environ["LAWVERIFY_PARSER_THREADS"])}}), flush=True)
        continue
    if job.get("action") == "release-models":
        print(json.dumps({"id": job["id"], "memoryMB": 128, "result": {}}), flush=True)
        continue
    if job.get("action") == "parse":
        if job["fileName"] == "hold-parsing.txt":
            Path(os.environ["LAWVERIFY_PARSER_ROOT"], "test-worker-running").touch()
            time.sleep(30)
        Path(job["outputPath"]).write_text(json.dumps({
            "schemaVersion": 1, "engineVersion": "qa", "text": "请核对合同金额。", "pages": 1, "blocks": [],
            "warnings": ["请对照原件核对金额"], "reviewRequired": True,
        }), encoding="utf-8")
        print(json.dumps({"id": job["id"], "memoryMB": 1024, "result": {"pid": os.getpid()}}), flush=True)
        continue
    if job.get("action") == "crash":
        os._exit(7)
    if job.get("action") == "resource-test":
        device = os.environ.get("MINERU_MODEL_ONNX_DEVICE")
        time.sleep(job.get("delay", 0))
        if job.get("gpuBusy") and device == "auto":
            print(json.dumps({"id": job["id"], "code": "PARSER_GPU_BUSY", "error": "synthetic busy GPU"}), flush=True)
            continue
        if job.get("memoryLimit") or (job.get("gpuMemoryLimit") and device == "auto"):
            os._exit(75)
        print(json.dumps({"id": job["id"], "result": {"pid": os.getpid(), "device": device,
              "threads": int(os.environ["LAWVERIFY_PARSER_THREADS"]),
              "offset": int(os.environ["LAWVERIFY_PARSER_CPU_OFFSET"]),
              "memoryMB": int(os.environ["LAWVERIFY_PARSER_MEMORY_MB"]), "diskBacked": disk_backed}}), flush=True)
        continue
    time.sleep(job.get("delay", 0))
    if job.get("action") == "error":
        print(json.dumps({"id": job["id"], "error": "synthetic bad document", "code": "PARSE_FAILED"}), flush=True)
    else:
        print(json.dumps({"id": job["id"], "result": {"pid": os.getpid(), "value": job.get("value")}}), flush=True)
