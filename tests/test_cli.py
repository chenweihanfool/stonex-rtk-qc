"""端到端測試：以合成 .PD 跑 CLI，檢查旗標、輸出檔、唯讀與錯誤處理。"""

import contextlib
import csv
import hashlib
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest

import make_fixture as mf
from rtkqc import __version__
from rtkqc.cli import main

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = main(argv)
    return code, out.getvalue(), err.getvalue()


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.reader(f))


class ScenarioTest(unittest.TestCase):
    """共用：在「測 試 資料」（含中文與空白）資料夾建立合成檔並跑一次。"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.data_dir = os.path.join(cls.tmp, "測 試 資料")
        os.makedirs(cls.data_dir)
        cls.files = mf.scenario(cls.data_dir)
        cls.hash_before = {k: sha(v) for k, v in cls.files.items()}
        cls.out = os.path.join(cls.tmp, "輸出 結果")
        cls.code, cls.stdout, cls.stderr = run_cli(
            [cls.files["day1"], cls.files["day2"], "--out", cls.out])
        cls.points = read_csv(os.path.join(cls.out, "points.csv"))[1:]
        cls.flags = {r[0]: r[10] for r in cls.points}

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)


class TestScenario(ScenarioTest):
    def test_exit_ok_and_files_present(self):
        self.assertEqual(self.code, 0, self.stderr)
        for name in ["observations.csv", "points.csv", "remeasure.csv",
                     "handbook.html", "manifest.json"]:
            self.assertTrue(os.path.isfile(os.path.join(self.out, name)), name)
        self.assertFalse(os.path.exists(os.path.join(self.out, "known_check.csv")))

    def test_observation_and_point_counts(self):
        obs_rows = read_csv(os.path.join(self.out, "observations.csv"))[1:]
        self.assertEqual(len(obs_rows), 22)  # 排除刪除點與孤兒點
        self.assertEqual(len(self.points), 12)

    def test_flags_per_point(self):
        expected = {
            "GDC060": "", "BNC032": "X1", "BNC033": "X6", "BNC034": "X5",
            "GDC050": "X2", "GDC051": "X3", "GDC052": "X4", "GDC053": "F1",
            "GDC054": "T1", "GDC101": "X6", "12": "", "BNC060": "",
        }
        self.assertEqual(self.flags, expected)

    def test_deleted_and_orphan_excluded(self):
        self.assertNotIn("GDC055", self.flags)
        self.assertNotIn("ORPHAN", self.flags)
        self.assertIn("GPSID", self.stderr)
        self.assertIn("已略過", self.stderr)

    def test_cross_file_grouping(self):
        bnc = [r for r in self.points if r[0] == "BNC060"][0]
        self.assertEqual(bnc[1], "2")
        self.assertEqual(bnc[9], "1200.00")  # 11-01 12:00 與 11-02 08:00，間隔 1200 分

    def test_auto_id_rule(self):
        self.assertIn("GDC060", self.flags)   # NAME 數字 + CODE 點號 → CODE
        self.assertIn("12", self.flags)       # NAME 數字 + CODE='29' → NAME

    def test_csv_has_bom(self):
        with open(os.path.join(self.out, "observations.csv"), "rb") as f:
            self.assertEqual(f.read(3), b"\xef\xbb\xbf")

    def test_source_unchanged(self):
        for k, path in self.files.items():
            self.assertEqual(sha(path), self.hash_before[k], k)

    def test_manifest_contents(self):
        with open(os.path.join(self.out, "manifest.json"), encoding="utf-8") as f:
            m = json.load(f)
        self.assertEqual(m["version"], "0.1.0")
        self.assertEqual(m["point_count"], 12)
        self.assertEqual(m["observation_count"], 22)
        self.assertEqual(m["flag_stats"]["X6"], 2)
        self.assertEqual(len(m["inputs"]), 2)
        self.assertEqual(m["inputs"][0]["sha256"], self.hash_before["day1"])
        self.assertEqual(m["thresholds"]["pdop_max"], 10.0)

    def test_remeasure_actions(self):
        rows = read_csv(os.path.join(self.out, "remeasure.csv"))
        by_id = {r[0]: r for r in rows[1:]}
        self.assertEqual(set(by_id), {k for k, v in self.flags.items() if v})
        self.assertEqual(by_id["BNC032"][2], "斷開重連 NTRIP 後再測一次")
        self.assertEqual(by_id["GDC054"][2], "重新整平對中後重測")
        self.assertEqual(by_id["BNC033"][2], "補測第二次（建議重連 NTRIP）")


class TestHandbook(ScenarioTest):
    def test_handbook_self_contained(self):
        with open(os.path.join(self.out, "handbook.html"), encoding="utf-8") as f:
            html = f.read()
        self.assertNotIn("http://", html)
        self.assertNotIn("https://", html)
        self.assertNotIn("<script", html)
        self.assertIn("TSTSN0001", html)
        self.assertIn("S900A", html)
        self.assertIn("X1", html)


class TestKnownAndConfig(ScenarioTest):
    def test_known_check_and_k1(self):
        known = os.path.join(self.tmp, "known.csv")
        with open(known, "w", encoding="utf-8-sig") as f:
            # GDC060 平均偏移約 2.75cm → K1；未測點不輸出
            f.write("點號,N,E,H\nGDC060,2700000.030,200000.000,50.0\nNOTMEASURED,1,1,\n")
        out = os.path.join(self.tmp, "known_out")
        code, _, err = run_cli([self.files["day1"], self.files["day2"],
                                "--out", out, "--known", known])
        self.assertEqual(code, 0, err)
        rows = read_csv(os.path.join(out, "known_check.csv"))
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1][0], "GDC060")
        self.assertEqual(rows[1][5], "是")
        points = {r[0]: r[10] for r in read_csv(os.path.join(out, "points.csv"))[1:]}
        self.assertIn("K1", points["GDC060"])

    def test_known_without_header(self):
        known = os.path.join(self.tmp, "known_nohdr.csv")
        with open(known, "w", encoding="utf-8") as f:
            f.write("GDC060,2700000.0025,200000.0025\n")
        out = os.path.join(self.tmp, "known_nohdr_out")
        code, _, err = run_cli([self.files["day1"], "--out", out, "--known", known])
        self.assertEqual(code, 0, err)
        rows = read_csv(os.path.join(out, "known_check.csv"))
        self.assertEqual(rows[1][5], "否")

    def test_config_overrides_threshold(self):
        cfg = os.path.join(self.tmp, "cfg.json")
        with open(cfg, "w", encoding="utf-8") as f:
            json.dump({"min_interval_min": 2000}, f)
        out = os.path.join(self.tmp, "cfg_out")
        code, _, err = run_cli([self.files["day1"], self.files["day2"],
                                "--out", out, "--config", cfg])
        self.assertEqual(code, 0, err)
        points = {r[0]: r[10] for r in read_csv(os.path.join(out, "points.csv"))[1:]}
        self.assertIn("D1", points["BNC060"])  # 1200 分 < 2000 分

    def test_handbook_escapes_html(self):
        d = os.path.join(self.tmp, "esc")
        os.makedirs(d)
        src = mf.make_pd(os.path.join(d, "esc.PD"), [
            mf.obs("<x>", "GDC999", "2026-11-01 08:00:00", "2026-11-01 08:05:00"),
        ])
        out = os.path.join(d, "out")
        code, _, err = run_cli([src, "--out", out, "--id-from", "name"])
        self.assertEqual(code, 0, err)
        with open(os.path.join(out, "handbook.html"), encoding="utf-8") as f:
            html = f.read()
        self.assertIn("&lt;x&gt;", html)
        self.assertNotIn("<x>", html)


class TestErrors(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_missing_file_exit2(self):
        out = os.path.join(self.tmp, "o")
        code, _, err = run_cli([os.path.join(self.tmp, "nope.PD"), "--out", out])
        self.assertEqual(code, 2)
        self.assertIn("找不到檔案", err)
        self.assertFalse(os.path.exists(out))

    def test_not_sqlite_exit2_no_output(self):
        bad = os.path.join(self.tmp, "bad.PD")
        with open(bad, "wb") as f:
            f.write(b"this is not a database at all" * 50)
        out = os.path.join(self.tmp, "o")
        code, _, err = run_cli([bad, "--out", out])
        self.assertEqual(code, 2)
        self.assertIn("SQLite", err)
        self.assertFalse(os.path.exists(os.path.join(out, "points.csv")))

    def test_missing_table_exit2(self):
        bad = os.path.join(self.tmp, "partial.PD")
        conn = sqlite3.connect(bad)
        conn.execute("CREATE TABLE Point (ID INTEGER)")
        conn.commit()
        conn.close()
        out = os.path.join(self.tmp, "o")
        code, _, err = run_cli([bad, "--out", out])
        self.assertEqual(code, 2)
        self.assertIn("缺少", err)
        self.assertFalse(os.path.exists(os.path.join(out, "observations.csv")))

    def test_bad_known_exit2(self):
        src = mf.make_pd(os.path.join(self.tmp, "a.PD"), [
            mf.obs("1", "GDC060", "2026-11-01 08:00:00", "2026-11-01 08:05:00"),
        ])
        known = os.path.join(self.tmp, "k.csv")
        with open(known, "w", encoding="utf-8") as f:
            f.write("GDC060,abc,def\n")
        code, _, err = run_cli([src, "--out", os.path.join(self.tmp, "o"), "--known", known])
        self.assertEqual(code, 2)

    def test_version_prints_bare_number(self):
        proc = subprocess.run([sys.executable, "-m", "rtkqc", "--version"],
                              cwd=REPO, capture_output=True, env=dict(os.environ, PYTHONUTF8="1"))
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.decode("utf-8").strip(), "0.1.0")
        self.assertEqual(__version__, "0.1.0")


if __name__ == "__main__":
    unittest.main()
