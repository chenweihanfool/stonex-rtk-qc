"""單元測試：點號解析、同主站距離、已知點讀取、門檻設定。"""

import json
import os
import shutil
import tempfile
import unittest

from rtkqc.pdreader import InputError, resolve_id
from rtkqc.rules import load_known, load_thresholds, plane_dist


class TestResolveId(unittest.TestCase):
    def test_auto_uses_code_when_name_digits_and_code_is_point(self):
        self.assertEqual(resolve_id("1", "GDC060", "auto"), "GDC060")
        self.assertEqual(resolve_id("2", "BNC032", "auto"), "BNC032")

    def test_auto_uses_name_when_code_is_economic_object(self):
        self.assertEqual(resolve_id("12", "29", "auto"), "12")

    def test_auto_uses_name_when_name_not_digits(self):
        self.assertEqual(resolve_id("GDC060", "BNC032", "auto"), "GDC060")

    def test_explicit_modes(self):
        self.assertEqual(resolve_id("1", "GDC060", "name"), "1")
        self.assertEqual(resolve_id("1", "GDC060", "code"), "GDC060")
        self.assertEqual(resolve_id("1", "", "code"), "1")


class TestPlaneDist(unittest.TestCase):
    def test_zero_and_small(self):
        self.assertEqual(plane_dist(10.0, 100.0, 10.0, 100.0), 0.0)
        # 0.0001 度緯差約 11 m
        d = plane_dist(10.0, 100.0, 10.0001, 100.0)
        self.assertTrue(10.5 < d < 11.5, d)


class TestLoadKnown(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, text, enc="utf-8"):
        p = os.path.join(self.tmp, "k.csv")
        with open(p, "w", encoding=enc, newline="") as f:
            f.write(text)
        return p

    def test_bom_header_and_optional_h(self):
        p = self._write("點號,N,E,H\nA1,2700000.1,200000.2,\nA2,2700001,200001,30\n",
                        enc="utf-8-sig")
        k = load_known(p)
        self.assertEqual(k["A1"], (2700000.1, 200000.2, None))
        self.assertEqual(k["A2"], (2700001.0, 200001.0, 30.0))

    def test_no_header(self):
        p = self._write("A1,2700000.1,200000.2\n")
        self.assertEqual(load_known(p)["A1"][0], 2700000.1)

    def test_bad_number_raises(self):
        p = self._write("A1,xx,yy\n")
        with self.assertRaises(InputError):
            load_known(p)


class TestThresholds(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _cfg(self, obj):
        p = os.path.join(self.tmp, "c.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(obj, f)
        return p

    def test_defaults(self):
        th = load_thresholds(None)
        self.assertEqual(th["hrms_max"], 0.02)
        self.assertEqual(th["pdop_max"], 10.0)

    def test_override(self):
        th = load_thresholds(self._cfg({"diff_2d_max": 0.03}))
        self.assertEqual(th["diff_2d_max"], 0.03)

    def test_unknown_key_rejected(self):
        with self.assertRaises(InputError):
            load_thresholds(self._cfg({"no_such_key": 1}))

    def test_non_number_rejected(self):
        with self.assertRaises(InputError):
            load_thresholds(self._cfg({"hrms_max": "0.02"}))


if __name__ == "__main__":
    unittest.main()
