"""單檔 HTML 建置的測試：docs/ 必須與原始檔建置結果位元組相同、無外部資源、含 CSP、版本一致。"""

import importlib.util
import json
import os
import re
import shutil
import tempfile
import unittest

from rtkqc import __version__

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(REPO, "docs")


def load_builder():
    spec = importlib.util.spec_from_file_location(
        "build_html", os.path.join(REPO, "tools", "build_html.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def read_bytes(path):
    with open(path, "rb") as f:
        return f.read()


class TestBuild(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.builder = load_builder()
        cls.built = cls.builder.build(cls.tmp)
        cls.html = read_bytes(os.path.join(DOCS, "index.html")).decode("utf-8")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_docs_match_fresh_build(self):
        for name in ["index.html", "rtkqc.html", "version.json"]:
            have = read_bytes(os.path.join(DOCS, name))
            if name == "version.json":  # 此檔未列入 .gitattributes -text，Windows checkout 可能是 CRLF
                have = have.replace(b"\r\n", b"\n")
            self.assertEqual(
                have, read_bytes(os.path.join(self.tmp, name)),
                f"docs/{name} 與重建結果不一致，請執行 python tools/build_html.py 後再 commit")

    def test_rtkqc_html_is_copy_of_index(self):
        self.assertEqual(read_bytes(os.path.join(DOCS, "index.html")),
                         read_bytes(os.path.join(DOCS, "rtkqc.html")))

    def test_build_is_deterministic(self):
        for name, data in self.builder.build().items():
            self.assertEqual(data, self.built[name], name)

    def test_no_external_resources(self):
        html = self.html
        self.assertEqual(re.findall(r'(?:src|href)\s*=\s*["\']?\s*https?:', html, re.I), [])
        self.assertEqual(re.findall(r'<script[^>]*\ssrc\s*=', html, re.I), [])
        self.assertEqual(re.findall(r'<link\b', html, re.I), [])
        self.assertEqual(re.findall(r'@import', html, re.I), [])
        self.assertEqual(re.findall(r'url\(\s*["\']?https?:', html, re.I), [])
        self.assertEqual(re.findall(r'<iframe|<img[^>]+src=["\']?http', html, re.I), [])

    def test_csp_meta(self):
        m = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]+)"', self.html)
        self.assertIsNotNone(m)
        self.assertEqual(
            m.group(1),
            "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; "
            "style-src 'unsafe-inline'; img-src data: blob:; "
            "connect-src https://chenweihanfool.github.io; base-uri 'none'; form-action 'none'")

    def test_embeds_version_changelog_wasm(self):
        self.assertIn(f"const VERSION = '{__version__}'", self.html)
        self.assertIn("RTKQC_CHANGELOG", self.html)
        self.assertIn("## 0.1.0 - 2026-11-09", self.html)
        self.assertIn('id="rtkqc-wasm"', self.html)
        # wasm 魔數 \0asm 的 base64 開頭
        m = re.search(r'id="rtkqc-wasm" type="text/plain">(AGFzb[A-Za-z0-9+/=]+)</script>', self.html)
        self.assertIsNotNone(m)
        self.assertEqual(len(re.findall(r'</script>', self.html)), len(re.findall(r'<script', self.html)))

    def test_only_network_call_is_version_check(self):
        app = read_bytes(os.path.join(REPO, "web", "src", "app.js")).decode("utf-8")
        self.assertEqual(len(re.findall(r'\bfetch\(', app)), 1)
        self.assertNotIn("XMLHttpRequest", app)
        self.assertNotIn("sendBeacon", app)
        self.assertNotIn("WebSocket", app)
        self.assertIn("https://chenweihanfool.github.io/stonex-rtk-qc/version.json", app)

    def test_version_json(self):
        with open(os.path.join(DOCS, "version.json"), encoding="utf-8") as f:
            v = json.load(f)
        self.assertEqual(v["version"], __version__)
        self.assertEqual(v["date"], "2026-11-09")
        self.assertEqual(v["download_url"], "https://chenweihanfool.github.io/stonex-rtk-qc/rtkqc.html")
        self.assertEqual(v["page_url"], "https://chenweihanfool.github.io/stonex-rtk-qc/")
        self.assertIn("單檔 HTML", v["notes"])
        self.assertNotIn("## 0.1.0", v["notes"])
        self.assertEqual(set(v), {"version", "date", "notes", "download_url", "page_url"})

    def test_changelog_latest_section(self):
        text = self.builder.read_text(os.path.join(REPO, "CHANGELOG.md"))
        version, date, notes = self.builder.latest_changelog(text)
        self.assertEqual(version, __version__)
        self.assertRegex(date, r"^\d{4}-\d{2}-\d{2}$")
        self.assertTrue(notes)

    def test_script_close_tag_escaped(self):
        self.assertEqual(self.builder.safe_script("a</script>b"), "a<" + chr(92) + "/script>b")


if __name__ == "__main__":
    unittest.main()
