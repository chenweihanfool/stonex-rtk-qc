"""品管門檻、旗標判定、點位平均與隔天重測清單。"""

import csv
import json
import math
from datetime import datetime
from decimal import ROUND_HALF_UP, Context, Decimal
from pathlib import Path

from .pdreader import InputError
from .tm2 import lonlat_to_tm2

DEFAULT_THRESHOLDS = {
    "same_base_tol_m": 0.01,
    "hrms_max": 0.02,
    "vrms_max": 0.05,
    "pdop_max": 10.0,
    "diff_2d_max": 0.02,
    "tilt_offset_max": 0.01,
    "min_interval_min": 0.0,  # 0 = 不檢查
    "known_tol_2d": 0.02,
    "neighbor_max_m": 100.0,  # 相鄰點位檢核：兩兩 2D 距離上限
    "min_fixed_epochs": 0.0,  # 每筆觀測至少幾筆 FIXED epoch（0 = 不檢查；圖根模式預設 180）
    "transform_resid_max": 0.098,  # 共同點轉換後坐標分量改正數上限（m）
    "azimuth_diff_max_sec": 20.0,  # 共同點間方位角較差上限（秒）
    "distance_ratio_min": 20000.0,  # 共同點間水平距相對較差比值分母下限
}

# 作業模式覆蓋的預設門檻（--config 仍可再覆蓋）
MODES = ("survey", "control")
MODE_DEFAULTS = {
    "survey": {},
    "control": {"min_fixed_epochs": 180.0, "min_interval_min": 60.0},
}

FLAG_ORDER = ["X1", "X2", "X3", "X4", "X5", "X6", "F1", "T1", "E1", "D1", "K1",
              "C1", "C2", "C3"]

FLAG_DESC = {
    "X1": "兩次觀測採相同主站",
    "X2": "固定解平面誤差未小於 2cm",
    "X3": "固定解高程誤差未小於 5cm",
    "X4": "PDOP 未小於 10",
    "X5": "兩次較差未小於 2cm",
    "X6": "僅有一個觀測值",
    "F1": "有非固定解（Pos_State 非 FIXED）的 epoch",
    "T1": "天線傾斜偏移量達門檻",
    "E1": "固定解筆數不足",
    "D1": "兩次觀測時間間隔不足",
    "K1": "與已知坐標差距超限",
    "C1": "共同點轉換後坐標分量改正數超限",
    "C2": "共同點間方位角較差超限",
    "C3": "共同點間水平距相對較差超限",
}

ACTIONS = {
    "X1": "斷開重連 NTRIP 後再測一次",
    "X2": "等衛星條件改善後重測",
    "X3": "等衛星條件改善後重測",
    "X4": "等衛星條件改善後重測",
    "X5": "再測一次",
    "X6": "補測第二次（建議重連 NTRIP）",
    "F1": "等衛星條件改善後重測",
    "T1": "重新整平對中後重測",
    "E1": "固定解筆數不足，重測並收足筆數",
    "D1": "間隔不足，隔段時間再測",
    "K1": "檢查系統偏移與天線高，重測已知點",
    "C1": "檢查該加密點觀測與已知坐標，必要時重測",
    "C2": "檢查相關加密點觀測，必要時重測",
    "C3": "檢查相關加密點觀測，必要時重測",
}

EARTH_R = 6378137.0


def load_thresholds(path, mode="survey"):
    if mode not in MODES:
        raise InputError(f"未知的作業模式：{mode}")
    th = dict(DEFAULT_THRESHOLDS)
    th.update(MODE_DEFAULTS[mode])
    if path is None:
        return th
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except OSError as e:
        raise InputError(f"無法讀取門檻設定：{path}（{e}）") from e
    except json.JSONDecodeError as e:
        raise InputError(f"門檻設定不是合法 JSON：{path}（{e}）") from e
    if not isinstance(data, dict):
        raise InputError("門檻設定最外層必須是 JSON 物件")
    for key, val in data.items():
        if key not in DEFAULT_THRESHOLDS:
            raise InputError(f"門檻設定未知欄位：{key}")
        if isinstance(val, bool) or not isinstance(val, (int, float)):
            raise InputError(f"門檻 {key} 必須是數字")
        th[key] = float(val)
    return th


