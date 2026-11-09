"""把 web/src 組成單一自含的 docs/index.html（另複製 docs/rtkqc.html、產生 docs/version.json）。

只用 Python 標準庫。用法：python tools/build_html.py [--out 資料夾]
輸出為位元組層級可重現：同樣的原始檔一定得到同樣的 docs/*，tests/test_build.py 會檢查。
"""

import argparse
import base64
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PAGE_URL = "https://chenweihanfool.github.io/stonex-rtk-qc/"
DOWNLOAD_URL = PAGE_URL + "rtkqc.html"

SQLJS_DIR = REPO / "vendor" / "sql.js-1.10.3"

BS = chr(92)  # 反斜線


def read_text(path):
    """讀文字檔並把換行統一成 LF（不同平台 checkout 的換行不同，輸出才會一致）。"""
    return Path(path).read_bytes().decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")


def get_version():
    text = read_text(REPO / "rtkqc" / "__init__.py")
    m = re.search(r'__version__\s*=\s*"([^"]+)"', text)
    if not m:
        raise SystemExit("找不到 rtkqc/__init__.py 的 __version__")
    return m.group(1)


def latest_changelog(text):
    """回傳 (版本, 日期, 純文字說明)：CHANGELOG 最新一節（第一個 `## 版本 - 日期`）。"""
    lines = text.split("\n")
    start = None
    for i, line in enumerate(lines):
        if re.match(r"^##\s+", line):
            start = i
            break
    if start is None:
        raise SystemExit("CHANGELOG.md 找不到版本小節（## 版本 - 日期）")
    m = re.match(r"^##\s+(\S+)\s+-\s+(\d{4}-\d{2}-\d{2})\s*$", lines[start])
    if not m:
        raise SystemExit("CHANGELOG.md 最新一節標題格式必須是「## 版本 - YYYY-MM-DD」")
    body = []
    for line in lines[start + 1:]:
        if re.match(r"^##\s+", line):
            break
        body.append(line)
    notes = []
    for line in body:
        t = line.strip()
        if not t:
            continue
        t = re.sub(r"^[-*]\s+", "・", t)
        t = t.replace("`", "").replace("**", "")
        notes.append(t)
    return m.group(1), m.group(2), "\n".join(notes)


def js_string(text):
    """輸出成可安全放進 <script> 的 JS 字串字面值。"""
    s = json.dumps(text, ensure_ascii=False)
    return (s.replace("<", BS + "u003c").replace(">", BS + "u003e")
             .replace(chr(0x2028), BS + "u2028").replace(chr(0x2029), BS + "u2029"))


def safe_script(code):
    """避免內嵌程式碼中的 </script 提早結束標籤。"""
    return re.sub(r"</(script)", lambda m: "<" + BS + "/" + m.group(1), code, flags=re.IGNORECASE)


def build(out_dir=None):
    """回傳 {檔名: bytes}；out_dir 不為 None 時一併寫入。"""
    version = get_version()
    cl_text = read_text(REPO / "CHANGELOG.md")
    cl_version, cl_date, notes = latest_changelog(cl_text)
    if cl_version != version:
        raise SystemExit(f"CHANGELOG 最新版本 {cl_version} 與 __version__ {version} 不一致")

    core = read_text(REPO / "web" / "src" / "rtkqc-core.js")
    m = re.search(r"const VERSION = '([^']+)'", core)
    if not m or m.group(1) != version:
        raise SystemExit("web/src/rtkqc-core.js 的 VERSION 與 __version__ 不一致")

    wasm_b64 = base64.b64encode((SQLJS_DIR / "sql-wasm.wasm").read_bytes()).decode("ascii")
    parts = {
        "{{CSS}}": read_text(REPO / "web" / "src" / "styles.css"),
        "{{WASM_B64}}": wasm_b64,
        "{{CHANGELOG_JSON}}": js_string(cl_text),
        "{{SQLJS}}": safe_script(read_text(SQLJS_DIR / "sql-wasm.js")),
        "{{CORE}}": safe_script(core),
        "{{XLSX}}": safe_script(read_text(REPO / "web" / "src" / "xlsx.js")),
        "{{APP}}": safe_script(read_text(REPO / "web" / "src" / "app.js")),
    }
    page = read_text(REPO / "web" / "src" / "index.template.html")
    # 一次取代全部占位符（不會把內嵌內容裡的 {{...}} 再次取代）
    page = re.sub(r"\{\{[A-Z0-9_]+\}\}", lambda mm: parts[mm.group(0)], page)
    data = page.encode("utf-8")

    version_json = json.dumps({
        "version": version,
        "date": cl_date,
        "notes": notes,
        "download_url": DOWNLOAD_URL,
        "page_url": PAGE_URL,
    }, ensure_ascii=False, indent=2) + "\n"

    files = {
        "index.html": data,
        "rtkqc.html": data,
        "version.json": version_json.encode("utf-8"),
    }
    if out_dir is not None:
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        for name, content in files.items():
            (out / name).write_bytes(content)
    return files


def main(argv=None):
    ap = argparse.ArgumentParser(description="建置單檔 HTML（docs/index.html、docs/rtkqc.html、docs/version.json）")
    ap.add_argument("--out", default=str(REPO / "docs"), help="輸出資料夾（預設 docs）")
    args = ap.parse_args(argv)
    files = build(args.out)
    for name, content in files.items():
        print(f"{Path(args.out) / name}  {len(content):,} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
