import fs from 'node:fs'
import { ContentEncoding, decodeText, detectEncoding } from './textEncoding.js'

/** Bounded, encoding-aware text reads.
 *
 *  Extracted from routes/files.ts so non-route modules can reuse it — the git
 *  panel needs it to synthesize a diff for an untracked file, which git itself
 *  cannot diff. Every reader here is capped: nothing in the UI may load an
 *  unbounded file into memory or into a JSON response. */

export const MAX_FILE_CONTENT_BYTES = 1024 * 1024

export interface BoundedFileContent {
  content: string
  size: number
  truncated: boolean
  binary: boolean
  /** Encoding the content was decoded with; `binary` when it was not decodable. */
  encoding: ContentEncoding
}

/** True when no text encoding explains the leading sample. NUL bytes alone are
 *  not the test — see textEncoding.ts, UTF-16 text is full of them. */
export function isProbablyBinary(sample: Buffer): boolean {
  return detectEncoding(sample).encoding === 'binary'
}

/** Read at most `cap` bytes so the viewer never loads an unbounded file. */
export function readFileBounded(file: string, cap = MAX_FILE_CONTENT_BYTES): BoundedFileContent {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const buffer = Buffer.allocUnsafe(Math.min(size, cap))
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0)
    const sample = buffer.subarray(0, read)
    const truncated = size > cap
    const detection = detectEncoding(sample)
    if (detection.encoding === 'binary') {
      return { content: '', size, truncated, binary: true, encoding: 'binary' }
    }
    const content = decodeText(sample, detection.encoding, detection.bomLength)
    return { content, size, truncated, binary: false, encoding: detection.encoding }
  } finally {
    fs.closeSync(fd)
  }
}
