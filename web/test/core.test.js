'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RTKQC = require('../src/rtkqc-core.js');
const H = require('./helpers.js');

const tmp = H.mkTmp('rtkqc-core-');
const files = H.makeScenario(tmp);
const outPy = path.join(tmp, 'py-out');
const py = H.runPython([files.day1, files.day2], outPy);

const knownCsv = path.join(tmp, 'known.csv');
fs.writeFileSync(knownCsv, '\ufeff點號,N,E,H\nGDC060,2700000.030,200000.000,50.0\nNOTMEASURED,1,1,\n', 'utf8');
const outPyKnown = path.join(tmp, 'py-known');
const pyKnown = H.runPython([files.day1, files.day2], outPyKnown, ['--known', knownCsv]);

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const readOut = (dir, name) => fs.readFileSync(path.join(dir, name));
const enc = (s) => Buffer.from(s, 'utf8');

test('版本與 Python 一致', () => {
  const r = H.py(['-m', 'rtkqc', '--version']);
  assert.equal(r.stdout.trim(), RTKQC.VERSION);
});

test('四捨五入：半數遠離零、不輸出負零', () => {
  assert.equal(RTKQC.fmt(0.125, 2), '0.13');
  assert.equal(RTKQC.fmt(-0.125, 2), '-0.13');
  assert.equal(RTKQC.fmt(1.0005, 3), '1.001');
  assert.equal(RTKQC.fmt(2.5, 0), '3');
  assert.equal(RTKQC.fmt(-0.0004, 3), '0.000');
  assert.equal(RTKQC.fmt(2700000, 3), '2700000.000');
  assert.equal(RTKQC.fmt(1e-7, 8), '0.00000010');
  assert.equal(RTKQC.fmt(null, 3), '');
  assert.equal(RTKQC.rnd(1.23456, 3), 1.235);
  assert.equal(RTKQC.rnd(null, 3), null);
});

test('四捨五入與 Python 逐筆相同（隨機＋邊界值）', () => {
  const vals = [];
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 300; i++) {
    vals.push((rand() - 0.5) * Math.pow(10, Math.floor(rand() * 9) - 3));
  }
  vals.push(0.0005, 1.0005, 2.675, 0.125, 0.5, 1e-9, 123456.7895, 2700000.0005, -0.0005, 0.00005);
  const code = 'import sys,json; sys.path.insert(0,"."); from rtkqc.rules import fmt; ' +
    'v=json.loads(sys.stdin.read()); print(json.dumps([[fmt(x,n) for n in (0,2,3,4,8)] for x in v]))';
  const r = H.py(['-c', code], { input: JSON.stringify(vals) });
  const pyVals = JSON.parse(r.stdout);
  vals.forEach((v, i) => {
    const mine = [0, 2, 3, 4, 8].map((n) => RTKQC.fmt(v, n));
    assert.deepEqual(mine, pyVals[i], String(v));
  });
});

test('TM2 與 Python 一致（台灣南北端與金門）', () => {
  const cases = [[25.30, 121.60], [21.90, 120.85], [24.45, 118.32], [25.0330, 121.5654], [23.5, 121.0]];
  const code = 'import sys,json; sys.path.insert(0,"."); from rtkqc.tm2 import lonlat_to_tm2 as f; ' +
    'print(json.dumps([f(a,b) for a,b in json.loads(sys.argv[1])]))';
  const r = H.py(['-c', code, JSON.stringify(cases)]);
  const pyVals = JSON.parse(r.stdout);
  cases.forEach(([lat, lon], i) => {
    const [n, e] = RTKQC.lonlatToTm2(lat, lon);
    assert.ok(Math.abs(n - pyVals[i][0]) < 1e-6, `N ${lat},${lon}`);
    assert.ok(Math.abs(e - pyVals[i][1]) < 1e-6, `E ${lat},${lon}`);
  });
});

test('正規 JSON 與 Python --json 深度相等', async () => {
  const pds = await H.readAll([files.day1, files.day2]);
  const an = RTKQC.analyze({ pds });
  assert.deepStrictEqual(an.result, py.json);
  assert.equal(an.result.observations.length, 22);
  assert.equal(an.result.points.length, 12);
});

test('輸入順序相反時，點位判定與主站命名仍相同', async () => {
  const pds = await H.readAll([files.day2, files.day1]);
  const an = RTKQC.analyze({ pds });
  assert.deepEqual(an.result.points, py.json.points);
  assert.deepEqual(an.result.bases.map((b) => b.label), py.json.bases.map((b) => b.label));
});

