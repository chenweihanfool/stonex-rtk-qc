"""輸出檔產生：observations.csv、points.csv、remeasure.csv、known_check.csv、handbook.html、manifest.json。

所有內容先在記憶體中組好（bytes），最後才一次寫入，避免留下半套輸出。
"""

import csv
import html
import io
import json

from . import __version__
from .rules import (ACTIONS, FLAG_DESC, FLAG_ORDER, find_neighbors, fmt, pair_2d,
                    point_coord, remeasure_rows, rnd)
from .transform import METHOD_LABEL

MODE_LABEL = {"survey": "現況／界址（survey）", "control": "圖根（control）"}

OBS_HEADER = [
    "來源檔名", "點號", "NAME", "CODE", "N", "E", "H", "開始時間", "結束時間",
    "epoch數", "FIXED epoch數", "HRMS", "VRMS", "PDOP", "衛星數",
    "epoch最大HRMS", "epoch最大VRMS", "epoch最大PDOP", "epoch最小衛星數",
    "epoch最大延遲", "Base_ID", "基站緯度", "基站經度", "主站距離", "天線高",
    "Pitch", "Roll", "傾斜偏移量", "該筆旗標",
]

POINT_HEADER = [
    "點號", "觀測數", "平均N", "平均E", "平均H", "兩次較差2D(m)", "高程較差(m)",
    "最早觀測時間", "最晚觀測時間", "兩次觀測時間間隔(分鐘)", "旗標",
]

OBS_CONTROL_HEADER = ["最近已知加密點", "距最近加密點(m)"]
POINT_TRANSFORM_HEADER = ["轉換後N", "轉換後E", "轉換後H"]
TRANSFORM_HEADER = [
    "點號", "觀測N", "觀測E", "觀測H", "已知N", "已知E", "已知H", "轉換後N", "轉換後E",
    "轉換後H", "vN", "vE", "v2D", "旗標",
]
PAIRS_HEADER = ["點號i", "點號j", "方位角較差(秒)", "已知距離(m)", "轉換後距離(m)",
                "相對較差比值分母", "旗標"]

REMEASURE_HEADER = ["點號", "旗標", "建議動作", "平均N", "平均E"]

KNOWN_HEADER = ["點號", "dN", "dE", "d2D", "dH", "是否超限"]


def _csv_bytes(header, rows):
    buf = io.StringIO(newline="")
    w = csv.writer(buf)
    w.writerow(header)
    w.writerows(rows)
    return buf.getvalue().encode("utf-8-sig")


def observation_rows(observations, control_given=False):
    rows = []
    for o in observations:
        row = [
            o["source"], o["id"], o["name"], o["code"],
            fmt(o["n"], 3), fmt(o["e"], 3), fmt(o["h"], 3),
            o["start"], o["end"], o["epoch_n"], o["fixed_n"],
            fmt(o["hrms"], 4), fmt(o["vrms"], 4), fmt(o["pdop"], 4),
            "" if o["sat"] is None else o["sat"],
            fmt(o["ep_hrms_max"], 4), fmt(o["ep_vrms_max"], 4),
            fmt(o["ep_pdop_max"], 4),
            "" if o["ep_sat_min"] is None else o["ep_sat_min"],
            fmt(o["ep_delay_max"], 4),
            o["base_id"] or "", fmt(o["base_lat"], 8), fmt(o["base_lon"], 8),
            fmt(o["dist_base"], 3), fmt(o["ant_h"], 3),
            fmt(o["pitch"], 2), fmt(o["roll"], 2), fmt(o["tilt_off"], 4),
            ";".join(o["obs_flags"]),
        ]
        if control_given:
            row.extend([o["nearest_control"] or "", fmt(o["nearest_control_dist"], 3)])
        rows.append(row)
    return rows


