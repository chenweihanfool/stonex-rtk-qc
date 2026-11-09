/* rtkqc 核心（純函式、無 DOM）：瀏覽器與 Node 共用。
 * 與 Python 參考實作（rtkqc/）逐欄對拍：判定規則、門檻、點號規則、去重、時間取用都以 Python 為準。
 */
var RTKQC = (function () {
'use strict';

const VERSION = '0.3.0';

class InputError extends Error {}

const DEFAULT_THRESHOLDS = {
  same_base_tol_m: 0.01,
  hrms_max: 0.02,
  vrms_max: 0.05,
  pdop_max: 10.0,
  diff_2d_max: 0.02,
  tilt_offset_max: 0.01,
  min_interval_min: 0.0, // 0 = 不檢查
  known_tol_2d: 0.02,
  neighbor_max_m: 100.0,
  min_fixed_epochs: 0.0, // 每筆觀測至少幾筆 FIXED epoch（0 = 不檢查；圖根模式預設 180）
  transform_resid_max: 0.098, // 共同點轉換後坐標分量改正數上限（m）
  azimuth_diff_max_sec: 20.0, // 共同點間方位角較差上限（秒）
  distance_ratio_min: 20000.0, // 共同點間水平距相對較差比值分母下限
};

// 作業模式覆蓋的預設門檻（--config／UI 設定仍可再覆蓋）
const MODES = ['survey', 'control'];
const MODE_DEFAULTS = {
  survey: {},
  control: { min_fixed_epochs: 180.0, min_interval_min: 60.0 },
};
const MODE_LABEL = { survey: '現況／界址（survey）', control: '圖根（control）' };

const FLAG_ORDER = ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'F1', 'T1', 'E1', 'D1', 'K1', 'C1', 'C2', 'C3'];

const FLAG_DESC = {
  X1: '兩次觀測採相同主站',
  X2: '固定解平面誤差未小於 2cm',
  X3: '固定解高程誤差未小於 5cm',
  X4: 'PDOP 未小於 10',
  X5: '兩次較差未小於 2cm',
  X6: '僅有一個觀測值',
  F1: '有非固定解（Pos_State 非 FIXED）的 epoch',
  T1: '天線傾斜偏移量達門檻',
  E1: '固定解筆數不足',
  D1: '兩次觀測時間間隔不足',
  K1: '與已知坐標差距超限',
  C1: '共同點轉換後坐標分量改正數超限',
  C2: '共同點間方位角較差超限',
  C3: '共同點間水平距相對較差超限',
};

const ACTIONS = {
  X1: '斷開重連 NTRIP 後再測一次',
  X2: '等衛星條件改善後重測',
  X3: '等衛星條件改善後重測',
  X4: '等衛星條件改善後重測',
  X5: '再測一次',
  X6: '補測第二次（建議重連 NTRIP）',
  F1: '等衛星條件改善後重測',
  T1: '重新整平對中後重測',
  E1: '固定解筆數不足，重測並收足筆數',
  D1: '間隔不足，隔段時間再測',
  K1: '檢查系統偏移與天線高，重測已知點',
  C1: '檢查該加密點觀測與已知坐標，必要時重測',
  C2: '檢查相關加密點觀測，必要時重測',
  C3: '檢查相關加密點觀測，必要時重測',
};

const EARTH_R = 6378137.0;

const REQUIRED_COLUMNS = {
  Point: ['ID', 'NAME', 'CODE', 'North', 'East', 'Height', 'DeleteSign', 'GPSID',
    'StartTime', 'EndTime', 'PitchAngle', 'RollAngle'],
  GPSCoordinate: ['ID', 'HRMS', 'VRMS', 'PDOP', 'Satellite_Locked', 'Base_ID',
    'Base_Latitude', 'Base_Longitude', 'DistancetoBase', 'Antenna_AntennaHeight'],
  GPSBackup: ['ID', 'Pos_State', 'Satellite_Locked', 'HRMS', 'VRMS', 'PDOP', 'Pos_Delay'],
  Antenna: ['ID', 'Type'],
};

const CODE_RE = /^[A-Za-z]{2,}[A-Za-z0-9-]*[0-9]$/;
const DIGITS_RE = /^[0-9]+$/;

/* ---------- 數字格式：四捨五入（半數遠離零），先取 15 位有效數字 ---------- */

function roundStr(v, nd) {
  let s = Number(v).toPrecision(15);
  let neg = false;
  if (s[0] === '-') { neg = true; s = s.slice(1); }
  let mant = s;
  let exp = 0;
  const ei = s.search(/e/i);
  if (ei >= 0) { mant = s.slice(0, ei); exp = parseInt(s.slice(ei + 1), 10); }
  const parts = mant.split('.');
  const ip = parts[0];
  const fp = parts[1] || '';
  const digits = ip + fp;
  const keep = ip.length + exp + nd; // 保留的位數（含小數 nd 位）
  let intDigits;
  let roundDigit = 0;
  if (keep < 0) {
    intDigits = '0';
  } else if (keep >= digits.length) {
    intDigits = digits + '0'.repeat(keep - digits.length);
  } else {
    intDigits = digits.slice(0, keep) || '0';
    roundDigit = digits.charCodeAt(keep) - 48;
  }
  let n = BigInt(intDigits);
  if (roundDigit >= 5) n += 1n;
  let t = n.toString();
  if (nd > 0) t = t.padStart(nd + 1, '0');
  const res = nd > 0 ? t.slice(0, t.length - nd) + '.' + t.slice(t.length - nd) : t;
  return (neg && n !== 0n ? '-' : '') + res;
}

function rnd(v, nd) {
  return v === null || v === undefined ? null : Number(roundStr(v, nd));
}

function fmt(v, nd) {
  return v === null || v === undefined ? '' : roundStr(v, nd);
}

// Python str(float) 風格：整數值補 .0
function pyNum(v) {
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

function pyStr(v) {
  return v === null || v === undefined ? 'None' : String(v);
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ---------- TWD97 TM2（Krüger n 級數，與 rtkqc/tm2.py 同） ---------- */

const TM = (function () {
  const A = 6378137.0;
  const F = 1.0 / 298.257222101;
  const LON0 = 121.0;
  const K0 = 0.9999;
  const E0 = 250000.0;
  const N0 = 0.0;
  const n = F / (2.0 - F);
  const n2 = n * n;
  const n3 = n2 * n;
  const n4 = n3 * n;
  const n5 = n4 * n;
  const n6 = n5 * n;
  const AA = A / (1.0 + n) * (1.0 + n2 / 4.0 + n4 / 64.0 + n6 / 256.0);
  const ALPHA = [
    n / 2.0 - 2.0 * n2 / 3.0 + 5.0 * n3 / 16.0 + 41.0 * n4 / 180.0 -
      127.0 * n5 / 288.0 + 7891.0 * n6 / 37800.0,
    13.0 * n2 / 48.0 - 3.0 * n3 / 5.0 + 557.0 * n4 / 1440.0 +
      281.0 * n5 / 630.0 - 1983433.0 * n6 / 1935360.0,
    61.0 * n3 / 240.0 - 103.0 * n4 / 140.0 + 15061.0 * n5 / 26880.0 +
      167603.0 * n6 / 181440.0,
    49561.0 * n4 / 161280.0 - 179.0 * n5 / 168.0 + 6601661.0 * n6 / 7257600.0,
    34729.0 * n5 / 80640.0 - 3418889.0 * n6 / 1995840.0,
    212378941.0 * n6 / 319334400.0,
  ];
  const RAD = Math.PI / 180.0;
  const C = 2.0 * Math.sqrt(n) / (1.0 + n);
  return function lonlatToTm2(latDeg, lonDeg) {
    const phi = latDeg * RAD;
    const lam = (lonDeg - LON0) * RAD;
    const s = Math.sin(phi);
    const t = Math.sinh(Math.atanh(s) - C * Math.atanh(C * s));
    const xi0 = Math.atan2(t, Math.cos(lam));
    const eta0 = Math.atanh(Math.sin(lam) / Math.sqrt(1.0 + t * t));
    let xi = xi0;
    let eta = eta0;
    for (let j = 1; j <= ALPHA.length; j++) {
      xi += ALPHA[j - 1] * Math.sin(2.0 * j * xi0) * Math.cosh(2.0 * j * eta0);
      eta += ALPHA[j - 1] * Math.cos(2.0 * j * xi0) * Math.sinh(2.0 * j * eta0);
    }
    return [N0 + K0 * AA * xi, E0 + K0 * AA * eta];
  };
})();

/* ---------- 讀 .PD（sql.js） ---------- */

async function sha256Hex(bytes) {
  const subtle = typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new InputError('此瀏覽器不支援 Web Crypto（需要 https 或 file:// 環境），無法計算 sha256');
  const buf = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function queryAll(db, sql) {
  const res = db.exec(sql);
  if (!res.length) return [];
  const cols = res[0].columns;
  return res[0].values.map((v) => {
    const o = {};
    cols.forEach((c, i) => { o[c] = v[i]; });
    return o;
  });
}

const fOrNull = (v) => (v === null || v === undefined ? null : Number(v));
const sOf = (v) => (v === null || v === undefined ? '' : String(v).trim());

function maxOf(vals) {
  let m = null;
  for (const v of vals) if (v !== null && v !== undefined && (m === null || v > m)) m = v;
  return m;
}
function minOf(vals) {
  let m = null;
  for (const v of vals) if (v !== null && v !== undefined && (m === null || v < m)) m = v;
  return m;
}

function resolveId(name, code, mode) {
  name = (name || '').trim();
  code = (code || '').trim();
  if (mode === 'name') return name;
  if (mode === 'code') return code || name;
  if (DIGITS_RE.test(name) && CODE_RE.test(code)) return code;
  return name;
}

async function readPD(SQL, bytes, name, idFrom) {
  idFrom = idFrom || 'auto';
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const size = bytes.length;
  const sha256 = await sha256Hex(bytes);

  let db;
  try {
    db = new SQL.Database(bytes);
  } catch (e) {
    throw new InputError(`無法開啟 ${name}：${e.message}`);
  }
  try {
    let tables;
    try {
      tables = new Set(queryAll(db, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));
    } catch (e) {
      throw new InputError(`不是 SQLite 資料庫：${name}`);
    }
    for (const table of Object.keys(REQUIRED_COLUMNS)) {
      if (!tables.has(table)) throw new InputError(`${name} 缺少資料表 ${table}`);
      const have = new Set(queryAll(db, `PRAGMA table_info(${table})`).map((r) => r.name));
      const missing = REQUIRED_COLUMNS[table].filter((c) => !have.has(c)).sort();
      if (missing.length) throw new InputError(`${name} 的 ${table} 缺少欄位：${missing.join(', ')}`);
    }

    const antennas = [];
    const seenAnt = new Set();
    for (const r of queryAll(db, 'SELECT ID, Type FROM Antenna')) {
      const key = JSON.stringify([sOf(r.ID), sOf(r.Type)]);
      if (!seenAnt.has(key)) { seenAnt.add(key); antennas.push([sOf(r.ID), sOf(r.Type)]); }
    }

    const gpsCols = new Set(queryAll(db, 'PRAGMA table_info(GPSCoordinate)').map((r) => r.name));
    const altExpr = gpsCols.has('Base_Altitude') ? 'Base_Altitude' : 'NULL AS Base_Altitude';
    const gps = new Map();
    for (const r of queryAll(db,
      'SELECT ID, HRMS, VRMS, PDOP, Satellite_Locked, Base_ID, Base_Latitude, ' +
      `Base_Longitude, ${altExpr}, DistancetoBase, Antenna_AntennaHeight FROM GPSCoordinate`)) {
      gps.set(r.ID, r);
    }

    const epochs = new Map();
    for (const r of queryAll(db,
      'SELECT ID, Pos_State, Satellite_Locked, HRMS, VRMS, PDOP, Pos_Delay FROM GPSBackup')) {
      if (!epochs.has(r.ID)) epochs.set(r.ID, []);
      epochs.get(r.ID).push(r);
    }

    const observations = [];
    const warnings = [];
    let deleted = 0;
    const ptCols = new Set(queryAll(db, 'PRAGMA table_info(Point)').map((r) => r.name));
    const geoExpr = ['Latitude', 'Longitude', 'Altitude'].map((c) => (ptCols.has(c) ? c : `NULL AS ${c}`)).join(', ');
    for (const pt of queryAll(db,
      'SELECT ID, NAME, CODE, North, East, Height, DeleteSign, GPSID, StartTime, EndTime, ' +
      `PitchAngle, RollAngle, ${geoExpr} FROM Point ORDER BY ID`)) {
      if (pt.DeleteSign) { deleted++; continue; }
      const g = gps.get(pt.GPSID);
      if (g === undefined) {
        warnings.push(`警告：${name} 的點 ID=${pyStr(pt.ID)}（NAME=${sOf(pt.NAME)}）` +
          `GPSID=${pyStr(pt.GPSID)} 在 GPSCoordinate 找不到，已略過`);
        continue;
      }
      if (pt.North === null || pt.East === null) {
        warnings.push(`警告：${name} 的點 ID=${pyStr(pt.ID)} 缺少坐標，已略過`);
        continue;
      }
      const ep = epochs.get(pt.GPSID) || [];
      const epochN = ep.length;
      const fixedN = ep.filter((e) => e.Pos_State === 'FIXED').length;
      const pitch = fOrNull(pt.PitchAngle);
      const roll = fOrNull(pt.RollAngle);
      const antH = fOrNull(g.Antenna_AntennaHeight);
      let tilt = null;
      if (pitch !== null && roll !== null && antH !== null) {
        tilt = antH * Math.tan(Math.max(Math.abs(pitch), Math.abs(roll)) * (Math.PI / 180));
      }
      observations.push({
        source: name,
        id: resolveId(pt.NAME, pt.CODE, idFrom),
        name: sOf(pt.NAME),
        code: sOf(pt.CODE),
        n: Number(pt.North),
        e: Number(pt.East),
        h: fOrNull(pt.Height),
        start: sOf(pt.StartTime),
        end: sOf(pt.EndTime),
        epoch_n: epochN,
        fixed_n: fixedN,
        hrms: fOrNull(g.HRMS),
        vrms: fOrNull(g.VRMS),
        pdop: fOrNull(g.PDOP),
        sat: g.Satellite_Locked,
        ep_hrms_max: maxOf(ep.map((e) => fOrNull(e.HRMS))),
        ep_vrms_max: maxOf(ep.map((e) => fOrNull(e.VRMS))),
        ep_pdop_max: maxOf(ep.map((e) => fOrNull(e.PDOP))),
        ep_sat_min: minOf(ep.map((e) => e.Satellite_Locked)),
        ep_delay_max: maxOf(ep.map((e) => fOrNull(e.Pos_Delay))),
        base_id: sOf(g.Base_ID) || null,
        base_lat: fOrNull(g.Base_Latitude),
        base_lon: fOrNull(g.Base_Longitude),
        base_alt: fOrNull(g.Base_Altitude),
        lat: fOrNull(pt.Latitude),
        lon: fOrNull(pt.Longitude),
        alt: fOrNull(pt.Altitude),
        dist_base: fOrNull(g.DistancetoBase),
        ant_h: antH,
        pitch,
        roll,
        tilt_off: tilt,
        obs_flags: [],
      });
    }
    return { name, size, sha256, observations, antennas, warnings, deleted_count: deleted };
  } finally {
    db.close();
  }
}

/* ---------- 已知點 CSV ---------- */

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
function pyFloat(s) {
  const t = String(s).trim();
  if (!FLOAT_RE.test(t)) throw new Error('not a float');
  return Number(t);
}

// 回傳 Map<點號, [N, E, H|null]>；格式同 Python load_known
function parseKnownCsv(text, label) {
  label = label || '已知點檔';
  text = text.replace(/^\ufeff/, '');
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  let rows = lines.map(parseCsvLine).filter((r) => r.some((c) => c.trim() !== ''));
  const known = new Map();
  if (!rows.length) return known;
  const idx = { id: 0, n: 1, e: 2, h: 3 };
  const header = rows[0].map((c) => c.trim());
  if (header.some((c) => c === '點號' || c === 'N' || c === 'E' || c === 'H')) {
    rows = rows.slice(1);
    const names = { id: '點號', n: 'N', e: 'E', h: 'H' };
    for (const key of Object.keys(names)) {
      if (header.includes(names[key])) idx[key] = header.indexOf(names[key]);
    }
  }
  rows.forEach((r, i) => {
    const lineno = i + 1;
    let pid;
    let n;
    let e;
    try {
      if (r[idx.id] === undefined || r[idx.n] === undefined || r[idx.e] === undefined) throw new Error('short');
      pid = r[idx.id].trim();
      n = pyFloat(r[idx.n]);
      e = pyFloat(r[idx.e]);
    } catch (ex) {
      throw new InputError(`已知點檔第 ${lineno} 列格式錯誤：${label}`);
    }
    let h = null;
    if (r.length > idx.h && r[idx.h].trim()) {
      try { h = pyFloat(r[idx.h]); } catch (ex) {
        throw new InputError(`已知點檔第 ${lineno} 列 H 非數字：${label}`);
      }
    }
    known.set(pid, [n, e, h]);
  });
  return known;
}

// 門檻物件驗證（同 Python load_thresholds 的規則）
function normalizeThresholds(obj, mode) {
  mode = mode || 'survey';
  if (!MODES.includes(mode)) throw new InputError(`未知的作業模式：${mode}`);
  const th = Object.assign({}, DEFAULT_THRESHOLDS, MODE_DEFAULTS[mode]);
  if (obj === null || obj === undefined) return th;
  if (typeof obj !== 'object' || Array.isArray(obj)) throw new InputError('門檻設定最外層必須是 JSON 物件');
  for (const key of Object.keys(obj)) {
    if (!(key in DEFAULT_THRESHOLDS)) throw new InputError(`門檻設定未知欄位：${key}`);
    const val = obj[key];
    if (typeof val !== 'number' || !Number.isFinite(val)) throw new InputError(`門檻 ${key} 必須是數字`);
    th[key] = val;
  }
  return th;
}

/* ---------- 判定 ---------- */

function planeDist(lat1, lon1, lat2, lon2) {
  const lat0 = ((lat1 + lat2) / 2) * (Math.PI / 180);
  const dy = (lat2 - lat1) * (Math.PI / 180) * EARTH_R;
  const dx = (lon2 - lon1) * (Math.PI / 180) * EARTH_R * Math.cos(lat0);
  return Math.sqrt(dx * dx + dy * dy);
}

function sameBase(a, b, th) {
  if (a.base_id !== b.base_id) return false;
  if (a.base_lat === null || a.base_lon === null || b.base_lat === null || b.base_lon === null) return false;
  return planeDist(a.base_lat, a.base_lon, b.base_lat, b.base_lon) < th.same_base_tol_m;
}

const dist2d = (dn, de) => Math.sqrt(dn * dn + de * de);
const pair2d = (a, b) => dist2d(a.n - b.n, a.e - b.e);
function pairDh(a, b) {
  if (a.h === null || b.h === null) return null;
  return Math.abs(a.h - b.h);
}

// 回傳「自 1970 起的整數秒」（僅用於相減，不做時區換算）；格式不符回傳 null
const TIME_RE = /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/;
function parseTimeSec(s) {
  const m = TIME_RE.exec(s || '');
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  const t = Date.UTC(y, mo - 1, d, h, mi, se);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d ||
      dt.getUTCHours() !== h || dt.getUTCMinutes() !== mi || dt.getUTCSeconds() !== se) return null;
  return t / 1000;
}

function obsFlags(o, th) {
  const flags = [];
  if (o.epoch_n > o.fixed_n) flags.push('F1');
  if (o.tilt_off !== null && o.tilt_off >= th.tilt_offset_max) flags.push('T1');
  if (th.min_fixed_epochs > 0 && o.fixed_n < th.min_fixed_epochs) flags.push('E1');
  return FLAG_ORDER.filter((f) => flags.includes(f));
}

function rowFlags(o, th) {
  const flags = [];
  if (o.hrms !== null && o.hrms >= th.hrms_max) flags.push('X2');
  if (o.vrms !== null && o.vrms >= th.vrms_max) flags.push('X3');
  if (o.pdop !== null && o.pdop >= th.pdop_max) flags.push('X4');
  for (const f of o.obs_flags) flags.push(f);
  return FLAG_ORDER.filter((f) => flags.includes(f));
}

function maxNone(vals) {
  return maxOf(vals);
}

function meanOf(vals) {
  let total = 0.0;
  let cnt = 0;
  for (const v of vals) {
    if (v !== null && v !== undefined) { total += v; cnt++; }
  }
  return cnt ? total / cnt : null;
}

const byStart = (a, b) => cmp(a.start, b.start);

function summarizePoint(pid, obsIn, th) {
  const obs = obsIn.slice().sort(byStart);
  const n = obs.length;
  const pairs = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([obs[i], obs[j]]);

  const d2 = maxNone(pairs.map(([a, b]) => pair2d(a, b)));
  const dh = maxNone(pairs.map(([a, b]) => pairDh(a, b)));

  const startSecs = obs.map((o) => parseTimeSec(o.start)).filter((t) => t !== null);
  let interval = null;
  if (n >= 2 && startSecs.length >= 2) {
    interval = (Math.max(...startSecs) - Math.min(...startSecs)) / 60.0;
  }

  const startsS = obs.map((o) => o.start).filter((s) => s);
  const endsS = obs.map((o) => o.end).filter((s) => s);
  const minStr = (arr) => arr.reduce((a, b) => (b < a ? b : a));
  const maxStr = (arr) => arr.reduce((a, b) => (b > a ? b : a));

  const flags = [];
  if (n >= 2 && pairs.every(([a, b]) => sameBase(a, b, th))) flags.push('X1');
  if (obs.some((o) => o.hrms !== null && o.hrms >= th.hrms_max)) flags.push('X2');
  if (obs.some((o) => o.vrms !== null && o.vrms >= th.vrms_max)) flags.push('X3');
  if (obs.some((o) => o.pdop !== null && o.pdop >= th.pdop_max)) flags.push('X4');
  if (d2 !== null && d2 >= th.diff_2d_max) flags.push('X5');
  if (n === 1) flags.push('X6');
  if (obs.some((o) => o.obs_flags.includes('F1'))) flags.push('F1');
  if (obs.some((o) => o.obs_flags.includes('T1'))) flags.push('T1');
  if (obs.some((o) => o.obs_flags.includes('E1'))) flags.push('E1');
  if (n >= 2 && th.min_interval_min > 0 && interval !== null && interval < th.min_interval_min) flags.push('D1');

  const avgN = meanOf(obs.map((o) => o.n));
  const avgE = meanOf(obs.map((o) => o.e));
  const avgH = meanOf(obs.map((o) => o.h));

  return {
    id: pid, obs, n, avg_n: avgN, avg_e: avgE, avg_h: avgH, d2, dh,
    first_start: startsS.length ? minStr(startsS) : '',
    last_end: endsS.length ? maxStr(endsS) : '',
    interval, flags, known: null, n_t: null, e_t: null, h_t: null,
  };
}

function buildPoints(observations, th) {
  const groups = new Map();
  for (const o of observations) {
    if (!groups.has(o.id)) groups.set(o.id, []);
    groups.get(o.id).push(o);
  }
  const ids = Array.from(groups.keys()).sort(cmp);
  return ids.map((pid) => summarizePoint(pid, groups.get(pid), th));
}

// 點位使用的坐標：有轉換用轉換後 (n_t, e_t, h_t)，否則用平均坐標
function pointCoord(p) {
  if (p.n_t !== null && p.n_t !== undefined) return [p.n_t, p.e_t, p.h_t];
  return [p.avg_n, p.avg_e, p.avg_h];
}

const sortFlags = (flags) => FLAG_ORDER.filter((f) => flags.includes(f));

// 與已知點（--known）比對：用點位使用的坐標（有轉換用轉換後），超限加 K1
function applyKnown(points, th, knownMap) {
  if (!knownMap) return;
  for (const p of points) {
    const known = knownMap.get(p.id);
    if (!known) continue;
    const [kn, ke, kh] = known;
    const [cn, ce, ch] = pointCoord(p);
    const dn = cn - kn;
    const de = ce - ke;
    const d2k = dist2d(dn, de);
    const dhK = ch === null || kh === null ? null : ch - kh;
    const over = d2k >= th.known_tol_2d;
    p.known = { dn, de, d2: d2k, dh: dhK, over };
    if (over) p.flags = sortFlags(p.flags.concat(['K1']));
  }
}

/* ---------- 已知加密點連測與坐標轉換（同 rtkqc/transform.py，運算順序逐項相同） ---------- */

const METHODS = ['auto', 'shift', 'helmert', 'affine', 'none'];
const METHOD_LABEL = {
  shift: '坐標分量平移', helmert: '4 參數平面轉換', affine: '6 參數平面轉換', none: '不轉換',
};
const MIN_POINTS = { shift: 1, helmert: 2, affine: 3 };
const RAD_TO_SEC = 180.0 / Math.PI * 3600.0;

function solveLinear(m, v) {
  const n = v.length;
  const a = m.map((row, i) => row.concat([v[i]]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(a[col][col]);
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > best) { best = Math.abs(a[r][col]); piv = r; }
    }
    if (best < 1e-9) throw new InputError('共同點幾何不足（點位重合或共線），無法求解轉換參數');
    if (piv !== col) { const t = a[col]; a[col] = a[piv]; a[piv] = t; }
    for (let r = col + 1; r < n; r++) {
      const f = a[r][col] / a[col][col];
      for (let c = col; c <= n; c++) a[r][c] -= f * a[col][c];
    }
  }
  const x = new Array(n).fill(0.0);
  for (let r = n - 1; r >= 0; r--) {
    let s = a[r][n];
    for (let c = r + 1; c < n; c++) s -= a[r][c] * x[c];
    x[r] = s / a[r][r];
  }
  return x;
}

function chooseMethod(method, nCommon) {
  if (!METHODS.includes(method)) throw new InputError(`未知的轉換方法：${method}`);
  if (method === 'auto') return nCommon === 0 ? 'none' : (nCommon === 1 ? 'shift' : 'helmert');
  if (method === 'none') return 'none';
  const need = MIN_POINTS[method];
  if (nCommon < need) throw new InputError(`轉換方法 ${method} 需要至少 ${need} 個共同點，目前只有 ${nCommon} 個`);
  return method;
}

// common: [[n_obs, e_obs, n_known, e_known]]
function fitModel(method, common) {
  const cn = meanOf(common.map((c) => c[0]));
  const ce = meanOf(common.map((c) => c[1]));
  const model = { method, cn, ce };
  if (method === 'shift') {
    model.tN = meanOf(common.map((c) => c[2] - c[0]));
    model.tE = meanOf(common.map((c) => c[3] - c[1]));
    return model;
  }
  if (method === 'helmert') {
    const m = [0, 1, 2, 3].map(() => [0.0, 0.0, 0.0, 0.0]);
    const v = [0.0, 0.0, 0.0, 0.0];
    for (const [no, eo, nk, ek] of common) {
      const n = no - cn;
      const e = eo - ce;
      const sets = [[[n, -e, 1.0, 0.0], nk - cn], [[e, n, 0.0, 1.0], ek - ce]];
      for (const [row, rhs] of sets) {
        for (let r = 0; r < 4; r++) {
          for (let c = 0; c < 4; c++) m[r][c] += row[r] * row[c];
          v[r] += row[r] * rhs;
        }
      }
    }
    const [a, b, tn, te] = solveLinear(m, v);
    model.a = a; model.b = b; model.tN = tn; model.tE = te;
    model.scale_ppm = (Math.sqrt(a * a + b * b) - 1.0) * 1e6;
    model.rotation_sec = Math.atan2(b, a) * RAD_TO_SEC;
    return model;
  }
  const mn = [0, 1, 2].map(() => [0.0, 0.0, 0.0]);
  const me = [0, 1, 2].map(() => [0.0, 0.0, 0.0]);
  const vn = [0.0, 0.0, 0.0];
  const ve = [0.0, 0.0, 0.0];
  for (const [no, eo, nk, ek] of common) {
    const row = [no - cn, eo - ce, 1.0];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        mn[r][c] += row[r] * row[c];
        me[r][c] += row[r] * row[c];
      }
      vn[r] += row[r] * (nk - cn);
      ve[r] += row[r] * (ek - ce);
    }
  }
  const [a1, a2, tn] = solveLinear(mn, vn);
  const [b1, b2, te] = solveLinear(me, ve);
  Object.assign(model, { a1, a2, b1, b2, tN: tn, tE: te });
  return model;
}

