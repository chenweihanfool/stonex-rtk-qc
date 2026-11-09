'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RTKQC = require('../src/rtkqc-core.js');
const RTKXLSX = require('../src/xlsx.js');
const H = require('./helpers.js');

const tmp = H.mkTmp('rtkqc-xlsx-');
const files = H.makeScenario(tmp);
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/* 自寫的 ZIP 讀取（只支援 stored）：回傳 { 檔名: Buffer }，並驗證 CRC32 */
function readZip(buf) {
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central header');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    assert.equal(method, 0, 'stored');
    assert.equal(buf.readUInt32LE(off), 0x04034b50, 'local header');
    const lnLen = buf.readUInt16LE(off + 26);
    const start = off + 30 + lnLen;
    const data = buf.subarray(start, start + size);
    assert.equal(RTKXLSX.crc32(data), crc, `CRC ${name}`);
    out[name] = data;
    p += 46 + nameLen;
  }
  return out;
}

/* 簡易 XML 良構性檢查：標籤配對、無裸 & */
function assertWellFormed(xml, label) {
  const stack = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|<\?[^>]*\?>/g;
  let last = 0;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const text = xml.slice(last, m.index);
    assert.ok(!/[<]/.test(text), `${label}: 文字含 <`);
    assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/.test(text), `${label}: 裸 &`);
    last = re.lastIndex;
    if (m[0].startsWith('<?')) continue;
    if (m[1]) {
      assert.equal(stack.pop(), m[2], `${label}: 標籤未配對 ${m[2]}`);
    } else if (!m[4]) {
      stack.push(m[2]);
    }
  }
  assert.equal(stack.length, 0, `${label}: 有未關閉標籤`);
  assert.equal(xml.slice(last).trim(), '', `${label}: 結尾有多餘內容`);
}

async function build(withKnown) {
  const pds = await H.readAll([files.day1, files.day2]);
  let known = null;
  if (withKnown) known = RTKQC.parseKnownCsv('GDC060,2700000.030,200000.000,50.0\n');
  const an = RTKQC.analyze({ pds, known, knownName: withKnown ? 'known.csv' : null });
  const ctx = {
    antennas: pds.flatMap((p) => p.antennas).filter((a, i, arr) => arr.findIndex((b) => b[0] === a[0] && b[1] === a[1]) === i),
    sources: an.pds.map((p) => p.name),
    runTime: '2026-11-09 12:00',
    version: RTKQC.VERSION,
    hasKnown: !!withKnown,
  };
  return { an, bytes: Buffer.from(RTKXLSX.buildWorkbook(an.result, ctx)), ctx };
}

