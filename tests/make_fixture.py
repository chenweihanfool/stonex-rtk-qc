"""建立合成（假）.PD 檔，供測試使用。絕不含真實坐標或真實資料。"""

import os
import sqlite3

SCHEMA = [
    "CREATE TABLE Point (ID INTEGER PRIMARY KEY, NAME TEXT, CODE TEXT, North REAL, "
    "East REAL, Height REAL, DeleteSign INTEGER, GPSID INTEGER, StartTime TEXT, "
    "EndTime TEXT, PitchAngle REAL, RollAngle REAL, HostIMEI TEXT, "
    "Latitude REAL, Longitude REAL, Altitude REAL)",
    "CREATE TABLE GPSCoordinate (ID INTEGER PRIMARY KEY, HRMS REAL, VRMS REAL, "
    "PDOP REAL, HDOP REAL, VDOP REAL, Satellite_Locked INTEGER, Pos_State TEXT, "
    "Pos_Delay REAL, DistancetoBase REAL, Antenna_MeasureHeight REAL, "
    "Antenna_AntennaHeight REAL, Base_ID TEXT, Base_Latitude REAL, "
    "Base_Longitude REAL, Base_Altitude REAL, InstrumentID TEXT, LocalDate TEXT, "
    "LocalTime TEXT)",
    "CREATE TABLE GPSBackup (ID INTEGER, Sub_Index INTEGER, Sub_Total INTEGER, "
    "HRMS REAL, VRMS REAL, PDOP REAL, HDOP REAL, VDOP REAL, Satellite_Locked INTEGER, "
    "Pos_State TEXT, Pos_Delay REAL, DistancetoBase REAL, Base_ID TEXT, "
    "Base_Latitude REAL, Base_Longitude REAL, Base_Altitude REAL, InstrumentID TEXT, "
    "LocalDate TEXT, LocalTime TEXT)",
    "CREATE TABLE Covariance (ID INTEGER PRIMARY KEY, Covxx REAL, Covxy REAL, "
    "Covxz REAL, Covyx REAL, Covyy REAL, Covyz REAL, Covzx REAL, Covzy REAL, "
    "Covzz REAL)",
    "CREATE TABLE Antenna (ID TEXT, Type TEXT, H REAL, R REAL, HL1 REAL, HL2 REAL)",
]

# 合成的基站：B1、B2 位置相距約 1 km，明顯不同主站
BASES = {
    "B1": (10.0, 100.0),
    "B2": (10.0, 100.01),
}

BASE_N = 2700000.0
BASE_E = 200000.0


def obs(name, code, start, end, *, dn=0.0, de=0.0, h=50.0, base="B1",
        hrms=0.01, vrms=0.02, pdop=2.0, sat=12, pos_states=None,
        pitch=0.0, roll=0.0, ant_h=1.8, deleted=0, dist=1000.0, orphan=False,
        lat=None, lon=None, alt=None, north=None, east=None):
    """回傳一筆觀測的規格 dict。dn/de 為相對假坐標的偏移（m）。"""
    return dict(name=name, code=code, start=start, end=end, dn=dn, de=de, h=h,
                base=base, hrms=hrms, vrms=vrms, pdop=pdop, sat=sat,
                pos_states=pos_states or ["FIXED", "FIXED", "FIXED"],
                pitch=pitch, roll=roll, ant_h=ant_h, deleted=deleted, dist=dist,
                orphan=orphan, lat=lat, lon=lon, alt=alt, north=north, east=east)


