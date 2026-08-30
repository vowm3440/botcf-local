import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isProbablyBinary, listDirectory, locateInsideRoot, readFileBounded, realpathInsideRoot, resolveInsideRoot, sortEntries, writeFileGuarded } from '../src/routes/files.js'

const ROOT = path.resolve('rootdir')

/** UTF-16 fixtures, since Buffer has no BE codec and no BOM helper. */
function utf16le(text: string, bom: boolean): Buffer {
  const body = Buffer.from(text, 'utf16le')
  return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body
}

function utf16be(text: string, bom: boolean): Buffer {
  const body = Buffer.from(text, 'utf16le').swap16()
  return bom ? Buffer.concat([Buffer.from([0xfe, 0xff]), body]) : body
}

describe('resolveInsideRoot', () => {
  it('resolves the empty request to the root itself', () => {
    expect(resolveInsideRoot(ROOT, '')).toBe(ROOT)
  })

  it('resolves nested relative paths', () => {
    expect(resolveInsideRoot(ROOT, 'sub/dir')).toBe(path.join(ROOT, 'sub', 'dir'))
  })

  it('rejects parent-directory escapes', () => {
    expect(resolveInsideRoot(ROOT, '../evil')).toBeNull()
    expect(resolveInsideRoot(ROOT, 'sub/../../evil')).toBeNull()
  })

  it('rejects absolute paths outside the root but accepts ones inside', () => {
    expect(resolveInsideRoot(ROOT, path.resolve('elsewhere'))).toBeNull()
    expect(resolveInsideRoot(ROOT, path.join(ROOT, 'sub'))).toBe(path.join(ROOT, 'sub'))
  })
})

describe('sortEntries', () => {
  it('sorts directories first, then names', () => {
    const sorted = sortEntries([
      { name: 'z.txt', type: 'file', size: 1, mtimeMs: 0 },
      { name: 'beta', type: 'dir', size: 0, mtimeMs: 0 },
      { name: 'a.txt', type: 'file', size: 1, mtimeMs: 0 },
      { name: 'alpha', type: 'dir', size: 0, mtimeMs: 0 }
    ])
    expect(sorted.map((entry) => entry.name)).toEqual(['alpha', 'beta', 'a.txt', 'z.txt'])
  })
})

describe('isProbablyBinary', () => {
  it('treats NUL bytes as binary and plain text as text', () => {
    expect(isProbablyBinary(Buffer.from('hello 世界\n'))).toBe(false)
    expect(isProbablyBinary(Buffer.from([0x50, 0x4b, 0x00, 0x01]))).toBe(true)
    expect(isProbablyBinary(Buffer.alloc(0))).toBe(false)
  })

  it('accepts UTF-16 text whose NUL bytes are just high bytes', () => {
    expect(isProbablyBinary(utf16le('const x = 1\r\n', true))).toBe(false)
    expect(isProbablyBinary(utf16le('const x = 1\r\n', false))).toBe(false)
    expect(isProbablyBinary(utf16be('const x = 1\r\n', true))).toBe(false)
    expect(isProbablyBinary(utf16be('const x = 1\r\n', false))).toBe(false)
  })

  it('keeps a UTF-8 log carrying ANSI escapes previewable', () => {
    expect(isProbablyBinary(Buffer.from('[31mERROR[0m done\n'))).toBe(false)
  })
})