test('CSV、handbook 與 Python 輸出逐位元組相同', async () => {
  const pds = await H.readAll([files.day1, files.day2]);
  const an = RTKQC.analyze({ pds });
  const out = RTKQC.textOutputs(an, '2026-11-09T00:00:00+08:00');
  for (const name of ['observations.csv', 'points.csv', 'remeasure.csv', 'handbook.html']) {
    assert.ok(enc(out[name]).equals(readOut(outPy, name)), `${name} 不一致`);
  }
  assert.equal(out['known_check.csv'], undefined);
  assert.ok(enc(out['observations.csv']).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
});

test('CTL 與 Python --ctl 逐字相同', async () => {
  const pds = await H.readAll([files.day1, files.day2]);
  const an = RTKQC.analyze({ pds });
  assert.ok(enc(RTKQC.ctlText(an.points)).equals(py.ctl));
});

test('已知點：JSON、known_check.csv、K1 與 Python 相同', async () => {
  const pds = await H.readAll([files.day1, files.day2]);
  const known = RTKQC.parseKnownCsv(fs.readFileSync(knownCsv, 'utf8'));
  const an = RTKQC.analyze({ pds, known, knownName: 'known.csv' });
  assert.deepStrictEqual(an.result, pyKnown.json);
  assert.equal(an.result.known_check.length, 1);
  assert.equal(an.result.known_check[0].over, true);
  const out = RTKQC.textOutputs(an, 'x');
  assert.ok(enc(out['known_check.csv']).equals(readOut(outPyKnown, 'known_check.csv')));
  assert.ok(enc(out['points.csv']).equals(readOut(outPyKnown, 'points.csv')));
});

test('manifest 內容與 Python 一致（執行時間、argv 除外）', async () => {
  const pds = await H.readAll([files.day1, files.day2]);
  const an = RTKQC.analyze({ pds });
  const m = JSON.parse(RTKQC.textOutputs(an, 'T')['manifest.json']);
  const pm = JSON.parse(readOut(outPy, 'manifest.json').toString('utf8'));
  for (const k of ['tool', 'version', 'thresholds', 'known_file', 'inputs', 'observation_count',
    'point_count', 'flag_stats', 'points_with_flags']) {
    assert.deepStrictEqual(m[k], pm[k], k);
  }
  assert.equal(m.run_time, 'T');
});

test('門檻覆蓋：min_interval_min 與 neighbor_max_m 與 Python 相同', async () => {
  const cfg = path.join(tmp, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ min_interval_min: 2000, neighbor_max_m: 0.01 }));
  const o = path.join(tmp, 'cfg-out');
  const p = H.runPython([files.day1, files.day2], o, ['--config', cfg]);
  const pds = await H.readAll([files.day1, files.day2]);
  const an = RTKQC.analyze({ pds, thresholds: { min_interval_min: 2000, neighbor_max_m: 0.01 } });
  assert.deepStrictEqual(an.result, p.json);
  assert.ok(an.result.points.find((x) => x.id === 'BNC060').flags.includes('D1'));
});

test('--id-from name／code 與 Python 相同', async () => {
  for (const mode of ['name', 'code']) {
    const o = path.join(tmp, 'id-' + mode);
    const p = H.runPython([files.day1, files.day2], o, ['--id-from', mode]);
    const pds = await H.readAll([files.day1, files.day2], mode);
    assert.deepStrictEqual(RTKQC.analyze({ pds }).result, p.json, mode);
  }
});

test('重複檔案（sha256 相同）只算一次並警告', async () => {
  const dup = path.join(tmp, '複本.PD');
  fs.copyFileSync(files.day1, dup);
  const pds = await H.readAll([files.day1, dup, files.day2]);
  const an = RTKQC.analyze({ pds });
  assert.ok(an.warnings.some((w) => w.includes('已略過重複輸入') && w.includes('複本.PD')));
  assert.deepStrictEqual(an.result.points, py.json.points);
  assert.equal(an.result.inputs.length, 2);
});

test('警告文字與 Python 相同（孤兒點）', async () => {
  const pds = await H.readAll([files.day1]);
  const an = RTKQC.analyze({ pds });
  const w = an.warnings.find((x) => x.includes('GPSID'));
  assert.ok(py.stderr.split(/\r?\n/).includes(w), w);
});

