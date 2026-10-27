'use strict';

/**
 * 抖音解析与下载核心
 *
 * 思路：抖音 Web 接口带动态签名（a_bogus / uifid），纯 HTTP 复刻极易失效。
 * 这里用 Electron 内置 Chromium 真打开作品页，让抖音自己的前端去签名、拿 Cookie，
 * 再从播放器和网络请求里把无水印源捞出来。
 */

const { BrowserWindow, session } = require('electron');
const https = require('https');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const PARTITION = 'persist:douyin';
const HOME = 'https://www.douyin.com/';

let log = (...a) => console.log('[parser]', ...a);
function setLogger(fn) {
  log = fn;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 媒体请求抓取                                                        */
/* ------------------------------------------------------------------ */

const mediaTaps = new Map(); // webContentsId -> string[]

function installMediaTap(ses) {
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    const bucket = mediaTaps.get(details.webContentsId);
    if (bucket && /douyinvod\.com|mime_type=video_mp4|\/video\/tos\//.test(details.url)) {
      bucket.push(details.url);
    }
    callback({});
  });

  // 给抖音 CDN 补 Referer，否则封面图和直链可能 403
  ses.webRequest.onBeforeSendHeaders(
    {
      urls: [
        '*://*.douyinpic.com/*',
        '*://*.douyinstatic.com/*',
        '*://*.douyinvod.com/*',
        '*://*.byteeffecttos.com/*',
      ],
    },
    (details, callback) => {
      details.requestHeaders['Referer'] = HOME;
      details.requestHeaders['User-Agent'] = UA;
      callback({ requestHeaders: details.requestHeaders });
    }
  );
}

/* ------------------------------------------------------------------ */
/* 链接识别                                                            */
/* ------------------------------------------------------------------ */

function extractLinks(text) {
  const out = [];
  const seen = new Set();
  const push = (u) => {
    const v = String(u).trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };

  const urlRe = /https?:\/\/[^\s\u4e00-\u9fa5，。！？、；："'（）《》【】]+/g;
  const found = String(text || '').match(urlRe) || [];
  for (const raw of found) {
    const clean = raw.replace(/[.,;)\]}>"']+$/, '');
    if (/douyin\.com|iesdouyin\.com|amemv\.com/.test(clean)) push(clean);
  }

  // 抖音客户端内的分享协议（snssdk1128:// / bytedance://），直接从里面挖作品 ID
  const proto = String(text || '').match(
    /(?:snssdk1128|bytedance|aweme):\/\/[^\s"'<>]*?(\d{15,21})/i
  );
  if (proto) push(proto[1]);

  if (out.length === 0) {
    const m = String(text || '').match(/(?<!\d)(7\d{18})(?!\d)/);
    if (m) push(m[1]);
  }
  return out;
}

function parseTarget(input) {
  const s = String(input).trim();
  if (/^\d{15,21}$/.test(s)) return { kind: 'video', id: s };

  let m = /douyin\.com\/(?:share\/)?(video|note|slides)\/(\d{15,21})/.exec(s);
  if (m) return { kind: m[1] === 'video' ? 'video' : 'note', id: m[2] };

  m = /[?&]modal_id=(\d{15,21})/.exec(s);
  if (m) return { kind: 'video', id: m[1] };

  m = /[?&]aweme_id=(\d{15,21})/.exec(s);
  if (m) return { kind: 'video', id: m[1] };

  return null;
}

/* ------------------------------------------------------------------ */
/* 解析窗口                                                            */
/* ------------------------------------------------------------------ */

let parseWin = null;

async function getParseWindow() {
  if (parseWin && !parseWin.isDestroyed()) return parseWin;

  parseWin = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  parseWin.webContents.setUserAgent(UA);
  parseWin.webContents.setAudioMuted(true);
  parseWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // 每次页面就绪时在主世界装钩子，截获抖音自己的详情接口
  parseWin.webContents.on('dom-ready', () => {
    parseWin.webContents.executeJavaScript(HOOK_JS, true).catch(() => {});
  });

  parseWin.on('closed', () => {
    parseWin = null;
  });
  return parseWin;
}

async function loadPage(win, url, tries = 2) {
  for (let i = 0; i < tries; i += 1) {
    try {
      await win.loadURL(url, { userAgent: UA });
      return true;
    } catch (e) {
      log('loadURL 失败', i + 1, e.message);
      await sleep(700);
    }
  }
  return false;
}

/**
 * 纯 HTTP 跟随短链跳转。比走 Chromium 网络栈快一个数量级
 * （实测 v.douyin.com 三级跳 483ms vs 会话内 fetch 3.7s）。
 */
function resolveByHttp(url) {
  return new Promise((resolve) => {
    let hops = 0;
    const go = (u) => {
      if (hops > 6) return resolve(null);
      hops += 1;
      let req;
      const done = (v) => {
        try {
          req && req.destroy();
        } catch (_) {}
        resolve(v);
      };
      try {
        req = https.get(
          u,
          { headers: { 'User-Agent': UA, Accept: '*/*' }, timeout: 6000 },
          (res) => {
            const loc = res.headers.location;
            res.resume();
            if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
              let next;
              try {
                next = new URL(loc, u).href;
              } catch (_) {
                return done(null);
              }
              const t = parseTarget(next);
              if (t) return done(t);
              return go(next);
            }
            return done(parseTarget(u));
          }
        );
      } catch (_) {
        return done(null);
      }
      req.on('error', () => done(null));
      req.on('timeout', () => done(null));
    };
    go(url);
  });
}

