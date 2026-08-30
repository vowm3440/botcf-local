/** Text-encoding sniffing for the file panel.
 *
 *  A NUL byte on its own does not mean "binary": UTF-16/UTF-32 text is half
 *  NUL whenever the content is ASCII, and on Windows those encodings are
 *  everywhere — PowerShell 5.1 `>` / `Out-File` default to UTF-16LE, as do
 *  Notepad's "Unicode" option and a lot of MSBuild/SQL tooling. Sniff the
 *  encoding first, decode with it, and only call a file binary when no text
 *  encoding explains the bytes. */

export type TextEncoding = 'utf8' | 'utf16le' | 'utf16be' | 'utf32le' | 'utf32be'
export type ContentEncoding = TextEncoding | 'binary'

/** A sniffed text encoding plus the length of the BOM to strip when decoding
 *  (and to re-attach when encoding, so a save keeps the file's original form). */
export interface TextDetection {
  encoding: TextEncoding
  bomLength: number
}

export type EncodingDetection = TextDetection | { encoding: 'binary'; bomLength: 0 }

const BINARY: EncodingDetection = { encoding: 'binary', bomLength: 0 }

/** Bytes inspected while sniffing — enough to characterise a file cheaply. */
export const SNIFF_BYTES = 8192

const BOM_BYTES: Record<TextEncoding, readonly number[]> = {
  utf8: [0xef, 0xbb, 0xbf],
  utf16le: [0xff, 0xfe],
  utf16be: [0xfe, 0xff],
  utf32le: [0xff, 0xfe, 0x00, 0x00],
  utf32be: [0x00, 0x00, 0xfe, 0xff]
}

/** UTF-32 first: its little-endian BOM starts with the whole UTF-16LE BOM, so
 *  checking UTF-16 first would decode UTF-32LE into NUL-laden garbage. */
const BOM_ORDER: readonly TextEncoding[] = ['utf32le', 'utf32be', 'utf8', 'utf16le', 'utf16be']

function matchBom(sample: Buffer): TextDetection | null {
  for (const encoding of BOM_ORDER) {
    const bom = BOM_BYTES[encoding]
    if (sample.length >= bom.length && bom.every((byte, i) => sample[i] === byte)) {
      return { encoding, bomLength: bom.length }
    }
  }
  return null
}

/** Positional NUL statistics identify BOM-less UTF-16: ASCII-heavy UTF-16 puts
 *  a NUL in every high byte, so NULs cluster on one parity and essentially
 *  never appear on the other. Real binaries scatter NULs across both. */
function sniffUtf16(head: Buffer): TextEncoding | null {
  const pairs = Math.floor(head.length / 2)
  if (pairs === 0) return null
  let evenNuls = 0
  let oddNuls = 0
  for (let i = 0; i < pairs * 2; i++) {
    if (head[i] !== 0) continue
    if (i % 2 === 0) evenNuls++
    else oddNuls++
  }
  // 30% rather than "nearly all" so CJK-heavy text (non-zero high bytes) still
  // matches; the opposite parity must stay clean apart from a stray byte or two.
  const expected = Math.max(1, Math.floor(pairs * 0.3))
  const stray = Math.floor(pairs * 0.02)
  if (oddNuls >= expected && evenNuls <= stray) return 'utf16le'
  if (evenNuls >= expected && oddNuls <= stray) return 'utf16be'
  return null
}

/** Length of `body` minus a trailing multi-byte UTF-8 sequence that the read
 *  cap cut in half, so a truncated preview never ends in U+FFFD. */
function wholeUtf8Length(body: Buffer): number {
  const earliest = Math.max(0, body.length - 4)
  for (let i = body.length - 1; i >= earliest; i--) {
    const byte = body[i]
    if ((byte & 0xc0) === 0x80) continue
    const needed = byte < 0xc0 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4
    return i + needed <= body.length ? body.length : i
  }
  return body.length
}

/** Node has no UTF-32 codec. Rare, but a UTF-32 BOM is unambiguous, so decoding
 *  it beats reporting a perfectly readable file as binary. */