describe('filesystem-backed listing and containment', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'botcf-files-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'botcf-outside-'))
  fs.mkdirSync(path.join(tmpRoot, 'sub'))
  fs.writeFileSync(path.join(tmpRoot, 'b.txt'), 'bb')
  fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'a')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret')

  let escapeLink = false
  try {
    fs.symlinkSync(outside, path.join(tmpRoot, 'esc'), 'junction')
    escapeLink = true
  } catch {
    // Symlink creation can be unavailable; the escape test is skipped then.
  }

  /** A junction POINTING AT the root, standing in for a symlinked workdir. */
  const rootLink = path.join(outside, 'link-to-root')
  let rootLinked = false
  try {
    fs.symlinkSync(tmpRoot, rootLink, 'junction')
    rootLinked = true
  } catch {
    // Same unavailability caveat as above.
  }

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it('lists entries dirs-first with sizes', () => {
    const { entries, truncated } = listDirectory(tmpRoot)
    const names = entries.map((entry) => entry.name)
    expect(names).toContain('sub')
    expect(names).toContain('a.txt')
    expect(names).toContain('b.txt')
    expect(names.indexOf('sub')).toBeLessThan(names.indexOf('a.txt'))
    expect(entries.find((entry) => entry.name === 'sub')?.type).toBe('dir')
    expect(entries.find((entry) => entry.name === 'b.txt')?.size).toBe(2)
    expect(truncated).toBe(false)
  })

  it('caps the number of entries and reports truncation', () => {
    const { entries, truncated } = listDirectory(tmpRoot, 2)
    expect(entries).toHaveLength(2)
    expect(truncated).toBe(true)
  })

  it('accepts existing directories inside the root', () => {
    expect(realpathInsideRoot(tmpRoot, 'sub')).toBe(path.join(fs.realpathSync.native(tmpRoot), 'sub'))
  })

  it('rejects missing paths and parent escapes', () => {
    expect(realpathInsideRoot(tmpRoot, 'missing')).toBeNull()
    expect(realpathInsideRoot(tmpRoot, '..')).toBeNull()
    expect(realpathInsideRoot(tmpRoot, path.join(outside))).toBeNull()
  })

  it.skipIf(!escapeLink)('rejects symlink escapes out of the root', () => {
    expect(realpathInsideRoot(tmpRoot, 'esc')).toBeNull()
    expect(realpathInsideRoot(tmpRoot, 'esc/secret.txt')).toBeNull()
  })

  it('distinguishes missing paths from out-of-root paths', () => {
    expect(locateInsideRoot(tmpRoot, 'sub')).toEqual({ status: 'ok', target: path.join(fs.realpathSync.native(tmpRoot), 'sub') })
    expect(locateInsideRoot(tmpRoot, 'missing')).toEqual({ status: 'missing' })
    expect(locateInsideRoot(tmpRoot, 'sub/../gone.txt')).toEqual({ status: 'missing' })
    expect(locateInsideRoot(tmpRoot, '..')).toEqual({ status: 'outside' })
    expect(locateInsideRoot(tmpRoot, outside)).toEqual({ status: 'outside' })
  })

  it('accepts an absolute path whose realpath lands inside the root', () => {
    // The workdir itself may be a symlink/junction, so OMP reports the resolved
    // absolute path — string containment fails but the realpath check passes.
    const real = fs.realpathSync.native(tmpRoot)
    expect(locateInsideRoot(tmpRoot, path.join(real, 'b.txt'))).toEqual({ status: 'ok', target: path.join(real, 'b.txt') })
  })

  it.skipIf(!rootLinked)('accepts real paths reported against a symlinked workdir', () => {
    const real = fs.realpathSync.native(tmpRoot)
    // A junction workdir: the request is string-wise outside `rootLink`, yet both
    // sides collapse to the same real directory, so it must be allowed.
    expect(locateInsideRoot(rootLink, path.join(real, 'b.txt'))).toEqual({ status: 'ok', target: path.join(real, 'b.txt') })
    expect(locateInsideRoot(rootLink, path.join(real, 'gone.txt'))).toEqual({ status: 'missing' })
    expect(locateInsideRoot(rootLink, path.join(outside, 'secret.txt'))).toEqual({ status: 'outside' })
  })

  it('reads text file content with size metadata', () => {
    const result = readFileBounded(path.join(tmpRoot, 'b.txt'))
    expect(result).toEqual({ content: 'bb', size: 2, truncated: false, binary: false, encoding: 'utf8' })
  })

  it('truncates content beyond the byte cap', () => {
    const result = readFileBounded(path.join(tmpRoot, 'b.txt'), 1)
    expect(result.content).toBe('b')
    expect(result.truncated).toBe(true)
    expect(result.size).toBe(2)
  })

  it('flags binary files and withholds their content', () => {
    const binFile = path.join(tmpRoot, 'blob.bin')
    fs.writeFileSync(binFile, Buffer.from([0x00, 0x01, 0x02]))
    const result = readFileBounded(binFile)
    expect(result.binary).toBe(true)
    expect(result.content).toBe('')
  })

  /** The reported bug: UTF-16 text is half NUL bytes, and the old NUL-only test
   *  reported these — routinely produced by PowerShell redirection and Notepad's
   *  "Unicode" save — as unpreviewable binary. */
  it.each([
    ['utf16le-bom.txt', utf16le('hello 世界\r\n', true), 'utf16le'],
    ['utf16le.txt', utf16le('hello 世界\r\n', false), 'utf16le'],
    ['utf16be-bom.txt', utf16be('hello 世界\r\n', true), 'utf16be'],
    ['utf16be.txt', utf16be('hello 世界\r\n', false), 'utf16be'],
    ['utf8-bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello 世界\r\n')]), 'utf8']
  ])('previews %s as decoded text without its BOM', (name, bytes, encoding) => {
    const file = path.join(tmpRoot, name as string)
    fs.writeFileSync(file, bytes as Buffer)
    const result = readFileBounded(file)
    expect(result.binary).toBe(false)
    expect(result.encoding).toBe(encoding)
    expect(result.content).toBe('hello 世界\r\n')
  })

  it('keeps genuine binaries binary even when NULs sit on one parity', () => {
    // A PNG header scatters NULs across both parities; the 16-bit sample blob
    // keeps them on odd offsets but decodes to control-character soup.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
    const pcm = Buffer.from([0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04, 0x00, 0x05, 0x00, 0x06, 0x00])
    for (const [name, bytes] of [['head.png', png], ['tone.pcm', pcm]] as const) {
      const file = path.join(tmpRoot, name)
      fs.writeFileSync(file, bytes)
      expect(readFileBounded(file)).toMatchObject({ binary: true, encoding: 'binary', content: '' })
    }
  })

  it('never ends a truncated preview on a split code unit', () => {
    const utf8File = path.join(tmpRoot, 'wide.txt')
    fs.writeFileSync(utf8File, 'a世界')
    // The cap lands inside 世 (3 bytes): drop the partial character, not U+FFFD.
    expect(readFileBounded(utf8File, 3).content).toBe('a')

    const utf16File = path.join(tmpRoot, 'wide-16.txt')
    fs.writeFileSync(utf16File, utf16le('ab', false))
    expect(readFileBounded(utf16File, 3).content).toBe('a')
  })
})