def point_rows(points, with_transform=False):
    rows = []
    for p in points:
        row = [
            p["id"], p["n"], fmt(p["avg_n"], 3), fmt(p["avg_e"], 3),
            fmt(p["avg_h"], 3), fmt(p["d2"], 4), fmt(p["dh"], 4),
            p["first_start"], p["last_end"], fmt(p["interval"], 2),
            ";".join(p["flags"]),
        ]
        if with_transform:
            row.extend([fmt(p["n_t"], 3), fmt(p["e_t"], 3), fmt(p["h_t"], 3)])
        rows.append(row)
    return rows


def transform_rows(tf):
    return [[c["id"], fmt(c["n_obs"], 3), fmt(c["e_obs"], 3), fmt(c["h_obs"], 3),
             fmt(c["n_known"], 3), fmt(c["e_known"], 3), fmt(c["h_known"], 3),
             fmt(c["n_t"], 3), fmt(c["e_t"], 3), fmt(c["h_t"], 3),
             fmt(c["vn"], 4), fmt(c["ve"], 4), fmt(c["v2d"], 4), ";".join(c["flags"])]
            for c in tf["common"]]


def pair_rows(tf):
    return [[x["i"], x["j"], fmt(x["az_diff_sec"], 2), fmt(x["d_known"], 3), fmt(x["d_t"], 3),
             fmt(x["ratio_den"], 0), ";".join(x["flags"])]
            for x in tf["pairs"]]


def known_rows(points):
    rows = []
    for p in points:
        k = p["known"]
        if k is None:
            continue
        rows.append([
            p["id"], fmt(k["dn"], 4), fmt(k["de"], 4), fmt(k["d2"], 4),
            fmt(k["dh"], 4), "是" if k["over"] else "否",
        ])
    return rows


def _esc(v):
    return html.escape("" if v is None else str(v), quote=True)


def handbook_html(observations, points, pds, th, mode="survey", tf=None):
    dates = sorted({o["start"][:10] for o in observations if o["start"]})
    date_text = "、".join(dates) if dates else "未知"
    if dates and len(dates) > 1:
        date_text = f"{dates[0]} ～ {dates[-1]}（{len(dates)} 天）"
    ant_set = sorted({(s, t) for pd in pds for s, t in pd.antennas})
    antennas = "、".join(f"{t} {s}" for s, t in ant_set) or "未知"
    inputs = "".join(
        f"<li>{_esc(pd.name)}（sha256 {_esc(pd.sha256[:12])}）</li>" for pd in pds
    )

    body = []
    for p in points:
        note = ";".join(p["flags"])
        first = p["obs"][0]
        for k, o in enumerate(p["obs"]):
            diff = "" if k == 0 else fmt(pair_2d(first, o), 4)
            body.append(
                "<tr>"
                f"<td>{_esc(o['base_id'] or '')}</td>"
                f"<td>{_esc(p['id'])}</td>"
                f"<td class=\"num\">{_esc(fmt(o['n'], 3))}</td>"
                f"<td class=\"num\">{_esc(fmt(o['e'], 3))}</td>"
                f"<td class=\"num\">{_esc(fmt(o['h'], 3))}</td>"
                f"<td class=\"num\">{_esc(fmt(o['hrms'], 4))}</td>"
                f"<td class=\"num\">{_esc(fmt(o['vrms'], 4))}</td>"
                f"<td class=\"num\">{_esc(fmt(o['pdop'], 2))}</td>"
                f"<td class=\"num\">{_esc(diff)}</td>"
                f"<td class=\"num\">{_esc(fmt(o['dist_base'], 1))}</td>"
                f"<td>{_esc(o['start'])}</td>"
                f"<td class=\"num\">{_esc(o['epoch_n'])}</td>"
                f"<td>{_esc(note)}</td>"
                "</tr>"
            )

    flag_items = "".join(
        f"<li><b>{_esc(f)}</b> {_esc(FLAG_DESC[f])}</li>" for f in FLAG_ORDER
    )
    rows_html = "\n".join(body) if body else '<tr><td colspan="13">無觀測資料</td></tr>'

    return f"""<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<title>RTK 觀測手簿</title>
<style>
@page {{ size: A4 landscape; margin: 12mm; }}
body {{ font-family: "Microsoft JhengHei", "PingFang TC", sans-serif; color: #111; font-size: 11px; }}
h1 {{ font-size: 18px; margin: 0 0 6px; }}
.meta {{ margin-bottom: 8px; line-height: 1.6; }}
.meta ul {{ margin: 2px 0 0 18px; padding: 0; }}
table {{ border-collapse: collapse; width: 100%; }}
th, td {{ border: 1px solid #555; padding: 3px 4px; }}
th {{ background: #e8e8e8; }}
td.num {{ text-align: right; font-variant-numeric: tabular-nums; }}
.foot {{ margin-top: 8px; line-height: 1.6; }}
.foot ul {{ margin: 2px 0 0 18px; padding: 0; columns: 2; }}
@media print {{ thead {{ display: table-header-group; }} tr {{ page-break-inside: avoid; }} }}
</style>
</head>
<body>
<h1>RTK 觀測手簿（VBS-RTK）</h1>
<div class="meta">
<div>接收儀型號與序號：{_esc(antennas)}</div>
<div>觀測日期（來源資料）：{_esc(date_text)}</div>
<div>輸入檔名與 sha256 前 12 碼：<ul>{inputs}</ul></div>
<div>工具版本：rtkqc {_esc(__version__)}　門檻：平面 HRMS {_esc(th['hrms_max'])} m／高程 VRMS {_esc(th['vrms_max'])} m／PDOP {_esc(th['pdop_max'])}／兩次較差 {_esc(th['diff_2d_max'])} m</div>
<div>作業模式：{_esc(MODE_LABEL[mode])}　坐標轉換：{_esc(METHOD_LABEL[tf['method']] if tf else METHOD_LABEL['none'])}</div>
</div>
<table>
<thead>
<tr>
<th>主站點名</th><th>測站點名</th><th>縱坐標 N</th><th>橫坐標 E</th><th>高程 H</th>
<th>平面誤差 HRMS</th><th>高程誤差 VRMS</th><th>PDOP</th><th>兩次較差(m)</th>
<th>主站距離(m)</th><th>開始時間</th><th>epoch數</th><th>備註</th>
</tr>
</thead>
<tbody>
{rows_html}
</tbody>
</table>
<div class="foot">旗標說明：<ul>{flag_items}</ul></div>
</body>
</html>
"""


