const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PORT = 7777;

// ── File type config ──
const LOG_PATTERNS = [/\.log(\.\d+)?$/, /npm-debug/, /yarn-error/, /crash/i, /error\.log$/i, /debug\.log$/i];
const TEMP_EXTENSIONS = new Set(['.tmp', '.temp', '.bak', '.old', '.cache', '.swp', '.swo', '~']);
const TEMP_FILENAMES  = new Set(['thumbs.db', 'desktop.ini', '.ds_store', 'ehthumbs.db']);
const SKIP_DIRS = new Set(['windows','system32','syswow64','program files','program files (x86)','$recycle.bin','boot','recovery']);

const DEFAULT_PATHS = [
  path.join(process.env.USERPROFILE || '', 'Downloads'),
  path.join(process.env.USERPROFILE || '', 'Documents'),
  path.join(process.env.USERPROFILE || '', 'Desktop'),
  path.join(process.env.USERPROFILE || '', 'Pictures'),
  path.join(process.env.APPDATA || '', '..', 'Local', 'Temp'),
  path.join(process.env.APPDATA || '', 'npm-cache'),
].filter(p => { try { return fs.existsSync(p); } catch { return false; } });

// ── Utils ──
function getSizeMB(fp) {
  try { return fs.statSync(fp).size / 1048576; } catch { return 0; }
}
function getAgeDays(fp) {
  try { return Math.floor((Date.now() - fs.statSync(fp).mtimeMs) / 86400000); } catch { return 0; }
}
function getHash(fp) {
  try {
    const buf = fs.readFileSync(fp);
    return crypto.createHash('md5').update(buf).digest('hex');
  } catch { return null; }
}
function walkDir(dir, list = [], depth = 0) {
  if (depth > 6) return list;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return list; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name.toLowerCase())) walkDir(full, list, depth + 1);
    } else if (e.isFile()) {
      list.push(full);
    }
  }
  return list;
}

// ── Scanner ──
let scanResults = [];
let scanStatus  = { running: false, progress: 0, total: 0, current: '' };

async function runScan(dirs, opts) {
  scanResults = [];
  scanStatus = { running: true, progress: 0, total: 0, current: 'Collecting files...' };

  let allFiles = [];
  for (const d of dirs) {
    if (fs.existsSync(d)) allFiles = allFiles.concat(walkDir(d));
  }

  scanStatus.total = allFiles.length;

  // Duplicates
  if (opts.dups) {
    const hashMap = new Map();
    for (let i = 0; i < allFiles.length; i++) {
      const fp = allFiles[i];
      scanStatus.progress = i;
      scanStatus.current = 'Scanning duplicates: ' + path.basename(fp);
      const sz = getSizeMB(fp);
      if (sz === 0 || sz > 500) continue;
      const h = getHash(fp);
      if (!h) continue;
      const key = h + '_' + Math.round(sz * 1000);
      if (hashMap.has(key)) {
        scanResults.push({ id: 'd' + i, type: 'duplicate', path: fp, name: path.basename(fp), dir: path.dirname(fp), sizeMB: sz, reason: 'Duplicate of: ' + path.basename(hashMap.get(key)), selected: true });
      } else { hashMap.set(key, fp); }
    }
  }

  // Logs
  if (opts.logs) {
    scanStatus.current = 'Scanning log files...';
    for (let i = 0; i < allFiles.length; i++) {
      const fp = allFiles[i];
      const name = path.basename(fp).toLowerCase();
      if (LOG_PATTERNS.some(p => p.test(name))) {
        scanResults.push({ id: 'l' + i, type: 'log', path: fp, name: path.basename(fp), dir: path.dirname(fp), sizeMB: getSizeMB(fp), reason: 'Log file (' + getAgeDays(fp) + ' days old)', selected: true });
      }
    }
  }

  // Temp
  if (opts.temp) {
    scanStatus.current = 'Scanning temp & cache...';
    for (let i = 0; i < allFiles.length; i++) {
      const fp = allFiles[i];
      const name = path.basename(fp).toLowerCase();
      const ext  = path.extname(fp).toLowerCase();
      const dir  = path.dirname(fp).toLowerCase();
      const inTempDir = dir.includes('\\temp') || dir.includes('/temp') || dir.includes('npm-cache') || dir.includes('.cache') || dir.includes('__pycache__');
      if (TEMP_EXTENSIONS.has(ext) || TEMP_FILENAMES.has(name) || inTempDir) {
        scanResults.push({ id: 't' + i, type: 'temp', path: fp, name: path.basename(fp), dir: path.dirname(fp), sizeMB: getSizeMB(fp), reason: 'Temp / Cache file', selected: true });
      }
    }
  }

  // Empty
  if (opts.empty) {
    scanStatus.current = 'Scanning empty files...';
    for (let i = 0; i < allFiles.length; i++) {
      const fp = allFiles[i];
      try { if (fs.statSync(fp).size === 0) scanResults.push({ id: 'e' + i, type: 'empty', path: fp, name: path.basename(fp), dir: path.dirname(fp), sizeMB: 0, reason: 'Empty file', selected: false }); }
      catch {}
    }
  }

  scanStatus.running = false;
  scanStatus.current = 'Scan complete — ' + scanResults.length + ' items found';
  scanStatus.progress = scanStatus.total;
}

