"""命令列入口：python -m rtkqc <.PD ...> --out <資料夾> [--known 已知點.csv] [--config 門檻.json]"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

from . import __version__
from .outputs import build_outputs, ctl_text, result_dict
from .pdreader import InputError, read_pd
from .rules import (assign_bases, build_points, load_known, load_thresholds, obs_flags,
                    row_flags)


def build_parser():
    p = argparse.ArgumentParser(
        prog="rtkqc",
        description="Stonex Cube-a .PD（SQLite）VBS-RTK 觀測品管（唯讀）。",
    )
    p.add_argument("inputs", nargs="+", metavar="PD", help="一或多個 .PD 檔")
    p.add_argument("--out", required=True, help="輸出資料夾（不存在會建立）")
    p.add_argument("--known", help="已知點 CSV（點號,N,E[,H]）")
    p.add_argument("--config", help="門檻設定 JSON（覆蓋預設門檻）")
    p.add_argument("--json", metavar="FILE", help="輸出判定結果正規 JSON（JS 對拍契約）")
    p.add_argument("--ctl", metavar="FILE", help="輸出 CTL（點名右靠 8 字元 縱坐標 橫坐標）")
    p.add_argument("--id-from", choices=["auto", "name", "code"], default="auto",
                   help="點號來源（預設 auto）")
    p.add_argument("--version", action="version", version=__version__)
    return p


def main(argv=None):
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    args = build_parser().parse_args(raw_argv)

    try:
        th = load_thresholds(args.config)
        known = load_known(args.known) if args.known else None
        pds = [read_pd(path, args.id_from) for path in args.inputs]
    except InputError as e:
        print(f"錯誤：{e}", file=sys.stderr)
        return 2

    # 同一份檔案（sha256 相同）只算一次，避免被誤當成第二次觀測
    seen, unique = {}, []
    for pd in pds:
        if pd.sha256 in seen:
            print(f"警告：{pd.name} 與 {seen[pd.sha256]} 內容相同（sha256 一致），已略過重複輸入",
                  file=sys.stderr)
            continue
        seen[pd.sha256] = pd.name
        unique.append(pd)
    pds = unique

    for pd in pds:
        for w in pd.warnings:
            print(w, file=sys.stderr)

    observations = [o for pd in pds for o in pd.observations]
    for o in observations:
        o["obs_flags"] = obs_flags(o, th)
    bases = assign_bases(observations, th)  # 依輸入順序（再依開始時間）命名主站
    for o in observations:
        o["row_flags"] = row_flags(o, th)
    observations.sort(key=lambda o: (o["id"], o["start"]))

    points = build_points(observations, th, known)
    run_time = datetime.now().astimezone().isoformat(timespec="seconds")
    known_name = Path(args.known).name if args.known else None
    files = build_outputs(observations, points, pds, th, raw_argv, run_time, known_name)

    extra = {}
    if args.json:
        result = result_dict(observations, points, bases, pds, th, known is not None)
        extra[Path(args.json)] = (json.dumps(result, ensure_ascii=False, indent=1)
                                  + "\n").encode("utf-8")
    if args.ctl:
        extra[Path(args.ctl)] = ctl_text(points).encode("utf-8")

    out = Path(args.out)
    try:
        out.mkdir(parents=True, exist_ok=True)
        for name, data in files.items():
            (out / name).write_bytes(data)
        for path, data in extra.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    except OSError as e:
        print(f"錯誤：無法寫入輸出資料夾 {out}：{e}", file=sys.stderr)
        return 2

    print(f"完成：{len(observations)} 筆觀測、{len(points)} 個點位、"
          f"{sum(1 for p in points if p['flags'])} 點有旗標 → {out}")
    return 0