def manifest_dict(args_argv, run_time, th, pds, observations, points, known_name, cx):
    flag_stats = {f: 0 for f in FLAG_ORDER}
    for p in points:
        for f in p["flags"]:
            flag_stats[f] += 1
    return {
        "tool": "rtkqc",
        "version": __version__,
        "run_time": run_time,
        "argv": args_argv,
        "thresholds": th,
        "known_file": known_name,
        "mode": cx["mode"],
        "control_file": cx["control_name"],
        "transform": (None if cx["tf"] is None else {
            "method": cx["tf"]["method"], "n_common": cx["tf"]["n_common"],
            "redundancy": cx["tf"]["redundancy"],
        }),
        "days_without_control": list(cx["days_without_control"]),
        "inputs": [
            {
                "name": pd.name,
                "size": pd.size,
                "sha256": pd.sha256,
                "observations": sum(1 for o in observations if o["source"] == pd.name),
                "deleted_points": pd.deleted_count,
            }
            for pd in pds
        ],
        "observation_count": len(observations),
        "point_count": len(points),
        "flag_stats": flag_stats,
        "points_with_flags": sum(1 for p in points if p["flags"]),
    }


def build_outputs(observations, points, pds, th, argv, run_time, known_name, cx):
    """回傳 {檔名: bytes}，全部組好後才寫入。

    cx：作業模式與連測資訊 {mode, control_name, tf, control_days, days_without_control}。
    """
    tf = cx["tf"]
    control_given = cx["control_name"] is not None
    obs_header = OBS_HEADER + (OBS_CONTROL_HEADER if control_given else [])
    point_header = POINT_HEADER + (POINT_TRANSFORM_HEADER if tf else [])
    files = {
        "observations.csv": _csv_bytes(obs_header, observation_rows(observations, control_given)),
        "points.csv": _csv_bytes(point_header, point_rows(points, tf is not None)),
        "remeasure.csv": _csv_bytes(REMEASURE_HEADER, remeasure_rows(points)),
        "handbook.html": handbook_html(observations, points, pds, th, cx["mode"],
                                       tf).encode("utf-8"),
    }
    if known_name is not None:
        files["known_check.csv"] = _csv_bytes(KNOWN_HEADER, known_rows(points))
    if tf is not None:
        files["transform.csv"] = _csv_bytes(TRANSFORM_HEADER, transform_rows(tf))
        files["transform_pairs.csv"] = _csv_bytes(PAIRS_HEADER, pair_rows(tf))
    manifest = manifest_dict(argv, run_time, th, pds, observations, points, known_name, cx)
    files["manifest.json"] = (
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    ).encode("utf-8")
    return files


