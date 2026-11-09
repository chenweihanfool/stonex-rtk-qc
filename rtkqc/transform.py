"""已知加密點連測：e-GNSS 坐標 → 法定坐標的平面轉換（平移／4 參數／6 參數）與檢核。

全部是純函式，運算順序與 web/src/rtkqc-core.js 完全相同（逐項累加、同樣的高斯消去），
兩邊的結果才會逐位相同。

模型（n、e 為以共同點「觀測坐標重心」(cn, ce) 中心化後的坐標）：
  shift  : N' = N + tN                         E' = E + tE
  helmert: N' = cn + (a·n − b·e) + tN          E' = ce + (b·n + a·e) + tE
  affine : N' = cn + (a1·n + a2·e) + tN        E' = ce + (b1·n + b2·e) + tE
tN、tE 為重心處的平移量（法定 − 觀測），所以數值很小（公尺級以下）。
"""

import math

from .pdreader import InputError
from .rules import _mean, dist2d, sort_flags

METHODS = ("auto", "shift", "helmert", "affine", "none")
METHOD_LABEL = {
    "shift": "坐標分量平移",
    "helmert": "4 參數平面轉換",
    "affine": "6 參數平面轉換",
    "none": "不轉換",
}
MIN_POINTS = {"shift": 1, "helmert": 2, "affine": 3}
RAD_TO_SEC = 180.0 / math.pi * 3600.0


def solve_linear(m, v):
    """高斯消去（部分選主元）解 m·x = v。JS 端逐步相同。"""
    n = len(v)
    a = [list(m[i]) + [v[i]] for i in range(n)]
    for col in range(n):
        piv = col
        best = abs(a[col][col])
        for r in range(col + 1, n):
            if abs(a[r][col]) > best:
                best = abs(a[r][col])
                piv = r
        if best < 1e-9:
            raise InputError("共同點幾何不足（點位重合或共線），無法求解轉換參數")
        if piv != col:
            a[col], a[piv] = a[piv], a[col]
        for r in range(col + 1, n):
            f = a[r][col] / a[col][col]
            for c in range(col, n + 1):
                a[r][c] -= f * a[col][c]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        s = a[r][n]
        for c in range(r + 1, n):
            s -= a[r][c] * x[c]
        x[r] = s / a[r][r]
    return x


def choose_method(method, n_common):
    """auto：0 點不轉換、1 點平移、≥2 點 4 參數。明確指定但點數不足時報錯。"""
    if method not in METHODS:
        raise InputError(f"未知的轉換方法：{method}")
    if method == "auto":
        return "none" if n_common == 0 else ("shift" if n_common == 1 else "helmert")
    if method == "none":
        return "none"
    need = MIN_POINTS[method]
    if n_common < need:
        raise InputError(f"轉換方法 {method} 需要至少 {need} 個共同點，目前只有 {n_common} 個")
    return method


def fit_model(method, common):
    """common：[(n_obs, e_obs, n_known, e_known)]。回傳模型 dict。"""
    cn = _mean([c[0] for c in common])
    ce = _mean([c[1] for c in common])
    model = {"method": method, "cn": cn, "ce": ce}
    if method == "shift":
        model["tN"] = _mean([c[2] - c[0] for c in common])
        model["tE"] = _mean([c[3] - c[1] for c in common])
        return model
    if method == "helmert":
        m = [[0.0] * 4 for _ in range(4)]
        v = [0.0] * 4
        for no, eo, nk, ek in common:
            n = no - cn
            e = eo - ce
            for row, rhs in (([n, -e, 1.0, 0.0], nk - cn), ([e, n, 0.0, 1.0], ek - ce)):
                for r in range(4):
                    for c in range(4):
                        m[r][c] += row[r] * row[c]
                    v[r] += row[r] * rhs
        a, b, tn, te = solve_linear(m, v)
        model.update(a=a, b=b, tN=tn, tE=te)
        model["scale_ppm"] = (math.sqrt(a * a + b * b) - 1.0) * 1e6
        model["rotation_sec"] = math.atan2(b, a) * RAD_TO_SEC
        return model
    # affine：N、E 各一組 3 個未知數
    mn = [[0.0] * 3 for _ in range(3)]
    me = [[0.0] * 3 for _ in range(3)]
    vn = [0.0] * 3
    ve = [0.0] * 3
    for no, eo, nk, ek in common:
        row = [no - cn, eo - ce, 1.0]
        for r in range(3):
            for c in range(3):
                mn[r][c] += row[r] * row[c]
                me[r][c] += row[r] * row[c]
            vn[r] += row[r] * (nk - cn)
            ve[r] += row[r] * (ek - ce)
    a1, a2, tn = solve_linear(mn, vn)
    b1, b2, te = solve_linear(me, ve)
    model.update(a1=a1, a2=a2, b1=b1, b2=b2, tN=tn, tE=te)
    return model


def apply_model(m, n, e):
    if m["method"] == "shift":
        return n + m["tN"], e + m["tE"]
    nc = n - m["cn"]
    ec = e - m["ce"]
    if m["method"] == "helmert":
        return (m["cn"] + (m["a"] * nc - m["b"] * ec) + m["tN"],
                m["ce"] + (m["b"] * nc + m["a"] * ec) + m["tE"])
    return (m["cn"] + (m["a1"] * nc + m["a2"] * ec) + m["tN"],
            m["ce"] + (m["b1"] * nc + m["b2"] * ec) + m["tE"])


