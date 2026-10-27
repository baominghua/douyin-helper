'use strict';

/**
 * 验证脚本：在真实登录会话里直接打 aweme/detail 接口
 *
 * 目的：确认「常驻首页窗口 + detail API + x-tt-argus/uifid/verifyFp 三补丁」
 * 这条路是否可行。可行则不再需要加载作品页、抠 video.currentSrc。
 *
 * 用法：electron scripts/verify-detail-api.js "<分享链接或作品ID>"
 */

const { app, BrowserWindow, session, net } = require('electron');
const fs = require('fs');
const path = require('path');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const PARTITION = 'persist:douyin';
const HOME = 'https://www.douyin.com/';
const OUT = path.join(__dirname, 'verify-result.json');

const OUT_LINES = [];
function say(...a) {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  OUT_LINES.push(line);
  console.log(line);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickAwemeId(s) {
  const m =
    /\/video\/(\d{8,})/.exec(s) ||
    /\/note\/(\d{8,})/.exec(s) ||
    /modal_id=(\d{8,})/.exec(s) ||
    /(\d{15,25})/.exec(s);
  return m ? m[1] : '';
}

async function resolveShort(url) {
  if (pickAwemeId(url)) return { url, id: pickAwemeId(url) };
  let cur = url;
  for (let i = 0; i < 6; i++) {
    let res;
    try {
      res = await net.fetch(cur, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': UA },
      });
    } catch (e) {
      return { url: cur, id: '', err: String(e && e.message) };
    }
    const loc = res.headers.get('location');
    say(`  hop${i + 1} ${res.status} -> ${loc || '(no location)'}`);
    if (!loc) return { url: cur, id: pickAwemeId(cur) };
    cur = new URL(loc, cur).href;
    const id = pickAwemeId(cur);
    if (id && /\/(video|note|share\/video)\//.test(cur)) return { url: cur, id };
  }
  return { url: cur, id: pickAwemeId(cur) };
}

/* 页面内执行的探测代码：参数由外面拼进模板 */
const PAGE_JS = (awemeId, uifid, svwebid) => `(async () => {
  const AWEME = ${JSON.stringify(awemeId)};
  const UIFID = ${JSON.stringify(uifid)};
  const SV = ${JSON.stringify(svwebid)};

  const COMMON = {
    device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web',
    pc_client_type: '1', version_code: '190600', version_name: '19.6.0',
    update_version_code: '170400', cookie_enabled: 'true',
    screen_width: String(screen.width), screen_height: String(screen.height),
    browser_language: navigator.language, browser_platform: navigator.platform,
    browser_name: 'Chrome', browser_version: '130.0.0.0',
    browser_online: 'true', engine_name: 'Blink', engine_version: '130.0.0.0',
    os_name: 'Windows', os_version: '10',
    cpu_core_num: String(navigator.hardwareConcurrency || 8),
    device_memory: String(navigator.deviceMemory || 8),
    platform: 'PC', downlink: '10', effective_type: '4g', round_trip_time: '50'
  };

  // 页面里有没有现成的签名工具
  let acrawler = '';
  try {
    if (window.byted_acrawler) acrawler = typeof window.byted_acrawler.frontierSign === 'function' ? 'frontierSign' : 'object';
    else if (window._0x3c9a) acrawler = '_0x3c9a';
  } catch (e) {}

  let xmst = '';
  try { xmst = localStorage.getItem('xmst') || ''; } catch (e) {}

  async function call(label, headers, params) {
    const q = new URLSearchParams(Object.assign({}, COMMON, { aweme_id: AWEME }, params));
    const url = '/aweme/v1/web/aweme/detail/?' + q.toString();
    const t0 = performance.now();
    try {
      const r = await fetch(url, { headers: Object.assign({}, headers), credentials: 'include' });
      const txt = await r.text();
      let j = null;
      try { j = JSON.parse(txt); } catch (e) {}
      const d = j && j.aweme_detail;
      return {
        label,
        status: r.status,
        ms: Math.round(performance.now() - t0),
        bytes: txt.length,
        head: txt.slice(0, 200),
        status_code: j && j.status_code,
        has_detail: !!d,
        desc: d && d.desc,
        author: d && d.author && d.author.nickname,
        aweme_type: d && d.aweme_type,
        bit_rates: d && d.video && d.video.bit_rate ? d.video.bit_rate.length : 0,
        best_br: (() => {
          if (!d || !d.video || !d.video.bit_rate) return null;
          let best = null;
          for (const b of d.video.bit_rate) if (!best || b.bit_rate > best.bit_rate) best = b;
          return best ? { bit_rate: best.bit_rate, w: best.play_addr && best.play_addr.width, h: best.play_addr && best.play_addr.height, url: best.play_addr && best.play_addr.url_list && best.play_addr.url_list[0] } : null;
        })(),
        images: d && d.images ? d.images.length : 0,
        first_image: d && d.images && d.images[0] ? (d.images[0].url_list || [])[0] : null,
        play_url: d && d.video && d.video.play_addr ? (d.video.play_addr.url_list || [])[0] : null,
      };
    } catch (e) {
      return { label, error: String(e && e.message) };
    }
  }

  const results = [];

  // ① 裸请求：模拟"纯 HTTP 方案"，对照组
  results.push(await call('bare', {}, {}));

  // ② 三补丁：x-tt-argus + uifid 头 + uifid/verifyFp/fp 同源参数
  const h2 = { 'x-tt-argus': '1' };
  if (UIFID) h2['uifid'] = UIFID;
  const p2 = { uifid: UIFID, verifyFp: SV, fp: SV };
  results.push(await call('argus+uifid', h2, p2));

  // ③ 页面有签名工具就再补一层
  if (acrawler === 'frontierSign') {
    try {
      const qstr = new URLSearchParams(Object.assign({}, COMMON, { aweme_id: AWEME }, p2)).toString();
      const sign = await window.byted_acrawler.frontierSign({ url: '/aweme/v1/web/aweme/detail/?' + qstr });
      const ab = sign && (sign['X-Bogus'] || sign.XBogus || sign.a_bogus || sign['x-bogus']);
      if (ab) results.push(await call('argus+sign', h2, Object.assign({ a_bogus: ab }, p2)));
      else results.push({ label: 'argus+sign', note: 'frontierSign 返回空', keys: Object.keys(sign || {}) });
    } catch (e) {
      results.push({ label: 'argus+sign', error: String(e && e.message) });
    }
  }

  return { aweme: AWEME, acrawler, xmst_len: xmst.length, results };
})()`;

async function main() {
  const input = process.argv[2] || '';
  if (!input) {
    say('缺少参数：分享链接或作品ID');
    app.exit(2);
    return;
  }

  say('== 1. 打开首页建立会话 ==');
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(UA);

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      partition: PARTITION,
      offscreen: false,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setUserAgent(UA);

  let r = { url: input, id: pickAwemeId(input) };
  if (!r.id) {
    say('  尝试 net.fetch 展开短链…');
    r = await resolveShort(input);
  }
  if (!r.id) {
    say('  net.fetch 未拿到 id，改用浏览器访问短链…');
    try {
      await win.loadURL(input, { userAgent: UA });
      await sleep(2500);
      const finalUrl = win.webContents.getURL();
      say('  落地 URL =', finalUrl);
      r = { url: finalUrl, id: pickAwemeId(finalUrl) };
    } catch (e) {
      say('  浏览器展开异常:', String(e && e.message));
      r = { url: win.webContents.getURL(), id: pickAwemeId(win.webContents.getURL()) };
    }
  }
  say('   id =', r.id || '(未识别)', ' url =', r.url);
  if (!r.id) {
    say('无法取到 aweme_id，退出');
    app.exit(3);
    return;
  }

  say('== 2. 回到首页 ==');
  const t0 = Date.now();
  try {
    await win.loadURL(HOME, { userAgent: UA });
  } catch (e) {
    say('  首页加载异常（忽略）:', String(e && e.message));
  }
  say('  首页 loadURL 耗时', Date.now() - t0, 'ms, url =', win.webContents.getURL());
  await sleep(3500);

  say('== 3. 检查 cookie ==');
  const cookies = await ses.cookies.get({ domain: 'douyin.com' });
  const map = {};
  for (const c of cookies) map[c.name] = c.value;
  const need = ['ttwid', 'UIFID', 'UIFID_TEMP', 's_v_web_id', 'msToken', 'sessionid', 'odin_tt'];
  for (const n of need) {
    const v = map[n];
    say(`  ${n.padEnd(12)} ${v ? 'len=' + v.length : '(缺失)'}`);
  }

  const uifid = map.UIFID || map.UIFID_TEMP || '';
  const svwebid = map.s_v_web_id || '';

  say('== 4. 调用 detail 接口 ==');
  let res;
  try {
    res = await win.webContents.executeJavaScript(PAGE_JS(r.id, uifid, svwebid), true);
  } catch (e) {
    say('  executeJavaScript 失败:', String(e && e.message));
    app.exit(4);
    return;
  }

  say('  acrawler =', res.acrawler || '(无)', ' xmst_len =', res.xmst_len);
  for (const one of res.results) {
    say('  ----------');
    say('  [' + one.label + ']', 'status=' + one.status, 'ms=' + one.ms, 'bytes=' + one.bytes);
    if (one.error) say('    error:', one.error);
    if (one.note) say('    note:', one.note, JSON.stringify(one.keys || {}));
    if (one.status !== undefined) say('    head:', one.head);
    if (one.has_detail) {
      say('    ✓ 成功  desc=', one.desc, ' author=', one.author, ' type=', one.aweme_type);
      say('    bit_rates=', one.bit_rates, ' best=', JSON.stringify(one.best_br && { br: one.best_br.bit_rate, w: one.best_br.w, h: one.best_br.h }));
      say('    play_url=', one.play_url);
      say('    images=', one.images, ' first_image=', one.first_image);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify({ input, resolved: r, cookies: Object.keys(map), ...res }, null, 2), 'utf8');
  say('== 结果已写入', OUT, '==');

  win.destroy();
  app.exit(0);
}

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.whenReady().then(() =>
  main().catch((e) => {
    say('FATAL', String(e && e.stack || e));
    app.exit(1);
  })
);

setTimeout(() => {
  say('超时退出');
  app.exit(9);
}, 90000).unref();