// ── Delete ──
function deleteFiles(ids, secure) {
  const results = [];
  for (const id of ids) {
    const f = scanResults.find(x => x.id === id);
    if (!f) continue;
    try {
      if (secure) {
        const sz = fs.statSync(f.path).size;
        const fd = fs.openSync(f.path, 'w');
        fs.writeSync(fd, Buffer.alloc(Math.min(sz, 1048576)));
        fs.closeSync(fd);
      }
      fs.unlinkSync(f.path);
      scanResults = scanResults.filter(x => x.id !== id);
      results.push({ id, success: true });
    } catch (e) {
      results.push({ id, success: false, error: e.message });
    }
  }
  return results;
}

// ── HTML UI ──
const HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>AmirAlone — SysClean Pro</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Rajdhani:wght@400;500;600;700&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#060608;--surface:#0c0c10;--card:#101014;--border:rgba(192,40,40,0.2);
  --red:#c0392b;--red2:#8b0000;--ember:#e07020;--dim:#3a3a44;
  --text:#d0d0d8;--bright:#f0f0f8;--muted:#55555f;
  --mono:'Share Tech Mono',monospace;--sans:'Rajdhani',sans-serif;
  --glow:0 0 20px rgba(192,57,43,0.4),0 0 60px rgba(192,57,43,0.1);
}
html,body{height:100%;background:var(--bg);font-family:var(--sans);color:var(--text);overflow:hidden}
canvas#fire{position:fixed;inset:0;z-index:0;opacity:.13;pointer-events:none}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse at 50% 100%,rgba(140,0,0,.12),transparent 60%);pointer-events:none;z-index:1}
body::after{content:'';position:fixed;inset:0;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");opacity:.03;pointer-events:none;z-index:2;animation:ns .1s steps(1) infinite}
@keyframes ns{0%{background-position:0 0}25%{background-position:30px 10px}75%{background-position:-20px 40px}}

/* blood bar */
.blood{position:fixed;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#3d0000,var(--red),var(--ember),var(--red),#3d0000);box-shadow:0 0 18px var(--red),0 0 40px rgba(192,57,43,.2);z-index:9999;animation:bp 3s infinite}
@keyframes bp{0%,100%{opacity:1}50%{opacity:.5}}
.drip{position:fixed;top:0;background:linear-gradient(to bottom,var(--red),transparent);border-radius:0 0 50% 50%;animation:dr linear infinite;z-index:9998}
@keyframes dr{0%{height:0;opacity:1}80%{opacity:1}100%{height:90px;opacity:0}}

/* layout */
.app{position:relative;z-index:10;display:grid;grid-template-rows:auto 1fr auto;height:100vh;max-width:1200px;margin:0 auto;padding:14px 18px 10px}

/* header */
.hdr{display:flex;align-items:center;justify-content:space-between;padding-bottom:12px;border-bottom:1px solid var(--border);position:relative;margin-bottom:14px}
.hdr::after{content:'';position:absolute;bottom:-1px;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,var(--red),var(--ember),var(--red),transparent)}
.brand{display:flex;align-items:center;gap:12px}
.brand-icon{width:46px;height:46px;border-radius:10px;background:linear-gradient(135deg,#1a0000,#3d0000);border:1px solid var(--red);display:flex;align-items:center;justify-content:center;font-size:22px;box-shadow:var(--glow);animation:sp 2.5s infinite}
@keyframes sp{0%,100%{box-shadow:0 0 10px rgba(192,57,43,.5)}50%{box-shadow:0 0 28px rgba(192,57,43,.95),0 0 55px rgba(192,57,43,.2)}}
.brand-name{font-family:var(--mono);font-size:20px;color:var(--red);text-shadow:0 0 12px rgba(192,57,43,.8);letter-spacing:2px;animation:gn 5s infinite}
@keyframes gn{0%,92%,100%{letter-spacing:2px;text-shadow:0 0 12px rgba(192,57,43,.8)}93%{letter-spacing:4px;text-shadow:-2px 0 red,2px 0 cyan}95%{letter-spacing:2px}}
.brand-sub{font-family:var(--mono);font-size:9px;color:var(--muted);letter-spacing:3px;margin-top:2px}
.hdr-links{display:flex;gap:8px}
.hlink{display:flex;align-items:center;gap:5px;padding:6px 12px;border-radius:7px;font-family:var(--mono);font-size:10px;text-decoration:none;border:1px solid;transition:all .2s;letter-spacing:1px}
.hlink.gh{color:#bbb;border-color:rgba(255,255,255,.1);background:rgba(255,255,255,.02)}
.hlink.gh:hover{color:#fff;background:rgba(255,255,255,.07);box-shadow:0 0 10px rgba(255,255,255,.08)}
.hlink.dc{color:#7289da;border-color:rgba(114,137,218,.25);background:rgba(114,137,218,.04)}
.hlink.dc:hover{background:rgba(114,137,218,.12);box-shadow:0 0 12px rgba(114,137,218,.25)}
.status-pill{display:flex;align-items:center;gap:7px;padding:6px 14px;border-radius:50px;border:1px solid rgba(192,57,43,.3);background:rgba(192,57,43,.06);font-family:var(--mono);font-size:10px;color:var(--red);letter-spacing:1px}
.sdot{width:7px;height:7px;background:var(--red);border-radius:50%;animation:sdp 1.5s infinite}
@keyframes sdp{0%,100%{opacity:1;box-shadow:0 0 5px var(--red)}50%{opacity:.2;box-shadow:none}}

/* main grid */
.main{display:grid;grid-template-columns:1fr 300px;gap:14px;overflow:hidden}

/* panel */
.panel{background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
.phead{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;position:relative;flex-shrink:0}
.phead::after{content:'';position:absolute;bottom:-1px;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(192,57,43,.35),transparent)}
.ptitle{font-family:var(--mono);font-size:12px;color:var(--bright);letter-spacing:1px;display:flex;align-items:center;gap:7px}

/* filter tabs */
.tabs{display:flex;gap:5px}
.tab{padding:4px 10px;border-radius:50px;font-family:var(--mono);font-size:9px;letter-spacing:1px;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--muted);transition:all .2s}
.tab.on{background:rgba(192,57,43,.12);border-color:rgba(192,57,43,.5);color:var(--red);box-shadow:0 0 8px rgba(192,57,43,.15)}

/* scan path input */
.path-section{padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.04);flex-shrink:0}
.path-label{font-family:var(--mono);font-size:9px;color:var(--muted);letter-spacing:2px;margin-bottom:6px}
.path-input{width:100%;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:7px;padding:7px 12px;color:var(--text);font-family:var(--mono);font-size:11px;outline:none;transition:border-color .2s}
.path-input:focus{border-color:rgba(192,57,43,.5);box-shadow:0 0 10px rgba(192,57,43,.1)}

/* categories */
.cats{padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.04);flex-shrink:0}
.cat{margin-bottom:12px}
.cat:last-child{margin-bottom:0}
.cat-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px}
.cat-name{font-family:var(--mono);font-size:10px;display:flex;align-items:center;gap:6px}
.cat-sz{font-family:var(--mono);font-size:9px;color:var(--muted)}
.track{height:4px;background:rgba(255,255,255,.04);border-radius:2px;overflow:hidden}
.fill{height:100%;border-radius:2px;width:0;transition:width 1.4s cubic-bezier(.4,0,.2,1)}
.cat-ct{font-family:var(--mono);font-size:9px;color:var(--muted);margin-top:3px}

/* file list */
.list-wrap{flex:1;overflow:hidden;display:flex;flex-direction:column;padding:0 16px 12px}
.list-bar{display:flex;justify-content:space-between;align-items:center;padding:8px 0 6px;flex-shrink:0}
.sel-btn{font-family:var(--mono);font-size:9px;color:var(--ember);background:none;border:none;cursor:pointer;letter-spacing:1px;transition:color .2s}
.sel-btn:hover{color:#ff8833}
.sel-ct{font-family:var(--mono);font-size:9px;color:var(--muted)}
.flist{flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(192,57,43,.3) transparent}
.fitem{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:7px;font-family:var(--mono);font-size:10px;color:var(--muted);border:1px solid transparent;cursor:pointer;transition:all .15s;animation:fi .25s ease forwards;opacity:0}
@keyframes fi{to{opacity:1}}
.fitem:hover{background:rgba(255,255,255,.02);border-color:rgba(255,255,255,.05);color:var(--text)}
.fitem.on{background:rgba(192,57,43,.07);border-color:rgba(192,57,43,.25);color:var(--red)}
.fitem.del{animation:fd .4s ease forwards}
@keyframes fd{to{opacity:0;transform:translateX(-12px) scale(.96);max-height:0;padding:0;margin:0;border:none}}
.fi-ico{font-size:12px;flex-shrink:0}
.fi-nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fi-sz{font-size:9px;color:var(--muted);flex-shrink:0;min-width:50px;text-align:right}
.fi-chk{width:13px;height:13px;border:1px solid rgba(255,255,255,.12);border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:8px;flex-shrink:0;transition:all .15s}
.fitem.on .fi-chk{background:var(--red);border-color:var(--red);color:#fff;box-shadow:0 0 5px rgba(192,57,43,.5)}

/* right panel */
.right{display:flex;flex-direction:column;gap:12px;overflow-y:auto;scrollbar-width:none}

/* action card */
.acard{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px;flex-shrink:0}
.acard-title{font-family:var(--mono);font-size:9px;letter-spacing:3px;color:var(--muted);margin-bottom:12px;text-transform:uppercase}

/* circular progress */
.circ-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.circ{width:68px;height:68px;position:relative;flex-shrink:0}
.circ svg{transform:rotate(-90deg);width:68px;height:68px}
.ctrack{fill:none;stroke:rgba(255,255,255,.04);stroke-width:5}
.cfill{fill:none;stroke:var(--red);stroke-width:5;stroke-linecap:round;stroke-dasharray:188;stroke-dashoffset:188;transition:stroke-dashoffset 1s ease;filter:drop-shadow(0 0 4px rgba(192,57,43,.7))}
.cval{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:14px;font-weight:900;color:var(--red)}
.scan-info-title{font-size:14px;font-weight:700;color:var(--bright);font-family:var(--sans)}
.scan-info-sub{font-family:var(--mono);font-size:9px;color:var(--muted);letter-spacing:1px;margin-top:3px}

/* buttons */
.btn{width:100%;padding:13px;border-radius:10px;font-family:var(--sans);font-size:14px;font-weight:700;cursor:pointer;border:1px solid;transition:all .25s;display:flex;align-items:center;justify-content:center;gap:8px;position:relative;overflow:hidden;letter-spacing:.5px}
.btn::before{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.06),transparent);transform:translateX(-100%);transition:transform .45s}
.btn:hover::before{transform:translateX(100%)}
.btn-scan{background:linear-gradient(135deg,rgba(192,57,43,.1),rgba(139,0,0,.15));border-color:var(--red);color:var(--red);box-shadow:0 0 12px rgba(192,57,43,.2)}
.btn-scan:hover{background:linear-gradient(135deg,rgba(192,57,43,.2),rgba(139,0,0,.25));box-shadow:var(--glow);transform:translateY(-1px)}
.btn-scan.running{animation:btnp 1s infinite;pointer-events:none}
@keyframes btnp{0%,100%{box-shadow:0 0 10px rgba(192,57,43,.4)}50%{box-shadow:0 0 28px rgba(192,57,43,.9),0 0 55px rgba(192,57,43,.2)}}
.btn-clean{background:linear-gradient(135deg,rgba(139,0,0,.07),rgba(100,0,0,.1));border-color:rgba(139,0,0,.4);color:#cc4444;margin-top:8px}
.btn-clean:hover:not(:disabled){background:rgba(139,0,0,.18);box-shadow:0 0 18px rgba(139,0,0,.4);transform:translateY(-1px)}
.btn-clean:disabled{opacity:.3;cursor:not-allowed}
.spin{display:inline-block}
.btn-scan.running .spin{animation:spinA .7s linear infinite}
@keyframes spinA{to{transform:rotate(360deg)}}

/* stats row */
.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;flex-shrink:0}
.stat{background:rgba(255,255,255,.02);border:1px solid var(--border);border-radius:10px;padding:10px 12px;position:relative;overflow:hidden}
.stat::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--sc,var(--red));opacity:.7}
.stat-lbl{font-family:var(--mono);font-size:8px;letter-spacing:2px;color:var(--muted);margin-bottom:4px}
.stat-val{font-family:var(--mono);font-size:20px;font-weight:900;color:var(--sc,var(--red));line-height:1}
.stat-sub{font-family:var(--mono);font-size:8px;color:var(--muted);margin-top:3px}