def load_known(path):
    """讀取已知點 CSV（點號,N,E[,H]），有無表頭都可。回傳 {點號: (N, E, H或None)}。"""
    p = Path(path)
    try:
        text = p.read_text(encoding="utf-8-sig")
    except OSError as e:
        raise InputError(f"無法讀取已知點檔：{path}（{e}）") from e
    except UnicodeDecodeError as e:
        raise InputError(f"已知點檔需為 UTF-8 編碼：{path}") from e

    rows = [r for r in csv.reader(text.splitlines()) if any(c.strip() for c in r)]
    if not rows:
        return {}

    idx = {"id": 0, "n": 1, "e": 2, "h": 3}
    header = [c.strip() for c in rows[0]]
    if any(c in ("點號", "N", "E", "H") for c in header):
        rows = rows[1:]
        names = {"id": "點號", "n": "N", "e": "E", "h": "H"}
        for key, label in names.items():
            if label in header:
                idx[key] = header.index(label)

    known = {}
    for lineno, r in enumerate(rows, start=1):
        try:
            pid = r[idx["id"]].strip()
            n = float(r[idx["n"]])
            e = float(r[idx["e"]])
        except (IndexError, ValueError) as ex:
            raise InputError(f"已知點檔第 {lineno} 列格式錯誤：{path}") from ex
        h = None
        if len(r) > idx["h"] and r[idx["h"]].strip():
            try:
                h = float(r[idx["h"]])
            except ValueError as ex:
                raise InputError(f"已知點檔第 {lineno} 列 H 非數字：{path}") from ex
        known[pid] = (n, e, h)
    return known


_DEC_CTX = Context(prec=60)


def round_half_up(v, nd):
    """四捨五入到 nd 位（半數遠離零）。先取 15 位有效數字消除二進位浮點誤差，JS 端同規則。

    回傳 Decimal（None 則回傳 None）；負零一律轉成 0。
    """
    if v is None:
        return None
    d = Decimal(format(float(v), ".15g"))
    q = d.quantize(Decimal(1).scaleb(-nd), rounding=ROUND_HALF_UP, context=_DEC_CTX)
    return abs(q) if q.is_zero() else q


def rnd(v, nd):
    """round_half_up 後轉 float（供 JSON 使用）。"""
    q = round_half_up(v, nd)
    return None if q is None else float(q)


def fmt(v, nd):
    q = round_half_up(v, nd)
    return "" if q is None else format(q, "f")


def plane_dist(lat1, lon1, lat2, lon2):
    """近似平面距離（m），用於同主站判斷。"""
    lat0 = math.radians((lat1 + lat2) / 2)
    dy = math.radians(lat2 - lat1) * EARTH_R
    dx = math.radians(lon2 - lon1) * EARTH_R * math.cos(lat0)
    return math.sqrt(dx * dx + dy * dy)


def same_base(a, b, th):
    if a["base_id"] != b["base_id"]:
        return False
    if None in (a["base_lat"], a["base_lon"], b["base_lat"], b["base_lon"]):
        return False
    d = plane_dist(a["base_lat"], a["base_lon"], b["base_lat"], b["base_lon"])
    return d < th["same_base_tol_m"]


def dist2d(dn, de):
    # 不用 math.hypot：sqrt 為 IEEE 正確捨入，JS 端結果逐位相同
    return math.sqrt(dn * dn + de * de)


def pair_2d(a, b):
    return dist2d(a["n"] - b["n"], a["e"] - b["e"])


def pair_dh(a, b):
    if a["h"] is None or b["h"] is None:
        return None
    return abs(a["h"] - b["h"])


def _parse_time(s):
    try:
        return datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError):
        return None


def obs_flags(o, th):
    """每筆觀測的旗標（F1、T1）。"""
    flags = []
    if o["epoch_n"] > o["fixed_n"]:
        flags.append("F1")
    if o["tilt_off"] is not None and o["tilt_off"] >= th["tilt_offset_max"]:
        flags.append("T1")
    if th["min_fixed_epochs"] > 0 and o["fixed_n"] < th["min_fixed_epochs"]:
        flags.append("E1")
    return [f for f in FLAG_ORDER if f in flags]