function applyModel(m, n, e) {
  if (m.method === 'shift') return [n + m.tN, e + m.tE];
  const nc = n - m.cn;
  const ec = e - m.ce;
  if (m.method === 'helmert') {
    return [m.cn + (m.a * nc - m.b * ec) + m.tN, m.ce + (m.b * nc + m.a * ec) + m.tE];
  }
  return [m.cn + (m.a1 * nc + m.a2 * ec) + m.tN, m.ce + (m.b1 * nc + m.b2 * ec) + m.tE];
}

function wrapPi(d) {
  if (d > Math.PI) d -= 2.0 * Math.PI;
  else if (d < -Math.PI) d += 2.0 * Math.PI;
  return d;
}

// 以共同點（觀測點號 ∈ 加密點）算轉換與檢核；不轉換時回傳 null
function computeTransform(points, control, method, th) {
  const commonPts = points.filter((p) => control && control.has(p.id));
  method = chooseMethod(method, commonPts.length);
  if (method === 'none') return null;
  const nC = commonPts.length;
  const fitIn = commonPts.map((p) => {
    const k = control.get(p.id);
    return [p.avg_n, p.avg_e, k[0], k[1]];
  });
  const model = fitModel(method, fitIn);
  const redundancy = 2 * nC - { shift: 2, helmert: 4, affine: 6 }[method];

  const dhList = [];
  for (const p of commonPts) {
    const kh = control.get(p.id)[2];
    if (kh !== null && p.avg_h !== null) dhList.push(kh - p.avg_h);
  }
  const dh = meanOf(dhList);

  const pointFlags = new Map();
  const addFlag = (id, f) => {
    if (!pointFlags.has(id)) pointFlags.set(id, new Set());
    pointFlags.get(id).add(f);
  };
  const common = [];
  for (const p of commonPts) {
    const [kn, ke, kh] = control.get(p.id);
    const [nt, et] = applyModel(model, p.avg_n, p.avg_e);
    let ht;
    if (p.avg_h === null) ht = null;
    else ht = dh !== null ? p.avg_h + dh : p.avg_h;
    const vn = kn - nt;
    const ve = ke - et;
    const flags = [];
    if (Math.abs(vn) >= th.transform_resid_max || Math.abs(ve) >= th.transform_resid_max) {
      flags.push('C1');
      addFlag(p.id, 'C1');
    }
    common.push({
      id: p.id, n_obs: p.avg_n, e_obs: p.avg_e, h_obs: p.avg_h,
      n_known: kn, e_known: ke, h_known: kh, n_t: nt, e_t: et, h_t: ht,
      vn, ve, v2d: dist2d(vn, ve), flags,
    });
  }

  const pairs = [];
  for (let i = 0; i < common.length; i++) {
    for (let j = i + 1; j < common.length; j++) {
      const a = common[i];
      const b = common[j];
      const dkn = b.n_known - a.n_known;
      const dke = b.e_known - a.e_known;
      const dtn = b.n_t - a.n_t;
      const dte = b.e_t - a.e_t;
      const azK = Math.atan2(dke, dkn);
      const azT = Math.atan2(dte, dtn);
      const azSec = Math.abs(wrapPi(azT - azK) * RAD_TO_SEC);
      const dK = dist2d(dkn, dke);
      const dT = dist2d(dtn, dte);
      const diff = Math.abs(dT - dK);
      const flags = [];
      if (azSec >= th.azimuth_diff_max_sec) flags.push('C2');
      if (dK > 0 && diff * th.distance_ratio_min >= dK) flags.push('C3');
      for (const f of flags) { addFlag(a.id, f); addFlag(b.id, f); }
      pairs.push({
        i: a.id, j: b.id, az_diff_sec: azSec, d_known: dK, d_t: dT,
        ratio_den: diff !== 0 ? dK / diff : null, flags,
      });
    }
  }

  const notes = [];
  if (redundancy === 0) notes.push('無多餘觀測，殘差無檢核意義');
  if (dh === null) notes.push('高程未轉換（加密點或觀測缺少高程）');
  return { model, method, n_common: nC, redundancy, dh, common, pairs, note: notes.join('；'), point_flags: pointFlags };
}