const sheetNames = (z) => [...z['xl/workbook.xml'].toString('utf8').matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
const sheetXml = (z, i) => z[`xl/worksheets/sheet${i}.xml`].toString('utf8');
const cellText = (xml, ref) => {
  const m = new RegExp(`<c r="${ref}"[^>]*>(?:<is><t[^>]*>([^<]*)</t></is>|<v>([^<]*)</v>)`).exec(xml);
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
};

test('ZIP：stored、CRC 正確、含必要部件', async () => {
  const { bytes } = await build(false);
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  const z = readZip(bytes);
  for (const n of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml']) {
    assert.ok(z[n], n);
  }
  for (const [name, data] of Object.entries(z)) assertWellFormed(data.toString('utf8'), name);
});

test('CRC32 已知值', () => {
  assert.equal(RTKXLSX.crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('無已知點：6 張工作表，名稱與順序比照 113 標準版', async () => {
  const { bytes } = await build(false);
  const z = readZip(bytes);
  assert.deepEqual(sheetNames(z), ['接收儀資訊表', '主站坐標表', '觀測資料彙整表', '點位坐標平均值表', '相鄰點位檢核表', '隔天重測清單']);
  assert.ok(!z['xl/worksheets/sheet7.xml']);
});

test('有已知點：7 張工作表，第 7 張為已知點檢核', async () => {
  const { bytes } = await build(true);
  const z = readZip(bytes);
  const names = sheetNames(z);
  assert.equal(names.length, 7);
  assert.equal(names[6], '已知點檢核');
  const s7 = sheetXml(z, 7);
  assert.equal(cellText(s7, 'A2'), 'GDC060');
  assert.equal(cellText(s7, 'F2'), '是');
});

test('觀測資料彙整表：標題、說明列、第 6 列表頭與資料列', async () => {
  const { an, bytes } = await build(false);
  const z = readZip(bytes);
  const s3 = sheetXml(z, 3);
  assert.equal(cellText(s3, 'A1'), 'RTK圖根測量觀測資料彙整表');
  assert.equal(cellText(s3, 'A2'), '來源：day1.PD、day2.PD　產製：2026-11-09 12:00　rtkqc 0.3.0');
  assert.equal(cellText(s3, 'A4'), '備註欄說明');
  assert.equal(cellText(s3, 'C4'), 'X1：表兩次觀測採相同主站。');
  assert.equal(cellText(s3, 'E4'), 'X2:表固定解平面誤差未小於2cm。');
  assert.equal(cellText(s3, 'I4'), 'X3：表固定解高程誤差未小於5cm。');
  assert.equal(cellText(s3, 'C5'), 'X4：表PDOP值未小於10。');
  assert.equal(cellText(s3, 'E5'), 'X5：表兩次較差未小於2cm');
  assert.equal(cellText(s3, 'H5'), 'X6:表僅有一個觀測值');
  const header = ['主站點名', '測站點名', '縱坐標(m)', '橫坐標(m)', '高程坐標(m)', '固定解平面誤差(m)',
    '固定解高程誤差(m)', 'PDOP值', '兩次觀測較差(m)', '主站與移動站距離', '備註', '觀測時間', 'epoch數'];
  header.forEach((h, i) => assert.equal(cellText(s3, String.fromCharCode(65 + i) + '6'), h));
  const rows = [...s3.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1])).filter((r) => r >= 7);
  assert.equal(rows.length, an.result.observations.length);
  // 第一筆（依點號排序的 "12"）
  const o = an.result.observations[0];
  assert.equal(cellText(s3, 'A7'), o.base_label);
  assert.equal(cellText(s3, 'B7'), o.id);
  assert.equal(Number(cellText(s3, 'C7')), o.n);
  assert.equal(cellText(s3, 'L7'), o.start);
  assert.equal(Number(cellText(s3, 'M7')), o.epoch_n);
  // 備註：點位級旗標＋該列旗標，依 X1…X6、F1、T1、D1、K1 排序
  const idx = an.result.observations.findIndex((x) => x.id === 'GDC050' && x.row_flags.includes('X2'));
  assert.equal(cellText(s3, 'K' + (idx + 7)), 'X2');
  const idx2 = an.result.observations.findIndex((x) => x.id === 'BNC032');
  assert.equal(cellText(s3, 'K' + (idx2 + 7)), 'X1');
  const idx3 = an.result.observations.findIndex((x) => x.id === 'GDC054');
  assert.equal(cellText(s3, 'K' + (idx3 + 7)), 'T1');
  assert.ok(s3.includes('<col min="12" max="12" width="18"'));
});

test('接收儀資訊表與主站坐標表', async () => {
  const { an, bytes } = await build(false);
  const z = readZip(bytes);
  const s1 = sheetXml(z, 1);
  assert.ok(s1.includes('<mergeCell ref="A1:E1"/>'));
  assert.equal(cellText(s1, 'A1'), '接收儀資訊');
  assert.deepEqual(['A2', 'B2', 'C2', 'D2'].map((r) => cellText(s1, r)), ['廠牌', '型號', '編號', '接收頻道數']);
  assert.deepEqual(['A3', 'B3', 'C3'].map((r) => cellText(s1, r)), ['Stonex', 'S900A', 'TSTSN0001']);
  const s2 = sheetXml(z, 2);
  assert.deepEqual(['A1', 'B1', 'C1', 'D1'].map((r) => cellText(s2, r)), ['主站點名', '縱座標', '橫坐標', '高程坐標']);
  assert.equal(cellText(s2, 'A2'), 'B1');
  assert.equal(Number(cellText(s2, 'B2')), an.result.bases[0].n);
  assert.equal(Number(cellText(s2, 'D2')), 40);
  // 表格下方空一列寫註記
  assert.ok(cellText(s2, "A" + (an.result.bases.length + 3)).startsWith("VBS 虛擬基站；縱橫坐標"));
  assert.equal(cellText(s2, 'A' + (an.result.bases.length + 2)), null);
});

test('相鄰點位檢核表：D 留空、E/F/G 為公式', async () => {
  const { an, bytes } = await build(false);
  const z = readZip(bytes);
  const s5 = sheetXml(z, 5);
  const n = an.result.neighbors.length;
  assert.ok(n > 0);
  assert.equal((s5.match(/<f>/g) || []).length, n * 3);
  assert.deepEqual(['A1', 'B1', 'C1', 'D1', 'E1', 'F1', 'G1'].map((r) => cellText(s5, r)),
    ['測站點名', '相鄰點名', '坐標反算距離(m)', '直接量測距離(m)', '較差(cm)', '相對較差比值', '檢核結果']);
  assert.ok(s5.includes('<c r="D2" s="3"/>'));
  assert.ok(s5.includes('<f>IF(D2="","",ROUND(ABS(D2-C2)*100,2))</f>'));
  assert.ok(s5.includes('ROUND(C2/(E2/100),0)'));
  assert.ok(s5.includes('&gt;3cm') || s5.includes('E2&gt;3'));
  assert.ok(s5.includes('相對較差比值分母&lt;3000'));
  const f = RTKXLSX.neighborFormulas(5);
  assert.ok(f.G.includes('F5>=3000') && f.G.includes('較差>3cm '));
});

test('點位坐標平均值表與隔天重測清單', async () => {
  const { an, bytes } = await build(false);
  const z = readZip(bytes);
  const s4 = sheetXml(z, 4);
  assert.deepEqual(['A1', 'B1', 'C1', 'D1', 'E1'].map((r) => cellText(s4, r)), ['點名', '縱坐標', '橫坐標', '高程坐標', '備註']);
  assert.equal([...s4.matchAll(/<row r="/g)].length, an.result.points.length + 1);
  const s6 = sheetXml(z, 6);
  assert.deepEqual(['A1', 'B1', 'C1', 'D1', 'E1'].map((r) => cellText(s6, r)), ['點號', '旗標', '建議動作', '平均N', '平均E']);
  assert.equal([...s6.matchAll(/<row r="/g)].length, an.result.remeasure.length + 1);
});

test('styles：黃底、框線、0.000／0.0 數字格式、新細明體 12 粗體', async () => {
  const { bytes } = await build(false);
  const z = readZip(bytes);
  const st = z['xl/styles.xml'].toString('utf8');
  assert.ok(st.includes('FFFFFF00'));
  assert.ok(st.includes('formatCode="0.000"') && st.includes('formatCode="0.0"'));
  assert.ok(st.includes('新細明體') && st.includes('<b/>') && st.includes('<sz val="12"/>'));
  assert.ok(st.includes('style="thin"'));
  assert.ok(z['xl/workbook.xml'].toString('utf8').includes('fullCalcOnLoad="1"'));
});

test('xlsx 內容來源：特殊字元會 escape', () => {
  const sheets = RTKXLSX.buildSheets({
    bases: [], observations: [], points: [], neighbors: [], remeasure: [], known_check: [],
  }, { antennas: [['A<&>', 'T"1']], sources: ['a&b.PD'], runTime: 'x', version: '0' });
  const xml = Buffer.from(RTKXLSX.buildWorkbook({
    bases: [], observations: [], points: [], neighbors: [], remeasure: [], known_check: [],
  }, { antennas: [['A<&>', 'T"1']], sources: ['a&b.PD'], runTime: 'x', version: '0' }));
  const z = readZip(xml);
  assert.equal(sheets.length, 6);
  const s1 = sheetXml(z, 1);
  assert.ok(s1.includes('A&lt;&amp;&gt;'));
  assertWellFormed(s1, 'sheet1');
  assertWellFormed(sheetXml(z, 3), 'sheet3');
});

test('RTKQC_SAMPLE_PD：真實樣本也能產出可讀的 xlsx', { skip: !process.env.RTKQC_SAMPLE_PD }, async () => {
  const sample = process.env.RTKQC_SAMPLE_PD;
  const pds = await H.readAll([sample]);
  const an = RTKQC.analyze({ pds });
  const bytes = Buffer.from(RTKXLSX.buildWorkbook(an.result, {
    antennas: pds.flatMap((p) => p.antennas), sources: [path.basename(sample)], runTime: 'x', version: RTKQC.VERSION,
  }));
  const z = readZip(bytes);
  assert.equal(sheetNames(z).length, 6);
  for (const [name, data] of Object.entries(z)) assertWellFormed(data.toString('utf8'), name);
});

test('主站坐標表註記：有修正時寫明平均 dN／dE', () => {
  const sheets = RTKXLSX.buildSheets({
    bases: [{ label: 'B1', n: 1, e: 2, h: 3, alt: 4, grid_corrected: true, grid_shift_n: -0.26, grid_shift_e: 0.4 }],
    observations: [], points: [], neighbors: [], remeasure: [], known_check: [],
  }, { antennas: [], sources: [], runTime: 'x', version: '0' });
  const note = sheets[1].rows[sheets[1].rows.length - 1][0];
  assert.ok(note.includes('平均 dN=-0.2600, dE=0.4000 m'));
  assert.ok(note.includes('高程＝橢球高減平均大地起伏'));
});
