'use strict';

const $ = (sel) => document.querySelector(sel);
// 注意：变量名不能叫 api，会和 preload 暴露的 window.api 全局属性冲突
const dy = window.api;

const state = {
  autoDownload: true,
  root: '',
  cards: new Map(), // taskId -> card ref
  queue: [],
  running: false,
};

/* ---------------- 工具 ---------------- */

function toast(msg, ms = 2400) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), ms);
}

function fmtBytes(n) {
  if (!n || n < 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function renderDir(root) {
  state.root = root || '';
  $('#dirText').textContent = root ? `${root}\\${today()}` : '未设置下载目录';
}

/* ---------------- 初始化 ---------------- */

async function init() {
  const s = await dy.getSettings();
  state.autoDownload = !!s.autoDownload;
  $('#autoDl').checked = state.autoDownload;
  $('#watchClip').checked = s.watchClipboard !== false;
  $('#floatOn').checked = s.floatEnabled !== false;
  renderDir(s.downloadRoot);

  dy.onProgress(onProgress);
  dy.onTaskParsed(onExternalParsed);
  dy.onTaskDone(onExternalDone);
  dy.onWatchChanged((d) => {
    if (d) $('#watchClip').checked = !!d.watchClipboard;
  });

  $('#btnMin').onclick = () => dy.minimize();
  $('#btnClose').onclick = () => dy.close();
  $('#btnParse').onclick = doParse;
  $('#btnPaste').onclick = doPaste;
  $('#btnDir').onclick = () => dy.openDir(state.root);
  $('#btnChangeDir').onclick = changeDir;
  $('#autoDl').onchange = async (e) => {
    state.autoDownload = e.target.checked;
    await dy.setAutoDownload(state.autoDownload);
    toast(state.autoDownload ? '解析完会自动开始下载' : '改为手动点按钮下载');
  };
  $('#watchClip').onchange = async (e) => {
    const r = await dy.setWatch(e.target.checked);
    toast(r && r.watchClipboard ? '已开启：复制抖音链接就自动下载' : '已暂停剪贴板监听');
  };
  $('#floatOn').onchange = async (e) => {
    const r = await dy.setFloatEnabled(e.target.checked);
    toast(r && r.floatEnabled ? '抖音窗口旁边会出现小条' : '悬浮条已关闭');
  };

  $('#input').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      doParse();
    }
  });
  $('#input').addEventListener('input', (e) => {
    const n = (e.target.value.match(/https?:\/\//g) || []).length;
    $('#hint').textContent = n > 1 ? `识别到 ${n} 条链接，会依次处理` : 'Ctrl + Enter 立即解析';
  });
}

/* ---------------- 剪贴板 / 悬浮条发起的任务 ---------------- */

function onExternalParsed(d) {
  if (!d || !d.item) return;
  if (d.source !== 'clip' && d.source !== 'float') return;

  $('#empty').style.display = 'none';
  const item = d.item;
  item.taskId = d.taskId;

  const card = addCard(item);
  card.classList.remove('pending');
  state.cards.set(d.taskId, card);
  setState(card, 'downloading', '正在连接…');
}

function onExternalDone(d) {
  if (!d || !d.taskId) return;
  const card = state.cards.get(d.taskId);
  if (!card) return;
  state.cards.delete(d.taskId);

  if (d.skipped) {
    setState(card, 'ready', '已解析，等待下载');
    return;
  }

  if (d.ok) {
    card._savedPath = (d.files && d.files[0]) || d.dir || '';
    const extra = d.files && d.files.length > 1 ? ` · ${d.files.length} 个文件` : '';
    setState(card, 'done', '已保存' + extra);
    toast('下载完成');
  } else {
    setState(card, 'error', d.error || '下载失败');
  }
}

async function doPaste() {
  const text = await dy.clipboardText();
  if (!text || !text.trim()) {
    toast('剪贴板是空的');
    return;
  }
  const box = $('#input');
  box.value = text.trim();
  box.dispatchEvent(new Event('input'));
  box.focus();
}

async function changeDir() {
  const r = await dy.chooseDir();
  if (r && r.ok) {
    renderDir(r.downloadRoot);
    toast('下载位置已更新');
  }
}

/* ---------------- 解析 ---------------- */

async function doParse() {
  const text = $('#input').value.trim();
  if (!text) {
    toast('先粘贴一个抖音链接');
    $('#input').focus();
    return;
  }

  const btn = $('#btnParse');
  btn.disabled = true;
  btn.querySelector('span').textContent = '解析中…';
  $('#empty').style.display = 'none';

  let res;
  try {
    res = await dy.parse(text);
  } catch (err) {
    res = { ok: false, error: err.message };
  }

  btn.disabled = false;
  btn.querySelector('span').textContent = '开始解析';

  if (!res || !res.ok) {
    toast(res && res.error ? res.error : '解析失败');
    return;
  }

  for (const item of res.results) addCard(item);
  $('#input').value = '';
  $('#hint').textContent = 'Ctrl + Enter 立即解析';

  const pending = [...document.querySelectorAll('.item.pending')];
  if (state.autoDownload && pending.length) {
    for (const el of pending) enqueue(el);
    runQueue();
  }
}

/* ---------------- 卡片 ---------------- */

/** 没有封面时，用视频首帧顶上 */
function fallbackToVideo(thumb, item) {
  if (item.videoUrl) {
    const v = document.createElement('video');
    v.src = item.videoUrl;
    v.muted = true;
    v.playsInline = true;
    v.preload = 'metadata';
    v.className = 'peek';
    v.addEventListener('loadeddata', () => {
      try {
        v.currentTime = 0.1;
      } catch (_) {}
    });
    v.onerror = () => {
      v.remove();
      addPlaceholder(thumb, '无水印视频');
    };
    thumb.appendChild(v);
  } else {
    addPlaceholder(thumb, item.kind === 'note' ? '图集' : '暂无封面');
  }
}

function addPlaceholder(thumb, text) {
  if (thumb.querySelector('.ph')) return;
  const ph = document.createElement('div');
  ph.className = 'ph';
  ph.textContent = text;
  thumb.prepend(ph);
}

function addCard(item) {
  const box = $('#results');

  const card = document.createElement('div');
  card.className = 'item' + (item.ok ? ' pending' : ' error');
  card._item = item;
  card._status = item.ok ? 'pending' : 'error';

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (item.cover) {
    const img = document.createElement('img');
    img.src = item.cover;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => {
      img.remove();
      fallbackToVideo(thumb, item);
    };
    thumb.appendChild(img);
  } else {
    fallbackToVideo(thumb, item);
  }
  const badge = document.createElement('span');
  badge.className = 'badge' + (item.kind === 'note' ? ' note' : '');
  badge.textContent =
    item.kind === 'note' ? `图集 ${item.images.length}P` : item.videoUrl ? '视频' : '无法解析';
  if (!item.ok) badge.textContent = '失败';
  thumb.appendChild(badge);

  const body = document.createElement('div');
  body.className = 'body';

  const title = document.createElement('div');
  title.className = 'item-title';
  title.textContent = item.ok
    ? item.shortTitle || item.title || '(无标题)'
    : item.input || '这个链接没处理成功';
  title.title = item.ok ? item.title || item.shortTitle || '' : title.textContent;

  const meta = document.createElement('div');
  meta.className = 'meta';
  if (item.ok) {
    const a = document.createElement('span');
    a.className = 'author';
    a.textContent = item.author || '未知作者';
    const d1 = document.createElement('span');
    d1.className = 'dot';
    const kind = document.createElement('span');
    kind.textContent = item.kind === 'note' ? `${item.images.length} 张图片` : '无水印视频';
    meta.append(a, d1, kind);
  } else {
    const e = document.createElement('span');
    e.className = 'state err';
    e.textContent = item.error || '解析失败';
    meta.appendChild(e);
  }

  const spacer = document.createElement('div');
  spacer.className = 'spacer';

  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.style.display = 'none';
  const fill = document.createElement('i');
  bar.appendChild(fill);

  const actions = document.createElement('div');
  actions.className = 'item-actions';

  const stateEl = document.createElement('span');
  stateEl.className = 'state';
  stateEl.textContent = item.ok ? '等待下载' : '';

  const sp2 = document.createElement('span');
  sp2.className = 'spacer';

  const btn = document.createElement('button');
  btn.className = 'dl-btn';
  btn.textContent = '下载';
  if (!item.ok) btn.style.display = 'none';
  btn.onclick = () => {
    if (card._status === 'pending' || card._status === 'error') {
      enqueue(card);
      runQueue();
    } else if (card._status === 'done') {
      dy.openPath(card._savedPath || '');
    }
  };

  actions.append(stateEl, sp2, btn);
  body.append(title, meta, spacer, bar, actions);
  card.append(thumb, body);
  box.appendChild(card);

  card._refs = { stateEl, bar, fill, btn, title };
  return card;
}

function setState(card, status, text) {
  card._status = status;
  const { stateEl, btn, bar, fill } = card._refs;
  stateEl.className = 'state';
  stateEl.innerHTML = '';
  if (status === 'downloading' || status === 'queued') {
    const sp = document.createElement('span');
    sp.className = 'spin';
    stateEl.appendChild(sp);
    stateEl.appendChild(document.createTextNode(text || ''));
  } else if (status === 'done') {
    stateEl.className = 'state ok';
    stateEl.textContent = text || '已完成';
  } else if (status === 'error') {
    stateEl.className = 'state err';
    stateEl.textContent = text || '失败';
  } else {
    stateEl.textContent = text || '';
  }

  if (status === 'downloading' || status === 'queued') {
    bar.style.display = 'block';
    btn.disabled = true;
    btn.textContent = status === 'queued' ? '排队中' : '下载中';
  } else if (status === 'done') {
    bar.style.display = 'block';
    bar.classList.add('done');
    fill.style.width = '100%';
    btn.disabled = false;
    btn.textContent = '打开';
  } else if (status === 'error') {
    btn.disabled = false;
    btn.textContent = '重试';
  } else {
    btn.disabled = false;
    btn.textContent = '下载';
  }
}

/* ---------------- 下载队列 ---------------- */

function enqueue(card) {
  if (!card || card._status === 'done' || card._status === 'downloading' || card._status === 'queued') return;
  card._status = 'queued';
  setState(card, 'queued', '排队中');
  state.queue.push(card);
}

async function runQueue() {
  if (state.running) return;
  state.running = true;

  while (state.queue.length) {
    const card = state.queue.shift();
    if (!card || !card.isConnected) continue;
    await runOne(card);
  }

  state.running = false;
}

async function runOne(card) {
  const item = card._item;
  const taskId = `${item.awemeId}_${Date.now()}`;
  item.taskId = taskId;
  state.cards.set(taskId, card);

  setState(card, 'downloading', '正在连接…');

  let r;
  try {
    r = await dy.download(item);
  } catch (err) {
    r = { ok: false, error: err.message };
  }

  if (r && r.ok) {
    card._savedPath = (r.files && r.files[0]) || r.dir || '';
    const extra = r.files.length > 1 ? ` · ${r.files.length} 个文件` : '';
    setState(card, 'done', '已保存' + extra);
    toast('下载完成');
  } else {
    setState(card, 'error', (r && r.error) || '下载失败');
    toast('下载失败：' + ((r && r.error) || '未知错误'));
  }
  state.cards.delete(taskId);
}

/* ---------------- 进度 ---------------- */

function onProgress(d) {
  const card = state.cards.get(d.taskId);
  if (!card) return;
  const { fill, stateEl } = card._refs;

  if (d.status === 'downloading') {
    const pct = d.progress || 0;
    fill.style.width = pct + '%';
    const size = d.total ? `${fmtBytes(d.received)} / ${fmtBytes(d.total)}` : fmtBytes(d.received);
    stateEl.innerHTML = '';
    const sp = document.createElement('span');
    sp.className = 'spin';
    stateEl.appendChild(sp);
    stateEl.appendChild(document.createTextNode(d.note ? `${d.note} · ${pct}%` : `${pct}%  ${size}`));
  } else if (d.status === 'error') {
    setState(card, 'error', d.message || '下载失败');
  }
}

init();