const shortLinkCache = new Map(); // 短链 -> { target, at }
const SHORT_TTL = 10 * 60 * 1000;

/** 短链 / 带跳转的链接：HTTP 优先，会话 fetch 次之，窗口兜底 */
async function resolveShortLink(url) {
  const direct = parseTarget(url);
  if (direct) return direct;

  const key = String(url).trim();
  const hit = shortLinkCache.get(key);
  if (hit && Date.now() - hit.at < SHORT_TTL) return hit.target;
  const cache = (t) => {
    if (t) shortLinkCache.set(key, { target: t, at: Date.now() });
    return t;
  };

  const byHttp = await resolveByHttp(key);
  if (byHttp) {
    log('短链解析(HTTP)', byHttp.kind, byHttp.id);
    return cache(byHttp);
  }

  try {
    const ses = session.fromPartition(PARTITION);
    const res = await ses.fetch(key, { headers: { 'User-Agent': UA }, redirect: 'follow' });
    const t = parseTarget(res.url || '');
    if (t) return cache(t);

    const html = await res.text();
    const m =
      /douyin\.com\/(?:share\/)?(video|note|slides)\/(\d{15,21})/.exec(html) ||
      /"aweme_id"\s*:\s*"(\d{15,21})"/.exec(html);
    if (m) {
      if (m.length === 3) return cache({ kind: m[1] === 'video' ? 'video' : 'note', id: m[2] });
      return cache({ kind: 'video', id: m[1] });
    }
  } catch (e) {
    log('短链 HTTP 解析失败', e.message);
  }

  const win = await getParseWindow();
  if (await loadPage(win, url)) {
    await sleep(1500);
    const t = parseTarget(win.webContents.getURL());
    if (t) return cache(t);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 页面信息提取                                                        */
/* ------------------------------------------------------------------ */

/**
 * 注入到页面主世界，钩住 fetch/XHR，把抖音自己的详情响应急存下来。
 * 这是拿「最高清晰度无水印源 + 完整图集 + 精确保封面」的关键。
 */
const HOOK_JS = `(function () {
  if (window.__DY_HOOKED) return 'already';
  window.__DY_HOOKED = true;
  window.__DY_DETAILS = [];

  function keep(u, txt) {
    try {
      if (window.__DY_DETAILS.length > 6) return;
      window.__DY_DETAILS.push({ u: String(u).slice(0, 160), t: txt });
    } catch (e) {}
  }
  function match(u) {
    return /aweme\\/detail|aweme\\/post|aweme\\/v1\\/web\\/aweme/.test(u || '');
  }

  var of = window.fetch;
  if (of) {
    window.fetch = function () {
      var u = '';
      try { u = (typeof arguments[0] === 'string') ? arguments[0] : (arguments[0] && arguments[0].url) || ''; } catch (e) {}
      var p = of.apply(this, arguments);
      try {
        if (match(u)) {
          p.then(function (r) {
            try { r.clone().text().then(function (t) { keep(u, t); }).catch(function () {}); } catch (e) {}
          }).catch(function () {});
        }
      } catch (e) {}
      return p;
    };
  }

  var XO = XMLHttpRequest.prototype.open;
  var XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    try { this.__u = u; } catch (e) {}
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    try {
      this.addEventListener('load', function () {
        try {
          if (match(self.__u)) keep(self.__u, self.responseText);
        } catch (e) {}
      });
    } catch (e) {}
    return XS.apply(this, arguments);
  };

  return 'hooked';
})()`;

const EXTRACT_JS = `(function () {
  var out = {
    url: location.href,
    title: document.title || '',
    desc: '',
    ogImage: '',
    videos: [],
    imgs: [],
    authorDom: '',
    bodyLen: 0,
    bodyHead: ''
  };

  try {
    var bt = document.body ? document.body.innerText || '' : '';
    out.bodyLen = bt.length;
    out.bodyHead = bt.slice(0, 200).replace(/\\s+/g, ' ');
  } catch (e) {}

  var md = document.querySelector('meta[name="description"]');
  if (md) out.desc = md.getAttribute('content') || '';
  var ogi = document.querySelector('meta[property="og:image"]');
  if (ogi) out.ogImage = ogi.getAttribute('content') || '';

  var vids = [];
  Array.prototype.slice.call(document.querySelectorAll('video')).forEach(function (v) {
    var s = v.currentSrc || v.src || '';
    if (s && s.indexOf('blob:') !== 0 && vids.indexOf(s) < 0) vids.push(s);
  });
  out.videos = vids;

  Array.prototype.slice.call(document.querySelectorAll('img')).forEach(function (im) {
    var s = im.currentSrc || im.src || '';
    if (!s || s.indexOf('data:') === 0) return;
    out.imgs.push({ s: s, w: im.naturalWidth || 0, h: im.naturalHeight || 0 });
  });

  var cand = document.querySelector('[data-e2e="video-author-name"], [data-e2e="user-name"], [data-e2e="detail-video-username"]');
  if (cand) out.authorDom = (cand.innerText || '').trim();

  return out;
})()`;

function pickBestMedia(urls, awemeId) {
  let best = null;
  let bestScore = -1;
  for (const u of urls) {
    if (!/douyinvod\.com|mime_type=video_mp4/.test(u)) continue;
    let score = 0;
    const br = /[?&]br=(\d+)/.exec(u);
    if (br) score = parseInt(br[1], 10);
    if (awemeId && u.indexOf(awemeId) >= 0) score += 1000000;
    if (score > bestScore) {
      bestScore = score;
      best = u;
    }
  }
  return best;
}

/** 图集原图：去掉 webp 转码模板 */
function toOriginalImage(u) {
  if (!u) return '';
  if (!/douyinpic\.com/.test(u)) return u;
  return u.replace(/~tplv-[^?]+/, '');
}

/** 只保留当前作品图集的图，滤掉头像和推荐流封面。URL 原样保留（改参数会 403） */
function buildImages(imgs) {
  const seen = new Set();
  const out = [];
  for (const it of imgs || []) {
    const raw = it.s || '';
    if (!/douyinpic\.com/.test(raw)) continue;
    if (raw.indexOf('aweme_images') < 0) continue;
    if (/avatar|\/100x100\/|aweme-avatar/.test(raw)) continue;
    if (it.w && it.w < 200) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

const BAD_AUTHORS = new Set(['我的', '首页', '推荐', '朋友', '关注', '消息', '我', '搜索', '抖音']);

function extractAuthorFromDesc(desc) {
  if (!desc) return '';
  let m = /[-—]\s*([^\s\-—]{1,24}?)于\s*\d{6,8}\s*发布在抖音/.exec(desc);
  if (m) return m[1].trim();
  return '';
}

/** 从 description 里取干净的标题：去掉尾部「- 作者于日期发布在抖音…」，取第一行 */
function titleFromDesc(desc) {
  if (!desc) return '';
  let t = String(desc).replace(/\s*[-—]\s*[^\s\-—]{1,24}?于\s*\d{6,8}\s*发布在抖音[\s\S]*$/, '');
  t = t.split('\n')[0].trim();
  return t;
}

function cleanTitle(raw) {
  let t = String(raw || '').trim();
  t = t.replace(/^抖音\s*[-—]\s*/, '');
  t = t.replace(/\s*[-—]\s*抖音\s*$/, '');
  return t;
}

function shortTitle(title, max = 40) {
  let t = String(title || '')
    .replace(/#[^\s#]+/g, ' ')
    .replace(/[【】\[\]（）()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) t = String(title || '').trim();
  if (t.length > max) t = t.slice(0, max).trim();
  return t;
}

/* ------------------------------------------------------------------ */
/* 解析一条作品                                                        */
/* ------------------------------------------------------------------ */

/** 从钩到的接口响应里翻出当前作品的完整数据 */
function findDetail(rawList, awemeId) {
  for (const txt of rawList || []) {
    let j;
    try {
      j = JSON.parse(txt);
    } catch (_) {
      continue;
    }
    if (!j || typeof j !== 'object') continue;

    if (j.aweme_detail && String(j.aweme_detail.aweme_id) === String(awemeId)) return j.aweme_detail;

    const list = j.aweme_list || j.awemeList || null;
    if (Array.isArray(list)) {
      const hit = list.find((x) => x && String(x.aweme_id) === String(awemeId));
      if (hit) return hit;
    }
  }
  return null;
}

function detailVideoUrl(detail) {
  if (!detail || !detail.video) return '';
  const v = detail.video;

  // 优先 bit_rate 阶梯里的最高档：比 play_addr 的默认档清晰得多
  const ladder = Array.isArray(v.bit_rate) ? v.bit_rate.slice() : [];
  ladder.sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));
  for (const b of ladder) {
    const pa = b.play_addr || b.play_addr_265 || {};
    const u = (pa.url_list || []).find((x) => /^https?:/.test(x));
    if (u) return u;
  }

  const pa = v.play_addr || v.play_addr_h264 || v.playAddr;
  const list = (pa && pa.url_list) || [];
  return list.find((u) => /^https?:/.test(u)) || '';
}

function detailImages(detail) {
  if (!detail || !Array.isArray(detail.images)) return [];
  const out = [];
  const seen = new Set();
  for (const im of detail.images) {
    const list = (im.url_list || im.urlList || []).filter((x) => /^https?:/.test(x));
    if (!list.length) continue;
    // 优先未套转码模板的原图（其余变体有概率 403）
    const pick = list.find((u) => !/~tplv-/.test(u)) || list[0];
    if (seen.has(pick)) continue;
    seen.add(pick);
    out.push(pick);
  }
  return out;
}

function detailCover(detail) {
  if (!detail) return '';
  if (detail.video) {
    const c = detail.video.cover || detail.video.origin_cover || detail.video.dynamic_cover;
    const u = c && (c.url_list || [])[0];
    if (u) return u;
  }
  if (detail.images && detail.images[0]) {
    return (detail.images[0].url_list || [])[0] || '';
  }
  return '';
}

/**
 * 判断当前页面是不是抖音的风控页（验证码 / 中间页 / 内容被清空）
 * 这类页面拿不到任何媒体，跟"私密作品"是两回事，必须分开提示
 */
function isRiskPage(data) {
  if (!data) return false;
  const t = String(data.title || '');
  const head = String(data.bodyHead || '');
  if (/验证码|安全验证|中间页|访问频繁|操作频繁|请完成验证|异常访问/.test(t + ' ' + head)) return true;
  const hasMedia = (data.videos && data.videos.length) || (data.imgs && data.imgs.length > 2);
  const len = Number(data.bodyLen || 0);
  // 有内容但极短，且没有任何媒体 —— 典型的拦截页
  if (!hasMedia && len > 0 && len < 600) return true;
  return false;
}

/** 解析会话被风控标记或缓存损坏时，清一次再试 */
async function resetParseSession() {
  try {
    const ses = session.fromPartition(PARTITION);
    await ses.clearStorageData({
      storages: ['cookies', 'localstorage', 'indexeddb', 'cachestorage', 'serviceworkers'],
    });
    await ses.clearCache();
    log('已重置解析会话');
    return true;
  } catch (e) {
    log('重置会话失败', e.message);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 方案 A：直接调详情接口（首选）                                       */
/* ------------------------------------------------------------------ */

/**
 * 在页面主世界同源 fetch 详情接口。
 *
 * 这条路是参照高星项目验证出来的：
 *  - 抖音 2026-08 起在边缘网关挂了 ArgusSecurityPlugin，纯 HTTP（Python/Node 的
 *    TLS 指纹）请求 aweme/detail 一律 403 Blocked by ArgusSecurityPlugin。
 *  - 但只要请求是从真实的 Chromium 页面里发出去的，TLS/UA/指纹全部一致，
 *    带上 UIFID cookie 就能过（实测连 x-tt-argus 头都不是必须的，加上更保险）。
 *  - uifid 参数必须和 verifyFp/fp 同源（都取自 s_v_web_id cookie），
 *    uifid 配自生成的 verifyFp 会被判 Signature Not Found。
 *
 * 相比"加载整个作品页再抠 DOM"，一次请求 ~200ms / ~63KB，不触发播放、不吃风控，
 * 图集也不用靠滚动懒加载，码率还能从 bit_rate 阶梯里直接挑最高的。
 */
const DETAIL_FETCH_JS = (awemeId, uifid, sv) => `(async () => {
  const q = new URLSearchParams({
    device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web',
    pc_client_type: '1', version_code: '190600', version_name: '19.6.0',
    update_version_code: '170400', cookie_enabled: 'true',
    platform: 'PC',
    browser_language: navigator.language || 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Chrome', browser_version: '130.0.0.0',
    browser_online: 'true', engine_name: 'Blink', engine_version: '130.0.0.0',
    os_name: 'Windows', os_version: '10',
    screen_width: String(screen.width), screen_height: String(screen.height),
    cpu_core_num: String(navigator.hardwareConcurrency || 8),
    device_memory: String(navigator.deviceMemory || 8),
    aweme_id: ${JSON.stringify(awemeId)},
    uifid: ${JSON.stringify(uifid)},
    verifyFp: ${JSON.stringify(sv)},
    fp: ${JSON.stringify(sv)}
  });
  const headers = { 'x-tt-argus': '1' };
  if (${JSON.stringify(uifid)}) headers['uifid'] = ${JSON.stringify(uifid)};
  try {
    const r = await fetch('/aweme/v1/web/aweme/detail/?' + q.toString(), {
      headers: headers, credentials: 'include'
    });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (e) {
      return { ok: false, status: r.status, body: txt.slice(0, 160) };
    }
    return {
      ok: true, status: r.status, statusCode: j.status_code,
      detail: j.aweme_detail || null,
      filter: j.filter_detail || null
    };
  } catch (e) {
    return { ok: false, status: 0, body: String(e && e.message) };
  }
})()`;

function currentUrl(win) {
  try {
    return win.webContents.getURL() || '';
  } catch (_) {
    return '';
  }
}

async function readDouyinCookies(win) {
  try {
    const cookies = await win.webContents.session.cookies.get({ domain: 'douyin.com' });
    const map = new Map(cookies.map((c) => [c.name, c.value]));
    return {
      uifid: map.get('UIFID') || map.get('UIFID_TEMP') || '',
      sv: map.get('s_v_web_id') || '',
      ttwid: map.get('ttwid') || '',
    };
  } catch (e) {
    log('读 cookie 失败', e.message);
    return { uifid: '', sv: '', ttwid: '' };
  }
}

/** 拿详情接口的 aweme_detail；拿不到返回 null，交给页面渲染兜底 */
async function fetchDetailFast(win, awemeId) {
  let ck = await readDouyinCookies(win);
  const onHome = /^https:\/\/www\.douyin\.com\//.test(currentUrl(win));
  if (!ck.uifid || !onHome) {
    log('准备接口会话：加载首页');
    const loaded = await loadPage(win, HOME);
    if (!loaded) return null;
    await sleep(1500);
    ck = await readDouyinCookies(win);
  }

  const t0 = Date.now();
  let res;
  try {
    res = await win.webContents.executeJavaScript(
      DETAIL_FETCH_JS(awemeId, ck.uifid, ck.sv),
      true
    );
  } catch (e) {
    log('详情接口调用异常', e.message);
    return null;
  }

  if (!res || !res.ok) {
    log('详情接口失败', res && res.status, res && res.body);
    return null;
  }
  if (!res.detail) {
    log('详情接口无内容', 'status_code=' + res.statusCode, res.filter ? JSON.stringify(res.filter).slice(0, 120) : '');
    return null;
  }
  log('详情接口命中', Date.now() - t0 + 'ms', 'uifid=' + (ck.uifid ? ck.uifid.length : 0));
  return res.detail;
}

/** 从 aweme_detail 直接组装成品，不需要再碰 DOM */
function buildItemFromDetail(detail, target, rawInput, pageUrl) {
  const images = detailImages(detail);
  const videoUrl = detailVideoUrl(detail);

  let kind;
  if (images.length) kind = 'note';
  else if (videoUrl) kind = 'video';
  else kind = 'unknown';

  const desc = detail.desc || '';
  let title = titleFromDesc(desc) || cleanTitle(desc);
  if (!title) title = '未命名作品';

  let author = (detail.author && detail.author.nickname) || '';
  author = String(author).replace(/^@/, '').trim() || '未知作者';

  const cover = detailCover(detail) || images[0] || '';

  const item = {
    ok: kind !== 'unknown',
    input: rawInput,
    awemeId: target.id,
    kind,
    pageUrl,
    title,
    shortTitle: shortTitle(title),
    author,
    desc,
    cover,
    videoUrl: kind === 'video' ? videoUrl : '',
    images: kind === 'note' ? images : [],
    candidates: [],
    via: 'api',
  };

  if (kind === 'unknown') {
    item.error = '接口返回了作品，但里面没有可下载的媒体（可能是私密或已删除）';
  }
  log('解析完成(api)', item.ok ? `${item.kind} | ${item.author} | ${item.shortTitle}` : item.error);
  return item;
}

async function parseItemInner(rawInput, _retry = 0) {
  const target = await resolveShortLink(rawInput);
  if (!target) {
    return { ok: false, input: rawInput, error: '没认出这是抖音链接' };
  }

  const pageUrl = `https://www.douyin.com/${target.kind}/${target.id}`;

  const win = await getParseWindow();

  // —— 首选：直接调详情接口 ——
  const fast = await fetchDetailFast(win, target.id);
  if (fast) return buildItemFromDetail(fast, target, rawInput, pageUrl);

  // —— 兜底：原来的整页渲染方案 ——
  log('接口方案未命中，回退整页渲染', pageUrl);
  const wcId = win.webContents.id;
  const bucket = [];
  mediaTaps.set(wcId, bucket);

  await loadPage(win, pageUrl);

  let data = null;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    await sleep(600);
    try {
      const got = await win.webContents.executeJavaScript(EXTRACT_JS, true);
      if (got) {
        data = got;
        const hasMedia = (got.videos && got.videos.length) || (got.imgs && got.imgs.length > 2);
        if (hasMedia) {
          await sleep(1600); // 等一等，让高码率源进来
          break;
        }
      }
    } catch (_) {
      // 页面还在跳转
    }
  }

  try {
    const again = await win.webContents.executeJavaScript(EXTRACT_JS, true);
    if (again) {
      if (!data) data = again;
      else {
        data.videos = Array.from(new Set([...(data.videos || []), ...(again.videos || [])]));
        const seen = new Set((data.imgs || []).map((x) => x.s));
        for (const it of again.imgs || []) if (!seen.has(it.s)) data.imgs.push(it);
        if (again.desc) data.desc = again.desc;
        if (!data.ogImage && again.ogImage) data.ogImage = again.ogImage;
      }
    }
  } catch (_) {}

  const tapped = bucket.slice();
  mediaTaps.delete(wcId);

  if (!data) {
    if (_retry < 1) {
      log('页面没加载出来，重置会话后重试一次');
      await resetParseSession();
      await sleep(1500);
      return parseItemInner(rawInput, _retry + 1);
    }
    return { ok: false, input: rawInput, error: '页面没能加载出来，可能被抖音限流了，等一会儿再试', risk: true };
  }

  // 读页面里钩到的接口响应（必须趁页面还没导航走）
  let detail = null;
  try {
    const rawArr = await win.webContents.executeJavaScript(
      '(window.__DY_DETAILS||[]).slice(0,6).map(function(x){return x.t})',
      true
    );
    detail = findDetail(rawArr, target.id);
    if (detail) log('命中详情接口');
  } catch (e) {
    log('读取详情失败', e.message);
  }

  let videoUrl = detailVideoUrl(detail) || pickBestMedia(tapped, target.id);
  if (!videoUrl && data.videos && data.videos.length) {
    videoUrl = pickBestMedia(data.videos, target.id) || data.videos[0];
  }

  const domImages = buildImages(data.imgs);
  const apiImages = detailImages(detail);
  const images = apiImages.length >= domImages.length && apiImages.length ? apiImages : domImages;

  let kind;
  if (target.kind === 'note') kind = 'note';
  else if (images.length >= 2) kind = 'note';
  else if (videoUrl) kind = 'video';
  else if (images.length) kind = 'note';
  else kind = 'unknown';

  const desc = (detail && detail.desc) || data.desc || '';

  let title = titleFromDesc(desc);
  if (!title) title = cleanTitle(data.title);

  let author = (detail && detail.author && detail.author.nickname) || '';
  if (!author) author = extractAuthorFromDesc(desc);
  if (!author) {
    const dom = String(data.authorDom || '').trim();
    if (dom && !BAD_AUTHORS.has(dom)) author = dom;
  }
  if (!author) author = '未知作者';

  const cover = detailCover(detail) || data.ogImage || images[0] || '';

  const item = {
    ok: true,
    input: rawInput,
    awemeId: target.id,
    kind,
    pageUrl,
    title,
    shortTitle: shortTitle(title),
    author: String(author).replace(/^@/, '').trim(),
    desc,
    cover,
    videoUrl: kind === 'video' ? videoUrl : '',
    images: kind === 'note' ? images : [],
    candidates: tapped.slice(0, 6),
  };

  if (kind === 'unknown') {
    item.ok = false;
    const risk = isRiskPage(data);
    if (risk) {
      if (_retry < 1) {
        log('命中抖音风控页（验证码/中间页），歇一下再试一次');
        await resetParseSession();
        await sleep(8000); // 给风控窗口一点时间滑过去，立即重试只会更糟
        return parseItemInner(rawInput, _retry + 1);
      }
      item.error = '抖音要求人机验证（访问太频繁），等 3 分钟再试';
      item.risk = true;
    } else {
      item.error = '没找到可下载的媒体，可能是私密作品、已删除或需要登录';
    }
  }

  log('解析完成', item.ok ? `${item.kind} | ${item.author} | ${item.shortTitle}` : item.error);
  return item;
}

/* ------------------------------------------------------------------ */
/* 对外入口：串行执行 + 风控冷却                                        */
/* ------------------------------------------------------------------ */

// 解析要共用同一个隐藏窗口，两个任务并发会互相抢占（loadURL 互相覆盖），
// 所以这里用一条 promise 链把所有解析排成一队
let parseChain = Promise.resolve();

// 被风控后进入冷却期：冷却期内直接拒绝，不再去请求抖音（越试越容易被锁）
let riskCooldownUntil = 0;
const RISK_COOLDOWN_MS = 180000;

function parseItem(rawInput) {
  const next = () => parseItemOuter(rawInput);
  const run = parseChain.then(next, next);
  parseChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function parseItemOuter(rawInput) {
  const now = Date.now();
  if (now < riskCooldownUntil) {
    const left = Math.ceil((riskCooldownUntil - now) / 1000);
    log('仍在风控冷却中，拒绝请求，剩余', left + 's');
    return {
      ok: false,
      input: rawInput,
      risk: true,
      error: `刚被抖音要求验证，请等 ${left} 秒再试`,
    };
  }

  const item = await parseItemInner(rawInput);

  if (!item.ok && item.risk) {
    riskCooldownUntil = Date.now() + RISK_COOLDOWN_MS;
    log(`进入风控冷却 ${RISK_COOLDOWN_MS / 1000} 秒`);
  }
  return item;
}

/* ------------------------------------------------------------------ */
/* 下载                                                                */
/* ------------------------------------------------------------------ */

function safeName(s, max = 60) {
  return String(s || '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/[.\s]+$/, '');
}

function uniqPath(dir, base, ext) {
  let name = `${base}${ext}`;
  let i = 1;
  while (fs.existsSync(path.join(dir, name))) {
    name = `${base}_${i}${ext}`;
    i += 1;
    if (i > 999) break;
  }
  return path.join(dir, name);
}

async function downloadUrl(url, filePath, onBytes) {
  const ses = session.fromPartition(PARTITION);
  const res = await ses.fetch(url, {
    headers: { 'User-Agent': UA, Referer: HOME, Accept: '*/*' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  if (!res.body) throw new Error('响应为空');

  const total = Number(res.headers.get('content-length') || 0);
  const contentType = res.headers.get('content-type') || '';
  await fsp.mkdir(path.dirname(filePath), { recursive: true });

  const tmp = filePath + '.part';
  const file = fs.createWriteStream(tmp);
  const reader = res.body.getReader();
  let got = 0;
  let lastTick = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!file.write(Buffer.from(value))) {
        await new Promise((r) => file.once('drain', r));
      }
      const now = Date.now();
      if (now - lastTick > 160) {
        lastTick = now;
        onBytes(got, total);
      }
    }
    await new Promise((resolve, reject) => file.end((err) => (err ? reject(err) : resolve())));
    await fsp.rename(tmp, filePath);
    onBytes(got, total || got);
    return { size: got, total: total || got, contentType };
  } catch (e) {
    file.destroy();
    try {
      await fsp.unlink(tmp);
    } catch (_) {}
    throw e;
  }
}

function mimeToExt(ct) {
  const s = String(ct || '').toLowerCase();
  if (/jpeg|jpg/.test(s)) return '.jpg';
  if (/png/.test(s)) return '.png';
  if (/webp/.test(s)) return '.webp';
  if (/gif/.test(s)) return '.gif';
  if (/heic|heif/.test(s)) return '.heic';
  if (/mp4/.test(s)) return '.mp4';
  return '';
}

async function downloadItem(item, dir, nameBase, report) {
  await fsp.mkdir(dir, { recursive: true });
  const base = safeName(nameBase, 90) || String(item.awemeId);
  const saved = [];

  if (item.kind === 'note' && item.images && item.images.length) {
    const count = item.images.length;
    for (let i = 0; i < count; i += 1) {
      const idx = String(i + 1).padStart(2, '0');
      let filePath = uniqPath(dir, `${base}_${idx}`, '.webp');
      report({
        status: 'downloading',
        name: path.basename(filePath),
        received: i,
        total: count,
        progress: Math.round((i / count) * 100),
        note: `第 ${i + 1}/${count} 张`,
      });
      try {
        const r = await downloadUrl(item.images[i], filePath, () => {});
        const ext = mimeToExt(r.contentType);
        if (ext && !filePath.endsWith(ext)) {
          const renamed = filePath.replace(/\.[^.]+$/, ext);
          try {
            await fsp.rename(filePath, renamed);
            filePath = renamed;
          } catch (_) {}
        }
        saved.push(filePath);
      } catch (e) {
        log('图片下载失败', i + 1, e.message);
      }
    }
    report({
      status: 'done',
      name: `${base}（${saved.length} 张）`,
      path: saved[0] || dir,
      size: 0,
      progress: 100,
    });
  } else if (item.videoUrl) {
    const filePath = uniqPath(dir, base, '.mp4');
    report({ status: 'downloading', name: path.basename(filePath), progress: 0, received: 0, total: 0 });
    const r = await downloadUrl(item.videoUrl, filePath, (got, total) => {
      report({
        status: 'downloading',
        name: path.basename(filePath),
        received: got,
        total,
        progress: total ? Math.min(99, Math.round((got / total) * 100)) : 0,
      });
    });
    saved.push(filePath);
    report({ status: 'done', name: path.basename(filePath), path: filePath, size: r.size, progress: 100 });
  } else {
    report({ status: 'error', message: '没有可下载的内容' });
    return { ok: false, error: '没有可下载的内容' };
  }

  if (!saved.length) {
    report({ status: 'error', message: '全部下载失败' });
    return { ok: false, error: '全部下载失败，可稍后重试' };
  }

  return { ok: true, files: saved, dir };
}

module.exports = {
  UA,
  PARTITION,
  HOME,
  setLogger,
  installMediaTap,
  extractLinks,
  parseTarget,
  resolveShortLink,
  parseItem,
  downloadItem,
  downloadUrl,
  safeName,
  uniqPath,
  shortTitle,
};
