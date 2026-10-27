const { app } = require('electron');
const path = require('path'); const fs = require('fs');
const LOGF = path.join(__dirname, 'test-dl-result.txt');
const buf = []; const out = (...a) => { buf.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); fs.writeFileSync(LOGF, buf.join('\n'), 'utf8'); };
process.on('uncaughtException', e => { out('UNCAUGHT ' + (e && e.stack)); setTimeout(() => app.exit(1), 200); });
const LINK = process.env.TEST_LINK || 'https://v.douyin.com/7CX4yB3-IDA/';
const DIR = process.env.TEST_DIR || path.join(__dirname, '..', 'tmp-dl');
app.whenReady().then(async () => {
  const p = require(path.join(__dirname, '..', 'src', 'parser.js'));
  p.setLogger((...a) => out('[log]', ...a));
  const t0 = Date.now();
  const it = await p.parseItem(LINK);
  out('parse ' + (Date.now() - t0) + 'ms ok=' + it.ok + ' ' + it.author + ' | ' + it.shortTitle);
  if (!it.ok) { out('FAIL ' + it.error); return setTimeout(() => app.exit(1), 300); }
  const t1 = Date.now();
  try {
    const r = await p.downloadItem(it, DIR, `${it.author}_${it.shortTitle}`, (s) => {
      if (s.status === 'downloading' && (!s.total || s.total > 1)) out('  prog ' + (s.progress || 0) + '% ' + (s.note || s.name || ''));
    });
    out('download ' + (Date.now() - t1) + 'ms files=' + JSON.stringify(r));
  } catch (e) { out('DL-ERR ' + (e && e.message)); }
  // 校验落盘
  try {
    for (const f of fs.readdirSync(DIR)) {
      const st = fs.statSync(path.join(DIR, f));
      const head = Buffer.alloc(12); const fd = fs.openSync(path.join(DIR, f), 'r'); fs.readSync(fd, head, 0, 12, 0); fs.closeSync(fd);
      out('  FILE ' + f + '  ' + st.size + ' bytes  magic=' + head.toString('hex').slice(0, 8));
    }
  } catch (e) { out('readdir err', e.message); }
  out('DONE');
  setTimeout(() => app.exit(0), 300);
});