def row_flags(o, th):
    """每筆觀測自己的旗標（X2、X3、X4、F1、T1），依 FLAG_ORDER 排序。obs_flags 需已算好。"""
    flags = []
    if o["hrms"] is not None and o["hrms"] >= th["hrms_max"]:
        flags.append("X2")
    if o["vrms"] is not None and o["vrms"] >= th["vrms_max"]:
        flags.append("X3")
    if o["pdop"] is not None and o["pdop"] >= th["pdop_max"]:
        flags.append("X4")
    flags.extend(f for f in o["obs_flags"])
    return [f for f in FLAG_ORDER if f in flags]


def _maxnone(vals):
    vals = [v for v in vals if v is not None]
    return max(vals) if vals else None


def _mean(vals):
    vals = [v for v in vals if v is not None]
    if not vals:
        return None
    total = 0.0  # 逐項相加（不用 sum()，Python 3.12 起 sum 會做補償加總，與 JS 不同）
    for v in vals:
        total += v
    return total / len(vals)


def summarize_point(pid, obs, th):
    """依點號彙整一組觀測，判定點位旗標（K1、C1～C3 由 apply_known／transform 之後補上）。"""
    obs = sorted(obs, key=lambda o: o["start"])
    n = len(obs)
    pairs = [(a, b) for i, a in enumerate(obs) for b in obs[i + 1:]]

    d2 = _maxnone([pair_2d(a, b) for a, b in pairs])
    dh = _maxnone([pair_dh(a, b) for a, b in pairs])

    starts = [t for t in (_parse_time(o["start"]) for o in obs) if t is not None]
    interval = None
    if n >= 2 and len(starts) >= 2:
        interval = (max(starts) - min(starts)).total_seconds() / 60.0

    starts_s = [o["start"] for o in obs if o["start"]]
    ends_s = [o["end"] for o in obs if o["end"]]

    flags = []
    if n >= 2 and all(same_base(a, b, th) for a, b in pairs):
        flags.append("X1")
    if any(o["hrms"] is not None and o["hrms"] >= th["hrms_max"] for o in obs):
        flags.append("X2")
    if any(o["vrms"] is not None and o["vrms"] >= th["vrms_max"] for o in obs):
        flags.append("X3")
    if any(o["pdop"] is not None and o["pdop"] >= th["pdop_max"] for o in obs):
        flags.append("X4")
    if d2 is not None and d2 >= th["diff_2d_max"]:
        flags.append("X5")
    if n == 1:
        flags.append("X6")
    if any("F1" in o["obs_flags"] for o in obs):
        flags.append("F1")
    if any("T1" in o["obs_flags"] for o in obs):
        flags.append("T1")
    if any("E1" in o["obs_flags"] for o in obs):
        flags.append("E1")
    if (n >= 2 and th["min_interval_min"] > 0 and interval is not None
            and interval < th["min_interval_min"]):
        flags.append("D1")

    avg_n = _mean([o["n"] for o in obs])
    avg_e = _mean([o["e"] for o in obs])
    avg_h = _mean([o["h"] for o in obs])

    return {
        "id": pid,
        "obs": obs,
        "n": n,
        "avg_n": avg_n,
        "avg_e": avg_e,
        "avg_h": avg_h,
        "d2": d2,
        "dh": dh,
        "first_start": min(starts_s) if starts_s else "",
        "last_end": max(ends_s) if ends_s else "",
        "interval": interval,
        "flags": flags,
        "known": None,
        "n_t": None,
        "e_t": None,
        "h_t": None,
    }


def build_points(observations, th):
    groups = {}
    for o in observations:
        groups.setdefault(o["id"], []).append(o)
    return [summarize_point(pid, groups[pid], th) for pid in sorted(groups)]


def point_coord(p):
    """點位使用的坐標：有轉換用轉換後 (n_t, e_t, h_t)，否則用平均坐標。"""
    if p.get("n_t") is not None:
        return p["n_t"], p["e_t"], p["h_t"]
    return p["avg_n"], p["avg_e"], p["avg_h"]


def sort_flags(flags):
    return [f for f in FLAG_ORDER if f in flags]


def apply_known(points, th, known_map):
    """與已知點（--known）比對：用點位使用的坐標（有轉換用轉換後），超限加 K1。"""
    if known_map is None:
        return
    for p in points:
        known = known_map.get(p["id"])
        if known is None:
            continue
        kn, ke, kh = known
        cn, ce, ch = point_coord(p)
        dn = cn - kn
        de = ce - ke
        d2k = dist2d(dn, de)
        dh_k = None if (ch is None or kh is None) else ch - kh
        over = d2k >= th["known_tol_2d"]
        p["known"] = {"dn": dn, "de": de, "d2": d2k, "dh": dh_k, "over": over}
        if over:
            p["flags"] = sort_flags(p["flags"] + ["K1"])