/* toggles */
.opt{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.03)}
.opt:last-child{border-bottom:none}
.opt-lbl{font-size:12px;display:flex;align-items:center;gap:7px;font-family:var(--sans)}
.tog{width:36px;height:19px;background:rgba(255,255,255,.07);border-radius:10px;position:relative;cursor:pointer;transition:background .25s;flex-shrink:0}
.tog.on{background:linear-gradient(90deg,var(--red2),var(--red));box-shadow:0 0 8px rgba(192,57,43,.4)}
.tog::after{content:'';position:absolute;width:13px;height:13px;background:#ccc;border-radius:50%;top:3px;left:3px;transition:transform .25s,background .25s}
.tog.on::after{transform:translateX(17px);background:#fff}

/* terminal */
.term{background:rgba(4,4,6,.97);border:1px solid var(--border);border-radius:14px;overflow:hidden;flex-shrink:0}
.term-bar{padding:9px 13px;background:var(--card);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px}
.tdot{width:9px;height:9px;border-radius:50%}
.term-lbl{font-family:var(--mono);font-size:9px;color:var(--muted);margin-right:8px;letter-spacing:2px}
.tlog{padding:10px 13px;font-family:var(--mono);font-size:10px;max-height:120px;overflow-y:auto;line-height:1.9;scrollbar-width:thin;scrollbar-color:rgba(192,57,43,.25) transparent}
.ll{animation:lf .25s forwards;opacity:0}
@keyframes lf{to{opacity:1}}
.lok{color:#43d17a}.lwarn{color:var(--ember)}.lerr{color:#cc3333}.linfo{color:#5b8fd5}.ldim{color:var(--muted)}

/* result banner */
.result{background:linear-gradient(135deg,rgba(139,0,0,.1),rgba(192,57,43,.07));border:1px solid rgba(192,57,43,.3);border-radius:12px;padding:14px 18px;display:none;align-items:center;justify-content:space-between;flex-shrink:0}
.result.show{display:flex;animation:fi .4s ease}
.res-title{font-size:15px;font-weight:700;color:var(--red);font-family:var(--sans)}
.res-sub{font-family:var(--mono);font-size:9px;color:var(--muted);margin-top:3px;letter-spacing:1px}

/* footer */
.foot{padding:8px 0 0;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:center;gap:16px;font-family:var(--mono);font-size:9px;color:var(--muted);letter-spacing:2px;flex-shrink:0}
.foot a{color:var(--red);text-decoration:none;transition:all .2s}
.foot a:hover{color:var(--ember);text-shadow:0 0 8px rgba(192,57,43,.5)}

/* scrollbar */
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:rgba(192,57,43,.3);border-radius:2px}

/* empty state */
.empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--muted);font-family:var(--mono);font-size:11px;letter-spacing:2px;gap:8px}
</style>
</head>
<body>
<canvas id="fire"></canvas>
<div class="blood"></div>

