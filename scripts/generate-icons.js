// One-off dev helper that generated icons/16.png, 32.png, 48.png, 128.png —
// a flat rounded-square icon (same accent blue used throughout the widget)
// with a white checkmark. No image library dependency: renders each icon
// via signed-distance-field math at 4x supersample, box-downsamples for
// anti-aliasing, and hand-encodes a minimal RGBA PNG using Node's built-in
// zlib. Not needed at runtime — only re-run this if the icon design changes.
//
// Usage: node scripts/generate-icons.js

const fs = require("fs")
const path = require("path")
const zlib = require("zlib")

const ACCENT = [10, 132, 255] // #0a84ff, same accent color used elsewhere in the widget
const SIZES = [16, 32, 48, 128]
const SUPERSAMPLE = 4

function sdRoundRect(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r)
  const qy = Math.abs(py - cy) - (halfH - r)
  const outsideX = Math.max(qx, 0)
  const outsideY = Math.max(qy, 0)
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(outsideX, outsideY) - r
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx = x1 + t * dx
  const cy = y1 + t * dy
  return Math.hypot(px - cx, py - cy)
}

function renderSuperPixel(x, y, s) {
  const cx = s / 2
  const cy = s / 2
  const half = s * 0.46
  const r = s * 0.22

  const bgDist = sdRoundRect(x, y, cx, cy, half, half, r)
  if (bgDist > 0.5) return [0, 0, 0, 0]

  const bgAlpha = 1 - Math.max(0, Math.min(1, bgDist + 0.5))

  // Checkmark, in fractions of the icon size.
  const p1 = [s * 0.27, s * 0.53]
  const p2 = [s * 0.43, s * 0.68]
  const p3 = [s * 0.75, s * 0.32]
  const thickness = s * 0.1

  const d1 = distToSegment(x, y, p1[0], p1[1], p2[0], p2[1])
  const d2 = distToSegment(x, y, p2[0], p2[1], p3[0], p3[1])
  const checkDist = Math.min(d1, d2) - thickness / 2
  const checkAlpha = 1 - Math.max(0, Math.min(1, checkDist + 0.5))

  if (checkAlpha > 0) {
    return [255, 255, 255, Math.round(255 * bgAlpha * Math.max(checkAlpha, 0))]
  }
  return [...ACCENT, Math.round(255 * bgAlpha)]
}

function renderIcon(size) {
  const s = size * SUPERSAMPLE
  const superPixels = new Array(s * s)
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      superPixels[y * s + x] = renderSuperPixel(x + 0.5, y + 0.5, s)
    }
  }

  const buffer = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = superPixels[(y * SUPERSAMPLE + sy) * s + (x * SUPERSAMPLE + sx)]
          r += px[0] * px[3]
          g += px[1] * px[3]
          b += px[2] * px[3]
          a += px[3]
        }
      }
      const n = SUPERSAMPLE * SUPERSAMPLE
      const alpha = a / n
      const idx = (y * size + x) * 4
      if (alpha > 0) {
        buffer[idx] = Math.round(r / a)
        buffer[idx + 1] = Math.round(g / a)
        buffer[idx + 2] = Math.round(b / a)
      }
      buffer[idx + 3] = Math.round(alpha)
    }
  }
  return buffer
}

function crc32(buf) {
  let c
  const table = crc32.table || (crc32.table = makeCrcTable())
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff
    crc = (crc >>> 8) ^ table[c]
  }
  return (crc ^ 0xffffffff) >>> 0
}

function makeCrcTable() {
  const table = new Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii")
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

function encodePng(rgbaBuffer, size) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(size, 0)
  ihdrData.writeUInt32BE(size, 4)
  ihdrData[8] = 8 // bit depth
  ihdrData[9] = 6 // color type: RGBA
  ihdrData[10] = 0
  ihdrData[11] = 0
  ihdrData[12] = 0

  // One filter-type byte (0 = none) prepended to each scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgbaBuffer.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const idatData = zlib.deflateSync(raw)

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdrData),
    chunk("IDAT", idatData),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

const outDir = path.join(__dirname, "..", "icons")
fs.mkdirSync(outDir, { recursive: true })
for (const size of SIZES) {
  const png = encodePng(renderIcon(size), size)
  fs.writeFileSync(path.join(outDir, `${size}.png`), png)
  console.log(`wrote icons/${size}.png`)
}