def make_pd(path, observations, antenna_serial="TSTSN0001", antenna_type="S900A"):
    """依規格建立 .PD（SQLite）。observations 為 obs() 回傳的 dict 串列。"""
    if os.path.exists(path):
        os.remove(path)
    conn = sqlite3.connect(path)
    try:
        for stmt in SCHEMA:
            conn.execute(stmt)
        for i, o in enumerate(observations, start=1):
            gid = 1000 + i
            conn.execute(
                "INSERT INTO Point (ID, NAME, CODE, North, East, Height, DeleteSign, "
                "GPSID, StartTime, EndTime, PitchAngle, RollAngle, HostIMEI, "
                "Latitude, Longitude, Altitude) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (i, o["name"], o["code"],
                 BASE_N + o["dn"] if o["north"] is None else o["north"],
                 BASE_E + o["de"] if o["east"] is None else o["east"], o["h"],
                 o["deleted"], gid, o["start"], o["end"], o["pitch"], o["roll"],
                 "IMEI0000", o["lat"], o["lon"], o["alt"]),
            )
            if o["orphan"]:
                continue
            blat, blon = BASES[o["base"]]
            conn.execute(
                "INSERT INTO GPSCoordinate (ID, HRMS, VRMS, PDOP, HDOP, VDOP, "
                "Satellite_Locked, Pos_State, Pos_Delay, DistancetoBase, "
                "Antenna_MeasureHeight, Antenna_AntennaHeight, Base_ID, "
                "Base_Latitude, Base_Longitude, Base_Altitude, InstrumentID, "
                "LocalDate, LocalTime) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (gid, o["hrms"], o["vrms"], o["pdop"], 1.0, 1.0, o["sat"], "FIXED",
                 0.5, o["dist"], 1.8, o["ant_h"], o["base"], blat, blon, 40.0,
                 antenna_serial, o["start"][:10], o["start"][11:]),
            )
            states = o["pos_states"]
            n_ep = len(states)
            for k, st in enumerate(states, start=1):
                conn.execute(
                    "INSERT INTO GPSBackup (ID, Sub_Index, Sub_Total, HRMS, VRMS, PDOP, "
                    "HDOP, VDOP, Satellite_Locked, Pos_State, Pos_Delay, DistancetoBase, "
                    "Base_ID, Base_Latitude, Base_Longitude, Base_Altitude, InstrumentID, "
                    "LocalDate, LocalTime) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (gid, k, n_ep, o["hrms"], o["vrms"], o["pdop"], 1.0, 1.0, o["sat"],
                     st, 0.5, o["dist"], o["base"], blat, blon, 40.0, antenna_serial,
                     o["start"][:10], o["start"][11:]),
                )
            conn.execute(
                "INSERT INTO Covariance (ID, Covxx, Covxy, Covxz, Covyx, Covyy, Covyz, "
                "Covzx, Covzy, Covzz) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (gid, 1e-6, 0, 0, 0, 1e-6, 0, 0, 0, 1e-6),
            )
        conn.execute(
            "INSERT INTO Antenna (ID, Type, H, R, HL1, HL2) VALUES (?,?,?,?,?,?)",
            (antenna_serial, antenna_type, 1.8, 0.1, 0.0, 0.0),
        )
        conn.commit()
    finally:
        conn.close()
    return path


