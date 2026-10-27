'use strict';

/**
 * 处理抖音客户端反复弹出的「获取打开此 'bitbrowser' 链接的应用」。
 *
 * 成因：抖音客户端里有一段检测脚本，会往页面里插一个隐藏 iframe，
 * 把 src 设成 bitbrowser://cc/ 来探测有没有装「比特浏览器」。
 * 本机没装，系统也没有登记这个协议，于是每次探测都由 Windows 弹一次
 * 「找不到应用」的框。
 *
 * 做法：在 HKCU 里登记一个静默的接收器（只写一行日志就退出），
 * 让系统认为这个协议有人处理，弹窗就不会再出现。不需要管理员权限，
 * 也不影响任何其它软件；用户随时可以从托盘菜单还原。
 */

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const PS1 = path.join(__dirname, 'proto-fix.ps1');
const VBS = path.join(__dirname, 'proto-sink.vbs');

function run(action) {
  return new Promise((resolve) => {
    if (!fs.existsSync(PS1)) {
      resolve({ ok: false, out: '', err: '缺少 proto-fix.ps1' });
      return;
    }
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        PS1,
        '-Action',
        action,
        '-Vbs',
        VBS,
      ],
      { windowsHide: true, timeout: 25000 },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        const errText = String(stderr || '').trim() || (err ? err.message : '');
        resolve({ ok: !err && out.indexOf('ERR') !== 0, out, err: errText });
      }
    );
  });
}

/** 当前是否已经登记过我们自己的接收器 */
async function status() {
  const r = await run('status');
  return {
    registered: /^REG /.test(r.out),
    ours: /proto-sink\.vbs/i.test(r.out),
    command: r.out.replace(/^REG\s*/, ''),
    raw: r.out,
    error: r.err,
  };
}

async function apply() {
  const st = await status();
  // 已登记且指向本程序的接收器，才算真正就绪
  if (st.ours && st.command.toLowerCase().indexOf(VBS.toLowerCase()) >= 0) {
    return { ok: true, changed: false, command: st.command };
  }
  const r = await run('apply');
  return { ok: r.ok, changed: true, command: r.out, error: r.err };
}

async function remove() {
  const r = await run('remove');
  return { ok: r.ok, removed: /^REMOVED/.test(r.out), raw: r.out, error: r.err };
}

module.exports = { run, status, apply, remove, VBS, PS1 };
