"""作業模式、E1、已知加密點連測與坐標轉換（transform.py）的測試。全部用合成資料。"""

import contextlib
import csv
import io
import json
import os
import shutil
import tempfile
import unittest

import make_fixture as mf
from rtkqc.cli import main
from rtkqc.pdreader import InputError
from rtkqc.rules import load_thresholds
from rtkqc.transform import choose_method, solve_linear


def run_cli(argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = main(argv)
    return code, out.getvalue(), err.getvalue()


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.reader(f))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_scenario(self, control=None, extra=None, outlier=0.0, extra_day=False,
                     fixed_epochs=3, header=True):
        """跑 CLI，回傳 (結束碼, stderr, 輸出資料夾, JSON 或 None, 情境)。"""
        sc = mf.control_scenario(os.path.join(self.tmp, "d"), outlier=outlier,
                                 extra_day=extra_day, fixed_epochs=fixed_epochs)
        ctl = mf.write_control_csv(os.path.join(self.tmp, "ctl.csv"),
                                   sc["control"] if control is None else control, header)
        out = os.path.join(self.tmp, "o")
        jp = os.path.join(self.tmp, "r.json")
        argv = [sc["pd"], "--out", out, "--json", jp, "--control", ctl] + (extra or [])
        code, _, err = run_cli(argv)
        r = None
        if code == 0:
            with open(jp, encoding="utf-8") as f:
                r = json.load(f)
        return code, err, out, r, sc


