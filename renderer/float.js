'use strict';

/**
 * 悬浮小条
 * 所有解析 / 下载都由主进程统一执行，这里只负责展示和发起。
 */

const $ = (s) => document.querySelector(s);
const dy = window.api;

const ui = {
  panel: $('.panel'),
  dot: $('#dot'),
  inp: $('#inp'),
  go: $('#go'),
  shot: $('#shot'),
  line1: $('#line1'),
  line2: $('#line2'),
  track: $('.track'),
  fill: $('#fill'),
  btnWatch: $('#btnWatch'),
};

let watchOn = true;
let busy = false;
let curTaskId = null;
let probeTimer = null;

/* ---------------- 小工具 ---------------- */

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function setDot(mode) {
  ui.dot.className = 'dot' + (mode === 'off' ? ' off' : mode === 'busy' ? ' busy' : '');
}

function setShot(url) {
  ui.shot.innerHTML = '';
  ui.shot.classList.remove('has-img');
  if (!url) {
    ui.shot.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path fill="currentColor" d="M14.6 3h2.5c.3 1.9 1.6 3.4 3.9 3.6v2.6c-1.5 0-2.9-.4-3.9-1.2v6.6a5.7 5.7 0 1 1-5.7-5.7c.3 0 .6 0 .9.1v2.7a3 3 0 1 0 2.1 2.9V3z"/></svg>';
    return;
  }
  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  img.onload = () => ui.shot.classList.add('has-img');
  img.onerror = () => setShot('');
  ui.shot.appendChild(img);
}

function setTrack(pct, state) {
  ui.track.className = 'track' + (state ? ' ' + state : '');
  ui.fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
}

function setBusy(on) {
  busy = on;
  ui.go.disabled = on;
  ui.inp.disabled = on;
  if (on) setDot('busy');
  else setDot(watchOn ? 'idle' : 'off');
}

/* ---------------- 状态展示 ---------------- */

function showIdle() {
  ui.line1.className = 'line1';
  ui.line2.className = 'line2';
  ui.line1.textContent = '等待复制链接';
  ui.line2.textContent = watchOn ? '自动监听中 · 在抖音里复制链接即可' : '自动监听已暂停';
  setShot('');
  setTrack(0);
}

function showParsing(text) {
  setBusy(true);
  ui.line1.className = 'line1 shimmer';
  ui.line2.className = 'line2';
  ui.line1.textContent = '正在解析…';
  ui.line2.textContent = text ? String(text).slice(0, 60) : '请稍等';
  setShot('');
  setTrack(12);
}

function showItem(item) {
  ui.line1.className = 'line1';
  ui.line2.className = 'line2';
  const t = item.shortTitle || item.title || item.awemeId || '作品';
  ui.line1.textContent = t;
  ui.line1.title = item.title || t;
  ui.line2.textContent =
    (item.author && item.author !== '未知作者' ? '@' + item.author : '') +
    (item.kind === 'note' ? ` · 图集 ${item.images ? item.images.length : 0}P` : ' · 视频');
  setShot(item.cover || (item.images && item.images[0]) || '');
  setTrack(6);
}

function showProgress(p) {
  const pct = Number(p.progress) || 0;
  setTrack(pct);
  ui.line2.className = 'line2';
  if (p.note) {
    // 图集：第 3/9 张
    ui.line2.textContent = `${p.note} · ${pct}%`;
  } else if (p.total) {
    ui.line2.textContent = `${fmtBytes(p.received)} / ${fmtBytes(p.total)} · ${pct}%`;
  } else {
    ui.line2.textContent = `下载中 ${pct}%`;
  }
}

function showDone(text) {
  setBusy(false);
  ui.line2.className = 'line2 ok';
  ui.line1.className = 'line1';
  ui.line2.textContent = text || '已保存';
  setTrack(100, 'done');
  clearTimeout(probeTimer);
  probeTimer = setTimeout(() => {
    if (!busy) {
      showIdle();
      setDot(watchOn ? 'idle' : 'off');
    }
  }, 6000);
}

