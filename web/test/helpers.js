'use strict';
// 測試共用：產生合成 .PD（呼叫 Python）、執行 Python CLI、載入 sql.js 與 JS 核心。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const PYTHON = process.env.PYTHON || 'python';
const ENV = Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });

function py(args, opts) {
  const r = spawnSync(PYTHON, args, Object.assign({ cwd: REPO, env: ENV, encoding: 'utf8' }, opts));
  if (r.error) throw r.error;
  return r;
}

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'rtkqc-'));
}

function makeScenario(dir) {
  const r = py(['-c',
    "import sys; sys.path.insert(0, 'tests'); import make_fixture as mf; mf.scenario(sys.argv[1])", dir]);
  if (r.status !== 0) throw new Error('產生合成 .PD 失敗：' + r.stderr);
  return { day1: path.join(dir, 'day1.PD'), day2: path.join(dir, 'day2.PD') };
}

function runPython(inputs, outDir, extra) {
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'py.json');
  const ctlPath = path.join(outDir, 'py.ctl');
  const r = py(['-m', 'rtkqc', ...inputs, '--out', outDir, '--json', jsonPath, '--ctl', ctlPath, ...(extra || [])]);
  if (r.status !== 0) throw new Error('Python CLI 失敗：' + r.stderr);
  return { json: JSON.parse(fs.readFileSync(jsonPath, 'utf8')), ctl: fs.readFileSync(ctlPath), stderr: r.stderr };
}

let sqlPromise = null;
function loadSql() {
  if (!sqlPromise) {
    const dir = path.join(REPO, 'vendor', 'sql.js-1.10.3');
    const initSqlJs = require(path.join(dir, 'sql-wasm.js'));
    sqlPromise = initSqlJs({ wasmBinary: fs.readFileSync(path.join(dir, 'sql-wasm.wasm')) });
  }
  return sqlPromise;
}

async function readAll(files, idFrom) {
  const RTKQC = require('../src/rtkqc-core.js');
  const SQL = await loadSql();
  const pds = [];
  for (const f of files) pds.push(await RTKQC.readPD(SQL, fs.readFileSync(f), path.basename(f), idFrom));
  return pds;
}

module.exports = { REPO, PYTHON, py, mkTmp, makeScenario, runPython, loadSql, readAll };
