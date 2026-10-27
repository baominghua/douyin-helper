'use strict';

/**
 * 抖音客户端窗口跟随
 *
 * 用一个常驻 PowerShell 子进程轮询抖音主窗口的屏幕矩形（物理像素），
 * 主进程按需把悬浮条吸附到窗口旁边。
 *
 * 之所以不每帧起一个新进程：powershell 冷启动 300~800ms，跟随会明显卡顿。
 * 这里只起一次，之后靠 stdout 逐行吐 JSON。
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, 'win-probe.ps1');

class WindowAnchor {
  /**
   * @param {(rect: object|null) => void} onChange 抖音窗口矩形变化（物理像素）
   * @param {(msg: string) => void} log
   */
  constructor(onChange, log) {
    this.onChange = onChange;
    this.log = log || (() => {});
    this.child = null;
    this.buf = '';
    this.last = null;
    this.timer = null;
    this.stopped = false;
    this.restarting = false;
  }

  start() {
    if (this.child || this.stopped) return;
    if (!fs.existsSync(SCRIPT)) {
      this.log('探针脚本不存在: ' + SCRIPT);
      return;
    }

    let child;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (e) {
      this.log('探针启动失败: ' + e.message);
      return;
    }

    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let idx;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (line) this.handleLine(line);
      }
    });

    child.stderr.on('data', (d) => {
      const s = String(d || '').trim();
      if (s) this.log('探针 stderr: ' + s.slice(0, 300));
    });

    child.on('exit', (code) => {
      this.child = null;
      if (this.stopped) return;
      this.log('探针退出 code=' + code + '，2 秒后重启');
      // 探针意外退出时自动拉起，但不做无上限重试
      this.restarting = true;
      setTimeout(() => {
        this.restarting = false;
        if (!this.stopped) this.start();
      }, 2000);
    });

    child.on('error', (e) => {
      this.log('探针错误: ' + e.message);
    });

    this.log('抖音窗口探针已启动');
  }

  handleLine(line) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_) {
      return;
    }

    const prev = this.last;
    let next;

    if (!obj.found) {
      next = null;
    } else {
      // 最小化 / 隐藏当作不可用，悬浮条跟着藏起来
      const usable = obj.visible && !obj.minimized && obj.w > 200 && obj.h > 200;
      next = usable
        ? { x: obj.x, y: obj.y, w: obj.w, h: obj.h, hwnd: obj.hwnd, focus: obj.focus }
        : null;
    }

    // 只有真正变化才回调，避免每 400ms 抖动一次窗口位置
    const same =
      (prev === null && next === null) ||
      (prev &&
        next &&
        prev.x === next.x &&
        prev.y === next.y &&
        prev.w === next.w &&
        prev.h === next.h &&
        prev.focus === next.focus);

    this.last = next;
    if (!same) this.onChange(next);
  }

  /** 当前是否检测到可用的抖音窗口 */
  get rect() {
    return this.last;
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.child) {
      try {
        this.child.kill();
      } catch (_) {}
      this.child = null;
    }
  }
}

module.exports = { WindowAnchor };
