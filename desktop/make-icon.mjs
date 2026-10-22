// 零依赖生成 1024x1024 应用图标：圆角蓝底 + 白色 [ / ] 图形
// 遵守 macOS 图标规范：1024 画布中图标本体只占 824x824，四周各留 100px 透明边距，
// 否则在 Dock / 启动台里会比系统图标显得大一圈。
import { deflateSync, crc32 } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const W = 1024
const BODY = 824                    // 系统规范：图标主体边长
const SCALE = BODY / W              // 逻辑坐标 → 画布坐标
const OFF = (W - BODY) / 2          // 居中偏移
const px = Buffer.alloc(W * W * 4)
const set = (x, y, [r, g, b]) => {
  // 逻辑坐标（0..1023）映射到居中的 824x824 主体区域
  const X = Math.round(x * SCALE + OFF)
  const Y = Math.round(y * SCALE + OFF)
  if (X < 0 || Y < 0 || X >= W || Y >= W) return
  const i = (Y * W + X) * 4
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255
}

// 圆角底（逻辑空间 R 换算到画布后约 185px，贴合 macOS squircle 观感）
const R = 230, BG = [37, 99, 235]
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    const dx = Math.max(R - x, x - (W - 1 - R), 0)
    const dy = Math.max(R - y, y - (W - 1 - R), 0)
    if (dx * dx + dy * dy <= R * R) set(x, y, BG)
  }
}

// 白色图形：左括号、右括号、中间斜杠
const white = [255, 255, 255]
const bar = (x0, x1, y0, y1) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, white)
}
const stroke = (x0, y0, x1, y1, w) => {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * i) / n
    for (let dy = -w; dy <= w; dy++) for (let dx = -w; dx <= w; dx++) {
      if (dx * dx + dy * dy <= w * w) set(x + dx, y + dy, white)
    }
  }
}
bar(215, 315, 290, 734)
bar(709, 809, 290, 734)
stroke(600, 330, 470, 512, 42)
stroke(470, 512, 600, 694, 42)

// 打包成 PNG（RGBA，filter 0）
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0)
  return Buffer.concat([len, t, data, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(W, 4)
ihdr[8] = 8; ihdr[9] = 6
const stride = W * 4 + 1
const raw = Buffer.alloc(stride * W)
for (let y = 0; y < W; y++) {
  raw[y * stride] = 0
  px.copy(raw, y * stride + 1, y * W * 4, (y + 1) * W * 4)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])
writeFileSync(new URL('./icon.png', import.meta.url), png)

// 自检：内容边界必须落在 100px 边距内，否则 Dock 里会比系统图标显大
let minX = W, minY = W, maxX = -1, maxY = -1
for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
  if (px[(y * W + x) * 4 + 3] > 0) {
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
}
const margin = Math.min(minX, minY, W - 1 - maxX, W - 1 - maxY)
if (margin < 95 || margin > 105) throw new Error(`图标边距 ${margin}px，应在 100px 左右`)
console.log(`icon.png ${png.length} bytes，内容 ${maxX - minX + 1}x${maxY - minY + 1}，边距 ${margin}px ✓`)