<div class="app">

  <!-- HEADER -->
  <div class="hdr">
    <div class="brand">
      <div class="brand-icon">&#9760;</div>
      <div>
        <div class="brand-name">AmirAlone</div>
        <div class="brand-sub">SysClean Pro // Node.js Engine // v3.0</div>
      </div>
    </div>
    <div class="hdr-links">
      <a class="hlink gh" href="https://github.com/voidethic" target="_blank">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
        voidethic
      </a>
      <a class="hlink dc" href="https://discord.gg/K6NvjzKc" target="_blank">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057.1 18.08.114 18.1.134 18.115a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
        Discord
      </a>
      <div class="status-pill"><div class="sdot"></div><span id="status-txt">READY</span></div>
    </div>
  </div>

  <!-- MAIN -->
  <div class="main">

    <!-- LEFT: scanner -->
    <div class="panel">
      <div class="phead">
        <div class="ptitle">&#128269; Scanned Files</div>
        <div class="tabs">
          <div class="tab on" onclick="setFilter('all',this)">ALL</div>
          <div class="tab" onclick="setFilter('duplicate',this)">DUP</div>
          <div class="tab" onclick="setFilter('log',this)">LOG</div>
          <div class="tab" onclick="setFilter('temp',this)">TEMP</div>
        </div>
      </div>

      <div class="path-section">
        <div class="path-label">// SCAN PATH</div>
        <input class="path-input" id="scanPath" type="text" placeholder="Leave empty for default paths (Downloads, Documents, Desktop, Temp)">
      </div>

      <div class="cats">
        <div class="cat">
          <div class="cat-row">
            <div class="cat-name"><span style="color:var(--red)">&#9679;</span> Duplicates</div>
            <div class="cat-sz" id="cs1">–</div>
          </div>
          <div class="track"><div class="fill" id="p1" style="background:var(--red);box-shadow:0 0 5px rgba(192,57,43,.5)"></div></div>
          <div class="cat-ct" id="cc1">waiting...</div>
        </div>
        <div class="cat">
          <div class="cat-row">
            <div class="cat-name"><span style="color:var(--ember)">&#9679;</span> Log Files</div>
            <div class="cat-sz" id="cs2">–</div>
          </div>
          <div class="track"><div class="fill" id="p2" style="background:var(--ember);box-shadow:0 0 5px rgba(224,112,32,.4)"></div></div>
          <div class="cat-ct" id="cc2">waiting...</div>
        </div>
        <div class="cat">
          <div class="cat-row">
            <div class="cat-name"><span style="color:#5b8fd5">&#9679;</span> Temp / Cache</div>
            <div class="cat-sz" id="cs3">–</div>
          </div>
          <div class="track"><div class="fill" id="p3" style="background:#5b8fd5;box-shadow:0 0 5px rgba(91,143,213,.4)"></div></div>
          <div class="cat-ct" id="cc3">waiting...</div>
        </div>
        <div class="cat" style="margin-bottom:0">
          <div class="cat-row">
            <div class="cat-name"><span style="color:#cc4444">&#9679;</span> Empty Files</div>
            <div class="cat-sz" id="cs4">–</div>
          </div>
          <div class="track"><div class="fill" id="p4" style="background:#cc4444"></div></div>
          <div class="cat-ct" id="cc4">waiting...</div>
        </div>
      </div>

      <div class="list-wrap">
        <div class="list-bar">
          <button class="sel-btn" onclick="selAll()">// SELECT ALL</button>
          <span class="sel-ct" id="sel-ct">0 selected</span>
        </div>
        <div class="flist" id="flist">
          <div class="empty-state">
            <span style="font-size:24px">&#9760;</span>
            <span>Run a scan to find files</span>
          </div>
        </div>
      </div>
    </div>

    <!-- RIGHT -->
    <div class="right">

      <!-- scan control -->
      <div class="acard">
        <div class="circ-row">
          <div>
            <div class="scan-info-title">Scan Control</div>
            <div class="scan-info-sub" id="scan-sub">// IDLE — ready</div>
          </div>
          <div class="circ">
            <svg viewBox="0 0 68 68">
              <circle class="ctrack" cx="34" cy="34" r="29"/>
              <circle class="cfill" id="cfill" cx="34" cy="34" r="29"/>
            </svg>
            <div class="cval" id="cpct">0%</div>
          </div>
        </div>
        <button class="btn btn-scan" id="btn-scan" onclick="startScan()">
          <span class="spin" id="sico">&#9760;</span>
          <span id="stext">Start Scan</span>
        </button>
        <button class="btn btn-clean" id="btn-clean" disabled onclick="cleanFiles()">
          &#128293; Clean Selected
        </button>
      </div>

      <!-- stats -->
      <div class="stats">
        <div class="stat" style="--sc:var(--red)">
          <div class="stat-lbl">DUPLICATES</div>
          <div class="stat-val" id="sv1">0</div>
          <div class="stat-sub" id="ss1">— MB</div>
        </div>
        <div class="stat" style="--sc:var(--ember)">
          <div class="stat-lbl">LOG FILES</div>
          <div class="stat-val" id="sv2">0</div>
          <div class="stat-sub" id="ss2">— MB</div>
        </div>
        <div class="stat" style="--sc:#5b8fd5">
          <div class="stat-lbl">TEMP/CACHE</div>
          <div class="stat-val" id="sv3">0</div>
          <div class="stat-sub" id="ss3">— MB</div>
        </div>
        <div class="stat" style="--sc:#cc4444">
          <div class="stat-lbl">RECLAIMABLE</div>
          <div class="stat-val" id="sv4">0</div>
          <div class="stat-sub">MB total</div>
        </div>
      </div>

      <!-- options -->
      <div class="acard">
        <div class="acard-title">// options</div>
        <div class="opt"><div class="opt-lbl">&#128257; Duplicate files</div><div class="tog on" id="t1" onclick="this.classList.toggle('on')"></div></div>
        <div class="opt"><div class="opt-lbl">&#128203; Old log files</div><div class="tog on" id="t2" onclick="this.classList.toggle('on')"></div></div>
        <div class="opt"><div class="opt-lbl">&#128193; Temp &amp; Cache</div><div class="tog on" id="t3" onclick="this.classList.toggle('on')"></div></div>
        <div class="opt"><div class="opt-lbl">&#9711; Empty files</div><div class="tog" id="t4" onclick="this.classList.toggle('on')"></div></div>
        <div class="opt"><div class="opt-lbl">&#128737; Secure Wipe</div><div class="tog" id="t5" onclick="this.classList.toggle('on')"></div></div>
      </div>

      <!-- terminal -->
      <div class="term">
        <div class="term-bar">
          <div class="tdot" style="background:#ff5f57"></div>
          <div class="tdot" style="background:#ffbd2e"></div>
          <div class="tdot" style="background:#28c940"></div>
          <span class="term-lbl">// AmirAlone@voidethic</span>
        </div>
        <div class="tlog" id="tlog">
          <div class="ll ldim">SysClean Pro v3.0 — Node.js Engine</div>
          <div class="ll ldim">github.com/voidethic | discord.gg/K6NvjzKc</div>
          <div class="ll linfo">System ready. Press Start Scan.</div>
        </div>
      </div>

      <!-- result -->
      <div class="result" id="result">
        <div>
          <div class="res-title" id="res-title">Cleanup Complete!</div>
          <div class="res-sub" id="res-sub">—</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:26px">&#9760;</div>
          <div style="font-family:var(--mono);font-size:8px;color:var(--muted);margin-top:3px;letter-spacing:2px">VOID CLEAN</div>
        </div>
      </div>

    </div>
  </div>

  <!-- FOOTER -->
  <div class="foot">
    <span>built by</span>
    <a href="https://github.com/voidethic" target="_blank">voidethic</a>
    <span>&#183;</span>
    <a href="https://discord.gg/K6NvjzKc" target="_blank">discord.gg/K6NvjzKc</a>
    <span>&#183;</span>
    <span>AmirAlone &copy; 2025</span>
  </div>

