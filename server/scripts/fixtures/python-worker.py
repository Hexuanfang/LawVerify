"""进程池协议测试替身，只使用标准库。"""
import json
import os
import sys
import time

print(json.dumps({"type": "ready", "device": "cpu", "version": "test"}), flush=True)
for line in sys.stdin:
    job = json.loads(line)
    if job.get("action") == "crash":
        os._exit(7)
    time.sleep(job.get("delay", 0))
    if job.get("action") == "error":
        print(json.dumps({"id": job["id"], "error": "synthetic bad document", "code": "PARSE_FAILED"}), flush=True)
    else:
        print(json.dumps({"id": job["id"], "result": {"pid": os.getpid(), "value": job.get("value")}}), flush=True)