test('錯誤：非 SQLite、缺資料表會丟出清楚訊息', async () => {
  const SQL = await H.loadSql();
  const bad = new Uint8Array(Buffer.from('this is not a database at all'.repeat(50)));
  await assert.rejects(RTKQC.readPD(SQL, bad, 'bad.PD'),
    (e) => e instanceof RTKQC.InputError && /SQLite/.test(e.message));
  const db = new SQL.Database();
  db.run('CREATE TABLE Point (ID INTEGER)');
  const partial = db.export();
  db.close();
  await assert.rejects(RTKQC.readPD(SQL, partial, 'partial.PD'),
    (e) => e instanceof RTKQC.InputError && /缺少欄位/.test(e.message));
});

test('已知點 CSV 解析：無表頭、錯誤格式', () => {
  const k = RTKQC.parseKnownCsv('GDC060,2700000.0025,200000.0025\n');
  assert.deepEqual(k.get('GDC060'), [2700000.0025, 200000.0025, null]);
  assert.throws(() => RTKQC.parseKnownCsv('GDC060,abc,def\n'), RTKQC.InputError);
  assert.equal(RTKQC.parseKnownCsv('').size, 0);
});

test('門檻驗證', () => {
  assert.throws(() => RTKQC.normalizeThresholds({ nope: 1 }), /未知欄位/);
  assert.throws(() => RTKQC.normalizeThresholds({ hrms_max: 'a' }), /必須是數字/);
  assert.equal(RTKQC.normalizeThresholds({ hrms_max: 0.03 }).hrms_max, 0.03);
});

test('真實樣本對拍（RTKQC_SAMPLE_PD）', { skip: !process.env.RTKQC_SAMPLE_PD }, async () => {
  const sample = process.env.RTKQC_SAMPLE_PD;
  const o = path.join(tmp, 'real-out');
  const p = H.runPython([sample], o);
  const pds = await H.readAll([sample]);
  const an = RTKQC.analyze({ pds });
  assert.deepStrictEqual(an.result, p.json);
  const out = RTKQC.textOutputs(an, 'x');
  for (const name of ['observations.csv', 'points.csv', 'remeasure.csv', 'handbook.html']) {
    assert.ok(enc(out[name]).equals(readOut(o, name)), `${name} 不一致`);
  }
  assert.ok(enc(RTKQC.ctlText(an.points)).equals(p.ctl));
});

test('語意化版本比較（更新提示用）', () => {
  assert.equal(RTKQC.compareVersions('0.3.0', '0.2.0'), 1);
  assert.equal(RTKQC.compareVersions('0.2.0', '0.2.0'), 0);
  assert.equal(RTKQC.compareVersions('0.1.9', '0.2.0'), -1);
  assert.equal(RTKQC.compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(RTKQC.compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(RTKQC.compareVersions('v0.2.1', '0.2.0'), 1);
  assert.equal(RTKQC.compareVersions('abc', '0.2.0'), null);
});

test('sortedAntennas 去重並排序', () => {
  const pds = [{ antennas: [['B2', 'S900A'], ['A1', 'S900A']] }, { antennas: [['A1', 'S900A']] }];
  assert.deepEqual(RTKQC.sortedAntennas(pds), [['A1', 'S900A'], ['B2', 'S900A']]);
});

test('主站框架差修正：JSON 與 Python 相同，且等於真值', async () => {
  const d = path.join(tmp, 'frame');
  fs.mkdirSync(d);
  const r = H.py(['-c',
    "import sys; sys.path.insert(0, 'tests'); import make_fixture as mf; mf.frame_scenario(sys.argv[1])", d]);
  assert.equal(r.status, 0, r.stderr);
  const pdPath = path.join(d, 'frame.PD');
  const p = H.runPython([pdPath], path.join(d, 'out'));
  const pds = await H.readAll([pdPath]);
  const an = RTKQC.analyze({ pds });
  assert.deepStrictEqual(an.result, p.json);
  const [b1, b2] = an.result.bases;
  const [tn, te] = RTKQC.lonlatToTm2(10.0, 100.0);
  assert.equal(b1.grid_corrected, true);
  assert.ok(Math.abs(b1.n - (tn - 0.26)) < 0.001);
  assert.ok(Math.abs(b1.e - (te + 0.40)) < 0.001);
  assert.ok(Math.abs(b1.h - 14.5) < 0.001);
  assert.equal(b2.grid_corrected, false);
  assert.equal(b2.grid_shift_n, null);
});