def _wrap_pi(d):
    if d > math.pi:
        d -= 2.0 * math.pi
    elif d < -math.pi:
        d += 2.0 * math.pi
    return d


def compute_transform(points, control, method, th):
    """以共同點（觀測點號 ∈ 加密點）算轉換與檢核。不轉換時回傳 None。

    回傳 dict：model、method、n_common、redundancy、dh、common、pairs、note、point_flags。
    """
    common_pts = [p for p in points if control is not None and p["id"] in control]
    method = choose_method(method, len(common_pts))
    if method == "none":
        return None
    n_c = len(common_pts)
    fit_in = []
    for p in common_pts:
        kn, ke, _ = control[p["id"]]
        fit_in.append((p["avg_n"], p["avg_e"], kn, ke))
    model = fit_model(method, fit_in)
    redundancy = 2 * n_c - {"shift": 2, "helmert": 4, "affine": 6}[method]

    dh_list = []
    for p in common_pts:
        kh = control[p["id"]][2]
        if kh is not None and p["avg_h"] is not None:
            dh_list.append(kh - p["avg_h"])
    dh = _mean(dh_list)

    point_flags = {}
    common = []
    for p in common_pts:
        kn, ke, kh = control[p["id"]]
        nt, et = apply_model(model, p["avg_n"], p["avg_e"])
        if p["avg_h"] is None:
            ht = None
        else:
            ht = p["avg_h"] + dh if dh is not None else p["avg_h"]
        vn = kn - nt
        ve = ke - et
        flags = []
        if abs(vn) >= th["transform_resid_max"] or abs(ve) >= th["transform_resid_max"]:
            flags.append("C1")
            point_flags.setdefault(p["id"], set()).add("C1")
        common.append({
            "id": p["id"], "n_obs": p["avg_n"], "e_obs": p["avg_e"], "h_obs": p["avg_h"],
            "n_known": kn, "e_known": ke, "h_known": kh,
            "n_t": nt, "e_t": et, "h_t": ht, "vn": vn, "ve": ve, "v2d": dist2d(vn, ve),
            "flags": flags,
        })

    pairs = []
    for i, a in enumerate(common):
        for b in common[i + 1:]:
            dkn = b["n_known"] - a["n_known"]
            dke = b["e_known"] - a["e_known"]
            dtn = b["n_t"] - a["n_t"]
            dte = b["e_t"] - a["e_t"]
            az_k = math.atan2(dke, dkn)
            az_t = math.atan2(dte, dtn)
            az_sec = abs(_wrap_pi(az_t - az_k) * RAD_TO_SEC)
            d_k = dist2d(dkn, dke)
            d_t = dist2d(dtn, dte)
            diff = abs(d_t - d_k)
            flags = []
            if az_sec >= th["azimuth_diff_max_sec"]:
                flags.append("C2")
            if d_k > 0 and diff * th["distance_ratio_min"] >= d_k:
                flags.append("C3")
            for f in flags:
                point_flags.setdefault(a["id"], set()).add(f)
                point_flags.setdefault(b["id"], set()).add(f)
            pairs.append({"i": a["id"], "j": b["id"], "az_diff_sec": az_sec,
                          "d_known": d_k, "d_t": d_t,
                          "ratio_den": (d_k / diff) if diff != 0 else None,
                          "flags": flags})

    notes = []
    if redundancy == 0:
        notes.append("無多餘觀測，殘差無檢核意義")
    if dh is None:
        notes.append("高程未轉換（加密點或觀測缺少高程）")
    return {"model": model, "method": method, "n_common": n_c, "redundancy": redundancy,
            "dh": dh, "common": common, "pairs": pairs, "note": "；".join(notes),
            "point_flags": point_flags}


def apply_to_points(points, tf):
    """替每個點位加上轉換後坐標 n_t/e_t/h_t，並把 C1～C3 掛到相關點位旗標。"""
    if tf is None:
        return
    model = tf["model"]
    for p in points:
        p["n_t"], p["e_t"] = apply_model(model, p["avg_n"], p["avg_e"])
        if p["avg_h"] is None:
            p["h_t"] = None
        else:
            p["h_t"] = p["avg_h"] + tf["dh"] if tf["dh"] is not None else p["avg_h"]
        extra = tf["point_flags"].get(p["id"])
        if extra:
            p["flags"] = sort_flags(set(p["flags"]) | extra)


def nearest_controls(observations, control, tf):
    """每筆觀測找最近的加密點（用轉換後坐標；無轉換用原坐標）。"""
    ids = sorted(control) if control else []
    model = tf["model"] if tf is not None else None
    for o in observations:
        o["nearest_control"] = None
        o["nearest_control_dist"] = None
        if not ids:
            continue
        if model is not None:
            n, e = apply_model(model, o["n"], o["e"])
        else:
            n, e = o["n"], o["e"]
        for cid in ids:
            kn, ke, _ = control[cid]
            d = dist2d(n - kn, e - ke)
            if o["nearest_control_dist"] is None or d < o["nearest_control_dist"]:
                o["nearest_control"] = cid
                o["nearest_control_dist"] = d


def control_days(observations, control):
    """每日連測檢查：回傳 (control_days, days_without_control)。沒給加密點時兩者皆空。"""
    if control is None:
        return [], []
    days = {}
    for o in observations:
        if not o["start"]:
            continue
        s = days.setdefault(o["start"][:10], set())
        if o["id"] in control:
            s.add(o["id"])
    keys = sorted(days)
    return ([{"date": d, "control_points": sorted(days[d])} for d in keys],
            [d for d in keys if not days[d]])
