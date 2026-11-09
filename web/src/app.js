/* rtkqc 單檔 HTML 的 UI。資料只在記憶體中處理，不上傳；唯一的網路請求是檢查 version.json。 */
(function () {
'use strict';

var R = RTKQC;
var X = RTKXLSX;

var VERSION_URL = 'https://chenweihanfool.github.io/stonex-rtk-qc/version.json';
var SITE_PREFIX = 'https://chenweihanfool.github.io/';
var LS_TH = 'rtkqc.thresholds.v1';
var LS_IDFROM = 'rtkqc.idfrom.v1';
var LS_MODE = 'rtkqc.mode.v1';
var LS_TFM = 'rtkqc.transform.v1';

var TH_FIELDS = [
  ['same_base_tol_m', '同主站位置容許差（m）'],
  ['hrms_max', '固定解平面誤差上限（m）'],
  ['vrms_max', '固定解高程誤差上限（m）'],
  ['pdop_max', 'PDOP 上限'],
  ['diff_2d_max', '兩次較差上限（m）'],
  ['tilt_offset_max', '表桿傾斜偏移上限（m）'],
  ['min_interval_min', '兩次觀測最短間隔（分，0＝不檢查）'],
  ['known_tol_2d', '與已知點較差上限（m）'],
  ['neighbor_max_m', '相鄰點位距離上限（m）'],
  ['min_fixed_epochs', '每筆觀測最少固定解筆數（0＝不檢查；控制點模式預設 180、圖根 60）'],
  ['transform_resid_max', '共同點轉換後坐標分量改正數上限（m）'],
  ['azimuth_diff_max_sec', '共同點間方位角較差上限（秒）'],
  ['distance_ratio_min', '共同點間水平距相對較差比值分母下限'],
];

var RED_FLAGS = ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'K1', 'E1', 'C1', 'C2', 'C3'];

var state = {
  entries: [], // { id, name, bytes, pd, pdMode, error }
  nextId: 1,
  known: null, // { name, text }
  control: null, // { name, text }：已知加密點成果表
  mode: 'survey',
  transform: 'auto',
  thOver: {}, // 使用者改過的門檻（其餘依作業模式預設）
  analysis: null,
  busy: false,
  rerun: false,
};

function $(id) { return document.getElementById(id); }

function el(tag, attrs, children) {
  var e = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach(function (k) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
  }
  (children || []).forEach(function (c) {
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return e;
}

/* ---------- localStorage（一律 try/catch，失敗也能用） ---------- */

function lsGet(key) {
  try { return window.localStorage.getItem(key); } catch (e) { return null; }
}
function lsSet(key, val) {
  try { window.localStorage.setItem(key, val); } catch (e) { /* 忽略 */ }
}

function loadSettings() {
  var raw = lsGet(LS_TH);
  if (raw) {
    try {
      var th = R.normalizeThresholds(JSON.parse(raw));
      var over = {};
      Object.keys(th).forEach(function (k) {
        // 只保留與預設不同的值（舊版存的是全部門檻；相同於預設的就跟著作業模式走）
        if (typeof th[k] === 'number' && th[k] >= 0 && th[k] !== R.DEFAULT_THRESHOLDS[k]) over[k] = th[k];
      });
      state.thOver = over;
    } catch (e) { /* 壞掉的設定就用預設 */ }
  }
  var idFrom = lsGet(LS_IDFROM);
  if (idFrom === 'auto' || idFrom === 'name' || idFrom === 'code') $('id-from').value = idFrom;
  var mode = lsGet(LS_MODE);
  if (R.MODES.indexOf(mode) >= 0) state.mode = mode;
  $('mode').value = state.mode;
  var tfm = lsGet(LS_TFM);
  if (R.METHODS.indexOf(tfm) >= 0) state.transform = tfm;
  $('transform-method').value = state.transform;
}

// 目前實際使用的門檻（作業模式預設＋使用者改過的）
function effectiveTh() {
  return R.normalizeThresholds(state.thOver, state.mode);
}

/* ---------- 訊息 ---------- */

function showMessages(list) {
  var box = $('messages');
  box.textContent = '';
  list.forEach(function (m) { box.appendChild(el('div', { class: 'msg ' + m.kind, text: m.text })); });
}

/* ---------- sql.js ---------- */

var sqlPromise = null;
function getSql() {
  if (!sqlPromise) {
    var b64 = $('rtkqc-wasm').textContent.trim();
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    sqlPromise = initSqlJs({ wasmBinary: bytes });
  }
  return sqlPromise;
}

/* ---------- 檔案處理 ---------- */

function readFileBytes(file) {
  if (file.arrayBuffer) return file.arrayBuffer().then(function (b) { return new Uint8Array(b); });
  return new Promise(function (resolve, reject) {
    var fr = new FileReader();
    fr.onload = function () { resolve(new Uint8Array(fr.result)); };
    fr.onerror = function () { reject(fr.error); };
    fr.readAsArrayBuffer(file);
  });
}

function readFileText(file) {
  if (file.text) return file.text();
  return new Promise(function (resolve, reject) {
    var fr = new FileReader();
    fr.onload = function () { resolve(String(fr.result)); };
    fr.onerror = function () { reject(fr.error); };
    fr.readAsText(file, 'utf-8');
  });
}

function addFiles(fileList, kind) {
  var files = Array.prototype.slice.call(fileList || []);
  var jobs = files.map(function (f) {
    if (kind === 'control' || /\.(csv|txt)$/i.test(f.name)) {
      return readFileText(f).then(function (t) {
        if (kind === 'control') state.control = { name: f.name, text: t };
        else state.known = { name: f.name, text: t };
      });
    }
    return readFileBytes(f).then(function (bytes) {
      state.entries.push({ id: state.nextId++, name: f.name, bytes: bytes, pd: null, pdMode: null, error: null });
    }).catch(function (e) {
      state.entries.push({ id: state.nextId++, name: f.name, bytes: null, pd: null, pdMode: null,
        error: '無法讀取檔案：' + (e && e.message ? e.message : e) });
    });
  });
  return Promise.all(jobs).then(run);
}

function renderFileList() {
  var ul = $('file-list');
  ul.textContent = '';
  state.entries.forEach(function (en) {
    var status;
    if (en.error) status = el('span', { class: 'state-err', text: '錯誤' });
    else if (en.pd) status = el('span', { class: 'state-ok', text: en.pd.observations.length + ' 筆觀測' });
    else status = el('span', { class: 'hint', text: '讀取中' });
    var rm = el('button', { type: 'button', class: 'ghost', text: '移除' });
    rm.addEventListener('click', function () {
      state.entries = state.entries.filter(function (x) { return x.id !== en.id; });
      run();
    });
    ul.appendChild(el('li', null, [el('span', { class: 'name', text: en.name }), status, rm]));
  });
  $('known-name').textContent = state.known ? '已知點檔：' + state.known.name : '';
  $('control-name').textContent = state.control ? '加密點成果表：' + state.control.name : '';
}

/* ---------- 執行 ---------- */

function run() {
  if (state.busy) { state.rerun = true; return Promise.resolve(); }
  state.busy = true;
  return doRun().then(function () {
    state.busy = false;
    if (state.rerun) { state.rerun = false; return run(); }
    return null;
  }, function (e) {
    state.busy = false;
    showMessages([{ kind: 'err', text: '處理失敗：' + (e && e.message ? e.message : e) }]);
  });
}

function doRun() {
  var msgs = [];
  var idFrom = $('id-from').value;
  renderFileList();
  if (!state.entries.length) {
    state.analysis = null;
    $('results').hidden = true;
    showMessages([]);
    return Promise.resolve();
  }
  return getSql().then(function (SQL) {
    var chain = Promise.resolve();
    state.entries.forEach(function (en) {
      if (en.error && !en.bytes) return;
      chain = chain.then(function () {
        if (en.pd && en.pdMode === idFrom) return null;
        return R.readPD(SQL, en.bytes, en.name, idFrom).then(function (pd) {
          en.pd = pd; en.pdMode = idFrom; en.error = null;
        }, function (e) {
          en.pd = null; en.error = e && e.message ? e.message : String(e);
        });
      });
    });
    return chain;
  }).then(function () {
    renderFileList();
    state.entries.forEach(function (en) {
      if (en.error) msgs.push({ kind: 'err', text: en.name + '：' + en.error });
    });
    var pds = state.entries.filter(function (en) { return en.pd; }).map(function (en) { return en.pd; });
    var known = null;
    var knownName = null;
    if (state.known) {
      try {
        known = R.parseKnownCsv(state.known.text, state.known.name);
        knownName = state.known.name;
      } catch (e) {
        msgs.push({ kind: 'err', text: e.message });
      }
    }
    if (!pds.length) {
      state.analysis = null;
      $('results').hidden = true;
      showMessages(msgs);
      return;
    }
    var control = null;
    var controlName = null;
    if (state.control) {
      try {
        control = R.parseKnownCsv(state.control.text, state.control.name);
        controlName = state.control.name;
      } catch (e) {
        msgs.push({ kind: 'err', text: e.message });
      }
    }
    var an;
    try {
      an = R.analyze({ pds: pds, thresholds: state.thOver, known: known, knownName: knownName,
        mode: state.mode, control: control, controlName: controlName, transform: state.transform });
    } catch (e) {
      msgs.push({ kind: 'err', text: e && e.message ? e.message : String(e) });
      state.analysis = null;
      $('results').hidden = true;
      showMessages(msgs);
      return;
    }
    an.warnings.forEach(function (w) { msgs.push({ kind: 'warn', text: w }); });
    state.analysis = an;
    showMessages(msgs);
    renderResults(an);
  });
}

/* ---------- 結果 ---------- */

function chips(flags) {
  var frag = document.createDocumentFragment();
  flags.forEach(function (f) {
    frag.appendChild(el('span', { class: 'chip ' + (RED_FLAGS.indexOf(f) >= 0 ? 'red' : 'amber'),
      title: R.FLAG_DESC[f] || f, text: f }));
  });
  return frag;
}

function th(text) { return el('th', { text: text }); }
function td(text, cls) { return el('td', cls ? { class: cls, text: text } : { text: text }); }

// 轉換摘要卡與每日連測警告
function renderTransform(an) {
  var sec = $('transform-section');
  var card = $('transform-card');
  var notes = $('transform-notes');
  card.textContent = '';
  notes.textContent = '';
  if (an.controlName === null) { sec.hidden = true; return; }
  sec.hidden = false;
  var tf = an.result.transform;
  function stat(num, lbl) {
    card.appendChild(el('div', { class: 'stat' }, [el('div', { class: 'num', text: String(num) }), el('div', { class: 'lbl', text: lbl })]));
  }
  if (!tf) {
    stat('不轉換', '沒有共同點，或指定不轉換（觀測點號與加密點號都不相同）');
  } else {
    var maxRes = 0;
    tf.common.forEach(function (c) { maxRes = Math.max(maxRes, Math.abs(c.vn), Math.abs(c.ve)); });
    var c1 = tf.common.filter(function (c) { return c.flags.indexOf('C1') >= 0; }).length;
    var c2 = tf.pairs.filter(function (x) { return x.flags.indexOf('C2') >= 0; }).length;
    var c3 = tf.pairs.filter(function (x) { return x.flags.indexOf('C3') >= 0; }).length;
    stat(R.METHOD_LABEL[tf.method], '轉換方法');
    stat(tf.n_common, '共同點數（多餘觀測 ' + tf.redundancy + '）');
    if (tf.method === 'helmert') {
      stat(R.fmt(tf.params.scale_ppm, 3), '尺度（ppm）');
      stat(R.fmt(tf.params.rotation_sec, 3), '旋轉（秒）');
    }
    stat(R.fmt(maxRes, 4), '最大殘差分量（m）');
    [['C1', c1], ['C2', c2], ['C3', c3]].forEach(function (it) {
      var box = el('div', { class: 'stat' }, [el('div', { class: 'num', text: String(it[1]) }), el('div', { class: 'lbl' })]);
      box.lastChild.appendChild(chips([it[0]]));
      box.lastChild.appendChild(document.createTextNode(R.FLAG_DESC[it[0]]));
      card.appendChild(box);
    });
    if (tf.note) notes.appendChild(el('div', { class: 'msg warn', text: tf.note }));
  }
  if (an.daysWithoutControl.length) {
    notes.appendChild(el('div', { class: 'msg warn',
      text: '以下日期沒有連測任何已知加密點：' + an.daysWithoutControl.join('、') }));
  }
}

function renderResults(an) {
  var res = an.result;
  $('results').hidden = false;

  var flagCount = {};
  R.FLAG_ORDER.forEach(function (f) { flagCount[f] = 0; });
  an.points.forEach(function (p) { p.flags.forEach(function (f) { flagCount[f]++; }); });
  var flagged = an.points.filter(function (p) { return p.flags.length; }).length;

  var sum = $('summary');
  sum.textContent = '';
  function stat(num, lbl) {
    sum.appendChild(el('div', { class: 'stat' }, [el('div', { class: 'num', text: String(num) }), el('div', { class: 'lbl', text: lbl })]));
  }
  stat(res.observations.length, '觀測數');
  stat(res.points.length, '點數');
  stat(flagged, '有旗標點數');
  R.FLAG_ORDER.forEach(function (f) {
    if (flagCount[f]) {
      var box = el('div', { class: 'stat' }, [el('div', { class: 'num', text: String(flagCount[f]) }), el('div', { class: 'lbl' })]);
      box.lastChild.appendChild(chips([f]));
      box.lastChild.appendChild(document.createTextNode(R.FLAG_DESC[f]));
      sum.appendChild(box);
    }
  });

  renderTransform(an);

  var pt = $('points-table');
  pt.textContent = '';
  var head = el('tr');
  var ptHead = ['點號', '觀測數', '平均N', '平均E', '平均H', '兩次較差2D(m)', '高程較差(m)', '間隔(分)', '旗標'];
  if (an.tf) ptHead = ptHead.concat(['轉換後N', '轉換後E', '轉換後H']);
  ptHead.forEach(function (h) { head.appendChild(th(h)); });
  pt.appendChild(el('thead', null, [head]));
  var tb = el('tbody');
  an.points.forEach(function (p) {
    var cls = p.flags.some(function (f) { return RED_FLAGS.indexOf(f) >= 0; }) ? 'row-red' : (p.flags.length ? 'row-amber' : '');
    var tr = el('tr', cls ? { class: cls } : null);
    tr.appendChild(td(p.id));
    tr.appendChild(td(String(p.n), 'num'));
    tr.appendChild(td(R.fmt(p.avg_n, 3), 'num'));
    tr.appendChild(td(R.fmt(p.avg_e, 3), 'num'));
    tr.appendChild(td(R.fmt(p.avg_h, 3), 'num'));
    tr.appendChild(td(R.fmt(p.d2, 4), 'num'));
    tr.appendChild(td(R.fmt(p.dh, 4), 'num'));
    tr.appendChild(td(R.fmt(p.interval, 2), 'num'));
    var c = el('td');
    c.appendChild(chips(p.flags));
    tr.appendChild(c);
    if (an.tf) {
      tr.appendChild(td(R.fmt(p.n_t, 3), 'num'));
      tr.appendChild(td(R.fmt(p.e_t, 3), 'num'));
      tr.appendChild(td(R.fmt(p.h_t, 3), 'num'));
    }
    tb.appendChild(tr);
  });
  pt.appendChild(tb);

  var rt = $('remeasure-table');
  rt.textContent = '';
  var rh = el('tr');
  ['點號', '旗標', '建議動作', '平均N', '平均E'].forEach(function (h) { rh.appendChild(th(h)); });
  rt.appendChild(el('thead', null, [rh]));
  var rb = el('tbody');
  if (!res.remeasure.length) {
    rb.appendChild(el('tr', null, [el('td', { colspan: '5', text: '沒有需要重測的點。' })]));
  }
  res.remeasure.forEach(function (r) {
    var tr = el('tr');
    tr.appendChild(td(r.id));
    var c = el('td');
    c.appendChild(chips(r.flags));
    tr.appendChild(c);
    tr.appendChild(td(r.actions.join('；'), 'wrap'));
    tr.appendChild(td(R.fmt(r.avg_n, 3), 'num'));
    tr.appendChild(td(R.fmt(r.avg_e, 3), 'num'));
    rb.appendChild(tr);
  });
  rt.appendChild(rb);

  renderDownloads(an);
}

/* ---------- 下載 ---------- */

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function nowStrings() {
  var d = new Date();
  var off = -d.getTimezoneOffset();
  var sign = off >= 0 ? '+' : '-';
  var a = Math.abs(off);
  var local = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  return {
    iso: local + sign + pad2(Math.floor(a / 60)) + ':' + pad2(a % 60),
    display: local.replace('T', ' ').slice(0, 16),
    date: d,
  };
}

function saveBlob(name, bytes, mime) {
  var blob = new Blob([bytes], { type: mime });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
}

var enc = new TextEncoder();

function buildAll(an) {
  var t = nowStrings();
  var texts = R.textOutputs(an, t.iso, ['rtkqc.html']);
  var antennas = R.sortedAntennas(an.pds);
  var xlsx = X.buildWorkbook(an.result, {
    antennas: antennas,
    sources: an.pds.map(function (p) { return p.name; }),
    runTime: t.display,
    version: R.VERSION,
    hasKnown: an.knownName !== null,
    hasControl: an.controlName !== null,
  }, t.date);
  return { texts: texts, xlsx: xlsx, date: t.date };
}

var XLSX_NAME = 'RTK圖根測量觀測彙整檔.xlsx';
var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function renderDownloads(an) {
  var box = $('downloads');
  box.textContent = '';
  var list = [
    { label: '彙整檔 .xlsx（主要）', primary: true, name: XLSX_NAME, mime: XLSX_MIME },
    { label: 'observations.csv', name: 'observations.csv', mime: 'text/csv;charset=utf-8' },
    { label: 'points.csv', name: 'points.csv', mime: 'text/csv;charset=utf-8' },
    { label: 'remeasure.csv', name: 'remeasure.csv', mime: 'text/csv;charset=utf-8' },
  ];
  if (an.knownName !== null) list.push({ label: 'known_check.csv', name: 'known_check.csv', mime: 'text/csv;charset=utf-8' });
  if (an.tf) {
    list.push({ label: 'transform.csv', name: 'transform.csv', mime: 'text/csv;charset=utf-8' });
    list.push({ label: 'transform_pairs.csv', name: 'transform_pairs.csv', mime: 'text/csv;charset=utf-8' });
  }
  list.push({ label: 'handbook.html（手簿）', name: 'handbook.html', mime: 'text/html;charset=utf-8' });
  list.push({ label: 'manifest.json', name: 'manifest.json', mime: 'application/json' });
  list.push({ label: 'CTL', name: 'control.ctl', mime: 'text/plain;charset=utf-8' });
  list.push({ label: '全部打包 .zip', name: 'rtkqc-all.zip', mime: 'application/zip', zip: true });

  list.forEach(function (it) {
    var b = el('button', { type: 'button', class: it.primary ? 'primary' : 'ghost', text: it.label });
    b.addEventListener('click', function () {
      try {
        var out = buildAll(state.analysis);
        if (it.zip) {
          var entries = [{ name: XLSX_NAME, data: out.xlsx }];
          Object.keys(out.texts).forEach(function (k) { entries.push({ name: k, data: out.texts[k] }); });
          saveBlob(it.name, X.zip(entries, out.date), it.mime);
        } else if (it.name === XLSX_NAME) {
          saveBlob(it.name, out.xlsx, it.mime);
        } else {
          saveBlob(it.name, enc.encode(out.texts[it.name]), it.mime);
        }
      } catch (e) {
        showMessages([{ kind: 'err', text: '產生檔案失敗：' + (e && e.message ? e.message : e) }]);
      }
    });
    box.appendChild(b);
  });
}

/* ---------- 門檻設定 ---------- */

function buildThresholdUi() {
  var grid = $('th-grid');
  grid.textContent = '';
  var eff = effectiveTh();
  TH_FIELDS.forEach(function (f) {
    var inp = el('input', { type: 'number', step: 'any', min: '0', id: 'th-' + f[0] });
    inp.value = String(eff[f[0]]);
    inp.addEventListener('change', function () {
      var v = Number(inp.value);
      if (inp.value.trim() === '' || !isFinite(v) || v < 0) {
        inp.className = 'bad';
        return;
      }
      inp.className = '';
      state.thOver[f[0]] = v;
      lsSet(LS_TH, JSON.stringify(state.thOver));
      run();
    });
    grid.appendChild(el('label', null, [f[1], inp]));
  });
}

/* ---------- 版本歷程 ---------- */

function renderChangelog() {
  var body = $('changelog-body');
  body.textContent = '';
  var text = typeof RTKQC_CHANGELOG === 'string' ? RTKQC_CHANGELOG : '';
  var ul = null;
  text.split(/\r?\n/).forEach(function (line) {
    var m;
    if ((m = /^##\s+(.*)$/.exec(line))) {
      ul = null;
      body.appendChild(el('h3', { text: m[1] }));
    } else if (/^#\s+/.test(line) || !line.trim()) {
      ul = null;
    } else if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) {
      if (!ul) { ul = el('ul'); body.appendChild(ul); }
      ul.appendChild(el('li', { text: m[1].replace(/[`*]/g, '') }));
    } else {
      ul = null;
      body.appendChild(el('p', { text: line.replace(/[`*]/g, '') }));
    }
  });
}

function openChangelog() {
  renderChangelog();
  var dlg = $('changelog-dialog');
  if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
}

/* ---------- 更新提示（失敗一律靜默） ---------- */

function checkUpdate() {
  try {
    if (typeof fetch !== 'function') return;
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 3000);
    var opts = { cache: 'no-store' };
    if (ctl) opts.signal = ctl.signal;
    fetch(VERSION_URL, opts).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) return null;
      return res.json();
    }).then(function (info) {
      if (!info || typeof info.version !== 'string') return;
      if (R.compareVersions(info.version, R.VERSION) !== 1) return;
      showUpdate(info);
    }).catch(function () { clearTimeout(timer); });
  } catch (e) { /* 靜默 */ }
}

