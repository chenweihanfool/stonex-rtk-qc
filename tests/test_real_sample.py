"""真實樣本測試：只有設定環境變數 RTKQC_SAMPLE_PD 時才執行，否則 skip。

本檔不含任何真實資料，也不讀取樣本內容；只執行 CLI 並檢查輸出結構。
"""

import contextlib
import io
import os
import shutil
import tempfile
import unittest

from rtkqc.cli import main

SAMPLE = os.environ.get("RTKQC_SAMPLE_PD")


@unittest.skipUnless(SAMPLE, "未設定 RTKQC_SAMPLE_PD，略過真實樣本測試")
class TestRealSample(unittest.TestCase):
    def test_sample_runs(self):
        out_dir = tempfile.mkdtemp()
        try:
            err = io.StringIO()
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
                code = main([SAMPLE, "--out", out_dir])
            self.assertEqual(code, 0, err.getvalue())
            for name in ["observations.csv", "points.csv", "remeasure.csv",
                         "handbook.html", "manifest.json"]:
                self.assertTrue(os.path.isfile(os.path.join(out_dir, name)), name)
            with open(os.path.join(out_dir, "observations.csv"), encoding="utf-8-sig") as f:
                lines = [ln for ln in f.read().splitlines() if ln.strip()]
            self.assertEqual(len(lines) - 1, 14)
        finally:
            shutil.rmtree(out_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