</div>

<script>
// ── Fire Canvas ──
(()=>{
  const c=document.getElementById('fire');
  let W=c.width=window.innerWidth,H=c.height=window.innerHeight;
  const ctx=c.getContext('2d');
  const pts=Array.from({length:110},mk);
  function mk(){return{x:Math.random()*W,y:H+Math.random()*60,vx:(Math.random()-.5)*1.1,vy:-(1+Math.random()*2.5),sz:1.5+Math.random()*4.5,life:1,dec:.005+Math.random()*.011,hue:Math.random()>.4?0:18}}
  function frame(){
    ctx.clearRect(0,0,W,H);
    pts.forEach((p,i)=>{
      p.x+=p.vx+(Math.random()-.5)*.6;p.y+=p.vy;p.life-=p.dec;p.sz*=.993;
      if(p.life<=0){pts[i]=mk();return}
      const g=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,p.sz*2);
      g.addColorStop(0,\`hsla(\${p.hue},100%,60%,\${p.life})\`);
      g.addColorStop(.5,\`hsla(\${p.hue+10},100%,38%,\${p.life*.35})\`);
      g.addColorStop(1,'transparent');
      ctx.beginPath();ctx.arc(p.x,p.y,p.sz*2,0,Math.PI*2);
      ctx.fillStyle=g;ctx.fill();
    });
    requestAnimationFrame(frame);
  }
  frame();
  window.addEventListener('resize',()=>{W=c.width=window.innerWidth;H=c.height=window.innerHeight});
})();

// ── Blood drips ──
(()=>{
  function mk(){
    const d=document.createElement('div');
    d.className='drip';
    d.style.cssText=\`right:\${Math.random()*100}%;width:\${1+Math.random()*2.5}px;animation-duration:\${2+Math.random()*2.5}s\`;
    document.body.appendChild(d);
    setTimeout(()=>d.remove(),5000);
  }
  setInterval(mk,2200);setTimeout(mk,600);
})();

// ── State ──
let files=[], filter='all', scanning=false, logIdx=0;

function fmt(mb){
  if(mb>=1024) return (mb/1024).toFixed(2)+' GB';
  if(mb<.1) return (mb*1024).toFixed(0)+' KB';
  return mb.toFixed(1)+' MB';
}

function log(txt,cls='ldim'){
  const el=document.getElementById('tlog');
  const d=document.createElement('div');
  d.className='ll '+cls;
  d.style.animationDelay=(logIdx++*20)+'ms';
  const ts=new Date().toLocaleTimeString('en-US',{hour12:false});
  d.textContent='['+ts+'] '+txt;
  el.appendChild(d);el.scrollTop=el.scrollHeight;
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms))}

async function arcAnim(from,to,dur){
  const cfill=document.getElementById('cfill');
  const cpct=document.getElementById('cpct');
  const circ=188,steps=30,st=dur/steps;
  for(let i=0;i<=steps;i++){
    const v=from+(to-from)*(i/steps);
    cfill.style.strokeDashoffset=circ-(v/100)*circ;
    cpct.textContent=Math.round(v)+'%';
    await sleep(st);
  }
}

// ── Scan ──
async function startScan(){
  if(scanning) return;
  scanning=true;
  files=[];
  document.getElementById('btn-scan').classList.add('running');
  document.getElementById('sico').textContent='↻';
  document.getElementById('stext').textContent='Scanning...';
  document.getElementById('btn-clean').disabled=true;
  document.getElementById('result').classList.remove('show');
  document.getElementById('flist').innerHTML='<div class="empty-state"><span>Scanning...</span></div>';
  resetStats();

  const opts={
    dups: document.getElementById('t1').classList.contains('on'),
    logs: document.getElementById('t2').classList.contains('on'),
    temp: document.getElementById('t3').classList.contains('on'),
    empty: document.getElementById('t4').classList.contains('on'),
  };
  const customPath = document.getElementById('scanPath').value.trim();

  log('Starting scan...','linfo');
  document.getElementById('scan-sub').textContent='// SCANNING...';
  document.getElementById('status-txt').textContent='SCANNING';

  await arcAnim(0,10,400);

  try {
    // poll progress
    const pollInterval = setInterval(async()=>{
      try{
        const r=await fetch('/api/status');
        const s=await r.json();
        if(s.total>0){
          const pct=Math.min(95,Math.floor((s.progress/s.total)*85)+10);
          document.getElementById('cfill').style.strokeDashoffset=188-(pct/100)*188;
          document.getElementById('cpct').textContent=pct+'%';
          document.getElementById('scan-sub').textContent='// '+s.current.slice(0,30);
          if(s.current && s.current!==document._lastStatus){
            document._lastStatus=s.current;
            log(s.current,'ldim');
          }
        }
        if(!s.running) clearInterval(pollInterval);
      }catch{}
    },400);

    const res = await fetch('/api/scan',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...opts, customPath})
    });
    clearInterval(pollInterval);
    const data = await res.json();
    files = data.results;
  } catch(e){
    log('Error: '+e.message,'lerr');
  }

  await arcAnim(85,100,400);

  scanning=false;
  document.getElementById('btn-scan').classList.remove('running');
  document.getElementById('sico').textContent='&#9760;';
  document.getElementById('stext').textContent='Rescan';
  document.getElementById('scan-sub').textContent='// SCAN COMPLETE';
  document.getElementById('status-txt').textContent='READY';
  document.getElementById('btn-clean').disabled=files.filter(f=>f.selected).length===0;

  updateStats();
  renderList();

  const totalSz = files.reduce((s,f)=>s+f.sizeMB,0);
  log('Scan complete — '+files.length+' items found ('+fmt(totalSz)+')','lok');
}

// ── Stats ──
function resetStats(){
  ['sv1','sv2','sv3','sv4'].forEach(id=>document.getElementById(id).textContent='0');
  ['ss1','ss2','ss3'].forEach(id=>document.getElementById(id).textContent='— MB');
  ['p1','p2','p3','p4'].forEach(id=>document.getElementById(id).style.width='0');
  ['cs1','cs2','cs3','cs4'].forEach(id=>document.getElementById(id).textContent='–');
  ['cc1','cc2','cc3','cc4'].forEach(id=>document.getElementById(id).textContent='waiting...');
}

function updateStats(){
  const d=files.filter(f=>f.type==='duplicate');
  const l=files.filter(f=>f.type==='log');
  const t=files.filter(f=>f.type==='temp');
  const e=files.filter(f=>f.type==='empty');
  const sumMB = arr=>arr.reduce((s,f)=>s+f.sizeMB,0);

  document.getElementById('sv1').textContent=d.length;
  document.getElementById('sv2').textContent=l.length;
  document.getElementById('sv3').textContent=t.length;
  document.getElementById('sv4').textContent=Math.round(sumMB(files));
  document.getElementById('ss1').textContent=fmt(sumMB(d));
  document.getElementById('ss2').textContent=fmt(sumMB(l));
  document.getElementById('ss3').textContent=fmt(sumMB(t));

  const mx=Math.max(sumMB(d),sumMB(l),sumMB(t),sumMB(e),1);
  document.getElementById('p1').style.width=Math.round(sumMB(d)/mx*100)+'%';
  document.getElementById('p2').style.width=Math.round(sumMB(l)/mx*100)+'%';
  document.getElementById('p3').style.width=Math.round(sumMB(t)/mx*100)+'%';
  document.getElementById('p4').style.width=Math.max(3,Math.round(sumMB(e)/mx*100))+'%';
  document.getElementById('cs1').textContent=fmt(sumMB(d));
  document.getElementById('cs2').textContent=fmt(sumMB(l));
  document.getElementById('cs3').textContent=fmt(sumMB(t));
  document.getElementById('cs4').textContent=e.length+' files';
  document.getElementById('cc1').textContent=d.length+' duplicate files';
  document.getElementById('cc2').textContent=l.length+' log files';
  document.getElementById('cc3').textContent=t.length+' temp files';
  document.getElementById('cc4').textContent=e.length+' empty files';
}

// ── File List ──
const ICONS={duplicate:'&#128257;',log:'&#128203;',temp:'&#128193;',empty:'&#9711;'};

function renderList(){
  const container=document.getElementById('flist');
  const vis=filter==='all'?files:files.filter(f=>f.type===filter);
  if(!vis.length){
    container.innerHTML='<div class="empty-state"><span style="font-size:20px">&#127881;</span><span>Nothing found!</span></div>';
    return;
  }
  container.innerHTML='';
  vis.forEach((f,i)=>{
    const el=document.createElement('div');
    el.className='fitem'+(f.selected?' on':'');
    el.id='fi-'+f.id;
    el.style.animationDelay=(i*22)+'ms';
    const nm=f.name.length>36?f.name.slice(0,33)+'...':f.name;
    el.innerHTML=\`<span class="fi-ico">\${ICONS[f.type]||'?'}</span><span class="fi-nm" title="\${f.path}">\${nm}</span><span class="fi-sz">\${fmt(f.sizeMB)}</span><div class="fi-chk">\${f.selected?'&#10003;':''}</div>\`;
    el.onclick=()=>toggleFile(f.id);
    container.appendChild(el);
  });
  updateSelCount();
}

function toggleFile(id){
  const f=files.find(x=>x.id===id);if(!f)return;
  f.selected=!f.selected;
  const el=document.getElementById('fi-'+id);
  if(el){el.classList.toggle('on',f.selected);el.querySelector('.fi-chk').innerHTML=f.selected?'&#10003;':'';}
  updateSelCount();
}

function selAll(){
  const vis=filter==='all'?files:files.filter(f=>f.type===filter);
  const all=vis.every(f=>f.selected);
  vis.forEach(f=>f.selected=!all);
  renderList();
}

function updateSelCount(){
  const n=files.filter(f=>f.selected).length;
  document.getElementById('sel-ct').textContent=n+' selected';
  document.getElementById('btn-clean').disabled=n===0;
}

function setFilter(type,el){
  filter=type;
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  el.classList.add('on');
  renderList();
}

// ── Clean ──
async function cleanFiles(){
  const sel=files.filter(f=>f.selected);
  if(!sel.length) return;
  document.getElementById('btn-clean').disabled=true;
  document.getElementById('btn-scan').disabled=true;
  const secure=document.getElementById('t5').classList.contains('on');
  const totalSz=sel.reduce((s,f)=>s+f.sizeMB,0);
  log('Starting cleanup — '+sel.length+' files...','lwarn');

  try{
    const res=await fetch('/api/delete',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ids:sel.map(f=>f.id),secure})
    });
    const data=await res.json();

    for(const r of data.results){
      const el=document.getElementById('fi-'+r.id);
      if(el) el.classList.add('del');
      if(r.success){
        files=files.filter(f=>f.id!==r.id);
        log('Deleted: '+sel.find(f=>f.id===r.id)?.name,'lok');
      } else {
        log('Failed: '+r.error,'lerr');
      }
      await sleep(60);
    }
  }catch(e){
    log('Error: '+e.message,'lerr');
  }

  updateStats();
  renderList();
  document.getElementById('btn-scan').disabled=false;

  const res=document.getElementById('result');
  res.classList.add('show');
  document.getElementById('res-title').textContent='Cleanup complete!';
  document.getElementById('res-sub').textContent=sel.length+' files deleted — '+fmt(totalSz)+' freed';
  log('Done! '+fmt(totalSz)+' freed — AmirAlone@voidethic','lok');
}

// ── Glitch effect ──
setInterval(()=>{
  const vals=document.querySelectorAll('.stat-val');
  if(!vals.length)return;
  const v=vals[Math.floor(Math.random()*vals.length)];
  v.style.filter='brightness(2.2) hue-rotate(25deg)';
  setTimeout(()=>v.style.filter='',55);
},3800);
</script>
</body>
</html>`;

// ── HTTP Server ──
const server = http.createServer(async (req, res) => {
  const url = req.url;

  // Serve UI
  if (req.method === 'GET' && url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  // Scan status
  if (req.method === 'GET' && url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(scanStatus));
    return;
  }

  // Start scan
  if (req.method === 'POST' && url === '/api/scan') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const opts = JSON.parse(body);
        const dirs = opts.customPath ? [opts.customPath] : DEFAULT_PATHS;
        runScan(dirs, opts); // async, don't await
        // poll until done
        while (scanStatus.running) await new Promise(r => setTimeout(r, 200));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: scanResults }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Delete files
  if (req.method === 'POST' && url === '/api/delete') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { ids, secure } = JSON.parse(body);
        const results = deleteFiles(ids, secure);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n  AmirAlone — SysClean Pro v3.0');
  console.log('  github.com/voidethic | discord.gg/K6NvjzKc');
  console.log('  ─────────────────────────────────────');
  console.log('  Server running at: http://localhost:' + PORT);
  console.log('  Opening browser...\n');

  // Auto-open browser on Windows
  try {
    execSync('start http://localhost:' + PORT, { stdio: 'ignore' });
  } catch {
    console.log('  Open manually: http://localhost:' + PORT);
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('  Port ' + PORT + ' is busy. Close other instances first.');
  } else {
    console.error('  Server error:', e.message);
  }
  process.exit(1);
});
