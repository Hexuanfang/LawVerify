import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python-workers"))
import gpu_headroom


class GpuHeadroomTests(unittest.TestCase):
    def check(self, *, gpu_kind="discrete", dedicated=8, budget=6, used=1, load=20, platform="win32"):
        gib = 1024 ** 3
        adapter = SimpleNamespace(kind=gpu_kind, dedicated_memory_bytes=dedicated * gib, luid="00000000:01234567")
        with (patch.object(gpu_headroom.sys, "platform", platform),
              patch.object(gpu_headroom, "_directml_adapter", return_value=adapter),
              patch.object(gpu_headroom, "_video_memory", return_value=(budget * gib, used * gib)),
              patch.object(gpu_headroom, "_gpu_load", return_value=load)):
            return gpu_headroom.gpu_has_headroom()

    def test_uses_discrete_gpu_with_room_for_other_apps(self):
        self.assertTrue(self.check())

    def test_refuses_integrated_and_small_discrete_adapters(self):
        self.assertFalse(self.check(gpu_kind="integrated"))
        self.assertFalse(self.check(dedicated=4))

    def test_refuses_tight_vram_budget_and_busy_gpu(self):
        self.assertFalse(self.check(budget=3))
        self.assertFalse(self.check(budget=6, used=5))
        self.assertFalse(self.check(load=80))

    def test_unknown_gpu_load_and_unsupported_platform_use_cpu(self):
        self.assertFalse(self.check(load=None))
        self.assertFalse(self.check(platform="darwin"))

    def test_combines_process_load_on_same_engine_only(self):
        readings = [
            ("pid_1_luid_0x00000000_0x01234567_phys_0_eng_0_engtype_3D", 40),
            ("pid_2_luid_0x00000000_0x01234567_phys_0_eng_0_engtype_3D", 30),
            ("pid_3_luid_0x00000000_0x01234567_phys_0_eng_1_engtype_Copy", 10),
            ("pid_4_luid_0x00000000_0x0decaf00_phys_0_eng_0_engtype_3D", 100),
        ]
        with patch.object(gpu_headroom, "_engine_readings", return_value=readings):
            self.assertEqual(gpu_headroom._gpu_load("00000000:01234567"), 70)

    def test_broken_gpu_runtime_uses_cpu(self):
        with (patch.object(gpu_headroom.sys, "platform", "win32"),
              patch.object(gpu_headroom, "_directml_adapter", side_effect=RuntimeError("测试驱动异常"))):
            self.assertFalse(gpu_headroom.gpu_has_headroom())


if __name__ == "__main__":
    unittest.main()
