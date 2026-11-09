"""命令列入口：python -m rtkqc <.PD ...> --out <資料夾> [--known 已知點.csv] [--config 門檻.json]"""

import argparse
import sys
from datetime import datetime
from pathlib import Path

from . import __version__
from .outputs import build_outputs
from .pdreader import InputError, read_pd
from .rules import build_points, load_known, load_thresholds, obs_flags


def build_parser():
    p = argparse.ArgumentParser(
        prog="rtkqc",
        description="Stonex Cube-a .PD（SQLite）VBS-RTK 觀測品管（唯讀）。",
    )
    p.add_argument("inputs", nargs="+", metavar="PD", help="一或多個 .PD 檔")
    p.add_argument("--out", required=True, help="輸出資料夾（不存在會建立）")
    p.add_argument("--known", help="已知點 CSV（點號,N,E[,H]）")
    p.add_argument("--config", help="門檻設定 JSON（覆蓋預設門檻）")
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

    for pd in pds:
        for w in pd.warnings:
            print(w, file=sys.stderr)

    observations = [o for pd in pds for o in pd.observations]
    for o in observations:
        o["obs_flags"] = obs_flags(o, th)
    observations.sort(key=lambda o: (o["id"], o["start"]))

    points = build_points(observations, th, known)
    run_time = datetime.now().astimezone().isoformat(timespec="seconds")
    known_name = Path(args.known).name if args.known else None
    files = build_outputs(observations, points, pds, th, raw_argv, run_time, known_name)

    out = Path(args.out)
    try:
        out.mkdir(parents=True, exist_ok=True)
        for name, data in files.items():
            (out / name).write_bytes(data)
    except OSError as e:
        print(f"錯誤：無法寫入輸出資料夾 {out}：{e}", file=sys.stderr)
        return 2

    print(f"完成：{len(observations)} 筆觀測、{len(points)} 個點位、"
          f"{sum(1 for p in points if p['flags'])} 點有旗標 → {out}")
    return 0