class TestHelpers(unittest.TestCase):
    def test_solve_linear(self):
        x = solve_linear([[2.0, 1.0], [1.0, 3.0]], [5.0, 10.0])
        self.assertAlmostEqual(x[0], 1.0)
        self.assertAlmostEqual(x[1], 3.0)

    def test_singular_raises(self):
        with self.assertRaises(InputError):
            solve_linear([[1.0, 1.0], [1.0, 1.0]], [1.0, 2.0])

    def test_choose_method(self):
        self.assertEqual(choose_method("auto", 0), "none")
        self.assertEqual(choose_method("auto", 1), "shift")
        self.assertEqual(choose_method("auto", 2), "helmert")
        self.assertEqual(choose_method("auto", 9), "helmert")
        self.assertEqual(choose_method("none", 5), "none")
        with self.assertRaises(InputError):
            choose_method("affine", 2)
        with self.assertRaises(InputError):
            choose_method("helmert", 1)

    def test_mode_thresholds(self):
        s = load_thresholds(None, "survey")
        c = load_thresholds(None, "control")
        self.assertEqual((s["min_fixed_epochs"], s["min_interval_min"]), (0.0, 0.0))
        self.assertEqual((c["min_fixed_epochs"], c["min_interval_min"]), (180.0, 60.0))
        self.assertEqual(c["transform_resid_max"], 0.098)
        self.assertEqual(c["azimuth_diff_max_sec"], 20.0)
        self.assertEqual(c["distance_ratio_min"], 20000.0)

    def test_config_overrides_mode_default(self):
        tmp = tempfile.mkdtemp()
        try:
            p = os.path.join(tmp, "c.json")
            with open(p, "w", encoding="utf-8") as f:
                json.dump({"min_fixed_epochs": 100}, f)
            self.assertEqual(load_thresholds(p, "control")["min_fixed_epochs"], 100.0)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class TestHelmert(Base):
    def test_recovers_known_transform(self):
        code, err, out, r, sc = self.run_scenario()
        self.assertEqual(code, 0, err)
        tf = r["transform"]
        self.assertEqual(tf["method"], "helmert")
        self.assertEqual(tf["n_common"], 7)
        self.assertEqual(tf["redundancy"], 2 * 7 - 4)
        pr = tf["params"]
        a, b = mf.tf_params()
        c = tf["centroid"]
        # 重心處的平移量 = 真值轉換套在重心上的位移（觀測重心與參考點差不到 1 m，與 TF_TN、TF_TE 只差 µm 級）
        fn, fe = mf.tf_forward(c["n"], c["e"])
        self.assertLess(abs(pr["tN"] - (fn - c["n"])), 0.001)
        self.assertLess(abs(pr["tE"] - (fe - c["e"])), 0.001)
        self.assertLess(abs(pr["tN"] - mf.TF_TN), 0.001)
        self.assertLess(abs(pr["tE"] - mf.TF_TE), 0.001)
        self.assertLess(abs(pr["scale_ppm"] - mf.TF_PPM), 0.1)
        self.assertLess(abs(pr["rotation_sec"] - mf.TF_SEC), 0.01)
        self.assertLess(abs(pr["a"] - a), 1e-9)
        self.assertLess(abs(pr["b"] - b), 1e-9)
        self.assertLess(abs(tf["dh"] - mf.TF_DH), 0.0005)
        self.assertEqual(tf["note"], "")

    def test_all_points_transformed_to_truth(self):
        code, err, out, r, sc = self.run_scenario()
        for p in r["points"]:
            tn, te, th = sc["truth"][p["id"]]
            self.assertLess(abs(p["n_t"] - tn), 0.001, p["id"])
            self.assertLess(abs(p["e_t"] - te), 0.001, p["id"])
            self.assertLess(abs(p["h_t"] - th), 0.001, p["id"])
        for c in r["transform"]["common"]:
            self.assertLess(abs(c["vn"]), 0.001)
            self.assertLess(abs(c["ve"]), 0.001)
            self.assertEqual(c["flags"], [])
        self.assertEqual(len(r["transform"]["pairs"]), 21)
        for x in r["transform"]["pairs"]:
            self.assertEqual(x["flags"], [])
            self.assertLess(x["az_diff_sec"], 1.0)

    def test_ctl_and_points_use_transformed(self):
        sc_dir = os.path.join(self.tmp, "x")
        sc = mf.control_scenario(sc_dir)
        ctl = mf.write_control_csv(os.path.join(self.tmp, "c.csv"), sc["control"])
        out = os.path.join(self.tmp, "o")
        ctl_out = os.path.join(self.tmp, "o.ctl")
        code, _, err = run_cli([sc["pd"], "--out", out, "--control", ctl, "--ctl", ctl_out])
        self.assertEqual(code, 0, err)
        with open(ctl_out, encoding="utf-8", newline="") as f:
            lines = f.read().split("\r\n")[:-1]
        by = {ln.split()[0]: ln.split()[1:] for ln in lines}
        tn, te, _ = sc["truth"]["CP01"]
        self.assertLess(abs(float(by["CP01"][0]) - tn), 0.001)
        self.assertLess(abs(float(by["CP01"][1]) - te), 0.001)
        rows = read_csv(os.path.join(out, "points.csv"))
        self.assertEqual(rows[0][-3:], ["轉換後N", "轉換後E", "轉換後H"])
        self.assertEqual(rows[0][2], "平均N")  # 原有欄位保留
        # 原始平均坐標與轉換後不同
        cp01 = [x for x in rows if x[0] == "CP01"][0]
        self.assertNotEqual(cp01[2], cp01[-3])

    def test_outputs_files(self):
        code, err, out, r, sc = self.run_scenario()
        for name in ["transform.csv", "transform_pairs.csv"]:
            self.assertTrue(os.path.isfile(os.path.join(out, name)), name)
        rows = read_csv(os.path.join(out, "transform.csv"))
        self.assertEqual(len(rows), 1 + 7)
        self.assertEqual(rows[0][0], "點號")
        pairs = read_csv(os.path.join(out, "transform_pairs.csv"))
        self.assertEqual(len(pairs), 1 + 21)
        obs_rows = read_csv(os.path.join(out, "observations.csv"))
        self.assertEqual(obs_rows[0][-2:], ["最近已知加密點", "距最近加密點(m)"])
        with open(os.path.join(out, "handbook.html"), encoding="utf-8") as f:
            html = f.read()
        self.assertIn("4 參數平面轉換", html)
        self.assertIn("survey", html)
        with open(os.path.join(out, "manifest.json"), encoding="utf-8") as f:
            m = json.load(f)
        self.assertEqual(m["mode"], "survey")
        self.assertEqual(m["control_file"], "ctl.csv")
        self.assertEqual(m["transform"]["method"], "helmert")

    def test_nearest_control(self):
        code, err, out, r, sc = self.run_scenario()
        by = {o["id"]: o for o in r["observations"]}
        self.assertEqual(by["CP03"]["nearest_control"], "CP03")
        self.assertLess(by["CP03"]["nearest_control_dist"], 0.001)
        # P01 (30, 40)：最近的加密點是 CP00（距離 50 m）
        self.assertEqual(by["P01"]["nearest_control"], "CP00")
        self.assertLess(abs(by["P01"]["nearest_control_dist"] - 50.0), 0.01)