def scenario(dir_path):
    """建立兩個合成檔（同一點分在兩天），涵蓋每條旗標、點號規則與刪除點。

    回傳 {"day1": path, "day2": path}。
    預期（預設門檻）：
      GDC060 無旗標；BNC032 X1；BNC033 X6；BNC034 X5；GDC050 X2；
      GDC051 X3；GDC052 X4；GDC053 F1；GDC054 T1；GDC101 X6；
      "12" 無旗標（NAME 數字、CODE='29' → 取 NAME）；BNC060 無旗標（跨檔兩次）。
      GDC055 已刪除，不輸出；孤兒點（GPSID 找不到）略過並警告。
    """
    day1 = [
        obs("1", "GDC060", "2026-11-01 08:00:00", "2026-11-01 08:05:00", dn=0.0, de=0.0, base="B1"),
        obs("1", "GDC060", "2026-11-01 09:00:00", "2026-11-01 09:05:00", dn=0.005, de=0.005, base="B2"),
        obs("2", "BNC032", "2026-11-01 08:10:00", "2026-11-01 08:15:00", base="B1"),
        obs("2", "BNC032", "2026-11-01 09:10:00", "2026-11-01 09:15:00", base="B1"),
        obs("3", "BNC033", "2026-11-01 08:20:00", "2026-11-01 08:25:00", base="B1"),
        obs("4", "BNC034", "2026-11-01 08:30:00", "2026-11-01 08:35:00", base="B1"),
        obs("4", "BNC034", "2026-11-01 09:30:00", "2026-11-01 09:35:00", dn=0.03, base="B2"),
        obs("5", "GDC050", "2026-11-01 08:40:00", "2026-11-01 08:45:00", base="B1"),
        obs("5", "GDC050", "2026-11-01 09:40:00", "2026-11-01 09:45:00", base="B2", hrms=0.03),
        obs("6", "GDC051", "2026-11-01 08:50:00", "2026-11-01 08:55:00", base="B1", vrms=0.06),
        obs("6", "GDC051", "2026-11-01 09:50:00", "2026-11-01 09:55:00", base="B2"),
        obs("7", "GDC052", "2026-11-01 10:00:00", "2026-11-01 10:05:00", base="B1", pdop=11.0),
        obs("7", "GDC052", "2026-11-01 11:00:00", "2026-11-01 11:05:00", base="B2"),
        obs("8", "GDC053", "2026-11-01 10:10:00", "2026-11-01 10:15:00", base="B1",
            pos_states=["FIXED", "FLOAT", "FIXED"]),
        obs("8", "GDC053", "2026-11-01 11:10:00", "2026-11-01 11:15:00", base="B2"),
        obs("9", "GDC054", "2026-11-01 10:20:00", "2026-11-01 10:25:00", base="B1",
            roll=1.0, ant_h=2.0),
        obs("9", "GDC054", "2026-11-01 11:20:00", "2026-11-01 11:25:00", base="B2",
            roll=1.0, ant_h=2.0),
        obs("10", "GDC055", "2026-11-01 10:30:00", "2026-11-01 10:35:00", deleted=1),
        obs("11", "GDC101", "2026-11-01 10:40:00", "2026-11-01 10:45:00", base="B1"),
        obs("12", "29", "2026-11-01 10:50:00", "2026-11-01 10:55:00", base="B1"),
        obs("12", "29", "2026-11-01 11:50:00", "2026-11-01 11:55:00", base="B2"),
        obs("13", "BNC060", "2026-11-01 12:00:00", "2026-11-01 12:05:00", base="B1"),
        obs("99", "ORPHAN", "2026-11-01 12:10:00", "2026-11-01 12:15:00", orphan=True),
    ]
    day2 = [
        obs("13", "BNC060", "2026-11-02 08:00:00", "2026-11-02 08:05:00", base="B2"),
    ]
    d1 = make_pd(os.path.join(dir_path, "day1.PD"), day1)
    d2 = make_pd(os.path.join(dir_path, "day2.PD"), day2)
    return {"day1": d1, "day2": d2}


FRAME_DN = -0.26
FRAME_DE = 0.40
FRAME_UNDULATION = 25.5


def frame_scenario(dir_path):
    """主站框架差修正用：Point 的經緯度（RTCM 轉換前框架）與控制器網格 N/E 差固定 (dN, dE)，
    Altitude 比 Height 高 FRAME_UNDULATION。B1 的真值＝TM2(基站經緯度) + (dN, dE)，高程 40 − 25.5。
    B1 有兩個點、B2 只有經緯度缺失的點（無法修正）。回傳 .PD 路徑。
    """
    from rtkqc.tm2 import lonlat_to_tm2

    def pt(name, lat, lon, base, start):
        n, e = lonlat_to_tm2(lat, lon)
        return obs(name, "GDC" + name, start, start[:11] + "09:00:00", base=base,
                   lat=lat, lon=lon, alt=50.0 + FRAME_UNDULATION,
                   north=n + FRAME_DN, east=e + FRAME_DE)

    observations = [
        pt("1", 10.0, 100.001, "B1", "2026-11-01 08:00:00"),
        pt("2", 10.001, 100.0, "B1", "2026-11-01 08:10:00"),
        obs("3", "GDC3", "2026-11-01 08:20:00", "2026-11-01 08:25:00", base="B2"),
    ]
    return make_pd(os.path.join(dir_path, "frame.PD"), observations)