function safeLink(url) {
  return typeof url === 'string' && url.indexOf(SITE_PREFIX) === 0 ? url : null;
}

function showUpdate(info) {
  var bar = $('update-bar');
  bar.textContent = '';
  bar.appendChild(el('div', null, [el('strong', { text: '有新版本 ' + info.version + '（目前 ' + R.VERSION + '）' })]));
  if (typeof info.notes === 'string' && info.notes.trim()) {
    bar.appendChild(el('div', { class: 'notes', text: info.notes.trim().slice(0, 600) }));
  }
  var links = el('div');
  var dl = safeLink(info.download_url);
  var pg = safeLink(info.page_url);
  if (dl) links.appendChild(el('a', { href: dl, target: '_blank', rel: 'noopener noreferrer', text: '下載新版' }));
  if (pg) links.appendChild(el('a', { href: pg, target: '_blank', rel: 'noopener noreferrer', text: '線上使用' }));
  links.appendChild(el('span', { text: '下載後用新檔取代舊檔即可。' }));
  bar.appendChild(links);
  bar.hidden = false;
}

/* ---------- 啟動 ---------- */

function init() {
  $('ver').textContent = 'v' + R.VERSION;
  $('ver2').textContent = 'v' + R.VERSION;
  loadSettings();
  buildThresholdUi();

  var drop = $('drop');
  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (e) { if (e.dataTransfer) addFiles(e.dataTransfer.files); });
  // 拖到頁面其他地方時，避免瀏覽器直接開啟檔案
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  $('pd-input').addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });
  $('known-input').addEventListener('change', function (e) { addFiles(e.target.files, 'known'); e.target.value = ''; });
  $('control-input').addEventListener('change', function (e) { addFiles(e.target.files, 'control'); e.target.value = ''; });
  $('id-from').addEventListener('change', function () { lsSet(LS_IDFROM, $('id-from').value); run(); });
  $('mode').addEventListener('change', function () {
    state.mode = $('mode').value;
    lsSet(LS_MODE, state.mode);
    buildThresholdUi();
    run();
  });
  $('transform-method').addEventListener('change', function () {
    state.transform = $('transform-method').value;
    lsSet(LS_TFM, state.transform);
    run();
  });
  $('th-reset').addEventListener('click', function () {
    state.thOver = {};
    lsSet(LS_TH, JSON.stringify(state.thOver));
    buildThresholdUi();
    run();
  });
  $('btn-changelog').addEventListener('click', openChangelog);
  $('changelog-close').addEventListener('click', function () {
    var dlg = $('changelog-dialog');
    if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
  });
  $('btn-print').addEventListener('click', function () { window.print(); });

  checkUpdate();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
})();