class TestOtherMethods(Base):
    def test_affine_recovers(self):
        code, err, out, r, sc = self.run_scenario(extra=["--transform", "affine"])
        self.assertEqual(code, 0, err)
        tf = r["transform"]
        self.assertEqual(tf["method"], "affine")
        self.assertEqual(tf["redundancy"], 2 * 7 - 6)
        a, b = mf.tf_params()
        pr = tf["params"]
        self.assertLess(abs(pr["a1"] - a), 1e-9)
        self.assertLess(abs(pr["a2"] + b), 1e-9)
        self.assertLess(abs(pr["b1"] - b), 1e-9)
        self.assertLess(abs(pr["b2"] - a), 1e-9)
        self.assertNotIn("scale_ppm", pr)
        for p in r["points"]:
            tn, te, _ = sc["truth"][p["id"]]
            self.assertLess(abs(p["n_t"] - tn), 0.001)
            self.assertLess(abs(p["e_t"] - te), 0.001)

    def test_one_common_point_is_shift(self):
        sc = mf.control_scenario(os.path.join(self.tmp, "d"))
        only = {"CP01": sc["control"]["CP01"]}
        ctl = mf.write_control_csv(os.path.join(self.tmp, "c.csv"), only, header=False)
        jp = os.path.join(self.tmp, "r.json")
        code, _, err = run_cli([sc["pd"], "--out", os.path.join(self.tmp, "o"), "--json", jp,
                                "--control", ctl])
        self.assertEqual(code, 0, err)
        with open(jp, encoding="utf-8") as f:
            tf = json.load(f)["transform"]
        self.assertEqual(tf["method"], "shift")
        self.assertEqual(tf["n_common"], 1)
        self.assertEqual(tf["redundancy"], 0)
        self.assertIn("無多餘觀測，殘差無檢核意義", tf["note"])
        self.assertEqual(tf["pairs"], [])
        # 平移量 = 已知 − 觀測
        c = tf["common"][0]
        self.assertAlmostEqual(tf["params"]["tN"], c["n_known"] - c["n_obs"], places=3)
        self.assertAlmostEqual(c["vn"], 0.0, places=4)

    def test_two_common_points_zero_redundancy(self):
        sc = mf.control_scenario(os.path.join(self.tmp, "d"))
        two = {k: sc["control"][k] for k in ("CP01", "CP02")}
        ctl = mf.write_control_csv(os.path.join(self.tmp, "c.csv"), two)
        jp = os.path.join(self.tmp, "r.json")
        code, _, err = run_cli([sc["pd"], "--out", os.path.join(self.tmp, "o"), "--json", jp,
                                "--control", ctl])
        self.assertEqual(code, 0, err)
        with open(jp, encoding="utf-8") as f:
            tf = json.load(f)["transform"]
        self.assertEqual(tf["method"], "helmert")
        self.assertEqual(tf["redundancy"], 0)
        self.assertIn("無多餘觀測，殘差無檢核意義", tf["note"])
        self.assertEqual(len(tf["pairs"]), 1)

    def test_affine_with_two_points_exit2(self):
        sc = mf.control_scenario(os.path.join(self.tmp, "d"))
        two = {k: sc["control"][k] for k in ("CP01", "CP02")}
        ctl = mf.write_control_csv(os.path.join(self.tmp, "c.csv"), two)
        out = os.path.join(self.tmp, "o")
        code, _, err = run_cli([sc["pd"], "--out", out, "--control", ctl,
                                "--transform", "affine"])
        self.assertEqual(code, 2)
        self.assertIn("affine", err)
        self.assertFalse(os.path.exists(os.path.join(out, "points.csv")))

    def test_no_common_point_no_transform(self):
        sc = mf.control_scenario(os.path.join(self.tmp, "d"))
        ctl = mf.write_control_csv(os.path.join(self.tmp, "c.csv"), {"ZZ99": (1.0, 2.0, None)})
        out = os.path.join(self.tmp, "o")
        jp = os.path.join(self.tmp, "r.json")
        code, _, err = run_cli([sc["pd"], "--out", out, "--json", jp, "--control", ctl])
        self.assertEqual(code, 0, err)
        with open(jp, encoding="utf-8") as f:
            r = json.load(f)
        self.assertIsNone(r["transform"])
        self.assertTrue(all(p["n_t"] is None for p in r["points"]))
        self.assertFalse(os.path.exists(os.path.join(out, "transform.csv")))
        self.assertEqual(read_csv(os.path.join(out, "points.csv"))[0][-1], "旗標")

    def test_transform_none(self):
        code, err, out, r, sc = self.run_scenario(extra=["--transform", "none"])
        self.assertEqual(code, 0, err)
        self.assertIsNone(r["transform"])

    def test_no_height_in_control(self):
        sc = mf.control_scenario(os.path.join(self.tmp, "d"))
        nohn = {k: (n, e, None) for k, (n, e, _) in sc["control"].items()}
        ctl = mf.write_control_csv(os.path.join(self.tmp, "c.csv"), nohn)
        jp = os.path.join(self.tmp, "r.json")
        code, _, err = run_cli([sc["pd"], "--out", os.path.join(self.tmp, "o"), "--json", jp,
                                "--control", ctl])
        self.assertEqual(code, 0, err)
        with open(jp, encoding="utf-8") as f:
            r = json.load(f)
        self.assertIsNone(r["transform"]["dh"])
        self.assertIn("高程未轉換", r["transform"]["note"])
        p = [x for x in r["points"] if x["id"] == "CP01"][0]
        self.assertEqual(p["h_t"], p["avg_h"])