def remeasure_rows(points):
    rows = []
    for p in points:
        if not p["flags"]:
            continue
        actions = []
        for f in FLAG_ORDER:
            if f in p["flags"] and ACTIONS[f] not in actions:
                actions.append(ACTIONS[f])
        rows.append([p["id"], ";".join(p["flags"]), "；".join(actions),
                     fmt(p["avg_n"], 3), fmt(p["avg_e"], 3)])
    return rows


def assign_bases(observations, th):
    """把每筆觀測歸到主站，替每筆加上 base_label，回傳主站清單。

    主站＝Base_ID 相同且基站位置差 < same_base_tol_m。主站點名＝Base_ID，
    同 ID 不同位置依出現順序（開始時間，同時間依輸入順序）加 (2)、(3)…。
    """
    bases = []
    for o in sorted(observations, key=lambda x: x["start"]):  # 穩定排序
        found = None
        for b in bases:
            if b["base_id"] != o["base_id"]:
                continue
            if b["lat"] is None and o["base_lat"] is None and b["lon"] is None                     and o["base_lon"] is None:
                found = b
                break
            if None in (b["lat"], b["lon"], o["base_lat"], o["base_lon"]):
                continue
            if plane_dist(b["lat"], b["lon"], o["base_lat"], o["base_lon"])                     < th["same_base_tol_m"]:
                found = b
                break
        if found is None:
            same_id = sum(1 for b in bases if b["base_id"] == o["base_id"])
            label = o["base_id"] or ""
            if same_id:
                label = f"{label}({same_id + 1})"
            n = e = None
            if o["base_lat"] is not None and o["base_lon"] is not None:
                n, e = lonlat_to_tm2(o["base_lat"], o["base_lon"])
            found = {"label": label, "base_id": o["base_id"], "lat": o["base_lat"],
                     "lon": o["base_lon"], "alt": o.get("base_alt"), "n": n, "e": e,
                     "h": o.get("base_alt"), "grid_shift_n": None, "grid_shift_e": None,
                     "undulation": None, "grid_corrected": False, "count": 0}
            bases.append(found)
        found["count"] += 1
        o["base_label"] = found["label"]
    correct_bases(observations, bases)
    return bases


def correct_bases(observations, bases):
    """用同主站觀測點的控制器網格坐標修正主站坐標的框架差。

    .PD 的經緯度是網路 RTCM 轉換前的框架，North/East/Height 是轉換後的 TWD97 網格。
    shift = 平均(控制器 N/E − TM2(觀測點經緯度))；undulation = 平均(Altitude − Height)。
    主站網格坐標 = TM2(基站經緯度) + shift；h = Base_Altitude − undulation。
    缺欄位或沒有觀測時保留未修正值，grid_corrected = False。
    """
    for b in bases:
        dn, de, du = [], [], []
        for o in observations:
            if o["base_label"] != b["label"]:
                continue
            if o.get("lat") is not None and o.get("lon") is not None:
                tn, te = lonlat_to_tm2(o["lat"], o["lon"])
                dn.append(o["n"] - tn)
                de.append(o["e"] - te)
            if o.get("alt") is not None and o["h"] is not None:
                du.append(o["alt"] - o["h"])
        if not dn or b["n"] is None:
            continue
        b["grid_shift_n"] = _mean(dn)
        b["grid_shift_e"] = _mean(de)
        b["n"] += b["grid_shift_n"]
        b["e"] += b["grid_shift_e"]
        b["grid_corrected"] = True
        if du and b["alt"] is not None:
            b["undulation"] = _mean(du)
            b["h"] = b["alt"] - b["undulation"]


def find_neighbors(points, th):
    """點位平均坐標兩兩 2D 距離 <= neighbor_max_m 的點對（依點位排序，i<j）。"""
    out = []
    for i, a in enumerate(points):
        for b in points[i + 1:]:
            d = dist2d(a["avg_n"] - b["avg_n"], a["avg_e"] - b["avg_e"])
            if d <= th["neighbor_max_m"]:
                out.append({"id": a["id"], "other": b["id"], "dist": d})
    return out
