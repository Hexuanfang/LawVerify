"""在加载解析引擎前给当前 worker 设置 CPU 和内存预算。"""
import os
import sys
import threading
import time


_MIB = 1024 ** 2
MEMORY_LIMIT_EXIT = 75
_read_memory = None


def current_worker_memory_mb():
    return _read_memory() // _MIB if _read_memory else 0


def is_memory_limit_error(error):
    return isinstance(error, MemoryError) or any(marker in str(error).lower() for marker in (
        "unable to allocate", "failed to allocate memory", "std::bad_alloc", "bad allocation",
        "paging file is too small", "not enough memory resources", "out of memory",
    ))


def _env_integer(name, default):
    try:
        return max(0, int(os.environ.get(name, default)))
    except ValueError:
        return default


def _select_cpus(available, threads, offset):
    # 至少保留一个逻辑核心，单核只能依靠低优先级与限流。
    usable = available[:-1] if len(available) > 1 else available
    start = offset % len(usable)
    return (usable[start:] + usable[:start])[:threads]


def _windows_cpu_order(kernel, mask):
    from ctypes import POINTER, Structure, byref, c_int, c_size_t, c_ulonglong, sizeof
    from ctypes.wintypes import BOOL, DWORD

    class ProcessorInfo(Structure):
        _fields_ = [("mask", c_size_t), ("relationship", c_int), ("data", c_ulonglong * 2)]

    available = [index for index in range(mask.bit_length()) if mask & (1 << index)]
    query = kernel.GetLogicalProcessorInformation
    query.argtypes = [POINTER(ProcessorInfo), POINTER(DWORD)]
    query.restype = BOOL
    size = DWORD()
    query(None, byref(size))
    if not size.value or size.value % sizeof(ProcessorInfo):
        return available
    info = (ProcessorInfo * (size.value // sizeof(ProcessorInfo)))()
    if not query(info, byref(size)):
        return available
    # 每个物理核心先取一个逻辑 CPU，多线程核心优先，避免先把两个线程放到同一物理核。
    cores = sorted((item.mask & mask for item in info if item.relationship == 0 and item.mask & mask),
                   key=lambda core: (-core.bit_count(), core))
    primary = [(core & -core).bit_length() - 1 for core in cores]
    return primary + [cpu for cpu in available if cpu not in primary]


def _windows_job_limit(kernel, process, limit):
    from ctypes import Structure, byref, c_longlong, c_size_t, c_ulonglong, sizeof
    from ctypes.wintypes import BOOL, DWORD, HANDLE, LPCWSTR, LPVOID

    class BasicLimit(Structure):
        _fields_ = [
            ("process_time", c_longlong), ("job_time", c_longlong), ("flags", DWORD),
            ("min_working_set", c_size_t), ("max_working_set", c_size_t), ("active_processes", DWORD),
            ("affinity", c_size_t), ("priority", DWORD), ("scheduling_class", DWORD),
        ]

    class ExtendedLimit(Structure):
        _fields_ = [
            ("basic", BasicLimit), ("io_counters", c_ulonglong * 6),
            ("process_memory", c_size_t), ("job_memory", c_size_t),
            ("peak_process_memory", c_size_t), ("peak_job_memory", c_size_t),
        ]

    kernel.CreateJobObjectW.argtypes = [LPVOID, LPCWSTR]
    kernel.CreateJobObjectW.restype = HANDLE
    kernel.SetInformationJobObject.argtypes = [HANDLE, DWORD, LPVOID, DWORD]
    kernel.SetInformationJobObject.restype = BOOL
    kernel.AssignProcessToJobObject.argtypes = [HANDLE, HANDLE]
    kernel.AssignProcessToJobObject.restype = BOOL
    kernel.CloseHandle.argtypes = [HANDLE]
    kernel.CloseHandle.restype = BOOL
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        return
    try:
        settings = ExtendedLimit()
        settings.basic.flags = 0x100  # JOB_OBJECT_LIMIT_PROCESS_MEMORY
        settings.process_memory = limit
        if kernel.SetInformationJobObject(job, 9, byref(settings), sizeof(settings)):
            # 进程受外层 Job 约束时，系统可能拒绝加入新 Job；内存采样继续兜底。
            kernel.AssignProcessToJobObject(job, process)
    finally:
        # 没有设置 KILL_ON_JOB_CLOSE，系统会保留 Job 直至关联进程退出。
        kernel.CloseHandle(job)


def _windows_limits(threads, offset, memory_limit):
    from ctypes import POINTER, Structure, WinDLL, byref, c_size_t, sizeof
    from ctypes.wintypes import BOOL, DWORD, HANDLE

    class MemoryCounters(Structure):
        _fields_ = [("size", DWORD), ("page_faults", DWORD), ("peak_working_set", c_size_t),
                    ("working_set", c_size_t), ("quota", c_size_t * 4),
                    ("pagefile", c_size_t), ("peak_pagefile", c_size_t), ("private_usage", c_size_t)]

    kernel = WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = HANDLE
    process = kernel.GetCurrentProcess()
    kernel.GetPriorityClass.argtypes = [HANDLE]
    kernel.GetPriorityClass.restype = DWORD
    kernel.SetPriorityClass.argtypes = [HANDLE, DWORD]
    if kernel.GetPriorityClass(process) not in (0x40, 0x4000):  # IDLE、BELOW_NORMAL
        kernel.SetPriorityClass(process, 0x4000)

    kernel.GetProcessAffinityMask.argtypes = [HANDLE, POINTER(c_size_t), POINTER(c_size_t)]
    kernel.SetProcessAffinityMask.argtypes = [HANDLE, c_size_t]
    process_mask, system_mask = c_size_t(), c_size_t()
    if kernel.GetProcessAffinityMask(process, byref(process_mask), byref(system_mask)) and process_mask.value:
        available = _windows_cpu_order(kernel, process_mask.value)
        cpus = _select_cpus(available, threads, offset)
        kernel.SetProcessAffinityMask(process, sum(1 << index for index in cpus))
        threads = len(cpus)

    # 提交量包含已保留但尚未驻留的页；硬上限给模型分配器留少量余量，驻留量另行监控。
    _windows_job_limit(kernel, process, memory_limit + min(memory_limit // 4, 256 * _MIB))
    kernel.K32GetProcessMemoryInfo.argtypes = [HANDLE, POINTER(MemoryCounters), DWORD]
    kernel.K32GetProcessMemoryInfo.restype = BOOL

    def read_memory():
        counters = MemoryCounters()
        counters.size = sizeof(counters)
        if kernel.K32GetProcessMemoryInfo(process, byref(counters), counters.size):
            return counters.working_set
        return 0

    return threads, read_memory


def _unix_limits(threads, offset):
    import resource

    try:
        priority = os.getpriority(os.PRIO_PROCESS, 0)
        if priority < 10:
            os.setpriority(os.PRIO_PROCESS, 0, 10)
    except OSError:
        pass
    if hasattr(os, "sched_getaffinity"):
        try:
            cpus = _select_cpus(sorted(os.sched_getaffinity(0)), threads, offset)
            threads = len(cpus)
            os.sched_setaffinity(0, cpus)
        except OSError:
            pass

    # macOS 的 getrusage 计入峰值且以字节为单位。Linux 优先读实际驻留内存。
    if sys.platform == "darwin":
        return threads, lambda: resource.getrusage(resource.RUSAGE_SELF).ru_maxrss

    page_size = os.sysconf("SC_PAGE_SIZE")

    def read_memory():
        try:
            with open("/proc/self/statm", encoding="ascii") as statistics:
                return int(statistics.read().split()[1]) * page_size
        except (OSError, ValueError, IndexError):
            return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024

    return threads, read_memory


def _watch_memory(limit, read_memory):
    while True:
        if read_memory() >= limit:
            os._exit(MEMORY_LIMIT_EXIT)
        time.sleep(0.25)


def start_worker_limits():
    global _read_memory
    memory_mb = _env_integer("LAWVERIFY_PARSER_MEMORY_MB", 0)
    if not memory_mb:
        return 4
    offset = _env_integer("LAWVERIFY_PARSER_CPU_OFFSET", 0)
    available_threads = max(1, (os.cpu_count() or 1) - 1)
    threads = min(_env_integer("LAWVERIFY_PARSER_THREADS", 4) or 1, available_threads)
    limit = memory_mb * _MIB
    if os.name == "nt":
        threads, read_memory = _windows_limits(threads, offset, limit)
    else:
        threads, read_memory = _unix_limits(threads, offset)
    _read_memory = read_memory
    # 已超限时直接退出，避免 Windows 硬上限拦截监护线程的栈内存分配。
    if read_memory() >= limit:
        os._exit(MEMORY_LIMIT_EXIT)
    threading.Thread(target=_watch_memory, args=(limit, read_memory), daemon=True).start()
    return threads
