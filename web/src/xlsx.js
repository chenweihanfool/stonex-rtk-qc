/* 最小 OOXML（.xlsx）寫入器＋ZIP（stored）：不使用任何外部函式庫。
 * 產出格式比照 113 年「RTK 圖根測量觀測彙整檔（標準版）」。
 */
var RTKXLSX = (function () {
'use strict';

/* ---------- CRC32 與 ZIP（stored，不壓縮） ---------- */

const CRC_TABLE = (function () {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();
const toBytes = (v) => (typeof v === 'string' ? encoder.encode(v) : v);

function dosDateTime(date) {
  if (!date) return { time: 0, date: (0 << 9) | (1 << 5) | 1 }; // 1980-01-01 00:00:00
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** entries: [{ name, data(string|Uint8Array) }] → Uint8Array（ZIP，stored，檔名 UTF-8） */
function zip(entries, when) {
  const dt = dosDateTime(when);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const ent of entries) {
    const name = encoder.encode(ent.name);
    const data = toBytes(ent.data);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8 檔名
    lh.setUint16(8, 0, true); // stored
    lh.setUint16(10, dt.time, true);
    lh.setUint16(12, dt.date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dt.time, true);
    ch.setUint16(14, dt.date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint16(30, 0, true);
    ch.setUint16(32, 0, true);
    ch.setUint16(34, 0, true);
    ch.setUint16(36, 0, true);
    ch.setUint32(38, 0, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  const all = parts.concat(central, [new Uint8Array(eocd.buffer)]);
  let total = 0;
  for (const p of all) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of all) { out.set(p, pos); pos += p.length; }
  return out;
}

/* ---------- XML 工具 ---------- */

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function xmlEsc(s) {
  return String(s)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function colName(i) { // 0 → A
  let s = '';
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

/* 樣式索引（cellXfs） */
const ST = { NORMAL: 0, HEADER: 1, TEXT: 2, N3: 3, N1: 4, N2: 5, INT: 6, BOLD: 7, N4: 8 };

function stylesXml() {
  const font = (bold) => '<font>' + (bold ? '<b/>' : '') +
    '<sz val="12"/><name val="新細明體"/><family val="1"/><charset val="136"/></font>';
  const thin = '<border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right>' +
    '<top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border>';
  const xf = (numFmt, font, fill, border, align) =>
    `<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0"` +
    (numFmt ? ' applyNumberFormat="1"' : '') + (font ? ' applyFont="1"' : '') +
    (fill ? ' applyFill="1"' : '') + (border ? ' applyBorder="1"' : '') +
    (align ? ' applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' : '/>');
  return XML_HEAD +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="3"><numFmt numFmtId="164" formatCode="0.000"/><numFmt numFmtId="165" formatCode="0.0"/>' +
    '<numFmt numFmtId="166" formatCode="0.0000"/></numFmts>' +
    `<fonts count="2">${font(false)}${font(true)}</fonts>` +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>${thin}</borders>` +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="9">' +
    xf(0, 0, 0, 0, false) + // 0 一般
    xf(0, 1, 2, 1, true) + // 1 表頭
    xf(0, 0, 0, 1, false) + // 2 文字（框線）
    xf(164, 0, 0, 1, false) + // 3 0.000
    xf(165, 0, 0, 1, false) + // 4 0.0
    xf(2, 0, 0, 1, false) + // 5 0.00
    xf(1, 0, 0, 1, false) + // 6 整數
    xf(0, 1, 0, 0, false) + // 7 粗體（無框）
    xf(166, 0, 0, 1, false) + // 8 0.0000
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';
}

/* ---------- 工作表 ---------- */

// cell: null | string | number | { v, s, f }
function cellXml(ref, cell) {
  if (cell === null || cell === undefined) return '';
  const c = (typeof cell === 'object') ? cell : { v: cell };
  const s = c.s ? ` s="${c.s}"` : '';
  if (c.f !== undefined) {
    return `<c r="${ref}"${s}><f>${xmlEsc(c.f).replace(/&quot;/g, '"')}</f><v></v></c>`;
  }
  if (c.v === null || c.v === undefined || c.v === '') return c.s ? `<c r="${ref}"${s}/>` : '';
  if (typeof c.v === 'number') {
    if (!Number.isFinite(c.v)) return `<c r="${ref}"${s}/>`;
    return `<c r="${ref}"${s}><v>${c.v}</v></c>`;
  }
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(c.v)}</t></is></c>`;
}

function sheetXml(sheet) {
  let rows = '';
  sheet.rows.forEach((row, ri) => {
    let cells = '';
    row.forEach((cell, ci) => { cells += cellXml(colName(ci) + (ri + 1), cell); });
    if (cells) rows += `<row r="${ri + 1}">${cells}</row>`;
  });
  const cols = sheet.cols.map((w, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const merges = sheet.merges && sheet.merges.length
    ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
    : '';
  return XML_HEAD +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<cols>${cols}</cols><sheetData>${rows}</sheetData>${merges}</worksheet>`;
}

const H = (v) => ({ v, s: ST.HEADER });
const T = (v) => ({ v, s: ST.TEXT });
const N3 = (v) => ({ v, s: ST.N3 });

const POINT_LEVEL_FLAGS = ['X1', 'X5', 'X6', 'D1', 'K1', 'C1', 'C2', 'C3'];
const FLAG_ORDER = ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'F1', 'T1', 'E1', 'D1', 'K1', 'C1', 'C2', 'C3'];
const METHOD_LABEL = {
  shift: '坐標分量平移', helmert: '4 參數平面轉換', affine: '6 參數平面轉換', none: '不轉換',
};
const MODE_LABEL = { survey: '現況／界址（survey）', control: '圖根（control）' };
const N4 = (v) => ({ v, s: ST.N4 });
const N2 = (v) => ({ v, s: ST.N2 });

// 「已知點連測與轉換」工作表：上方參數與檢核標準、中段共同點殘差、下段兩兩（方位角／邊長）檢核
function controlSheet(result) {
  const tf = result.transform || null;
  const th = result.thresholds || {};
  const resid = th.transform_resid_max === undefined ? 0.098 : th.transform_resid_max;
  const azMax = th.azimuth_diff_max_sec === undefined ? 20 : th.azimuth_diff_max_sec;
  const ratioMin = th.distance_ratio_min === undefined ? 20000 : th.distance_ratio_min;
  const rows = [[{ v: '已知點連測與轉換', s: ST.BOLD }]];
  const kv = (k, v) => rows.push([T(k), typeof v === 'object' && v !== null ? v : T(v)]);
  kv('作業模式', MODE_LABEL[result.mode] || String(result.mode || ''));
  kv('轉換方法', tf ? METHOD_LABEL[tf.method] : '不轉換（沒有共同點，或指定不轉換）');
  if (tf) {
    kv('共同點數', { v: tf.n_common, s: ST.INT });
    kv('多餘觀測數', { v: tf.redundancy, s: ST.INT });
    const pr = tf.params;
    kv('tN（重心處平移，m）', N4(pr.tN));
    kv('tE（重心處平移，m）', N4(pr.tE));
    if (tf.method === 'helmert') {
      kv('尺度（ppm）', N3(pr.scale_ppm));
      kv('旋轉（秒）', N3(pr.rotation_sec));
      kv('a（尺度×cos 旋轉角）', pr.a.toFixed(12));
      kv('b（尺度×sin 旋轉角）', pr.b.toFixed(12));
    } else if (tf.method === 'affine') {
      for (const k of ['a1', 'a2', 'b1', 'b2']) kv(k, pr[k].toFixed(12));
    }
    kv('重心坐標 N、E（觀測，m）', T(tf.centroid.n.toFixed(3) + '、' + tf.centroid.e.toFixed(3)));
    kv('高程處理', tf.dh === null || tf.dh === undefined
      ? '高程未轉換（加密點或觀測缺少高程）'
      : '平均高程差 dH = ' + tf.dh.toFixed(4) + ' m（轉換後高程＝觀測高程＋dH）');
    if (tf.note) kv('註記', tf.note);
  }
  kv('檢核標準', '共同點坐標分量改正數 < ' + (resid * 100).toFixed(1) + ' cm；共同點間方位角較差 < ' + azMax +
    ' 秒；水平距相對較差 < 1/' + ratioMin + '（依國土測繪中心 VBS-RTK 辦理加密控制及圖根測量作業手冊）');
  const missing = result.days_without_control || [];
  kv('未連測已知加密點的日期', missing.length ? missing.join('、') : '無');
  if (tf) {
    rows.push([]);
    rows.push([{ v: '共同點殘差（已知 − 轉換後）', s: ST.BOLD }]);
    rows.push(['點號', '觀測N', '觀測E', '觀測H', '已知N', '已知E', '已知H', '轉換後N', '轉換後E', '轉換後H',
      'vN(m)', 'vE(m)', 'v2D(m)', '檢核'].map(H));
    for (const c of tf.common) {
      rows.push([T(c.id), N3(c.n_obs), N3(c.e_obs), N3(c.h_obs), N3(c.n_known), N3(c.e_known), N3(c.h_known),
        N3(c.n_t), N3(c.e_t), N3(c.h_t), N4(c.vn), N4(c.ve), N4(c.v2d), T(c.flags.length ? c.flags.join(',') : 'OK')]);
    }
    rows.push([]);
    rows.push([{ v: '共同點間方位角與邊長檢核', s: ST.BOLD }]);
    rows.push(['點號i', '點號j', '方位角較差(秒)', '已知距離(m)', '轉換後距離(m)', '相對較差比值分母', '檢核'].map(H));
    for (const x of tf.pairs) {
      rows.push([T(x.i), T(x.j), N2(x.az_diff_sec), N3(x.d_known), N3(x.d_t),
        { v: x.ratio_den, s: ST.INT }, T(x.flags.length ? x.flags.join(',') : 'OK')]);
    }
  }
  return { name: '已知點連測與轉換', cols: [26, 15, 15, 15, 15, 15, 12, 15, 15, 12, 11, 11, 11, 10], rows };
}

function baseNote(bases) {
  const ok = bases.filter((b) => b.grid_corrected);
  if (!ok.length) return 'VBS 虛擬基站；縱橫坐標＝經緯度換算 TM2（未修正框架差：缺少觀測點經緯度）；高程為橢球高。';
  const mean = (k) => ok.reduce((s, b) => s + b[k], 0) / ok.length;
  const f4 = (v) => v.toFixed(4);
  return 'VBS 虛擬基站；縱橫坐標＝經緯度換算 TM2 後，以同主站觀測點的控制器網格坐標修正框架差' +
    `（平均 dN=${f4(mean('grid_shift_n'))}, dE=${f4(mean('grid_shift_e'))} m）；高程＝橢球高減平均大地起伏。`;
}

function neighborFormulas(r) {
  const C = 'C' + r;
  const D = 'D' + r;
  const E = 'E' + r;
  const F = 'F' + r;
  return {
    E: `IF(${D}="","",ROUND(ABS(${D}-${C})*100,2))`,
    F: `IF(OR(${D}="",${E}=""),"",IF(${E}=0,"",ROUND(${C}/(${E}/100),0)))`,
    G: `IF(${D}="","",IF(AND(${E}<=3,IF(${F}="",TRUE,${F}>=3000)),"OK",` +
      `IF(${E}>3,"較差>3cm ","")&IF(${F}="","",IF(${F}<3000,"相對較差比值分母<3000",""))))`,
  };
}

/**
 * 依正規 JSON 結果組出 6～8 張工作表規格（有已知點檢核＋有加密點連測時最多 8 張）。
 * ctx: { antennas: [[編號, 型號]...], sources: [檔名...], runTime: '產製時間字串', version,
 *        hasKnown（有 --known）, hasControl（有 --control：多「已知點連測與轉換」表與觀測表 N、O 欄）}
 */
function buildSheets(result, ctx) {
  const sheets = [];

  // 1. 接收儀資訊表
  const rec = [
    [H('接收儀資訊'), H(''), H(''), H(''), H('')],
    [H('廠牌'), H('型號'), H('編號'), H('接收頻道數')],
  ];
  for (const [id, type] of ctx.antennas) rec.push([T('Stonex'), T(type), T(id), T('')]);
  sheets.push({ name: '接收儀資訊表', cols: [10, 16, 16, 14, 10], rows: rec, merges: ['A1:E1'] });

  // 2. 主站坐標表
  const bases = [[H('主站點名'), H('縱座標'), H('橫坐標'), H('高程坐標')]];
  for (const b of result.bases) bases.push([T(b.label), N3(b.n), N3(b.e), N3(b.h)]);
  bases.push([]);
  bases.push([baseNote(result.bases)]);
  sheets.push({ name: '主站坐標表', cols: [16, 15, 15, 15], rows: bases });

  // 3. 觀測資料彙整表
  const byId = new Map(result.points.map((p) => [p.id, p]));
  const obs = [
    [{ v: 'RTK圖根測量觀測資料彙整表', s: ST.BOLD }],
    [`來源：${ctx.sources.join('、')}　產製：${ctx.runTime}　rtkqc ${ctx.version}`],
    ['F1：表有非固定解 epoch。　T1：表桿傾斜偏移未小於1cm。　D1：表兩次觀測間隔不足。　K1：表與已知點較差超限。' +
      '　E1：表固定解筆數不足。　C1：表共同點轉換後坐標分量改正數超限。　C2：表共同點間方位角較差超限。' +
      '　C3：表共同點間水平距相對較差超限。'],
    ['備註欄說明', null, 'X1：表兩次觀測採相同主站。', null, 'X2:表固定解平面誤差未小於2cm。', null, null, null,
      'X3：表固定解高程誤差未小於5cm。'],
    [null, null, 'X4：表PDOP值未小於10。', null, 'X5：表兩次較差未小於2cm', null, null, 'X6:表僅有一個觀測值'],
    ['主站點名', '測站點名', '縱坐標(m)', '橫坐標(m)', '高程坐標(m)', '固定解平面誤差(m)', '固定解高程誤差(m)',
      'PDOP值', '兩次觀測較差(m)', '主站與移動站距離', '備註', '觀測時間', 'epoch數']
      .concat(ctx.hasControl ? ['最近已知加密點', '距離(m)'] : []).map(H),
  ];
  for (const o of result.observations) {
    const p = byId.get(o.id);
    const flags = new Set(o.row_flags);
    if (p) for (const f of p.flags) if (POINT_LEVEL_FLAGS.includes(f)) flags.add(f);
    const note = FLAG_ORDER.filter((f) => flags.has(f)).join(',');
    obs.push([
      T(o.base_label), T(o.id), N3(o.n), N3(o.e), N3(o.h), N3(o.hrms), N3(o.vrms),
      { v: o.pdop, s: ST.N1 }, N3(p && p.count >= 2 ? p.d2 : null), N3(o.dist_base),
      T(note), T(o.start), { v: o.epoch_n, s: ST.INT },
    ].concat(ctx.hasControl ? [T(o.nearest_control || ''), N3(o.nearest_control_dist)] : []));
  }
  sheets.push({
    name: '觀測資料彙整表',
    cols: [10, 11, 13, 13, 13, 13, 13, 9, 10.5, 11.5, 14, 18, 8].concat(ctx.hasControl ? [16, 11] : []),
    rows: obs,
  });

  // 4. 點位坐標平均值表
  const pts = [['點名', '縱坐標', '橫坐標', '高程坐標', '備註'].map(H)];
  const tfm = result.transform || null;
  for (const p of result.points) {
    const conv = tfm && p.n_t !== null && p.n_t !== undefined;
    pts.push([T(p.id), N3(conv ? p.n_t : p.avg_n), N3(conv ? p.e_t : p.avg_e), N3(conv ? p.h_t : p.avg_h),
      T(p.flags.join(','))]);
  }
  if (tfm) {
    pts.push([]);
    pts.push(['坐標已由 e-GNSS 以 ' + METHOD_LABEL[tfm.method] + ' 轉換為法定坐標']);
  }
  sheets.push({ name: '點位坐標平均值表', cols: [12, 15, 15, 15, 18], rows: pts });

  // 5. 相鄰點位檢核表（D 留空，E/F/G 為公式）
  const nb = [['測站點名', '相鄰點名', '坐標反算距離(m)', '直接量測距離(m)', '較差(cm)', '相對較差比值', '檢核結果'].map(H)];
  result.neighbors.forEach((x, i) => {
    const f = neighborFormulas(i + 2);
    nb.push([T(x.id), T(x.other), N3(x.dist), { v: null, s: ST.N3 },
      { f: f.E, s: ST.N2 }, { f: f.F, s: ST.INT }, { f: f.G, s: ST.TEXT }]);
  });
  sheets.push({ name: '相鄰點位檢核表', cols: [12, 12, 17, 17, 11, 14, 30], rows: nb });

  // 5b. 已知點連測與轉換（只在有加密點成果表時）
  if (ctx.hasControl) sheets.push(controlSheet(result));

  // 6. 隔天重測清單
  const rem = [['點號', '旗標', '建議動作', '平均N', '平均E'].map(H)];
  for (const r of result.remeasure) rem.push([T(r.id), T(r.flags.join(';')), T(r.actions.join('；')), N3(r.avg_n), N3(r.avg_e)]);
  sheets.push({ name: '隔天重測清單', cols: [12, 14, 46, 15, 15], rows: rem });

  // 7. 已知點檢核（只在有已知點檔時）
  if (ctx.hasKnown) {
    const kn = [['點號', 'dN', 'dE', 'd2D', 'dH', '是否超限'].map(H)];
    for (const k of result.known_check) {
      kn.push([T(k.id), { v: k.dn, s: ST.N4 }, { v: k.de, s: ST.N4 }, { v: k.d2, s: ST.N4 },
        { v: k.dh, s: ST.N4 }, T(k.over ? '是' : '否')]);
    }
    if (result.transform) {
      kn.push([]);
      kn.push(['比對坐標：已轉換（' + METHOD_LABEL[result.transform.method] + '）後的法定坐標']);
    }
    sheets.push({ name: '已知點檢核', cols: [12, 11, 11, 11, 11, 11], rows: kn });
  }
  return sheets;
}

/** 組出 .xlsx 位元組（Uint8Array）。 */
function buildWorkbook(result, ctx, when) {
  const sheets = buildSheets(result, ctx);
  const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const entries = [];
  entries.push({
    name: '[Content_Types].xml',
    data: XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>',
  });
  entries.push({
    name: '_rels/.rels',
    data: XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  });
  entries.push({
    name: 'xl/workbook.xml',
    data: XML_HEAD + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS_REL}">` +
      '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews>' +
      '<sheets>' + sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets>' +
      '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>',
  });
  entries.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/></Relationships>`,
  });
  entries.push({ name: 'xl/styles.xml', data: stylesXml() });
  sheets.forEach((s, i) => entries.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) }));
  return zip(entries, when);
}

return { crc32, zip, buildWorkbook, buildSheets, colName, neighborFormulas };
})();

if (typeof module !== 'undefined') module.exports = RTKXLSX;
