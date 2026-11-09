"""--json／--ctl／TM2／主站命名／相鄰點位檢核 的測試。"""

import contextlib
import io
import json
import math
import os
import shutil
import tempfile
import unittest

import make_fixture as mf
from rtkqc import __version__
from rtkqc.cli import main
from rtkqc.rules import fmt, rnd
from rtkqc.tm2 import lonlat_to_tm2


def run_cli(argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = main(argv)
    return code, out.getvalue(), err.getvalue()


def snyder_tm2(lat, lon):
    """獨立參考：Snyder《Map Projections—A Working Manual》橢球橫麥卡托級數（公式 8-9～8-13）。"""
    a = 6378137.0
    f = 1 / 298.257222101
    e2 = 2 * f - f * f
    ep2 = e2 / (1 - e2)
    k0 = 0.9999
    p = math.radians(lat)
    big_a = math.radians(lon - 121.0) * math.cos(p)
    n = a / math.sqrt(1 - e2 * math.sin(p) ** 2)
    t = math.tan(p) ** 2
    c = ep2 * math.cos(p) ** 2
    m = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * p
             - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * math.sin(2 * p)
             + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * math.sin(4 * p)
             - (35 * e2 ** 3 / 3072) * math.sin(6 * p))
    x = k0 * n * (big_a + (1 - t + c) * big_a ** 3 / 6
                  + (5 - 18 * t + t * t + 72 * c - 58 * ep2) * big_a ** 5 / 120)
    y = k0 * (m + n * math.tan(p) * (big_a ** 2 / 2
                                      + (5 - t + 9 * c + 4 * c * c) * big_a ** 4 / 24
                                      + (61 - 58 * t + t * t + 600 * c - 330 * ep2)
                                      * big_a ** 6 / 720))
    return y, 250000.0 + x


class TestTM2(unittest.TestCase):
    def test_central_meridian_easting(self):
        _, e = lonlat_to_tm2(23.5, 121.0)
        self.assertAlmostEqual(e, 250000.0, places=6)

    def test_equator_origin(self):
        n, e = lonlat_to_tm2(0.0, 121.0)
        self.assertAlmostEqual(n, 0.0, places=6)
        self.assertAlmostEqual(e, 250000.0, places=6)

    def test_against_independent_series(self):
        # 台灣北端、南端、西部離島（金門）、臺北 101 附近
        cases = [(25.30, 121.60), (21.90, 120.85), (24.45, 118.32), (25.0330, 121.5654),
                 (23.97, 120.98)]
        for lat, lon in cases:
            n, e = lonlat_to_tm2(lat, lon)
            rn, re_ = snyder_tm2(lat, lon)
            self.assertLess(abs(n - rn), 0.001, (lat, lon))
            self.assertLess(abs(e - re_), 0.001, (lat, lon))

    def test_known_magnitudes(self):
        n, e = lonlat_to_tm2(25.0330, 121.5654)
        self.assertTrue(2769000 < n < 2770000, n)
        self.assertTrue(306000 < e < 308000, e)


class TestRounding(unittest.TestCase):
    def test_half_away_from_zero(self):
        self.assertEqual(fmt(0.125, 2), "0.13")
        self.assertEqual(fmt(-0.125, 2), "-0.13")
        self.assertEqual(fmt(1.0005, 3), "1.001")   # 二進位浮點略小於 1.0005，仍視為 1.0005
        self.assertEqual(fmt(2.5, 0), "3")
        self.assertEqual(fmt(-0.0004, 3), "0.000")  # 不輸出負零
        self.assertEqual(fmt(None, 3), "")
        self.assertEqual(rnd(1.23456, 3), 1.235)
        self.assertIsNone(rnd(None, 3))


class JsonBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.files = mf.scenario(cls.tmp)
        cls.out = os.path.join(cls.tmp, "o")
        cls.json_path = os.path.join(cls.tmp, "r.json")
        cls.ctl_path = os.path.join(cls.tmp, "r.ctl")
        cls.code, _, cls.err = run_cli([cls.files["day1"], cls.files["day2"], "--out", cls.out,
                                        "--json", cls.json_path, "--ctl", cls.ctl_path])
        with open(cls.json_path, encoding="utf-8") as f:
            cls.r = json.load(f)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)


