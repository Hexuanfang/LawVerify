"""用 Windows 的显存预算和 GPU 引擎负载检查解析是否适合使用独显。"""
from collections import defaultdict
import ctypes as C
from functools import cache
import re
import sys
import time


GIB = 1024 ** 3
_ENGINE_INSTANCE = re.compile(r"_luid_0x([\da-f]+)_0x([\da-f]+)_phys_(\d+)_eng_(\d+)_", re.I)


@cache
def _directml_adapter():
    from onnxruntime import get_available_providers
    from mineru.model.runtime.windows_gpu import discover_gpus, preferred_gpu

    if "DmlExecutionProvider" not in get_available_providers():
        return None
    return preferred_gpu(discover_gpus())


class _VideoMemoryInfo(C.Structure):
    # DXGI_QUERY_VIDEO_MEMORY_INFO
    _fields_ = [(name, C.c_uint64) for name in ("budget", "usage", "available_for_reservation", "reservation")]


def _video_memory(luid):
    from mineru.model.runtime.windows_gpu import _Luid, _check, _guid, _method, _release

    create = C.WinDLL("dxgi").CreateDXGIFactory1
    create.argtypes, create.restype = [C.c_void_p, C.POINTER(C.c_void_p)], C.c_int32
    factory = C.c_void_p()
    factory4 = _guid("1bc6ea02-ef36-464f-bf0c-21ca39e5168a")
    _check(create(C.byref(factory4), C.byref(factory)))
    adapter = C.c_void_p()
    try:
        high, low = (int(value, 16) for value in luid.split(":"))
        adapter3 = _guid("645967a4-1392-4310-a798-8053ce3e93fd")
        # IDXGIFactory4::EnumAdapterByLuid
        lookup = _method(factory, 26, C.c_int32, _Luid, C.c_void_p, C.POINTER(C.c_void_p))
        _check(lookup(factory, _Luid(low, high), C.byref(adapter3), C.byref(adapter)))
        # IDXGIAdapter3::QueryVideoMemoryInfo，查询节点 0 的本地（独显）显存。
        query = _method(adapter, 14, C.c_int32, C.c_uint32, C.c_int32, C.POINTER(_VideoMemoryInfo))
        value = _VideoMemoryInfo()
        _check(query(adapter, 0, 0, C.byref(value)))
        return value.budget, value.usage
    finally:
        _release(adapter)
        _release(factory)


class _CounterValue(C.Structure):
    # PDH_FMT_COUNTERVALUE：本查询使用 double 成员。
    _fields_ = [("status", C.c_uint32), ("value", C.c_double)]


class _CounterItem(C.Structure):
    # PDH_FMT_COUNTERVALUE_ITEM_W
    _fields_ = [("name", C.c_wchar_p), ("data", _CounterValue)]


def _pdh_function(pdh, name, *argtypes):
    function = getattr(pdh, name)
    function.argtypes, function.restype = argtypes, C.c_uint32
    return function


def _engine_readings():
    pdh = C.WinDLL("pdh")
    handle = C.c_void_p
    open_query = _pdh_function(pdh, "PdhOpenQueryW", C.c_wchar_p, C.c_size_t, C.POINTER(handle))
    query = handle()
    if open_query(None, 0, C.byref(query)) != 0:
        return []
    try:
        add = _pdh_function(pdh, "PdhAddEnglishCounterW", handle, C.c_wchar_p, C.c_size_t, C.POINTER(handle))
        counter = handle()
        if add(query, r"\GPU Engine(*)\Utilization Percentage", 0, C.byref(counter)) != 0:
            return []
        collect = _pdh_function(pdh, "PdhCollectQueryData", handle)
        if collect(query) != 0:
            return []
        time.sleep(0.15)
        if collect(query) != 0:
            return []
        integer = C.c_uint32
        read = _pdh_function(pdh, "PdhGetFormattedCounterArrayW", handle, integer,
                             C.POINTER(integer), C.POINTER(integer), C.c_void_p)
        size, count = integer(), integer()
        # PDH_FMT_DOUBLE | PDH_FMT_NOCAP100；先查询数组长度。
        flags = 0x8200
        if read(counter, flags, C.byref(size), C.byref(count), None) != 0x800007D2 or not 0 < size.value <= 2 ** 20:
            return []
        buffer = C.create_string_buffer(size.value)
        if (read(counter, flags, C.byref(size), C.byref(count), buffer) != 0
                or count.value * C.sizeof(_CounterItem) > len(buffer)):
            return []
        items = C.cast(buffer, C.POINTER(_CounterItem))
        return [(items[index].name, items[index].data.value) for index in range(count.value)
                if items[index].name and items[index].data.status in (0, 1)]
    finally:
        _pdh_function(pdh, "PdhCloseQuery", handle)(query)


def _gpu_load(luid):
    high, low = (int(value, 16) for value in luid.split(":"))
    engines = defaultdict(float)
    for name, load in _engine_readings():
        match = _ENGINE_INSTANCE.search(name)
        if not match or (int(match[1], 16), int(match[2], 16)) != (high, low):
            continue
        if not 0 <= load <= 100:
            return None
        # PDH 分进程计数，先按实际引擎合并，再取最忙的引擎。
        engines[match[3], match[4]] += load
    return max(engines.values(), default=None)


def gpu_has_headroom():
    """只有可核实的独显、显存和负载余量同时满足时才启用 DirectML。"""
    if sys.platform != "win32":
        return False
    try:
        adapter = _directml_adapter()
        dedicated = adapter.dedicated_memory_bytes if adapter is not None else None
        if adapter is None or adapter.kind != "discrete" or not dedicated or dedicated < 6 * GIB:
            return False
        budget, usage = _video_memory(adapter.luid)
        reserve = max(2 * GIB, dedicated // 4)
        if min(dedicated, budget) < reserve + max(2 * GIB, usage):
            return False
        load = _gpu_load(adapter.luid)
        return load is not None and load <= 65
    except (AttributeError, C.ArgumentError, ImportError, OSError, RuntimeError, TypeError, ValueError):
        return False
