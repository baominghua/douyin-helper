'use strict';

/**
 * 抖音下载小助手 —— 主进程
 *
 * 两个窗口：
 *   mainWin  ：完整界面（粘贴、历史、设置）
 *   floatWin ：贴在抖音客户端窗口旁边的小条，随客户端出现/隐藏/移动
 *
 * 解析与下载核心在 src/parser.js，窗口跟随在 src/window-anchor.js
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  session,
  shell,
  screen,
  clipboard,
  Tray,
  Menu,
  nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const parser = require('./src/parser');
const protoFix = require('./src/proto-fix');
const { WindowAnchor } = require('./src/window-anchor');

// 尽早改名，保证 userData 落在 %APPDATA%\DouyinHelper 而不是公共的 Electron 目录
app.setName('DouyinHelper');

const HOME = parser.HOME;
const PARTITION = parser.PARTITION;
const LOG_FILE = path.join(__dirname, 'logs', 'app.log');

const FLOAT_W = 372;
const FLOAT_H = 178;
const FLOAT_GAP = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 日志                                                                */
/* ------------------------------------------------------------------ */

function logLine(...args) {
  const text =
    new Date().toISOString().slice(11, 19) +
    '  ' +
    args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, text + '\n');
  } catch (_) {}
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

const settings = {
  downloadRoot: '',
  autoDownload: true,
  watchClipboard: true,
  floatEnabled: true,
  launchAtLogin: false,
  // 抖音客户端会探测 bitbrowser:// 协议，没装就弹「找不到应用」，这里默认帮它挂个静默接收器
  protoFix: true,
};

function loadSettings() {
  try {
    Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8')));
  } catch (_) {}
  if (!settings.downloadRoot) {
    settings.downloadRoot = path.join(app.getPath('downloads'), '抖音下载');
  }
  logLine('下载目录 =', settings.downloadRoot);
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) {
    logLine('保存设置失败', e.message);
  }
}

/* ------------------------------------------------------------------ */
/* 历史记录                                                            */
/* ------------------------------------------------------------------ */

const historyFile = () => path.join(app.getPath('userData'), 'history.json');

function pushHistory(entry) {
  try {
    let hist = [];
    try {
      hist = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
    } catch (_) {}
    hist.unshift(entry);
    fs.writeFileSync(historyFile(), JSON.stringify(hist.slice(0, 300), null, 2), 'utf8');
  } catch (e) {
    logLine('写历史失败', e.message);
  }
}

/* ------------------------------------------------------------------ */
/* 窗口广播                                                            */
/* ------------------------------------------------------------------ */

function bcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w && !w.isDestroyed()) {
      try {
        w.webContents.send(channel, payload);
      } catch (_) {}
    }
  }
}

/* ------------------------------------------------------------------ */
/* 主窗口                                                              */
/* ------------------------------------------------------------------ */

let mainWin = null;
let balloonShown = false;

