"""WGS84／GRS80 經緯度 → TWD97 TM2（中央經線 121°，二度分帶）。

橢球 GRS80：a = 6378137，1/f = 298.257222101。
投影參數：中央經線 121°E、比例因子 k0 = 0.9999、假東 250000 m、假北 0。
採 Krüger n 級數（Karney 2011，與 PROJ etmerc 同一演算法），展開到 n^6。
WGS84 與 GRS80 的橢球差異在平面上不到 0.1 mm，視為同一橢球。
"""

import math

A = 6378137.0
INV_F = 298.257222101
F = 1.0 / INV_F
LON0 = 121.0
K0 = 0.9999
E0 = 250000.0
N0 = 0.0

_n = F / (2.0 - F)
_n2 = _n * _n
_n3 = _n2 * _n
_n4 = _n3 * _n
_n5 = _n4 * _n
_n6 = _n5 * _n

_AA = A / (1.0 + _n) * (1.0 + _n2 / 4.0 + _n4 / 64.0 + _n6 / 256.0)

_ALPHA = (
    _n / 2.0 - 2.0 * _n2 / 3.0 + 5.0 * _n3 / 16.0 + 41.0 * _n4 / 180.0
    - 127.0 * _n5 / 288.0 + 7891.0 * _n6 / 37800.0,
    13.0 * _n2 / 48.0 - 3.0 * _n3 / 5.0 + 557.0 * _n4 / 1440.0
    + 281.0 * _n5 / 630.0 - 1983433.0 * _n6 / 1935360.0,
    61.0 * _n3 / 240.0 - 103.0 * _n4 / 140.0 + 15061.0 * _n5 / 26880.0
    + 167603.0 * _n6 / 181440.0,
    49561.0 * _n4 / 161280.0 - 179.0 * _n5 / 168.0 + 6601661.0 * _n6 / 7257600.0,
    34729.0 * _n5 / 80640.0 - 3418889.0 * _n6 / 1995840.0,
    212378941.0 * _n6 / 319334400.0,
)

_RAD = math.pi / 180.0
_C = 2.0 * math.sqrt(_n) / (1.0 + _n)


def lonlat_to_tm2(lat_deg, lon_deg):
    """回傳 (縱坐標 N, 橫坐標 E)，單位 m。"""
    phi = lat_deg * _RAD
    lam = (lon_deg - LON0) * _RAD
    s = math.sin(phi)
    t = math.sinh(math.atanh(s) - _C * math.atanh(_C * s))
    xi0 = math.atan2(t, math.cos(lam))
    eta0 = math.atanh(math.sin(lam) / math.sqrt(1.0 + t * t))
    xi, eta = xi0, eta0
    for j, a in enumerate(_ALPHA, start=1):
        xi += a * math.sin(2.0 * j * xi0) * math.cosh(2.0 * j * eta0)
        eta += a * math.cos(2.0 * j * xi0) * math.sinh(2.0 * j * eta0)
    return N0 + K0 * _AA * xi, E0 + K0 * _AA * eta
