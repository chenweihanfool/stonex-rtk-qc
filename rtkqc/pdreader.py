"""唯讀讀取 Stonex Cube-a 的 .PD（SQLite）。

檔案一律以 mode=ro&immutable=1 開啟，不寫入、不建立暫存檔。
"""

import hashlib
import math
import re
import sqlite3
from pathlib import Path


class InputError(Exception):
    """輸入錯誤：檔案不存在、非 SQLite、缺資料表或欄位、設定檔格式錯誤等。"""


REQUIRED_COLUMNS = {
    "Point": {
        "ID", "NAME", "CODE", "North", "East", "Height", "DeleteSign",
        "GPSID", "StartTime", "EndTime", "PitchAngle", "RollAngle",
    },
    "GPSCoordinate": {
        "ID", "HRMS", "VRMS", "PDOP", "Satellite_Locked", "Base_ID",
        "Base_Latitude", "Base_Longitude", "DistancetoBase",
        "Antenna_AntennaHeight",
    },
    "GPSBackup": {
        "ID", "Pos_State", "Satellite_Locked", "HRMS", "VRMS", "PDOP", "Pos_Delay",
    },
    "Antenna": {"ID", "Type"},
}

# 點號解析：CODE 符合經界點代碼樣式（字母開頭、結尾為數字）
CODE_RE = re.compile(r"^[A-Za-z]{2,}[A-Za-z0-9\-]*[0-9]$")
DIGITS_RE = re.compile(r"^[0-9]+$")


class PDData:
    """單一 .PD 檔的讀取結果（全部在記憶體中，讀完即關閉資料庫）。"""

    def __init__(self, name, path, size, sha256, observations, antennas,
                 warnings, deleted_count):
        self.name = name
        self.path = path
        self.size = size
        self.sha256 = sha256
        self.observations = observations
        self.antennas = antennas
        self.warnings = warnings
        self.deleted_count = deleted_count


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def resolve_id(name, code, mode):
    """依 --id-from 決定點號。auto 規則逐筆判斷。"""
    name = (name or "").strip()
    code = (code or "").strip()
    if mode == "name":
        return name
    if mode == "code":
        return code or name
    if DIGITS_RE.match(name) and CODE_RE.match(code):
        return code
    return name


def _uri(path):
    # as_uri() 會做 URI 百分比編碼，含中文與空白也能開
    return Path(path).resolve().as_uri() + "?mode=ro&immutable=1"


def _max(vals):
    vals = [v for v in vals if v is not None]
    return max(vals) if vals else None


def _min(vals):
    vals = [v for v in vals if v is not None]
    return min(vals) if vals else None


def _f(v):
    return None if v is None else float(v)


def _s(v):
    return "" if v is None else str(v).strip()


def read_pd(path, id_from="auto"):
    p = Path(path)
    if not p.is_file():
        raise InputError(f"找不到檔案：{path}")
    size = p.stat().st_size
    digest = sha256_of(p)

    try:
        conn = sqlite3.connect(_uri(p), uri=True)
    except sqlite3.Error as e:
        raise InputError(f"無法開啟 {p.name}：{e}") from e
    conn.row_factory = sqlite3.Row
    try:
        try:
            tables = {r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
        except sqlite3.DatabaseError as e:
            raise InputError(f"不是 SQLite 資料庫：{p.name}") from e

        for table, cols in REQUIRED_COLUMNS.items():
            if table not in tables:
                raise InputError(f"{p.name} 缺少資料表 {table}")
            have = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
            missing = sorted(cols - have)
            if missing:
                raise InputError(f"{p.name} 的 {table} 缺少欄位：{', '.join(missing)}")

        antennas = []
        seen = set()
        for r in conn.execute("SELECT ID, Type FROM Antenna"):
            key = (_s(r["ID"]), _s(r["Type"]))
            if key not in seen:
                seen.add(key)
                antennas.append(key)

        gps = {}
        for r in conn.execute(
            "SELECT ID, HRMS, VRMS, PDOP, Satellite_Locked, Base_ID, Base_Latitude, "
            "Base_Longitude, DistancetoBase, Antenna_AntennaHeight FROM GPSCoordinate"
        ):
            gps[r["ID"]] = r

        epochs = {}
        for r in conn.execute(
            "SELECT ID, Pos_State, Satellite_Locked, HRMS, VRMS, PDOP, Pos_Delay "
            "FROM GPSBackup"
        ):
            epochs.setdefault(r["ID"], []).append(r)

        observations = []
        warnings = []
        deleted = 0
        for pt in conn.execute(
            "SELECT ID, NAME, CODE, North, East, Height, DeleteSign, GPSID, "
            "StartTime, EndTime, PitchAngle, RollAngle FROM Point ORDER BY ID"
        ):
            if pt["DeleteSign"]:
                deleted += 1
                continue
            g = gps.get(pt["GPSID"])
            if g is None:
                warnings.append(
                    f"警告：{p.name} 的點 ID={pt['ID']}（NAME={_s(pt['NAME'])}）"
                    f"GPSID={pt['GPSID']} 在 GPSCoordinate 找不到，已略過"
                )
                continue
            if pt["North"] is None or pt["East"] is None:
                warnings.append(
                    f"警告：{p.name} 的點 ID={pt['ID']} 缺少坐標，已略過"
                )
                continue

            ep = epochs.get(pt["GPSID"], [])
            epoch_n = len(ep)
            fixed_n = sum(1 for e in ep if e["Pos_State"] == "FIXED")
            pitch = _f(pt["PitchAngle"])
            roll = _f(pt["RollAngle"])
            ant_h = _f(g["Antenna_AntennaHeight"])
            tilt = None
            if pitch is not None and roll is not None and ant_h is not None:
                tilt = ant_h * math.tan(math.radians(max(abs(pitch), abs(roll))))

            observations.append({
                "source": p.name,
                "id": resolve_id(pt["NAME"], pt["CODE"], id_from),
                "name": _s(pt["NAME"]),
                "code": _s(pt["CODE"]),
                "n": float(pt["North"]),
                "e": float(pt["East"]),
                "h": _f(pt["Height"]),
                "start": _s(pt["StartTime"]),
                "end": _s(pt["EndTime"]),
                "epoch_n": epoch_n,
                "fixed_n": fixed_n,
                "hrms": _f(g["HRMS"]),
                "vrms": _f(g["VRMS"]),
                "pdop": _f(g["PDOP"]),
                "sat": g["Satellite_Locked"],
                "ep_hrms_max": _max(_f(e["HRMS"]) for e in ep),
                "ep_vrms_max": _max(_f(e["VRMS"]) for e in ep),
                "ep_pdop_max": _max(_f(e["PDOP"]) for e in ep),
                "ep_sat_min": _min(e["Satellite_Locked"] for e in ep),
                "ep_delay_max": _max(_f(e["Pos_Delay"]) for e in ep),
                "base_id": _s(g["Base_ID"]) or None,
                "base_lat": _f(g["Base_Latitude"]),
                "base_lon": _f(g["Base_Longitude"]),
                "dist_base": _f(g["DistancetoBase"]),
                "ant_h": ant_h,
                "pitch": pitch,
                "roll": roll,
                "tilt_off": tilt,
                "obs_flags": [],
            })
    finally:
        conn.close()

    return PDData(p.name, str(p), size, digest, observations, antennas,
                  warnings, deleted)
