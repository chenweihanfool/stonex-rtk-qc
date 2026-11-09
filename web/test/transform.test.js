'use strict';
// 作業模式、E1、已知加密點連測與坐標轉換：JS 與 Python 參考實作逐項對拍（JSON、CSV、CTL、手簿）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RTKQC = require('../src/rtkqc-core.js');
const H = require('./helpers.js');

const root = H.mkTmp('rtkqc-tf-');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const makeControl = (opts) => H.makeControl(root, opts);

const enc = (s) => Buffer.from(s, 'utf8');

async function compare(opts, extraArgs, jsOpts) {
  const sc = makeControl(opts);
  const outDir = path.join(sc.dir, 'py-out');
  const py = H.runPython([sc.pd], outDir, ['--control', sc.ctl].concat(extraArgs || []));
  const pds = await H.readAll([sc.pd]);
  const control = RTKQC.parseKnownCsv(fs.readFileSync(sc.ctl, 'utf8'));
  const an = RTKQC.analyze(Object.assign({ pds, control, controlName: 'ctl.csv' }, jsOpts || {}));
  assert.deepStrictEqual(an.result, py.json);
  const out = RTKQC.textOutputs(an, 'T');
  const names = ['observations.csv', 'points.csv', 'remeasure.csv', 'handbook.html'];
  if (an.tf) names.push('transform.csv', 'transform_pairs.csv');
  for (const n of names) assert.ok(enc(out[n]).equals(fs.readFileSync(path.join(outDir, n))), `${n} 不一致`);
  assert.equal(out['transform.csv'] === undefined, !fs.existsSync(path.join(outDir, 'transform.csv')));
  assert.ok(enc(RTKQC.ctlText(an.points)).equals(py.ctl), 'CTL 不一致');
  const m = JSON.parse(out['manifest.json']);
  const pm = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  for (const k of ['version', 'thresholds', 'mode', 'control_file', 'transform', 'days_without_control',
    'flag_stats', 'points_with_flags', 'inputs']) {
    assert.deepStrictEqual(m[k], pm[k], k);
  }
  return { an, py, sc };
}

test('helmert（預設）：JSON、CSV、CTL、手簿、manifest 與 Python 相同，並回推真值', async () => {
  const { an } = await compare({});
  const tf = an.result.transform;
  assert.equal(tf.method, 'helmert');
  assert.equal(tf.n_common, 7);
  assert.equal(tf.redundancy, 10);
  assert.ok(Math.abs(tf.params.scale_ppm - 5) < 0.1);
  assert.ok(Math.abs(tf.params.rotation_sec - 2) < 0.01);
  assert.ok(Math.abs(tf.params.tN - -0.26) < 0.001);
  assert.ok(Math.abs(tf.params.tE - 0.40) < 0.001);
  assert.ok(Math.abs(tf.dh - 0.35) < 0.0005);
  assert.equal(tf.pairs.length, 21);
});

test('affine：與 Python 相同', async () => {
  const { an } = await compare({}, ['--transform', 'affine'], { transform: 'affine' });
  assert.equal(an.result.transform.method, 'affine');
  assert.equal(an.result.transform.redundancy, 8);
});

test('shift（明確指定）與 1 點自動平移', async () => {
  await compare({}, ['--transform', 'shift'], { transform: 'shift' });
  const { an } = await compare({ only: ['CP01'] });
  assert.equal(an.result.transform.method, 'shift');
  assert.equal(an.result.transform.redundancy, 0);
  assert.ok(an.result.transform.note.includes('無多餘觀測，殘差無檢核意義'));
});

test('2 點 helmert：無多餘觀測註記', async () => {
  const { an } = await compare({ only: ['CP01', 'CP02'] });
  assert.equal(an.result.transform.method, 'helmert');
  assert.equal(an.result.transform.redundancy, 0);
  assert.equal(an.result.transform.pairs.length, 1);
});

test('沒有共同點與 --transform none：不轉換', async () => {
  const a = await compare({ only: ['ZZ'] });
  assert.equal(a.an.result.transform, null);
  const b = await compare({}, ['--transform', 'none'], { transform: 'none' });
  assert.equal(b.an.result.transform, null);
  assert.equal(b.an.result.observations[0].nearest_control !== null, true);
});

test('故意偏 0.12 m：C1、C2、C3 與 Python 相同', async () => {
  const { an } = await compare({ outlier: 0.12 });
  const tf = an.result.transform;
  assert.deepEqual(tf.common.find((c) => c.id === 'CP00').flags, ['C1']);
  assert.ok(tf.pairs.some((x) => x.flags.includes('C2')));
  assert.ok(tf.pairs.some((x) => x.flags.includes('C3')));
  assert.ok(an.result.points.find((p) => p.id === 'CP00').flags.includes('C1'));
});

