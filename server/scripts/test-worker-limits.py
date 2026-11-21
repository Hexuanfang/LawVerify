"""使用短时子进程验证资源限制，避免修改测试进程自身的资源配置。"""
from importlib.util import find_spec
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest


WORKERS = Path(__file__).resolve().parents[2] / "python-workers"


class WorkerLimitTests(unittest.TestCase):
    def worker(self, code, memory="", threads="1"):
        env = dict(os.environ, LAWVERIFY_PARSER_MEMORY_MB=memory, LAWVERIFY_PARSER_THREADS=threads,
                   LAWVERIFY_PARSER_CPU_OFFSET="0", PYTHONDONTWRITEBYTECODE="1")
        return subprocess.run([sys.executable, "-c", code], cwd=WORKERS, env=env, text=True,
                              capture_output=True, timeout=10)

    def test_legacy_worker_keeps_default_thread_count(self):
        result = self.worker("from worker_limits import start_worker_limits; print(start_worker_limits())")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "4")

    @unittest.skipUnless(find_spec("mineru"), "需要已安装的 MinerU 运行时")
    def test_bounded_onnx_session_releases_unused_cpu_allocations(self):
        result = self.worker("""
from mineru.model.runtime import onnx
from onnxruntime import SessionOptions
from worker import configure_bounded_onnx

configure_bounded_onnx()
options = SessionOptions()
onnx.configure_ort_threads(options, intra_op_num_threads=2)
assert options.intra_op_num_threads == 2
assert not options.enable_cpu_mem_arena
""")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_worker_caps_threads_and_restricts_supported_cpu_affinity(self):
        result = self.worker("""
import json
import os
from worker_limits import start_worker_limits

threads = start_worker_limits()
affinity = len(os.sched_getaffinity(0)) if hasattr(os, 'sched_getaffinity') else None
if os.name == 'nt':
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32')
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.GetProcessAffinityMask.argtypes = [wintypes.HANDLE, ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(ctypes.c_size_t)]
    process_mask, system_mask = ctypes.c_size_t(), ctypes.c_size_t()
    if kernel.GetProcessAffinityMask(kernel.GetCurrentProcess(), ctypes.byref(process_mask), ctypes.byref(system_mask)):
        affinity = process_mask.value.bit_count() or None
print(json.dumps([threads, affinity]))
""", memory="256")
        self.assertEqual(result.returncode, 0, result.stderr)
        threads, affinity = json.loads(result.stdout)
        self.assertEqual(threads, 1)
        if affinity is not None:
            self.assertEqual(affinity, 1)

    def test_worker_terminates_when_already_above_memory_limit(self):
        result = self.worker("""
import time
from worker_limits import start_worker_limits

allocation = bytearray(32 * 1024 * 1024)
for offset in range(0, len(allocation), 4096):
    allocation[offset] = 1
start_worker_limits()
time.sleep(2)
""", memory="24")
        self.assertEqual(result.returncode, 75, result.stderr)

    def test_worker_rejects_allocations_that_cross_memory_limit(self):
        result = self.worker("""
import time
from worker_limits import start_worker_limits

start_worker_limits()
try:
    allocation = bytearray(48 * 1024 * 1024)
except MemoryError:
    print('allocation refused')
else:
    for offset in range(0, len(allocation), 4096):
        allocation[offset] = 1
    time.sleep(2)
""", memory="40")
        if result.returncode != 75:
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "allocation refused")


if __name__ == "__main__":
    unittest.main()