function showError(msg) {
  setBusy(false);
  ui.line2.className = 'line2 err';
  ui.line2.textContent = msg || '出错了';
  setTrack(100, 'err');
  clearTimeout(probeTimer);
  probeTimer = setTimeout(() => {
    if (!busy) showIdle();
  }, 6000);
}

/* ---------------- 发起任务 ---------------- */

async function submit(text) {
  const v = String(text || '').trim();
  if (!v || busy) return;
  showParsing('正在识别链接');
  try {
    const r = await dy.submit(v, 'float');
    if (!r || !r.ok) {
      showError((r && r.error) || '没能识别出抖音链接');
    }
  } catch (e) {
    showError(e.message || '解析失败');
  }
}

function autoSubmitIfLink(v) {
  const s = String(v || '');
  if (!/https?:\/\/[^\s]+/.test(s) && !/^\d{15,21}$/.test(s.trim())) return;
  if (!/douyin|iesdouyin|snssdk|amemv/i.test(s) && !/^\d{15,21}$/.test(s.trim())) return;
  submit(s);
}

/* ---------------- 事件 ---------------- */

ui.inp.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submit(ui.inp.value);
  }
});

ui.inp.addEventListener('input', () => {
  const v = ui.inp.value.trim();
  clearTimeout(ui.inp._t);
  if (!v) return;
  ui.inp._t = setTimeout(() => {
    if (ui.inp.value.trim() === v) autoSubmitIfLink(v);
  }, 500);
});

ui.go.addEventListener('click', () => {
  if (ui.inp.value.trim()) submit(ui.inp.value);
  else ui.inp.focus();
});

ui.btnWatch.addEventListener('click', async () => {
  watchOn = !watchOn;
  ui.btnWatch.classList.toggle('off', !watchOn);
  ui.btnWatch.title = watchOn ? '暂停自动监听' : '开启自动监听';
  await dy.setWatch(watchOn);
  if (!busy) {
    showIdle();
    setDot(watchOn ? 'idle' : 'off');
  }
});

$('#btnMain').addEventListener('click', () => dy.openMain());
$('#btnHide').addEventListener('click', () => dy.hideFloat());

/* 主进程事件 */

dy.onClipHit((d) => {
  clearTimeout(probeTimer);
  const raw = String((d && d.text) || '').trim();
  showParsing(raw && raw.length < 40 ? raw : '已捕获抖音链接，解析中');
  ui.inp.value = '';
});

dy.onTaskParsed((d) => {
  if (!d || !d.item) return;
  if (d.source !== 'clip' && d.source !== 'float') return;
  curTaskId = d.taskId;
  showItem(d.item);
});

dy.onProgress((p) => {
  if (!p || (curTaskId && p.taskId !== curTaskId)) return;
  if (p.taskId) curTaskId = p.taskId;
  if (p.status === 'downloading') {
    if (ui.line1.className.indexOf('shimmer') >= 0) {
      ui.line1.className = 'line1';
      ui.line1.textContent = '正在下载';
    }
    setBusy(true);
    showProgress(p);
  } else if (p.status === 'error') {
    showError(p.message || '下载失败');
  }
});

dy.onTaskDone((d) => {
  if (!d || (curTaskId && d.taskId !== curTaskId)) return;
  if (d.ok) {
    const n = (d.files && d.files.length) || 1;
    const parts = [];
    if (d.size) parts.push(fmtBytes(d.size));
    if (n > 1) parts.push(n + ' 个文件');
    showDone(parts.length ? '已保存 · ' + parts.join(' · ') : '已保存');
    ui.line1.title = ((d.files && d.files[0]) || '').split(/[\\/]/).pop() || '';
  } else {
    showError(d.error || '下载失败');
  }
  ui.inp.value = '';
});

/* ---------------- 初始化 ---------------- */

(async function init() {
  try {
    const s = await dy.getSettings();
    watchOn = s.watchClipboard !== false;
  } catch (_) {}
  ui.btnWatch.classList.toggle('off', !watchOn);
  ui.btnWatch.title = watchOn ? '暂停自动监听' : '开启自动监听';
  showIdle();
  setDot(watchOn ? 'idle' : 'off');
  setTimeout(() => ui.inp.focus(), 120);
})();