function decodeUtf32(body: Buffer, little: boolean): string {
  const units = Math.floor(body.length / 4)
  const points: number[] = []
  for (let i = 0; i < units; i++) {
    const point = little ? body.readUInt32LE(i * 4) : body.readUInt32BE(i * 4)
    const valid = point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
    points.push(valid ? point : 0xfffd)
  }
  // Chunked so a megabyte of code points cannot blow the argument limit.
  let text = ''
  for (let i = 0; i < points.length; i += 4096) {
    text += String.fromCodePoint(...points.slice(i, i + 4096))
  }
  return text
}

/** Decode `sample` as `encoding`, dropping a leading BOM of `bomLength` bytes
 *  and any trailing partial code unit left behind by the read cap. */
export function decodeText(sample: Buffer, encoding: TextEncoding, bomLength = 0): string {
  const body = sample.subarray(bomLength)
  switch (encoding) {
    case 'utf8':
      return body.subarray(0, wholeUtf8Length(body)).toString('utf8')
    case 'utf16le':
      return body.subarray(0, body.length - (body.length % 2)).toString('utf16le')
    case 'utf16be':
      // Copy before swapping: the caller's buffer must not be mutated.
      return Buffer.from(body.subarray(0, body.length - (body.length % 2))).swap16().toString('utf16le')
    case 'utf32le':
    case 'utf32be':
      return decodeUtf32(body, encoding === 'utf32le')
  }
}

/** C0 codes that do occur in real text — tabs and newlines, plus ESC/BEL so
 *  terminal logs stay previewable. */
const TEXT_CONTROLS: ReadonlySet<number> = new Set([0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b])

/** Second opinion on a multi-byte-unit guess: a binary blob can satisfy the
 *  UTF-16 NUL pattern by chance, and decoded garbage gives it away. */
export function looksLikeText(text: string): boolean {
  if (text.length === 0) return true
  let suspicious = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 0) return false
    if (code === 0xfffd || code === 0x7f || (code < 0x20 && !TEXT_CONTROLS.has(code))) suspicious++
  }
  return suspicious / text.length <= 0.1
}

/** Sniff how `sample` should be decoded. `binary` means no text encoding
 *  explains the bytes and the viewer must not try to render them.
 *
 *  UTF-8 keeps the historical rule — a NUL inside the sniff window means binary
 *  — because a NUL cannot survive a round trip through the editor anyway, and
 *  because escape-heavy logs must not be reclassified. */
export function detectEncoding(sample: Buffer): EncodingDetection {
  const bom = matchBom(sample)
  if (bom && bom.encoding !== 'utf8') {
    return looksLikeText(decodeText(sample, bom.encoding, bom.bomLength)) ? bom : BINARY
  }
  const bomLength = bom?.bomLength ?? 0
  const body = sample.subarray(bomLength)
  const head = body.subarray(0, Math.min(body.length, SNIFF_BYTES))
  if (!head.includes(0)) return { encoding: 'utf8', bomLength }
  if (bom) return BINARY
  const guess = sniffUtf16(head)
  if (guess && looksLikeText(decodeText(body, guess))) return { encoding: guess, bomLength: 0 }
  return BINARY
}

function encodeBody(text: string, encoding: TextEncoding): Buffer {
  switch (encoding) {
    case 'utf8':
      return Buffer.from(text, 'utf8')
    case 'utf16le':
      return Buffer.from(text, 'utf16le')
    case 'utf16be':
      // Freshly allocated by Buffer.from, so swapping in place is safe.
      return Buffer.from(text, 'utf16le').swap16()
    case 'utf32le':
    case 'utf32be': {
      const points = Array.from(text)
      const out = Buffer.alloc(points.length * 4)
      points.forEach((char, i) => {
        const point = char.codePointAt(0) ?? 0xfffd
        if (encoding === 'utf32le') out.writeUInt32LE(point, i * 4)
        else out.writeUInt32BE(point, i * 4)
      })
      return out
    }
  }
}

/** Encode `text` in the file's own encoding, re-attaching the BOM when it had
 *  one, so saving never silently rewrites a UTF-16 file as UTF-8. */
export function encodeText(text: string, detection: TextDetection): Buffer {
  const body = encodeBody(text, detection.encoding)
  if (detection.bomLength === 0) return body
  return Buffer.concat([Buffer.from(BOM_BYTES[detection.encoding]), body])
}