def ctl_text(points):
    """CTL：每點一行，點名右靠 8 字元＋空白＋縱坐標＋空白＋橫坐標（0.000），CRLF。"""
    lines = []
    for p in points:
        n, e, _ = point_coord(p)
        lines.append(f"{p['id'].rjust(8)} {fmt(n, 3)} {fmt(e, 3)}\r\n")
    return "".join(lines)


def transform_dict(tf):
    """轉換結果的正規 JSON 片段（無轉換為 None）。"""
    if tf is None:
        return None
    m = tf["model"]
    params = {"tN": rnd(m["tN"], 4), "tE": rnd(m["tE"], 4)}
    if m["method"] == "helmert":
        params.update({"a": rnd(m["a"], 12), "b": rnd(m["b"], 12),
                       "scale_ppm": rnd(m["scale_ppm"], 3),
                       "rotation_sec": rnd(m["rotation_sec"], 3)})
    elif m["method"] == "affine":
        params.update({"a1": rnd(m["a1"], 12), "a2": rnd(m["a2"], 12),
                       "b1": rnd(m["b1"], 12), "b2": rnd(m["b2"], 12)})
    common = [{
        "id": c["id"],
        "n_obs": rnd(c["n_obs"], 3), "e_obs": rnd(c["e_obs"], 3), "h_obs": rnd(c["h_obs"], 3),
        "n_known": rnd(c["n_known"], 3), "e_known": rnd(c["e_known"], 3),
        "h_known": rnd(c["h_known"], 3),
        "n_t": rnd(c["n_t"], 3), "e_t": rnd(c["e_t"], 3), "h_t": rnd(c["h_t"], 3),
        "vn": rnd(c["vn"], 4), "ve": rnd(c["ve"], 4), "v2d": rnd(c["v2d"], 4),
        "flags": list(c["flags"]),
    } for c in tf["common"]]
    pairs = [{
        "i": x["i"], "j": x["j"], "az_diff_sec": rnd(x["az_diff_sec"], 2),
        "d_known": rnd(x["d_known"], 3), "d_t": rnd(x["d_t"], 3),
        "ratio_den": rnd(x["ratio_den"], 0), "flags": list(x["flags"]),
    } for x in tf["pairs"]]
    return {
        "method": tf["method"], "n_common": tf["n_common"], "redundancy": tf["redundancy"],
        "params": params, "centroid": {"n": rnd(m["cn"], 3), "e": rnd(m["ce"], 3)},
        "dh": rnd(tf["dh"], 4), "common": common, "pairs": pairs, "note": tf["note"],
    }