// 替每個點位加上轉換後坐標 n_t/e_t/h_t，並把 C1～C3 掛到相關點位旗標
function applyToPoints(points, tf) {
  if (tf === null) return;
  for (const p of points) {
    const [nt, et] = applyModel(tf.model, p.avg_n, p.avg_e);
    p.n_t = nt;
    p.e_t = et;
    if (p.avg_h === null) p.h_t = null;
    else p.h_t = tf.dh !== null ? p.avg_h + tf.dh : p.avg_h;
    const extra = tf.point_flags.get(p.id);
    if (extra) p.flags = sortFlags(Array.from(new Set(p.flags.concat(Array.from(extra)))));
  }
}

// 每筆觀測找最近的加密點（用轉換後坐標；無轉換用原坐標）
function nearestControls(observations, control, tf) {
  const ids = control ? Array.from(control.keys()).sort(cmp) : [];
  const model = tf !== null ? tf.model : null;
  for (const o of observations) {
    o.nearest_control = null;
    o.nearest_control_dist = null;
    if (!ids.length) continue;
    const [n, e] = model !== null ? applyModel(model, o.n, o.e) : [o.n, o.e];
    for (const cid of ids) {
      const k = control.get(cid);
      const d = dist2d(n - k[0], e - k[1]);
      if (o.nearest_control_dist === null || d < o.nearest_control_dist) {
        o.nearest_control = cid;
        o.nearest_control_dist = d;
      }
    }
  }
}