test('圖根模式（E1、間隔門檻）與門檻覆蓋', async () => {
  const a = await compare({}, ['--mode', 'control'], { mode: 'control' });
  assert.equal(a.an.result.mode, 'control');
  assert.ok(a.an.result.observations.every((o) => o.flags.includes('E1')));
  const b = await compare({ fixed_epochs: 180 }, ['--mode', 'control'], { mode: 'control' });
  assert.ok(b.an.result.observations.every((o) => !o.flags.includes('E1')));
  const sc = makeControl({});
  const cfg = path.join(sc.dir, 'cfg.json');
  fs.writeFileSync(cfg, JSON.stringify({ min_fixed_epochs: 2, transform_resid_max: 0 }));
  const py = H.runPython([sc.pd], path.join(sc.dir, 'o'), ['--control', sc.ctl, '--mode', 'control', '--config', cfg]);
  const pds = await H.readAll([sc.pd]);
  const an = RTKQC.analyze({ pds, mode: 'control', control: RTKQC.parseKnownCsv(fs.readFileSync(sc.ctl, 'utf8')),
    controlName: 'ctl.csv', thresholds: { min_fixed_epochs: 2, transform_resid_max: 0 } });
  assert.deepStrictEqual(an.result, py.json);
});

test('圖根模式（traverse）：60 筆，與 Python 相同', async () => {
  const a = await compare({ fixed_epochs: 60 }, ['--mode', 'traverse'], { mode: 'traverse' });
  assert.equal(a.an.result.mode, 'traverse');
  assert.ok(a.an.result.observations.every((o) => !o.flags.includes('E1')));
  const b = await compare({ fixed_epochs: 59 }, ['--mode', 'traverse'], { mode: 'traverse' });
  assert.ok(b.an.result.observations.every((o) => o.flags.includes('E1')));
});

test('每日連測檢查與警告文字', async () => {
  const { an, py } = await compare({ extra_day: true });
  assert.deepEqual(an.result.days_without_control, ['2026-11-02']);
  assert.ok(an.warnings.some((w) => w.includes('2026-11-02')));
  assert.ok(py.stderr.split(/\r?\n/).includes(an.warnings[an.warnings.length - 1]));
});

test('--known 使用轉換後坐標：與 Python 相同', async () => {
  const sc = makeControl({});
  const known = path.join(sc.dir, 'known.csv');
  fs.writeFileSync(known, '點號,N,E,H\nP01,2700030.000,200040.000,50.7\n');
  const py = H.runPython([sc.pd], path.join(sc.dir, 'o'), ['--control', sc.ctl, '--known', known]);
  const pds = await H.readAll([sc.pd]);
  const an = RTKQC.analyze({ pds, control: RTKQC.parseKnownCsv(fs.readFileSync(sc.ctl, 'utf8')), controlName: 'ctl.csv',
    known: RTKQC.parseKnownCsv(fs.readFileSync(known, 'utf8')), knownName: 'known.csv' });
  assert.deepStrictEqual(an.result, py.json);
  assert.equal(an.result.known_check[0].over, false);
});

test('沒給加密點時輸出不變：欄位與 v0.2.0 相同', async () => {
  const sc = makeControl({});
  const out = path.join(sc.dir, 'plain');
  const py = H.runPython([sc.pd], out);
  const pds = await H.readAll([sc.pd]);
  const an = RTKQC.analyze({ pds });
  assert.deepStrictEqual(an.result, py.json);
  const t = RTKQC.textOutputs(an, 'T');
  assert.ok(enc(t['observations.csv']).equals(fs.readFileSync(path.join(out, 'observations.csv'))));
  assert.equal(t['transform.csv'], undefined);
  assert.equal(an.result.transform, null);
  assert.deepEqual(an.result.control_days, []);
  assert.ok(t['observations.csv'].split('\r\n')[0].endsWith(',該筆旗標'));
});

test('條件不足會丟出 InputError：affine 少於 3 點、helmert 少於 2 點', async () => {
  const sc = makeControl({ only: ['CP01', 'CP02'] });
  const pds = await H.readAll([sc.pd]);
  const control = RTKQC.parseKnownCsv(fs.readFileSync(sc.ctl, 'utf8'));
  assert.throws(() => RTKQC.analyze({ pds, control, transform: 'affine' }),
    (e) => e instanceof RTKQC.InputError && /affine/.test(e.message));
  assert.throws(() => RTKQC.analyze({ pds, control, transform: 'helmert', mode: 'x' }), /未知的作業模式/);
  const one = RTKQC.parseKnownCsv('CP01,1,2\n');
  assert.throws(() => RTKQC.analyze({ pds, control: one, transform: 'helmert' }), RTKQC.InputError);
});

test('門檻驗證：作業模式預設', () => {
  const c = RTKQC.normalizeThresholds(null, 'control');
  assert.equal(c.min_fixed_epochs, 180);
  assert.equal(c.min_interval_min, 0);
  const t = RTKQC.normalizeThresholds(null, 'traverse');
  assert.equal(t.min_fixed_epochs, 60);
  assert.equal(t.min_interval_min, 0);
  assert.equal(RTKQC.normalizeThresholds({ min_fixed_epochs: 5 }, 'control').min_fixed_epochs, 5);
  assert.equal(RTKQC.normalizeThresholds(null).min_fixed_epochs, 0);
});