class TestChecks(Base):
    def test_outlier_flags_c1_c2_c3(self):
        code, err, out, r, sc = self.run_scenario(outlier=0.12)
        self.assertEqual(code, 0, err)
        tf = r["transform"]
        common = {c["id"]: c for c in tf["common"]}
        self.assertEqual(common["CP00"]["flags"], ["C1"])
        self.assertGreaterEqual(abs(common["CP00"]["vn"]), 0.098)
        for pid, c in common.items():
            if pid != "CP00":
                self.assertEqual(c["flags"], [], pid)
        flags = {p["id"]: p["flags"] for p in r["points"]}
        self.assertIn("C1", flags["CP00"])
        pair_flags = {(x["i"], x["j"]): x["flags"] for x in tf["pairs"]}
        self.assertTrue(any("C2" in f for f in pair_flags.values()))
        self.assertTrue(any("C3" in f for f in pair_flags.values()))
        # 沒涉及 CP00 的點對不應超限
        for (i, j), f in pair_flags.items():
            if "CP00" not in (i, j):
                self.assertTrue(all(x["az_diff_sec"] < 20 for x in tf["pairs"]
                                    if (x["i"], x["j"]) == (i, j)))
        # C2、C3 掛到相關兩點
        for x in tf["pairs"]:
            for fl in x["flags"]:
                self.assertIn(fl, flags[x["i"]])
                self.assertIn(fl, flags[x["j"]])
        # 比值分母：差為 0 才留空
        for x in tf["pairs"]:
            if "C3" in x["flags"]:
                self.assertLess(x["ratio_den"], 20000)

    def test_pair_values(self):
        code, err, out, r, sc = self.run_scenario(outlier=0.12)
        x = {(p["i"], p["j"]): p for p in r["transform"]["pairs"]}[("CP00", "CP01")]
        # CP00→CP01 是正北向 100 m；CP00 成果往北偏 0.12，已知距離變短、轉換後距離仍約 100 m
        self.assertAlmostEqual(x["d_known"], 100.0 - 0.12, delta=0.001)
        self.assertAlmostEqual(x["d_t"], 100.0, delta=0.02)
        self.assertIn("C3", x["flags"])
        self.assertAlmostEqual(x["ratio_den"], x["d_known"] / abs(x["d_t"] - x["d_known"]), delta=1)

    def test_threshold_overrides(self):
        # 乾淨資料也可用極小的門檻觸發 C1（分量改正數 ≥ 0）
        cfg = os.path.join(self.tmp, "cfg.json")
        with open(cfg, "w", encoding="utf-8") as f:
            json.dump({"transform_resid_max": 0.0}, f)
        code, err, out, r, sc = self.run_scenario(extra=["--config", cfg])
        self.assertTrue(all(c["flags"] == ["C1"] for c in r["transform"]["common"]))

    def test_known_check_uses_transformed(self):
        sc = mf.control_scenario(os.path.join(self.tmp, "d"))
        ctl = mf.write_control_csv(os.path.join(self.tmp, "c.csv"), sc["control"])
        kn = mf.write_control_csv(os.path.join(self.tmp, "k.csv"), {"P01": sc["truth"]["P01"]})
        jp = os.path.join(self.tmp, "r.json")
        code, _, err = run_cli([sc["pd"], "--out", os.path.join(self.tmp, "o"), "--json", jp,
                                "--control", ctl, "--known", kn])
        self.assertEqual(code, 0, err)
        with open(jp, encoding="utf-8") as f:
            r = json.load(f)
        k = r["known_check"][0]
        self.assertLess(k["d2"], 0.002)  # 轉換後與真值吻合；未轉換的話會差約 0.48 m
        self.assertFalse(k["over"])
        # 沒給 --control：同一個 .PD 直接比較會超限
        jp2 = os.path.join(self.tmp, "r2.json")
        run_cli([sc["pd"], "--out", os.path.join(self.tmp, "o2"), "--json", jp2, "--known", kn])
        with open(jp2, encoding="utf-8") as f:
            r2 = json.load(f)
        self.assertTrue(r2["known_check"][0]["over"])
        self.assertIsNone(r2["transform"])
        self.assertTrue(all(o["nearest_control"] is None for o in r2["observations"]))


