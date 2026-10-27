'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /* 主窗口 */
  parse: (text) => ipcRenderer.invoke('parse', text),
  download: (item) => ipcRenderer.invoke('download', item),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  chooseDir: () => ipcRenderer.invoke('set-download-root'),
  setAutoDownload: (v) => ipcRenderer.invoke('set-auto-download', v),
  openDir: (p) => ipcRenderer.invoke('open-dir', p),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  openDouyin: () => ipcRenderer.invoke('open-douyin'),
  clipboardText: () => ipcRenderer.invoke('clipboard-text'),
  minimize: () => ipcRenderer.send('win-min'),
  close: () => ipcRenderer.send('win-close'),

  /* 统一任务管线：剪贴板 / 悬浮条 / 主窗口共用 */
  submit: (text, source) => ipcRenderer.invoke('submit', text, source),
  setWatch: (v) => ipcRenderer.invoke('set-watch', v),
  getAppState: () => ipcRenderer.invoke('get-app-state'),
  setFloatEnabled: (v) => ipcRenderer.invoke('set-float-enabled', v),
  setLaunchAtLogin: (v) => ipcRenderer.invoke('set-launch-at-login', v),
  openMain: () => ipcRenderer.send('open-main'),
  hideFloat: () => ipcRenderer.send('hide-float'),
  toggleFloat: () => ipcRenderer.send('toggle-float'),

  /* 事件 */
  onProgress: (cb) => ipcRenderer.on('progress', (_e, d) => cb(d)),
  onClipHit: (cb) => ipcRenderer.on('clip-hit', (_e, d) => cb(d)),
  onTaskParsed: (cb) => ipcRenderer.on('task-parsed', (_e, d) => cb(d)),
  onTaskDone: (cb) => ipcRenderer.on('task-done', (_e, d) => cb(d)),
  onWatchChanged: (cb) => ipcRenderer.on('watch-changed', (_e, d) => cb(d)),
});