class TestJsonContract(JsonBase):
    def test_exit_and_top_level_keys(self):
        self.assertEqual(self.code, 0, self.err)
        self.assertEqual(list(self.r), ["version", "thresholds", "inputs", "observations",
                                        "points", "bases", "neighbors", "remeasure",
                                        "known_check"])
        self.assertEqual(self.r["version"], __version__)
        self.assertEqual(self.r["thresholds"]["neighbor_max_m"], 100.0)

    def test_inputs(self):
        self.assertEqual([i["name"] for i in self.r["inputs"]], ["day1.PD", "day2.PD"])
        self.assertEqual([i["observations"] for i in self.r["inputs"]], [21, 1])
        self.assertTrue(all(len(i["sha256"]) == 64 for i in self.r["inputs"]))

    def test_observation_order_and_fields(self):
        obs = self.r["observations"]
        self.assertEqual(len(obs), 22)
        keys = [(o["id"], o["start"]) for o in obs]
        self.assertEqual(keys, sorted(keys))
        first = obs[0]
        for k in ["source", "id", "name", "code", "n", "e", "h", "start", "end", "epoch_n",
                  "fixed_n", "hrms", "vrms", "pdop", "sat", "base_id", "base_label",
                  "base_lat", "base_lon", "base_alt", "dist_base", "ant_h", "pitch", "roll",
                  "tilt_off", "flags", "row_flags"]:
            self.assertIn(k, first)
        self.assertEqual(first["base_lat"], 10.0)
        self.assertEqual(first["base_alt"], 40.0)

    def test_row_flags(self):
        by = {}
        for o in self.r["observations"]:
            by.setdefault(o["id"], []).append(o["row_flags"])
        self.assertEqual(by["GDC050"], [[], ["X2"]])       # 第二筆 HRMS 0.03
        self.assertEqual(by["GDC052"], [["X4"], []])
        self.assertEqual(by["GDC054"], [["T1"], ["T1"]])
        self.assertEqual(by["GDC053"], [["F1"], []])

    def test_points_sorted_and_flags(self):
        pts = self.r["points"]
        ids = [p["id"] for p in pts]
        self.assertEqual(ids, sorted(ids))
        flags = {p["id"]: p["flags"] for p in pts}
        self.assertEqual(flags["BNC032"], ["X1"])
        self.assertEqual(flags["GDC060"], [])
        bnc060 = [p for p in pts if p["id"] == "BNC060"][0]
        self.assertEqual(bnc060["interval_min"], 1200.0)
        self.assertEqual(bnc060["count"], 2)

    def test_bases_in_order(self):
        bases = self.r["bases"]
        self.assertEqual([b["label"] for b in bases], ["B1", "B2"])
        self.assertEqual(sum(b["count"] for b in bases), 22)
        self.assertIsNotNone(bases[0]["n"])
        n, e = lonlat_to_tm2(10.0, 100.0)
        self.assertEqual(bases[0]["n"], rnd(n, 3))
        self.assertEqual(bases[0]["e"], rnd(e, 3))
        labels = {o["base_label"] for o in self.r["observations"]}
        self.assertEqual(labels, {"B1", "B2"})

    def test_remeasure_and_known_empty(self):
        rem = {r["id"]: r for r in self.r["remeasure"]}
        self.assertEqual(set(rem), {p["id"] for p in self.r["points"] if p["flags"]})
        self.assertEqual(rem["GDC054"]["actions"], ["重新整平對中後重測"])
        self.assertEqual(self.r["known_check"], [])

    def test_numbers_are_rounded(self):
        for o in self.r["observations"]:
            self.assertEqual(o["n"], rnd(o["n"], 3))
            self.assertEqual(o["tilt_off"], rnd(o["tilt_off"], 4))

    def test_neighbors_sorted_i_lt_j(self):
        ids = [p["id"] for p in self.r["points"]]
        pos = {p: i for i, p in enumerate(ids)}
        pairs = [(pos[n["id"]], pos[n["other"]]) for n in self.r["neighbors"]]
        self.assertTrue(all(i < j for i, j in pairs))
        self.assertEqual(pairs, sorted(pairs))
        self.assertEqual(len(pairs), 66)  # 12 點全在 100 m 內，C(12,2)