// 每日連測檢查：回傳 [control_days, days_without_control]
function controlDaysOf(observations, control) {
  if (!control) return [[], []];
  const days = new Map();
  for (const o of observations) {
    if (!o.start) continue;
    const d = o.start.slice(0, 10);
    if (!days.has(d)) days.set(d, new Set());
    if (control.has(o.id)) days.get(d).add(o.id);
  }
  const keys = Array.from(days.keys()).sort(cmp);
  return [
    keys.map((d) => ({ date: d, control_points: Array.from(days.get(d)).sort(cmp) })),
    keys.filter((d) => days.get(d).size === 0),
  ];
}

function assignBases(observations, th) {
  const bases = [];
  for (const o of observations.slice().sort(byStart)) {
    let found = null;
    for (const b of bases) {
      if (b.base_id !== o.base_id) continue;
      if (b.lat === null && o.base_lat === null && b.lon === null && o.base_lon === null) { found = b; break; }
      if (b.lat === null || b.lon === null || o.base_lat === null || o.base_lon === null) continue;
      if (planeDist(b.lat, b.lon, o.base_lat, o.base_lon) < th.same_base_tol_m) { found = b; break; }
    }
    if (found === null) {
      const sameId = bases.filter((b) => b.base_id === o.base_id).length;
      let label = o.base_id || '';
      if (sameId) label = `${label}(${sameId + 1})`;
      let n = null;
      let e = null;
      if (o.base_lat !== null && o.base_lon !== null) [n, e] = TM(o.base_lat, o.base_lon);
      found = { label, base_id: o.base_id, lat: o.base_lat, lon: o.base_lon,
        alt: o.base_alt === undefined ? null : o.base_alt, n, e,
        h: o.base_alt === undefined ? null : o.base_alt, grid_shift_n: null, grid_shift_e: null,
        undulation: null, grid_corrected: false, count: 0 };
      bases.push(found);
    }
    found.count++;
    o.base_label = found.label;
  }
  correctBases(observations, bases);
  return bases;
}