def result_dict(observations, points, bases, pds, th, known_given, cx):
    """判定結果正規 JSON（JS 與 Python 對拍的契約，欄位見 README）。

    浮點數先依欄位四捨五入（半數遠離零）。旗標一律用未四捨五入的值判定。
    """
    obs = []
    for o in observations:
        obs.append({
            "source": o["source"], "id": o["id"], "name": o["name"], "code": o["code"],
            "n": rnd(o["n"], 3), "e": rnd(o["e"], 3), "h": rnd(o["h"], 3),
            "start": o["start"], "end": o["end"],
            "epoch_n": o["epoch_n"], "fixed_n": o["fixed_n"],
            "hrms": rnd(o["hrms"], 4), "vrms": rnd(o["vrms"], 4),
            "pdop": rnd(o["pdop"], 4), "sat": o["sat"],
            "ep_hrms_max": rnd(o["ep_hrms_max"], 4),
            "ep_vrms_max": rnd(o["ep_vrms_max"], 4),
            "ep_pdop_max": rnd(o["ep_pdop_max"], 4),
            "ep_sat_min": o["ep_sat_min"],
            "ep_delay_max": rnd(o["ep_delay_max"], 4),
            "base_id": o["base_id"], "base_label": o["base_label"],
            "base_lat": rnd(o["base_lat"], 8), "base_lon": rnd(o["base_lon"], 8),
            "base_alt": rnd(o["base_alt"], 3),
            "dist_base": rnd(o["dist_base"], 3), "ant_h": rnd(o["ant_h"], 3),
            "pitch": rnd(o["pitch"], 2), "roll": rnd(o["roll"], 2),
            "tilt_off": rnd(o["tilt_off"], 4),
            "flags": list(o["obs_flags"]), "row_flags": list(o["row_flags"]),
            "nearest_control": o["nearest_control"],
            "nearest_control_dist": rnd(o["nearest_control_dist"], 3),
        })
    pts = []
    for p in points:
        pts.append({
            "id": p["id"], "count": p["n"],
            "avg_n": rnd(p["avg_n"], 3), "avg_e": rnd(p["avg_e"], 3),
            "avg_h": rnd(p["avg_h"], 3),
            "d2": rnd(p["d2"], 4), "dh": rnd(p["dh"], 4),
            "first_start": p["first_start"], "last_end": p["last_end"],
            "interval_min": rnd(p["interval"], 2), "flags": list(p["flags"]),
            "n_t": rnd(p["n_t"], 3), "e_t": rnd(p["e_t"], 3), "h_t": rnd(p["h_t"], 3),
        })
    base_list = [{
        "label": b["label"], "base_id": b["base_id"],
        "lat": rnd(b["lat"], 8), "lon": rnd(b["lon"], 8), "alt": rnd(b["alt"], 3),
        "n": rnd(b["n"], 3), "e": rnd(b["e"], 3), "h": rnd(b["h"], 3),
        "grid_shift_n": rnd(b["grid_shift_n"], 4), "grid_shift_e": rnd(b["grid_shift_e"], 4),
        "undulation": rnd(b["undulation"], 3), "grid_corrected": bool(b["grid_corrected"]),
        "count": b["count"],
    } for b in bases]
    neighbors = [{"id": x["id"], "other": x["other"], "dist": rnd(x["dist"], 3)}
                 for x in find_neighbors(points, th)]
    remeasure = []
    for p in points:
        if not p["flags"]:
            continue
        actions = []
        for f in FLAG_ORDER:
            if f in p["flags"] and ACTIONS[f] not in actions:
                actions.append(ACTIONS[f])
        remeasure.append({"id": p["id"], "flags": list(p["flags"]), "actions": actions,
                          "avg_n": rnd(p["avg_n"], 3), "avg_e": rnd(p["avg_e"], 3)})
    known = []
    for p in points:
        k = p["known"]
        if k is None:
            continue
        known.append({"id": p["id"], "dn": rnd(k["dn"], 4), "de": rnd(k["de"], 4),
                      "d2": rnd(k["d2"], 4), "dh": rnd(k["dh"], 4), "over": bool(k["over"])})
    return {
        "version": __version__,
        "thresholds": dict(th),
        "inputs": [{"name": pd.name, "sha256": pd.sha256,
                    "observations": sum(1 for o in observations if o["source"] == pd.name)}
                   for pd in pds],
        "observations": obs,
        "points": pts,
        "bases": base_list,
        "neighbors": neighbors,
        "remeasure": remeasure,
        "known_check": known,
        "mode": cx["mode"],
        "transform": transform_dict(cx["tf"]),
        "control_days": [{"date": d["date"], "control_points": list(d["control_points"])}
                         for d in cx["control_days"]],
        "days_without_control": list(cx["days_without_control"]),
    }
