const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const LOGF = path.join(__dirname, 'test-parse-result.txt');
const buf = [];
const out = (...a) => { const l = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); buf.push(l); try { fs.writeFileSync(LOGF, buf.join('\n'), 'utf8'); } catch (e) {} };
process.on('uncaughtException', (e) => { out('UNCAUGHT ' + String(e && e.stack || e)); setTimeout(() => app.exit(1), 200); });

const LINK = process.env.TEST_LINK || 'https://v.douyin.com/7CX4yB3-IDA/';
const TIMES = Number(process.env.TEST_TIMES || 3);

app.whenReady().then(async () => {
  const p = require(path.join(__dirname, '..', 'src', 'parser.js'));
  p.setLogger((...a) => out('  [log]', ...a));
  for (let i = 0; i < TIMES; i++) {
    const t0 = Date.now();
    let r;
    try { r = await p.parseItem(LINK); } catch (e) { r = { ok: false, error: 'THROW ' + (e && e.message) }; }
    out('\n### 第' + (i + 1) + '次 ' + (Date.now() - t0) + 'ms  ok=' + r.ok + ' via=' + r.via + ' kind=' + r.kind + ' ' + (r.error || ''));
    out('  ' + r.author + ' | ' + r.shortTitle + ' | imgs=' + (r.images || []).length);
    out('  v=' + String(r.videoUrl || '').slice(0, 80));
  }
  out('\nDONE ' + TIMES + ' 轮');
  setTimeout(() => app.exit(0), 300);
});