// 以同主站觀測點的控制器網格坐標修正主站坐標的框架差（同 rtkqc/rules.py correct_bases）
function correctBases(observations, bases) {
  for (const b of bases) {
    const dn = [];
    const de = [];
    const du = [];
    for (const o of observations) {
      if (o.base_label !== b.label) continue;
      if (o.lat !== null && o.lat !== undefined && o.lon !== null && o.lon !== undefined) {
        const [tn, te] = TM(o.lat, o.lon);
        dn.push(o.n - tn);
        de.push(o.e - te);
      }
      if (o.alt !== null && o.alt !== undefined && o.h !== null) du.push(o.alt - o.h);
    }
    if (!dn.length || b.n === null) continue;
    b.grid_shift_n = meanOf(dn);
    b.grid_shift_e = meanOf(de);
    b.n += b.grid_shift_n;
    b.e += b.grid_shift_e;
    b.grid_corrected = true;
    if (du.length && b.alt !== null) {
      b.undulation = meanOf(du);
      b.h = b.alt - b.undulation;
    }
  }
}

function findNeighbors(points, th) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i];
      const b = points[j];
      const d = dist2d(a.avg_n - b.avg_n, a.avg_e - b.avg_e);
      if (d <= th.neighbor_max_m) out.push({ id: a.id, other: b.id, dist: d });
    }
  }
  return out;
}

