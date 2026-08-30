// Generates apps/desktop/build/icon.ico — the product icon for the exe,
// installer and uninstaller. Kept in the repo (and the .ico committed) so the
// artwork is reproducible without a design tool or an image dependency:
// electron-builder only needs a 256x256 PNG inside an ICO container.
//
//   node build/generate-icon.mjs
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SIZE = 256

/** sRGB channel mix. t=0 → a, t=1 → b. */
const mix = (a, b, t) => a.map((c, i) => Math.round(c + (b[i] - c) * Math.min(1, Math.max(0, t))))

const BG_TOP = [79, 70, 229]     // indigo
const BG_BOTTOM = [30, 27, 75]   // deep navy
const FG = [246, 247, 255]

/** Signed distance to a rounded rectangle, in pixels. */
function roundedRectSdf(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius)
  const dy = Math.abs(y - cy) - (halfH - radius)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0) - radius
}

/** Coverage of a shape at one pixel, from its distance field (1px feather). */
const coverage = (dist) => Math.min(1, Math.max(0, 0.5 - dist))

function pixel(x, y) {
  // Rounded app tile.
  const tile = coverage(roundedRectSdf(x, y, SIZE / 2, SIZE / 2, SIZE / 2 - 6, SIZE / 2 - 6, 56))
  if (tile <= 0) return [0, 0, 0, 0]
  const bg = mix(BG_TOP, BG_BOTTOM, y / SIZE)

  // Speech bubble: body + tail, the console's "chat with the agent" mark.
  const body = coverage(roundedRectSdf(x, y, 128, 116, 62, 44, 22))
  const tailW = 26 * Math.max(0, 1 - (y - 152) / 34)
  const tail = y >= 150 && y <= 188 && x >= 96 && x <= 96 + tailW ? 1 : 0
  const bubble = Math.max(body, tail)

  // Three dots, punched back out of the bubble.
  let dots = 0
  for (const dx of [-34, 0, 34]) {
    dots = Math.max(dots, coverage(Math.hypot(x - (128 + dx), y - 116) - 9))
  }

  const ink = Math.max(0, bubble - dots)
  const rgb = mix(bg, FG, ink)
  return [...rgb, Math.round(tile * 255)]
}

function png() {
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
  let o = 0
  for (let y = 0; y < SIZE; y++) {
    raw[o++] = 0 // filter: none
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5)
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // truecolor + alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function ico(pngData) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)  // reserved
  header.writeUInt16LE(1, 2)  // type: icon
  header.writeUInt16LE(1, 4)  // one image
  const entry = Buffer.alloc(16)
  entry[0] = 0                // width 256 is encoded as 0
  entry[1] = 0                // height 256 is encoded as 0
  entry.writeUInt16LE(1, 4)   // color planes
  entry.writeUInt16LE(32, 6)  // bits per pixel
  entry.writeUInt32LE(pngData.length, 8)
  entry.writeUInt32LE(22, 12) // offset: 6-byte header + 16-byte entry
  return Buffer.concat([header, entry, pngData])
}

export const ICON_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'icon.ico')

/** The .ico bytes. Deterministic: same input, same file, every run. */
export function buildIcon() {
  return ico(png())
}

/** Write the icon and return where it went. Called by the release entry
 *  (build/dist.mjs) so a clean checkout cannot reach electron-builder with the
 *  file missing — the way the default Electron icon shipped once already. */
export function writeIcon() {
  writeFileSync(ICON_PATH, buildIcon())
  return ICON_PATH
}

// `node build/generate-icon.mjs`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`wrote ${writeIcon()}`)
}