# ---- 已知加密點連測／坐標轉換用的合成資料 ----
# 轉換真值（觀測 → 法定）：平移 (TF_TN, TF_TE)、尺度 +TF_PPM ppm、旋轉 +TF_SEC 秒、高程差 TF_DH。
TF_TN = -0.26
TF_TE = 0.40
TF_PPM = 5.0
TF_SEC = 2.0
TF_DH = 0.35

# 法定坐標（相對 BASE_N、BASE_E 的偏移）：前 7 個是加密點（CP00 在重心），後 2 個是一般點
CTL_LAYOUT = [
    ("CP00", 0.0, 0.0), ("CP01", 100.0, 0.0), ("CP02", -100.0, 0.0), ("CP03", 0.0, 120.0),
    ("CP04", 0.0, -120.0), ("CP05", 80.0, 90.0), ("CP06", -80.0, -90.0),
    ("P01", 30.0, 40.0), ("P02", -60.0, 70.0),
]
N_CONTROL = 7


def tf_params():
    import math
    k = 1.0 + TF_PPM * 1e-6
    th = TF_SEC / 3600.0 * math.pi / 180.0
    return k * math.cos(th), k * math.sin(th)


def tf_forward(n, e):
    """真值轉換：觀測 → 法定（以 BASE_N、BASE_E 為參考點）。"""
    a, b = tf_params()
    dn, de = n - BASE_N, e - BASE_E
    return BASE_N + a * dn - b * de + TF_TN, BASE_E + b * dn + a * de + TF_TE


def tf_inverse(n, e):
    """由法定坐標反推觀測坐標。"""
    a, b = tf_params()
    dn, de = n - BASE_N - TF_TN, e - BASE_E - TF_TE
    det = a * a + b * b
    return BASE_N + (a * dn + b * de) / det, BASE_E + (-b * dn + a * de) / det


def control_scenario(dir_path, outlier=0.0, extra_day=False, fixed_epochs=3):
    """一個 .PD（9 個點各一筆觀測，觀測坐標＝法定真值反推）。

    回傳 {"pd": 路徑, "control": {點號: (N, E, H)}（7 個加密點的法定成果）,
          "truth": {點號: (N, E, H)}（所有點的法定真值）}。
    outlier：CP00 的成果表 N 比真值多 outlier（模擬加密點成果或觀測有誤）。
    extra_day：多一筆隔天（11-02）只觀測一般點的觀測，用來測每日連測檢查。
    """
    os.makedirs(dir_path, exist_ok=True)
    observations, control, truth = [], {}, {}
    for i, (pid, dn, de) in enumerate(CTL_LAYOUT):
        ln, le, lh = BASE_N + dn, BASE_E + de, 50.0 + 0.1 * i
        on, oe = tf_inverse(ln, le)
        start = f"2026-11-01 08:{i:02d}:00"
        observations.append(obs(pid, "X", start, f"2026-11-01 08:{i:02d}:30", h=lh - TF_DH,
                                north=on, east=oe, pos_states=["FIXED"] * fixed_epochs))
        truth[pid] = (ln, le, lh)
        if i < N_CONTROL:
            control[pid] = (ln + (outlier if pid == "CP00" else 0.0), le, lh)
    if extra_day:
        on, oe = tf_inverse(BASE_N + 30.0, BASE_E + 40.0)
        observations.append(obs("P01", "X", "2026-11-02 09:00:00", "2026-11-02 09:00:30",
                                h=50.0 + 0.7 - TF_DH, north=on, east=oe,
                                pos_states=["FIXED"] * fixed_epochs))
    pd = make_pd(os.path.join(dir_path, "control.PD"), observations)
    return {"pd": pd, "control": control, "truth": truth}


def write_control_csv(path, control, header=True):
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        if header:
            f.write("點號,N,E,H\n")
        for pid, (n, e, h) in control.items():
            f.write(f"{pid},{n:.6f},{e:.6f},{'' if h is None else format(h, '.6f')}\n")
    return path