function remeasureActions(flags) {
  const actions = [];
  for (const f of FLAG_ORDER) {
    if (flags.includes(f) && !actions.includes(ACTIONS[f])) actions.push(ACTIONS[f]);
  }
  return actions;
}

/* ---------- 正規 JSON ---------- */

function transformJson(tf) {
  if (tf === null) return null;
  const m = tf.model;
  const params = { tN: rnd(m.tN, 4), tE: rnd(m.tE, 4) };
  if (m.method === 'helmert') {
    Object.assign(params, { a: rnd(m.a, 12), b: rnd(m.b, 12), scale_ppm: rnd(m.scale_ppm, 3),
      rotation_sec: rnd(m.rotation_sec, 3) });
  } else if (m.method === 'affine') {
    Object.assign(params, { a1: rnd(m.a1, 12), a2: rnd(m.a2, 12), b1: rnd(m.b1, 12), b2: rnd(m.b2, 12) });
  }
  const common = tf.common.map((c) => ({
    id: c.id,
    n_obs: rnd(c.n_obs, 3), e_obs: rnd(c.e_obs, 3), h_obs: rnd(c.h_obs, 3),
    n_known: rnd(c.n_known, 3), e_known: rnd(c.e_known, 3), h_known: rnd(c.h_known, 3),
    n_t: rnd(c.n_t, 3), e_t: rnd(c.e_t, 3), h_t: rnd(c.h_t, 3),
    vn: rnd(c.vn, 4), ve: rnd(c.ve, 4), v2d: rnd(c.v2d, 4), flags: c.flags.slice(),
  }));
  const pairs = tf.pairs.map((x) => ({
    i: x.i, j: x.j, az_diff_sec: rnd(x.az_diff_sec, 2), d_known: rnd(x.d_known, 3),
    d_t: rnd(x.d_t, 3), ratio_den: rnd(x.ratio_den, 0), flags: x.flags.slice(),
  }));
  return {
    method: tf.method, n_common: tf.n_common, redundancy: tf.redundancy, params,
    centroid: { n: rnd(m.cn, 3), e: rnd(m.ce, 3) }, dh: rnd(tf.dh, 4), common, pairs, note: tf.note,
  };
}

function buildResult(observations, points, bases, pds, th, cx) {
  const obs = observations.map((o) => ({
    source: o.source, id: o.id, name: o.name, code: o.code,
    n: rnd(o.n, 3), e: rnd(o.e, 3), h: rnd(o.h, 3),
    start: o.start, end: o.end, epoch_n: o.epoch_n, fixed_n: o.fixed_n,
    hrms: rnd(o.hrms, 4), vrms: rnd(o.vrms, 4), pdop: rnd(o.pdop, 4), sat: o.sat,
    ep_hrms_max: rnd(o.ep_hrms_max, 4), ep_vrms_max: rnd(o.ep_vrms_max, 4),
    ep_pdop_max: rnd(o.ep_pdop_max, 4), ep_sat_min: o.ep_sat_min,
    ep_delay_max: rnd(o.ep_delay_max, 4),
    base_id: o.base_id, base_label: o.base_label,
    base_lat: rnd(o.base_lat, 8), base_lon: rnd(o.base_lon, 8), base_alt: rnd(o.base_alt, 3),
    dist_base: rnd(o.dist_base, 3), ant_h: rnd(o.ant_h, 3),
    pitch: rnd(o.pitch, 2), roll: rnd(o.roll, 2), tilt_off: rnd(o.tilt_off, 4),
    flags: o.obs_flags.slice(), row_flags: o.row_flags.slice(),
    nearest_control: o.nearest_control, nearest_control_dist: rnd(o.nearest_control_dist, 3),
  }));
  const pts = points.map((p) => ({
    id: p.id, count: p.n,
    avg_n: rnd(p.avg_n, 3), avg_e: rnd(p.avg_e, 3), avg_h: rnd(p.avg_h, 3),
    d2: rnd(p.d2, 4), dh: rnd(p.dh, 4),
    first_start: p.first_start, last_end: p.last_end,
    interval_min: rnd(p.interval, 2), flags: p.flags.slice(),
    n_t: rnd(p.n_t, 3), e_t: rnd(p.e_t, 3), h_t: rnd(p.h_t, 3),
  }));
  const baseList = bases.map((b) => ({
    label: b.label, base_id: b.base_id, lat: rnd(b.lat, 8), lon: rnd(b.lon, 8),
    alt: rnd(b.alt, 3), n: rnd(b.n, 3), e: rnd(b.e, 3), h: rnd(b.h, 3),
    grid_shift_n: rnd(b.grid_shift_n, 4), grid_shift_e: rnd(b.grid_shift_e, 4),
    undulation: rnd(b.undulation, 3), grid_corrected: !!b.grid_corrected, count: b.count,
  }));
  const neighbors = findNeighbors(points, th).map((x) => ({ id: x.id, other: x.other, dist: rnd(x.dist, 3) }));
  const remeasure = points.filter((p) => p.flags.length).map((p) => ({
    id: p.id, flags: p.flags.slice(), actions: remeasureActions(p.flags),
    avg_n: rnd(p.avg_n, 3), avg_e: rnd(p.avg_e, 3),
  }));
  const known = points.filter((p) => p.known).map((p) => ({
    id: p.id, dn: rnd(p.known.dn, 4), de: rnd(p.known.de, 4), d2: rnd(p.known.d2, 4),
    dh: rnd(p.known.dh, 4), over: !!p.known.over,
  }));
  return {
    version: VERSION,
    thresholds: Object.assign({}, th),
    inputs: pds.map((pd) => ({
      name: pd.name, sha256: pd.sha256,
      observations: observations.filter((o) => o.source === pd.name).length,
    })),
    observations: obs,
    points: pts,
    bases: baseList,
    neighbors,
    remeasure,
    known_check: known,
    mode: cx.mode,
    transform: transformJson(cx.tf),
    control_days: cx.controlDays.map((d) => ({ date: d.date, control_points: d.control_points.slice() })),
    days_without_control: cx.daysWithoutControl.slice(),
  };
}

/**
 * 分析一組已讀入的 .PD。
 * opts: { pds, thresholds, known (Map|null), knownName, mode ('survey'|'control'),
 *        control (Map|null)、controlName、transform ('auto'|'shift'|'helmert'|'affine'|'none') }
 * 回傳 { th, pds(去重後), warnings, observations, points, bases, result, knownName, mode, tf,
 *        controlName, controlDays, daysWithoutControl }
 * 轉換條件不足（例如 affine 少於 3 點）時丟出 InputError。
 */