function createMainWindow() {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.show();
    mainWin.focus();
    return mainWin;
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWin = new BrowserWindow({
    width: Math.min(1080, Math.max(900, width - 120)),
    height: Math.min(780, Math.max(640, height - 120)),
    minWidth: 880,
    minHeight: 620,
    frame: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    backgroundColor: '#f4f5f7',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // ready-to-show 在部分显卡/远程桌面环境下不触发，多重兜底
  const revealMain = (why) => {
    if (!mainWin || mainWin.isDestroyed()) return;
    if (mainWin.isVisible()) return;
    mainWin.show();
    logLine('主窗口显示（' + why + '）');
  };
  mainWin.once('ready-to-show', () => revealMain('ready-to-show'));
  mainWin.webContents.once('did-finish-load', () => setTimeout(() => revealMain('did-finish-load'), 150));
  setTimeout(() => revealMain('timeout'), 1200);

  mainWin.on('close', (e) => {
    // 关窗只是收进托盘，程序要继续在后台守着剪贴板
    if (!app.isQuitting) {
      e.preventDefault();
      mainWin.hide();
      logLine('主窗口收进托盘');
      if (tray && !balloonShown) {
        balloonShown = true;
        try {
          tray.displayBalloon({
            title: '还在后台守着',
            content: '关掉窗口不影响使用：在抖音里复制链接就会自动下载。双击托盘图标可以重新打开。',
          });
        } catch (_) {}
      }
    }
  });

  mainWin.on('closed', () => {
    mainWin = null;
  });

  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    // 只放行正常网页链接，别的自定义协议一律不往系统里递
    if (/^(https?|file):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  return mainWin;
}

function showMain() {
  if (!mainWin || mainWin.isDestroyed()) createMainWindow();
  else {
    mainWin.show();
    mainWin.focus();
  }
}

/* ------------------------------------------------------------------ */
/* 悬浮条                                                              */
/* ------------------------------------------------------------------ */

let floatWin = null;
let floatReady = false;
let anchor = null;
let floatAttached = true; // 是否跟随抖音窗口（用户拖动后解除）
let lastExpected = null; // 我们最后一次设置的位置，用来识破用户拖动
let floatVisible = false;

function createFloatWindow() {
  if (floatWin && !floatWin.isDestroyed()) return floatWin;

  floatWin = new BrowserWindow({
    width: FLOAT_W,
    height: FLOAT_H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  floatWin.loadFile(path.join(__dirname, 'renderer', 'float.html'));
  floatWin.setAlwaysOnTop(true, 'floating');

  floatReady = false;
  floatWin.webContents.on('did-finish-load', () => {
    floatReady = true;
    logLine('悬浮条已加载');
    // 加载完如果抖音窗口在，立刻补一次显示（首帧空白一闪而过会很难看）
    if (anchor && anchor.rect && settings.floatEnabled) showFloat();
  });

  floatWin.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      hideFloat();
    }
  });

  // 用户手动拖动 → 解除吸附，不再被拉回去
  floatWin.on('moved', () => {
    if (!floatAttached || !lastExpected) return;
    const [x, y] = floatWin.getPosition();
    if (Math.abs(x - lastExpected.x) > 6 || Math.abs(y - lastExpected.y) > 6) {
      floatAttached = false;
      logLine('用户拖动悬浮条，已解除跟随');
    }
  });

  floatWin.on('closed', () => {
    floatWin = null;
    floatReady = false;
  });

  return floatWin;
}

/** 把悬浮条贴到抖音窗口旁边 */
function placeFloat(rect) {
  if (!floatWin || floatWin.isDestroyed()) return;

  let dipTL;
  let dipBR;
  let wa;

  try {
    dipTL = screen.screenToDipPoint({ x: rect.x, y: rect.y });
    dipBR = screen.screenToDipPoint({ x: rect.x + rect.w, y: rect.y + rect.h });
    const d = screen.getDisplayMatching({
      x: Math.round(dipTL.x),
      y: Math.round(dipTL.y),
      width: Math.max(1, Math.round(dipBR.x - dipTL.x)),
      height: Math.max(1, Math.round(dipBR.y - dipTL.y)),
    });
    wa = d.workArea;
  } catch (e) {
    logLine('坐标换算失败，跳过跟随', e.message);
    return;
  }

  const rightEdge = wa.x + wa.width;
  const bottomEdge = wa.y + wa.height;

  let x;
  let y;

  // 优先贴右侧外沿
  x = dipBR.x + FLOAT_GAP;
  if (x + FLOAT_W <= rightEdge) {
    y = dipTL.y + 52;
  } else {
    // 右侧没空间 → 试左侧
    const xLeft = dipTL.x - FLOAT_GAP - FLOAT_W;
    if (xLeft >= wa.x) {
      x = xLeft;
      y = dipTL.y + 52;
    } else {
      // 两侧都被挤满（抖音接近全屏）→ 浮在窗口内右下角
      x = dipBR.x - FLOAT_W - 18;
      y = dipBR.y - FLOAT_H - 18;
    }
  }

  // 收进工作区
  if (x + FLOAT_W > rightEdge) x = rightEdge - FLOAT_W - 4;
  if (x < wa.x) x = wa.x + 4;
  if (y + FLOAT_H > bottomEdge) y = bottomEdge - FLOAT_H - 4;
  if (y < wa.y) y = wa.y + 4;

  x = Math.round(x);
  y = Math.round(y);

  const [cx, cy] = floatWin.getPosition();
  if (Math.abs(cx - x) < 2 && Math.abs(cy - y) < 2) {
    lastExpected = { x, y };
    return;
  }

  lastExpected = { x, y };
  try {
    floatWin.setBounds({ x, y, width: FLOAT_W, height: FLOAT_H }, false);
  } catch (e) {
    logLine('设置悬浮条位置失败', e.message);
  }
}

function showFloat() {
  if (!settings.floatEnabled) return;
  if (!floatWin || floatWin.isDestroyed()) {
    createFloatWindow();
    return; // 加载完成后 did-finish-load 会再进来一次
  }
  if (!floatReady) return; // 页面还没画好，等它
  if (floatVisible) return;

  // 先摆好位置再显示，避免从别处闪一下才跳过去
  if (anchor && anchor.rect) placeFloat(anchor.rect);

  floatWin.showInactive();
  floatVisible = true;
  logLine('悬浮条显示于', JSON.stringify(floatWin.getBounds()));
}

function hideFloat() {
  if (floatWin && !floatWin.isDestroyed() && floatVisible) {
    floatWin.hide();
    floatVisible = false;
  }
}

function toggleFloat() {
  if (floatVisible) hideFloat();
  else showFloat();
}

function setFloatEnabled(v) {
  settings.floatEnabled = !!v;
  saveSettings();
  if (!settings.floatEnabled) hideFloat();
  else if (anchor && anchor.rect) showFloat();
  refreshTrayMenu();
  return settings.floatEnabled;
}

/* ------------------------------------------------------------------ */
/* 抖音窗口跟随                                                        */
/* ------------------------------------------------------------------ */

function onDouyinRect(rect) {
  if (!rect) {
    // 抖音关了 / 最小化了
    hideFloat();
    return;
  }
  if (!settings.floatEnabled) return;
  showFloat();
  if (floatAttached) placeFloat(rect);
}

function startAnchor() {
  if (anchor) return;
  anchor = new WindowAnchor(onDouyinRect, logLine);
  anchor.start();
}

function stopAnchor() {
  if (anchor) {
    anchor.stop();
    anchor = null;
  }
}

/* ------------------------------------------------------------------ */
/* 统一任务管线                                                        */
/* ------------------------------------------------------------------ */

const recentTasks = new Map(); // 链接 -> 时间戳，防重复
let pipelineBusy = false;

function todayFolder() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function downloadTask(item, taskId) {
  const dir = path.join(settings.downloadRoot, todayFolder());
  const nameBase = `${item.author}_${item.shortTitle || item.awemeId}`;

  try {
    const r = await parser.downloadItem(item, dir, nameBase, (p) =>
      bcast('progress', { taskId, ...p })
    );

    let size = 0;
    if (r.ok && Array.isArray(r.files)) {
      for (const f of r.files) {
        try {
          size += (await fsp.stat(f)).size;
        } catch (_) {}
      }
    }

    if (r.ok) {
      pushHistory({
        time: Date.now(),
        title: item.title,
        author: item.author,
        kind: item.kind,
        files: r.files,
        dir: r.dir,
        size,
      });
    }
    return { taskId, ...r, size };
  } catch (err) {
    logLine('下载失败', err.message);
    bcast('progress', { taskId, status: 'error', message: err.message });
    return { taskId, ok: false, error: err.message };
  }
}

/**
 * 解析 + 下载一条或多条链接，全程用事件广播进度
 * @param {string} text 剪贴板原文 / 输入框内容
 * @param {string} source 'clip' | 'float' | 'main'
 */
async function runPipeline(text, source) {
  const links = parser.extractLinks(text);
  if (!links.length) {
    return { ok: false, error: '没找到抖音链接' };
  }

  const now = Date.now();
  const fresh = links.filter((l) => {
    const t = recentTasks.get(l);
    return !t || now - t > 120000; // 同一个链接 2 分钟内不重复下载
  });
  if (!fresh.length) {
    return { ok: false, error: '这条已经下过了' };
  }
  for (const l of fresh) recentTasks.set(l, now);

  bcast('clip-hit', { text, links: fresh, source });

  const out = [];
  pipelineBusy = true;

  try {
    for (const link of fresh.slice(0, 8)) {
      let item;
      try {
        item = await parser.parseItem(link);
      } catch (err) {
        logLine('解析异常', err.message);
        item = { ok: false, input: link, error: err.message };
      }

      if (!item.ok) {
        bcast('task-done', {
          ok: false,
          error: item.error || '这个链接没能解析',
          source,
          input: link,
        });
        out.push(item);
        continue;
      }

      const taskId = `${item.awemeId}_${Date.now()}`;
      bcast('task-parsed', { item, taskId, source });
      out.push({ ...item, taskId });

      if (!settings.autoDownload) {
        bcast('task-done', { ok: true, taskId, source, skipped: true });
        continue;
      }

      // 给界面一点时间把卡片画出来，进度条才接得上
      await sleep(140);

      const r = await downloadTask(item, taskId);
      bcast('task-done', {
        ok: r.ok,
        taskId,
        files: r.files || [],
        dir: r.dir || '',
        size: r.size || 0,
        error: r.error || '',
        source,
      });
    }
  } finally {
    pipelineBusy = false;
  }

  return { ok: true, results: out };
}

/* ------------------------------------------------------------------ */
/* 剪贴板监听                                                          */
/* ------------------------------------------------------------------ */

let clipTimer = null;
let lastClipText = '';

function looksLikeDouyin(text) {
  if (!text || text.length > 20000) return false;
  if (/douyin\.com|iesdouyin\.com|snssdk|amemv\.com/i.test(text)) return true;
  return /(^|\D)(7\d{18})(\D|$)/.test(text);
}

function startClipboardWatch() {
  if (clipTimer) return;

  // 启动瞬间的剪贴板内容不处理，避免把之前复制的又下一遍
  try {
    lastClipText = clipboard.readText() || '';
  } catch (_) {}

  clipTimer = setInterval(async () => {
    if (!settings.watchClipboard) return;
    if (pipelineBusy) return;

    let text = '';
    try {
      text = clipboard.readText() || '';
    } catch (_) {
      return;
    }
    if (!text || text === lastClipText) return;
    lastClipText = text;

    if (!looksLikeDouyin(text)) return;

    logLine('剪贴板命中', text.slice(0, 80).replace(/\s+/g, ' '));
    try {
      await runPipeline(text, 'clip');
    } catch (e) {
      logLine('剪贴板任务失败', e.message);
    }
  }, 700);
}

function stopClipboardWatch() {
  if (clipTimer) {
    clearInterval(clipTimer);
    clipTimer = null;
  }
}

/* ------------------------------------------------------------------ */
/* 抖音「找不到应用」弹窗的静默处理                                    */
/* ------------------------------------------------------------------ */

/**
 * 抖音客户端里有一段脚本，会插一个隐藏 iframe 指向 bitbrowser://cc/ 来探测
 * 本机有没有装「比特浏览器」。没装的话，系统没有该协议的处理程序，Windows
 * 每次都会弹「获取打开此 'bitbrowser' 链接的应用」。
 *
 * 这里给它登记一个只写日志就退出的接收器，弹窗就再也不出现了。
 */
async function ensureProtoFix(force) {
  if (!force && settings.protoFix === false) return null;
  try {
    const r = await protoFix.apply();
    logLine('弹窗修复：', r.ok ? (r.changed ? '已登记 bitbrowser 接收器' : '已存在，跳过') : '失败 ' + r.error);
    if (r.ok && r.changed) {
      // 自检：ShellExecute 能把链接交出去，说明登记真的生效
      try {
        await shell.openExternal('bitbrowser://selfcheck');
        logLine('弹窗修复自检：通过');
      } catch (e) {
        logLine('弹窗修复自检：未生效', e.message);
      }
      if (tray && !settings.protoFixNoticed) {
        settings.protoFixNoticed = true;
        saveSettings();
        try {
          tray.displayBalloon({
            title: '弹窗已屏蔽',
            content: '抖音客户端老弹的「找不到应用」，已经处理好了，以后不会再出现。',
          });
        } catch (_) {}
      }
    }
    return r;
  } catch (e) {
    logLine('弹窗修复异常', e.message);
    return { ok: false, error: e.message };
  }
}

async function toggleProtoFix(on) {
  settings.protoFix = !!on;
  saveSettings();
  if (on) await ensureProtoFix(true);
  else {
    const r = await protoFix.remove();
    logLine('弹窗修复已还原', r.raw);
  }
  refreshTrayMenu();
  return settings.protoFix;
}

/* ------------------------------------------------------------------ */
/* 托盘                                                                */
/* ------------------------------------------------------------------ */

let tray = null;

function refreshTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: '打开完整窗口', click: () => showMain() },
    { type: 'separator' },
    {
      label: '桌面悬浮条',
      type: 'checkbox',
      checked: !!settings.floatEnabled,
      click: (item) => setFloatEnabled(item.checked),
    },
    {
      label: '自动监听剪贴板',
      type: 'checkbox',
      checked: !!settings.watchClipboard,
      click: (item) => setWatchClipboard(item.checked),
    },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: !!settings.launchAtLogin,
      click: (item) => setLaunchAtLogin(item.checked),
    },
    {
      label: '屏蔽「找不到应用」弹窗',
      type: 'checkbox',
      checked: settings.protoFix !== false,
      click: (item) => toggleProtoFix(item.checked),
    },
    { type: 'separator' },
    {
      label: '打开下载文件夹',
      click: async () => {
        try {
          await fsp.mkdir(settings.downloadRoot, { recursive: true });
        } catch (_) {}
        shell.openPath(settings.downloadRoot);
      },
    },
    {
      label: '重新吸附到抖音窗口',
      click: () => {
        floatAttached = true;
        if (anchor && anchor.rect) {
          showFloat();
          placeFloat(anchor.rect);
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, 'assets', 'icon-32.png');
    const img = nativeImage.createFromPath(iconPath);
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.setToolTip('抖音下载助手');
    refreshTrayMenu();
    tray.on('click', () => {
      if (floatVisible) showMain();
      else showFloat();
    });
    tray.on('double-click', () => showMain());
    logLine('托盘已创建');
  } catch (e) {
    logLine('托盘创建失败', e.message);
  }
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

ipcMain.handle('get-settings', () => ({
  downloadRoot: settings.downloadRoot,
  autoDownload: settings.autoDownload,
  watchClipboard: settings.watchClipboard,
  floatEnabled: settings.floatEnabled,
  launchAtLogin: settings.launchAtLogin,
  version: app.getVersion(),
}));

ipcMain.handle('get-app-state', () => ({
  floatVisible,
  floatAttached,
  douyin: anchor && anchor.rect ? { w: anchor.rect.w, h: anchor.rect.h } : null,
  watchClipboard: settings.watchClipboard,
  floatEnabled: settings.floatEnabled,
  launchAtLogin: settings.launchAtLogin,
}));

ipcMain.handle('set-download-root', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: '选择下载位置',
    defaultPath: settings.downloadRoot,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false };
  settings.downloadRoot = r.filePaths[0];
  saveSettings();
  return { ok: true, downloadRoot: settings.downloadRoot };
});