describe('writeFileGuarded', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'botcf-write-'))

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('writes new content to an existing text file and reports size/mtime', () => {
    const file = path.join(tmpRoot, 'edit.txt')
    fs.writeFileSync(file, 'before')
    const result = writeFileGuarded(file, 'after 世界')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.size).toBe(Buffer.byteLength('after 世界', 'utf8'))
      expect(result.mtimeMs).toBeGreaterThan(0)
      expect(fs.readFileSync(file, 'utf8')).toBe('after 世界')
    }
  })

  it('rejects directories', () => {
    const dir = path.join(tmpRoot, 'sub')
    fs.mkdirSync(dir)
    const result = writeFileGuarded(dir, 'x')
    expect(result).toMatchObject({ ok: false, code: 'not-file' })
  })

  it('rejects missing files (the editor only saves files it opened)', () => {
    const result = writeFileGuarded(path.join(tmpRoot, 'missing.txt'), 'x')
    expect(result).toMatchObject({ ok: false, code: 'not-file' })
  })

  it('rejects binary files', () => {
    const file = path.join(tmpRoot, 'blob.bin')
    fs.writeFileSync(file, Buffer.from([0x00, 0x01]))
    const result = writeFileGuarded(file, 'text')
    expect(result).toMatchObject({ ok: false, code: 'binary' })
    expect(fs.readFileSync(file)).toEqual(Buffer.from([0x00, 0x01]))
  })

  /** UTF-16 files are previewable now, so a save must round-trip their encoding
   *  instead of silently rewriting them as UTF-8. */
  it('re-encodes a save in the encoding and BOM the file already had', () => {
    const withBom = path.join(tmpRoot, 'utf16le-bom.txt')
    fs.writeFileSync(withBom, utf16le('v1', true))
    expect(writeFileGuarded(withBom, 'v2 世界').ok).toBe(true)
    expect(fs.readFileSync(withBom)).toEqual(utf16le('v2 世界', true))

    const bomless = path.join(tmpRoot, 'utf16be.txt')
    fs.writeFileSync(bomless, utf16be('v1', false))
    expect(writeFileGuarded(bomless, 'v2').ok).toBe(true)
    expect(fs.readFileSync(bomless)).toEqual(utf16be('v2', false))
  })

  it('applies the byte cap to the re-encoded bytes, not the character count', () => {
    const file = path.join(tmpRoot, 'utf16-cap.txt')
    fs.writeFileSync(file, utf16le('abcd', false))
    // Four characters re-encode to eight UTF-16 bytes: exactly at the cap.
    expect(writeFileGuarded(file, 'abcd', undefined, 8)).toMatchObject({ ok: true })
    expect(writeFileGuarded(file, 'abcde', undefined, 8)).toMatchObject({ ok: false, code: 'too-large' })
    expect(fs.readFileSync(file)).toEqual(utf16le('abcd', false))
  })

  it('rejects content beyond the byte cap without touching the file', () => {
    const file = path.join(tmpRoot, 'cap.txt')
    fs.writeFileSync(file, 'keep')
    const result = writeFileGuarded(file, 'abcdef', undefined, 4)
    expect(result).toMatchObject({ ok: false, code: 'too-large' })
    expect(fs.readFileSync(file, 'utf8')).toBe('keep')
  })

  it('rejects files larger than the cap (viewer only held a truncated copy)', () => {
    const file = path.join(tmpRoot, 'big.txt')
    fs.writeFileSync(file, '0123456789')
    const result = writeFileGuarded(file, 'tiny', undefined, 8)
    expect(result).toMatchObject({ ok: false, code: 'too-large' })
    expect(fs.readFileSync(file, 'utf8')).toBe('0123456789')
  })

  it('detects concurrent modification via baseMtimeMs and keeps the disk copy', () => {
    const file = path.join(tmpRoot, 'race.txt')
    fs.writeFileSync(file, 'v1')
    const staleBase = fs.statSync(file).mtimeMs - 5000
    const result = writeFileGuarded(file, 'v2', staleBase)
    expect(result).toMatchObject({ ok: false, code: 'conflict' })
    expect(fs.readFileSync(file, 'utf8')).toBe('v1')
  })

  it('accepts a matching baseMtimeMs', () => {
    const file = path.join(tmpRoot, 'match.txt')
    fs.writeFileSync(file, 'v1')
    const base = fs.statSync(file).mtimeMs
    const result = writeFileGuarded(file, 'v2', base)
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('v2')
  })
})
