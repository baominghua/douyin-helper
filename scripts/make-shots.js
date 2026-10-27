const { app, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const SRC1 = process.env.SHOT1; // 抖音窗口 + 悬浮条
const SRC2 = process.env.SHOT2; // 主窗口
const OUT = path.join(__dirname, '..', 'docs');

function ensure(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

/** 对 BGRA 位图的一块区域做马赛克（块平均色） */
function mosaicBitmap(buf, imgW, imgH, rects, block) {
  for (const r of rects) {
    const x0 = Math.max(0, Math.round(r.x));
    const y0 = Math.max(0, Math.round(r.y));
    const x1 = Math.min(imgW, Math.round(r.x + r.w));
    const y1 = Math.min(imgH, Math.round(r.y + r.h));
    for (let by = y0; by < y1; by += block) {
      for (let bx = x0; bx < x1; bx += block) {
        const ex = Math.min(bx + block, x1);
        const ey = Math.min(by + block, y1);
        let sb = 0, sg = 0, sr = 0, n = 0;
        for (let y = by; y < ey; y++) {
          for (let x = bx; x < ex; x++) {
            const i = (y * imgW + x) * 4;
            sb += buf[i]; sg += buf[i + 1]; sr += buf[i + 2]; n++;
          }
        }
        if (!n) continue;
        const b = (sb / n) | 0, g = (sg / n) | 0, rr = (sr / n) | 0;
        for (let y = by; y < ey; y++) {
          for (let x = bx; x < ex; x++) {
            const i = (y * imgW + x) * 4;
            buf[i] = b; buf[i + 1] = g; buf[i + 2] = rr; buf[i + 3] = 255;
          }
        }
      }
    }
  }
}

app.whenReady().then(() => {
  ensure(OUT);

  // 1) 主窗口：先把两个作品缩略图打码，再缩放
  const a = nativeImage.createFromPath(SRC2);
  const as = a.getSize();
  const buf = a.toBitmap();
  console.log('shot2 size', as.width, 'x', as.height, 'bitmap bytes', buf.length);
  const k = as.width / 1000; // 1000 宽预览图上的坐标 → 原图坐标
  const thumbs = [
    { x: 46 * k, y: 308 * k, w: 106 * k, h: 103 * k },
    { x: 46 * k, y: 474 * k, w: 106 * k, h: 103 * k },
  ];
  console.log('mosaic rects', JSON.stringify(thumbs.map((t) => ({
    x: Math.round(t.x), y: Math.round(t.y), w: Math.round(t.w), h: Math.round(t.h),
  }))));
  mosaicBitmap(buf, as.width, as.height, thumbs, Math.round(14 * k));
  const masked = nativeImage.createFromBuffer(buf, { width: as.width, height: as.height, scaleFactor: 1 });
  const aOut = masked.resize({ width: 1000, quality: 'best' });
  fs.writeFileSync(path.join(OUT, 'app-main.png'), aOut.toPNG());
  console.log('app-main.png', aOut.getSize().width, 'x', aOut.getSize().height,
    fs.statSync(path.join(OUT, 'app-main.png')).size, 'bytes');

  // 2) 抖音窗口右下角：裁出播放器 + 悬浮条，放大
  const b = nativeImage.createFromPath(SRC1);
  const bs = b.getSize();
  const rx = Math.round(bs.width * 0.66);
  const ry = Math.round(bs.height * 0.62);
  const crop = b.crop({ x: rx, y: ry, width: bs.width - rx, height: bs.height - ry });
  const bOut = crop.resize({ width: 900, quality: 'best' });
  fs.writeFileSync(path.join(OUT, 'float-bar.png'), bOut.toPNG());
  console.log('float-bar.png', bOut.getSize().width, 'x', bOut.getSize().height,
    fs.statSync(path.join(OUT, 'float-bar.png')).size, 'bytes');

  setTimeout(() => app.exit(0), 200);
});