ipcMain.handle('set-auto-download', (e, v) => {
  settings.autoDownload = !!v;
  saveSettings();
  return { ok: true, autoDownload: settings.autoDownload };
});

function setWatchClipboard(v) {
  settings.watchClipboard = !!v;
  saveSettings();
  bcast('watch-changed', { watchClipboard: settings.watchClipboard });
  refreshTrayMenu();
  return settings.watchClipboard;
}

ipcMain.handle('set-watch', (e, v) => ({ ok: true, watchClipboard: setWatchClipboard(v) }));

ipcMain.handle('set-float-enabled', (e, v) => {
  setFloatEnabled(v);
  return { ok: true, floatEnabled: settings.floatEnabled };
});

function setLaunchAtLogin(v) {
  settings.launchAtLogin = !!v;
  saveSettings();
  try {
    // 开机静默启动：只出悬浮条和托盘，不弹主窗口
    const args = app.isPackaged ? ['--silent'] : [path.resolve(__dirname), '--silent'];
    app.setLoginItemSettings({
      openAtLogin: settings.launchAtLogin,
      path: process.execPath,
      args,
    });
    logLine('开机自启 =', settings.launchAtLogin);
  } catch (e) {
    logLine('设置开机自启失败', e.message);
  }
  refreshTrayMenu();
  return settings.launchAtLogin;
}