class TestFrameCorrection(unittest.TestCase):
    def test_base_grid_corrected_to_truth(self):
        tmp = tempfile.mkdtemp()
        try:
            pd = mf.frame_scenario(tmp)
            jp = os.path.join(tmp, "r.json")
            code, _, err = run_cli([pd, "--out", os.path.join(tmp, "o"), "--json", jp])
            self.assertEqual(code, 0, err)
            with open(jp, encoding="utf-8") as f:
                bases = json.load(f)["bases"]
            b1, b2 = bases
            tn, te = lonlat_to_tm2(10.0, 100.0)
            self.assertTrue(b1["grid_corrected"])
            self.assertLess(abs(b1["n"] - (tn + mf.FRAME_DN)), 0.001)
            self.assertLess(abs(b1["e"] - (te + mf.FRAME_DE)), 0.001)
            self.assertLess(abs(b1["h"] - (40.0 - mf.FRAME_UNDULATION)), 0.001)
            self.assertAlmostEqual(b1["grid_shift_n"], mf.FRAME_DN, places=3)
            self.assertAlmostEqual(b1["grid_shift_e"], mf.FRAME_DE, places=3)
            self.assertAlmostEqual(b1["undulation"], mf.FRAME_UNDULATION, places=3)
            # B2 的觀測點沒有經緯度：保留未修正值
            self.assertFalse(b2["grid_corrected"])
            self.assertIsNone(b2["grid_shift_n"])
            self.assertIsNone(b2["undulation"])
            tn2, te2 = lonlat_to_tm2(10.0, 100.01)
            self.assertEqual(b2["n"], rnd(tn2, 3))
            self.assertEqual(b2["h"], 40.0)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_scenario_without_point_latlon_is_uncorrected(self):
        tmp = tempfile.mkdtemp()
        try:
            files = mf.scenario(tmp)
            jp = os.path.join(tmp, "r.json")
            run_cli([files["day1"], "--out", os.path.join(tmp, "o"), "--json", jp])
            with open(jp, encoding="utf-8") as f:
                self.assertTrue(all(not b["grid_corrected"] for b in json.load(f)["bases"]))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class TestCtl(JsonBase):
    def test_ctl_format(self):
        with open(self.ctl_path, "rb") as f:
            data = f.read().decode("utf-8")
        lines = data.split("\r\n")
        self.assertEqual(lines[-1], "")
        lines = lines[:-1]
        self.assertEqual(len(lines), len(self.r["points"]))
        for line, p in zip(lines, self.r["points"]):
            self.assertEqual(line, f"{p['id']:>8} {p['avg_n']:.3f} {p['avg_e']:.3f}")
        self.assertEqual(lines[0], "      12 2700000.000 200000.000")


class TestNeighborsThreshold(unittest.TestCase):
    def test_neighbor_max_from_config(self):
        tmp = tempfile.mkdtemp()
        try:
            files = mf.scenario(tmp)
            cfg = os.path.join(tmp, "c.json")
            with open(cfg, "w", encoding="utf-8") as f:
                json.dump({"neighbor_max_m": 0.01}, f)
            jp = os.path.join(tmp, "r.json")
            code, _, err = run_cli([files["day1"], files["day2"], "--out",
                                    os.path.join(tmp, "o"), "--config", cfg, "--json", jp])
            self.assertEqual(code, 0, err)
            with open(jp, encoding="utf-8") as f:
                r = json.load(f)
            # 點位平均坐標只有 BNC034 偏 1.5 cm、GDC060 偏 0.25 cm、GDC054 以外皆 0
            self.assertTrue(r["neighbors"])
            self.assertTrue(all(n["dist"] <= 0.01 for n in r["neighbors"]))
            self.assertLess(len(r["neighbors"]), 66)
            self.assertEqual(r["thresholds"]["neighbor_max_m"], 0.01)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class TestBaseNaming(unittest.TestCase):
    def test_same_id_different_position_gets_suffix(self):
        tmp = tempfile.mkdtemp()
        try:
            a = mf.make_pd(os.path.join(tmp, "a.PD"), [
                mf.obs("1", "GDC060", "2026-11-01 08:00:00", "2026-11-01 08:05:00", base="B1"),
                mf.obs("2", "GDC061", "2026-11-01 08:10:00", "2026-11-01 08:15:00", base="B2"),
            ])
            saved = dict(mf.BASES)
            mf.BASES["B1"] = (10.0, 100.5)  # 同 ID、位置差約 55 km
            try:
                b = mf.make_pd(os.path.join(tmp, "b.PD"), [
                    mf.obs("3", "GDC062", "2026-11-01 09:00:00", "2026-11-01 09:05:00",
                           base="B1"),
                    mf.obs("4", "GDC063", "2026-11-01 09:10:00", "2026-11-01 09:15:00",
                           base="B1"),
                ])
            finally:
                mf.BASES.clear()
                mf.BASES.update(saved)
            jp = os.path.join(tmp, "r.json")
            code, _, err = run_cli([a, b, "--out", os.path.join(tmp, "o"), "--json", jp])
            self.assertEqual(code, 0, err)
            with open(jp, encoding="utf-8") as f:
                r = json.load(f)
            self.assertEqual([x["label"] for x in r["bases"]], ["B1", "B2", "B1(2)"])
            self.assertEqual([x["base_id"] for x in r["bases"]], ["B1", "B2", "B1"])
            self.assertEqual([x["count"] for x in r["bases"]], [1, 1, 2])
            labels = {o["id"]: o["base_label"] for o in r["observations"]}
            self.assertEqual(labels, {"GDC060": "B1", "GDC061": "B2", "GDC062": "B1(2)",
                                      "GDC063": "B1(2)"})
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
