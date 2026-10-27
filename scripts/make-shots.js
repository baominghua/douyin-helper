const { app, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const SRC1 = process.env.SHOT1; // 抖音窗口 + 悬浮条
const SRC2 = process.env.SHOT2; // 主窗口
const OUT = path.join(__dirname, '..', 'docs');

function ensure(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

app.whenReady().then(() => {
  ensure(OUT);

  // 1) 主窗口：整幅缩放
  const a = nativeImage.createFromPath(SRC2);
  const as = a.getSize();
  console.log('shot2 size', as.width, 'x', as.height);
  const aOut = a.resize({ width: 1000, quality: 'best' });
  fs.writeFileSync(path.join(OUT, 'app-main.png'), aOut.toPNG());
  console.log('app-main.png', aOut.getSize().width, 'x', aOut.getSize().height,
    fs.statSync(path.join(OUT, 'app-main.png')).size, 'bytes');

  // 2) 抖音窗口右下角：裁出播放器 + 悬浮条，放大 2 倍
  const b = nativeImage.createFromPath(SRC1);
  const bs = b.getSize();
  console.log('shot1 size', bs.width, 'x', bs.height);
  const rx = Math.round(bs.width * 0.66);
  const ry = Math.round(bs.height * 0.62);
  const rw = bs.width - rx;
  const rh = bs.height - ry;
  const crop = b.crop({ x: rx, y: ry, width: rw, height: rh });
  const bOut = crop.resize({ width: 900, quality: 'best' });
  fs.writeFileSync(path.join(OUT, 'float-bar.png'), bOut.toPNG());
  console.log('float-bar.png crop', rw, 'x', rh, '->', bOut.getSize().width, 'x', bOut.getSize().height,
    fs.statSync(path.join(OUT, 'float-bar.png')).size, 'bytes');

  // 3) 悬浮条特写（只截小条本身）
  const cx = Math.round(bs.width * 0.775);
  const cy = Math.round(bs.height * 0.895);
  const cw = Math.round(bs.width * 0.225);
  const ch = Math.round(bs.height * 0.105);
  const crop2 = b.crop({ x: cx, y: cy, width: cw, height: ch });
  const cOut = crop2.resize({ width: 640, quality: 'best' });
  fs.writeFileSync(path.join(OUT, 'float-zoom.png'), cOut.toPNG());
  console.log('float-zoom.png crop', cw, 'x', ch, '->', cOut.getSize().width, 'x', cOut.getSize().height);

  setTimeout(() => app.exit(0), 200);
});