ipcMain.handle('set-launch-at-login', (e, v) => ({
  ok: true,
  launchAtLogin: setLaunchAtLogin(v),
}));

ipcMain.handle('parse', async (e, text) => {
  const links = parser.extractLinks(text);
  if (!links.length) return { ok: false, error: '没找到抖音链接，粘贴分享链接或复制口令试试' };

  const results = [];
  for (const link of links.slice(0, 20)) {
    try {
      results.push(await parser.parseItem(link));
    } catch (err) {
      logLine('解析异常', err.message);
      results.push({ ok: false, input: link, error: err.message });
    }
  }
  return { ok: true, results };
});

ipcMain.handle('download', async (e, item) => {
  const taskId = item.taskId || `${item.awemeId}_${Date.now()}`;
  return downloadTask(item, taskId);
});

ipcMain.handle('submit', async (e, text, source) => {
  try {
    return await runPipeline(text, source || 'float');
  } catch (err) {
    logLine('submit 失败', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('open-dir', async (e, p) => {
  const target = p || settings.downloadRoot;
  try {
    await fsp.mkdir(target, { recursive: true });
  } catch (_) {}
  shell.openPath(target);
  return { ok: true };
});

ipcMain.handle('open-path', (e, p) => {
  if (p && fs.existsSync(p)) shell.showItemInFolder(p);
  else shell.openPath(settings.downloadRoot);
  return { ok: true };
});

ipcMain.handle('clipboard-text', () => clipboard.readText());

ipcMain.handle('open-douyin', () => {
  shell.openExternal(HOME);
  return { ok: true };
});

ipcMain.handle('get-history', () => {
  try {
    return JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
  } catch (_) {
    return [];
  }
});

ipcMain.on('win-min', () => mainWin && mainWin.minimize());
ipcMain.on('win-close', () => mainWin && mainWin.close());
ipcMain.on('open-main', () => showMain());
ipcMain.on('hide-float', () => hideFloat());
ipcMain.on('toggle-float', () => toggleFloat());

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.setAppUserModelId('com.fafa.douyinhelper');

parser.setLogger(logLine);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMain();
  });

  app.whenReady().then(() => {
    loadSettings();
    parser.installMediaTap(session.fromPartition(PARTITION));
    parser.installMediaTap(session.defaultSession);

    createTray();

    // 抖音客户端探测 bitbrowser:// 导致的「找不到应用」弹窗，启动时顺手处理掉
    ensureProtoFix(false);

    const silent = process.argv.includes('--silent');
    if (!silent) createMainWindow();

    startAnchor();
    startClipboardWatch();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  // 常驻托盘，关掉所有窗口也不退出
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    app.isQuitting = true;
    stopClipboardWatch();
    stopAnchor();
  });
}