function analyze(opts) {
  const mode = opts.mode || 'survey';
  const th = normalizeThresholds(opts.thresholds, mode);
  const warnings = [];
  const seen = new Map();
  const unique = [];
  for (const pd of opts.pds) {
    if (seen.has(pd.sha256)) {
      warnings.push(`警告：${pd.name} 與 ${seen.get(pd.sha256)} 內容相同（sha256 一致），已略過重複輸入`);
      continue;
    }
    seen.set(pd.sha256, pd.name);
    unique.push(pd);
  }
  for (const pd of unique) for (const w of pd.warnings) warnings.push(w);

  const observations = [];
  for (const pd of unique) for (const o of pd.observations) observations.push(Object.assign({}, o));
  for (const o of observations) o.obs_flags = obsFlags(o, th);
  const bases = assignBases(observations, th);
  for (const o of observations) o.row_flags = rowFlags(o, th);
  observations.sort((a, b) => cmp(a.id, b.id) || cmp(a.start, b.start));

  const known = opts.known || null;
  const control = opts.control || null;
  const points = buildPoints(observations, th);
  const tf = computeTransform(points, control, opts.transform || 'auto', th);
  applyToPoints(points, tf);
  nearestControls(observations, control, tf);
  applyKnown(points, th, known);
  const [controlDays, daysWithoutControl] = controlDaysOf(observations, control);
  if (daysWithoutControl.length) {
    warnings.push('警告：以下日期沒有連測任何已知加密點：' + daysWithoutControl.join('、'));
  }
  const cx = { mode, tf, controlDays, daysWithoutControl };
  const result = buildResult(observations, points, bases, unique, th, cx);
  return {
    th, pds: unique, warnings, observations, points, bases, result, knownName: opts.knownName || null,
    mode, tf, controlName: control ? (opts.controlName || null) : null, controlDays, daysWithoutControl,
  };
}

/* ---------- 輸出 ---------- */

const OBS_HEADER = [
  '來源檔名', '點號', 'NAME', 'CODE', 'N', 'E', 'H', '開始時間', '結束時間',
  'epoch數', 'FIXED epoch數', 'HRMS', 'VRMS', 'PDOP', '衛星數',
  'epoch最大HRMS', 'epoch最大VRMS', 'epoch最大PDOP', 'epoch最小衛星數',
  'epoch最大延遲', 'Base_ID', '基站緯度', '基站經度', '主站距離', '天線高',
  'Pitch', 'Roll', '傾斜偏移量', '該筆旗標',
];
const POINT_HEADER = [
  '點號', '觀測數', '平均N', '平均E', '平均H', '兩次較差2D(m)', '高程較差(m)',
  '最早觀測時間', '最晚觀測時間', '兩次觀測時間間隔(分鐘)', '旗標',
];
const OBS_CONTROL_HEADER = ['最近已知加密點', '距最近加密點(m)'];
const POINT_TRANSFORM_HEADER = ['轉換後N', '轉換後E', '轉換後H'];
const TRANSFORM_HEADER = [
  '點號', '觀測N', '觀測E', '觀測H', '已知N', '已知E', '已知H', '轉換後N', '轉換後E',
  '轉換後H', 'vN', 'vE', 'v2D', '旗標',
];
const PAIRS_HEADER = ['點號i', '點號j', '方位角較差(秒)', '已知距離(m)', '轉換後距離(m)',
  '相對較差比值分母', '旗標'];
const REMEASURE_HEADER = ['點號', '旗標', '建議動作', '平均N', '平均E'];
const KNOWN_HEADER = ['點號', 'dN', 'dE', 'd2D', 'dH', '是否超限'];

function csvField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function csvText(header, rows) {
  const lines = [header].concat(rows).map((r) => r.map(csvField).join(','));
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

function observationRows(observations, controlGiven) {
  return observations.map((o) => {
    const row = [
    o.source, o.id, o.name, o.code,
    fmt(o.n, 3), fmt(o.e, 3), fmt(o.h, 3),
    o.start, o.end, o.epoch_n, o.fixed_n,
    fmt(o.hrms, 4), fmt(o.vrms, 4), fmt(o.pdop, 4),
    o.sat === null || o.sat === undefined ? '' : o.sat,
    fmt(o.ep_hrms_max, 4), fmt(o.ep_vrms_max, 4), fmt(o.ep_pdop_max, 4),
    o.ep_sat_min === null || o.ep_sat_min === undefined ? '' : o.ep_sat_min,
    fmt(o.ep_delay_max, 4),
    o.base_id || '', fmt(o.base_lat, 8), fmt(o.base_lon, 8),
    fmt(o.dist_base, 3), fmt(o.ant_h, 3),
    fmt(o.pitch, 2), fmt(o.roll, 2), fmt(o.tilt_off, 4),
    o.obs_flags.join(';'),
    ];
    if (controlGiven) row.push(o.nearest_control || '', fmt(o.nearest_control_dist, 3));
    return row;
  });
}

function pointRows(points, withTransform) {
  return points.map((p) => {
    const row = [
      p.id, p.n, fmt(p.avg_n, 3), fmt(p.avg_e, 3), fmt(p.avg_h, 3),
      fmt(p.d2, 4), fmt(p.dh, 4), p.first_start, p.last_end, fmt(p.interval, 2),
      p.flags.join(';'),
    ];
    if (withTransform) row.push(fmt(p.n_t, 3), fmt(p.e_t, 3), fmt(p.h_t, 3));
    return row;
  });
}

function transformRows(tf) {
  return tf.common.map((c) => [
    c.id, fmt(c.n_obs, 3), fmt(c.e_obs, 3), fmt(c.h_obs, 3),
    fmt(c.n_known, 3), fmt(c.e_known, 3), fmt(c.h_known, 3),
    fmt(c.n_t, 3), fmt(c.e_t, 3), fmt(c.h_t, 3),
    fmt(c.vn, 4), fmt(c.ve, 4), fmt(c.v2d, 4), c.flags.join(';'),
  ]);
}

function pairRows(tf) {
  return tf.pairs.map((x) => [
    x.i, x.j, fmt(x.az_diff_sec, 2), fmt(x.d_known, 3), fmt(x.d_t, 3),
    fmt(x.ratio_den, 0), x.flags.join(';'),
  ]);
}

function remeasureRows(points) {
  return points.filter((p) => p.flags.length).map((p) => [
    p.id, p.flags.join(';'), remeasureActions(p.flags).join('；'),
    fmt(p.avg_n, 3), fmt(p.avg_e, 3),
  ]);
}

function knownRows(points) {
  return points.filter((p) => p.known).map((p) => [
    p.id, fmt(p.known.dn, 4), fmt(p.known.de, 4), fmt(p.known.d2, 4),
    fmt(p.known.dh, 4), p.known.over ? '是' : '否',
  ]);
}

function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function sortedAntennas(pds) {
  const seen = new Set();
  const list = [];
  for (const pd of pds) {
    for (const [s, t] of pd.antennas) {
      const key = JSON.stringify([s, t]);
      if (!seen.has(key)) { seen.add(key); list.push([s, t]); }
    }
  }
  return list.sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]));
}