class TestModeAndE1(Base):
    def test_survey_has_no_e1(self):
        code, err, out, r, sc = self.run_scenario()
        self.assertEqual(r["mode"], "survey")
        self.assertEqual(r["thresholds"]["min_fixed_epochs"], 0.0)
        self.assertTrue(all("E1" not in o["flags"] for o in r["observations"]))

    def test_control_mode_e1(self):
        code, err, out, r, sc = self.run_scenario(extra=["--mode", "control"])
        self.assertEqual(r["mode"], "control")
        self.assertEqual(r["thresholds"]["min_fixed_epochs"], 180.0)
        self.assertEqual(r["thresholds"]["min_interval_min"], 60.0)
        self.assertTrue(all("E1" in o["flags"] and "E1" in o["row_flags"]
                            for o in r["observations"]))
        self.assertTrue(all("E1" in p["flags"] for p in r["points"]))
        rem = {x["id"]: x for x in r["remeasure"]}
        self.assertIn("固定解筆數不足，重測並收足筆數", rem["CP00"]["actions"])

    def test_control_mode_enough_epochs(self):
        code, err, out, r, sc = self.run_scenario(extra=["--mode", "control"], fixed_epochs=180)
        self.assertTrue(all("E1" not in o["flags"] for o in r["observations"]))
        code, err, out, r, sc = self.run_scenario(extra=["--mode", "control"], fixed_epochs=179)
        self.assertTrue(all("E1" in o["flags"] for o in r["observations"]))

    def test_config_overrides_mode(self):
        cfg = os.path.join(self.tmp, "cfg.json")
        with open(cfg, "w", encoding="utf-8") as f:
            json.dump({"min_fixed_epochs": 2}, f)
        code, err, out, r, sc = self.run_scenario(extra=["--mode", "control", "--config", cfg])
        self.assertEqual(r["thresholds"]["min_fixed_epochs"], 2.0)
        self.assertTrue(all("E1" not in o["flags"] for o in r["observations"]))
        with open(os.path.join(out, "manifest.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["mode"], "control")


class TestControlDays(Base):
    def test_day_without_control_warned(self):
        code, err, out, r, sc = self.run_scenario(extra_day=True)
        self.assertEqual(code, 0, err)
        self.assertEqual([d["date"] for d in r["control_days"]], ["2026-11-01", "2026-11-02"])
        self.assertEqual(r["control_days"][0]["control_points"],
                         ["CP00", "CP01", "CP02", "CP03", "CP04", "CP05", "CP06"])
        self.assertEqual(r["control_days"][1]["control_points"], [])
        self.assertEqual(r["days_without_control"], ["2026-11-02"])
        self.assertIn("2026-11-02", err)
        with open(os.path.join(out, "manifest.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["days_without_control"], ["2026-11-02"])

    def test_no_control_file_is_empty(self):
        sc = mf.control_scenario(os.path.join(self.tmp, "d"))
        jp = os.path.join(self.tmp, "r.json")
        code, _, err = run_cli([sc["pd"], "--out", os.path.join(self.tmp, "o"), "--json", jp])
        self.assertEqual(code, 0, err)
        with open(jp, encoding="utf-8") as f:
            r = json.load(f)
        self.assertEqual(r["control_days"], [])
        self.assertEqual(r["days_without_control"], [])
        self.assertIsNone(r["transform"])
        self.assertEqual(r["mode"], "survey")
        out_rows = read_csv(os.path.join(self.tmp, "o", "observations.csv"))
        self.assertEqual(out_rows[0][-1], "該筆旗標")  # 沒給 --control 時欄位與 0.2.0 相同


if __name__ == "__main__":
    unittest.main()