function handbookHtml(observations, points, pds, th, mode, tf) {
  mode = mode || 'survey';
  const dates = Array.from(new Set(observations.filter((o) => o.start).map((o) => o.start.slice(0, 10)))).sort(cmp);
  let dateText = dates.length ? dates.join('、') : '未知';
  if (dates.length > 1) dateText = `${dates[0]} ～ ${dates[dates.length - 1]}（${dates.length} 天）`;
  const antennas = sortedAntennas(pds).map(([s, t]) => `${t} ${s}`).join('、') || '未知';
  const inputs = pds.map((pd) => `<li>${esc(pd.name)}（sha256 ${esc(pd.sha256.slice(0, 12))}）</li>`).join('');

  const body = [];
  for (const p of points) {
    const note = p.flags.join(';');
    const first = p.obs[0];
    p.obs.forEach((o, k) => {
      const diff = k === 0 ? '' : fmt(pair2d(first, o), 4);
      body.push(
        '<tr>' +
        `<td>${esc(o.base_id || '')}</td>` +
        `<td>${esc(p.id)}</td>` +
        `<td class="num">${esc(fmt(o.n, 3))}</td>` +
        `<td class="num">${esc(fmt(o.e, 3))}</td>` +
        `<td class="num">${esc(fmt(o.h, 3))}</td>` +
        `<td class="num">${esc(fmt(o.hrms, 4))}</td>` +
        `<td class="num">${esc(fmt(o.vrms, 4))}</td>` +
        `<td class="num">${esc(fmt(o.pdop, 2))}</td>` +
        `<td class="num">${esc(diff)}</td>` +
        `<td class="num">${esc(fmt(o.dist_base, 1))}</td>` +
        `<td>${esc(o.start)}</td>` +
        `<td class="num">${esc(o.epoch_n)}</td>` +
        `<td>${esc(note)}</td>` +
        '</tr>');
    });
  }
  const flagItems = FLAG_ORDER.map((f) => `<li><b>${esc(f)}</b> ${esc(FLAG_DESC[f])}</li>`).join('');
  const rowsHtml = body.length ? body.join('\n') : '<tr><td colspan="13">無觀測資料</td></tr>';

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<title>RTK 觀測手簿</title>
<style>
@page { size: A4 landscape; margin: 12mm; }
body { font-family: "Microsoft JhengHei", "PingFang TC", sans-serif; color: #111; font-size: 11px; }
h1 { font-size: 18px; margin: 0 0 6px; }
.meta { margin-bottom: 8px; line-height: 1.6; }
.meta ul { margin: 2px 0 0 18px; padding: 0; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #555; padding: 3px 4px; }
th { background: #e8e8e8; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.foot { margin-top: 8px; line-height: 1.6; }
.foot ul { margin: 2px 0 0 18px; padding: 0; columns: 2; }
@media print { thead { display: table-header-group; } tr { page-break-inside: avoid; } }
</style>
</head>
<body>
<h1>RTK 觀測手簿（VBS-RTK）</h1>
<div class="meta">
<div>接收儀型號與序號：${esc(antennas)}</div>
<div>觀測日期（來源資料）：${esc(dateText)}</div>
<div>輸入檔名與 sha256 前 12 碼：<ul>${inputs}</ul></div>
<div>工具版本：rtkqc ${esc(VERSION)}　門檻：平面 HRMS ${esc(pyNum(th.hrms_max))} m／高程 VRMS ${esc(pyNum(th.vrms_max))} m／PDOP ${esc(pyNum(th.pdop_max))}／兩次較差 ${esc(pyNum(th.diff_2d_max))} m</div>
<div>作業模式：${esc(MODE_LABEL[mode])}　坐標轉換：${esc(METHOD_LABEL[tf ? tf.method : 'none'])}</div>
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
${rowsHtml}
</tbody>
</table>
<div class="foot">旗標說明：<ul>${flagItems}</ul></div>
</body>
</html>
`;
}

function manifestObject(an, argv, runTime) {
  const flagStats = {};
  for (const f of FLAG_ORDER) flagStats[f] = 0;
  for (const p of an.points) for (const f of p.flags) flagStats[f]++;
  return {
    tool: 'rtkqc',
    version: VERSION,
    run_time: runTime,
    argv,
    thresholds: an.th,
    known_file: an.knownName,
    mode: an.mode,
    control_file: an.controlName,
    transform: an.tf === null ? null : {
      method: an.tf.method, n_common: an.tf.n_common, redundancy: an.tf.redundancy,
    },
    days_without_control: an.daysWithoutControl.slice(),
    inputs: an.pds.map((pd) => ({
      name: pd.name, size: pd.size, sha256: pd.sha256,
      observations: an.observations.filter((o) => o.source === pd.name).length,
      deleted_points: pd.deleted_count,
    })),
    observation_count: an.observations.length,
    point_count: an.points.length,
    flag_stats: flagStats,
    points_with_flags: an.points.filter((p) => p.flags.length).length,
  };
}

function ctlText(points) {
  return points.map((p) => {
    const id = String(p.id);
    const pad = Math.max(0, 8 - Array.from(id).length);
    const [n, e] = pointCoord(p);
    return ' '.repeat(pad) + id + ' ' + fmt(n, 3) + ' ' + fmt(e, 3) + '\r\n';
  }).join('');
}

/** 產生所有文字輸出，回傳 { 檔名: 字串 }（CSV 以 BOM 開頭）。 */
function textOutputs(an, runTime, argv) {
  const controlGiven = an.controlName !== null;
  const files = {
    'observations.csv': csvText(controlGiven ? OBS_HEADER.concat(OBS_CONTROL_HEADER) : OBS_HEADER,
      observationRows(an.observations, controlGiven)),
    'points.csv': csvText(an.tf ? POINT_HEADER.concat(POINT_TRANSFORM_HEADER) : POINT_HEADER,
      pointRows(an.points, an.tf !== null)),
    'remeasure.csv': csvText(REMEASURE_HEADER, remeasureRows(an.points)),
    'handbook.html': handbookHtml(an.observations, an.points, an.pds, an.th, an.mode, an.tf),
  };
  if (an.knownName !== null) files['known_check.csv'] = csvText(KNOWN_HEADER, knownRows(an.points));
  if (an.tf) {
    files['transform.csv'] = csvText(TRANSFORM_HEADER, transformRows(an.tf));
    files['transform_pairs.csv'] = csvText(PAIRS_HEADER, pairRows(an.tf));
  }
  files['manifest.json'] = JSON.stringify(manifestObject(an, argv || ['rtkqc.html'], runTime), null, 2) + '\n';
  files['control.ctl'] = ctlText(an.points);
  return files;
}

/** 語意化版本比較：a>b 回傳 1、a<b 回傳 -1、相等 0；格式不符回傳 null。 */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

const api = {
  VERSION, InputError, DEFAULT_THRESHOLDS, MODES, MODE_DEFAULTS, MODE_LABEL, METHODS, METHOD_LABEL,
  FLAG_ORDER, FLAG_DESC, ACTIONS, pointCoord,
  roundStr, rnd, fmt, pyNum, lonlatToTm2: TM, readPD, parseKnownCsv, normalizeThresholds,
  analyze, compareVersions, csvText, ctlText, handbookHtml, manifestObject, textOutputs, sha256Hex, sortedAntennas,
  OBS_HEADER, POINT_HEADER, REMEASURE_HEADER, KNOWN_HEADER, TRANSFORM_HEADER, PAIRS_HEADER,
};
return api;
})();

if (typeof module !== 'undefined') module.exports = RTKQC;
