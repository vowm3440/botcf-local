/** Reads icon resources straight out of a Windows PE file.
 *
 *  The Windows-icon bug was closed once already on the strength of the
 *  electron-builder config naming `build/icon.ico`. It shipped with the default
 *  Electron icon anyway, because the file the config named did not exist. A path
 *  in a config is not a resource in an exe, so the release gate reads the exe.
 *
 *  Only what the check needs is implemented: RVA → file offset via the section
 *  table, the three-level resource tree (type → name → language), and the
 *  RT_ICON leaves. No writing, no other resource types.
 *
 *  References: PE/COFF spec §"Optional Header Data Directories" and
 *  §"The .rsrc Section"; ICO container layout (ICONDIR / ICONDIRENTRY). */

const RT_ICON = 3

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

class PeError extends Error {}

function need(buffer, offset, length, what) {
  if (offset < 0 || offset + length > buffer.length) throw new PeError(`PE 越界读取: ${what} @${offset}+${length} (文件 ${buffer.length} 字节)`)
}

function u16(buffer, offset, what) {
  need(buffer, offset, 2, what)
  return buffer.readUInt16LE(offset)
}

function u32(buffer, offset, what) {
  need(buffer, offset, 4, what)
  return buffer.readUInt32LE(offset)
}

/** Section table plus the resource data-directory entry — everything needed to
 *  turn an RVA into a file offset. */
function parseHeaders(buffer) {
  if (buffer.length < 64 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) throw new PeError('不是 PE 文件(缺少 MZ 签名)')
  const peOffset = u32(buffer, 0x3c, 'e_lfanew')
  if (buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') throw new PeError('不是 PE 文件(缺少 PE 签名)')

  const coff = peOffset + 4
  const sectionCount = u16(buffer, coff + 2, 'NumberOfSections')
  const optionalSize = u16(buffer, coff + 16, 'SizeOfOptionalHeader')
  const optional = coff + 20

  const magic = u16(buffer, optional, 'OptionalHeader.Magic')
  // PE32 keeps the data directories at +96, PE32+ at +112 (wider fields above).
  const directoriesAt = magic === 0x20b ? optional + 112 : optional + 96
  if (magic !== 0x10b && magic !== 0x20b) throw new PeError(`未知的 Optional Header magic 0x${magic.toString(16)}`)

  const resource = {
    rva: u32(buffer, directoriesAt + 2 * 8, 'ResourceTable.VirtualAddress'),
    size: u32(buffer, directoriesAt + 2 * 8 + 4, 'ResourceTable.Size')
  }

  const sectionsAt = optional + optionalSize
  const sections = []
  for (let i = 0; i < sectionCount; i++) {
    const at = sectionsAt + i * 40
    sections.push({
      name: buffer.toString('ascii', at, at + 8).replace(/\0+$/, ''),
      virtualSize: u32(buffer, at + 8, 'VirtualSize'),
      virtualAddress: u32(buffer, at + 12, 'VirtualAddress'),
      rawSize: u32(buffer, at + 16, 'SizeOfRawData'),
      rawOffset: u32(buffer, at + 20, 'PointerToRawData')
    })
  }
  return { sections, resource }
}

function rvaToOffset(sections, rva) {
  for (const section of sections) {
    const span = Math.max(section.virtualSize, section.rawSize)
    if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
      return section.rawOffset + (rva - section.virtualAddress)
    }
  }
  throw new PeError(`RVA 0x${rva.toString(16)} 不在任何节区内`)
}

/** One level of IMAGE_RESOURCE_DIRECTORY. */
function readDirectory(buffer, base, at) {
  const named = u16(buffer, at + 12, 'NumberOfNamedEntries')
  const ids = u16(buffer, at + 14, 'NumberOfIdEntries')
  const entries = []
  for (let i = 0; i < named + ids; i++) {
    const entryAt = at + 16 + i * 8
    const name = u32(buffer, entryAt, 'ResourceDirectoryEntry.Name')
    const data = u32(buffer, entryAt + 4, 'ResourceDirectoryEntry.OffsetToData')
    entries.push({
      id: (name & 0x80000000) === 0 ? name : null,
      isDirectory: (data & 0x80000000) !== 0,
      offset: base + (data & 0x7fffffff)
    })
  }
  return entries
}

/** Every RT_ICON image stored in `exeBuffer`, in resource-tree order. */
export function readPeIcons(exeBuffer) {
  const { sections, resource } = parseHeaders(exeBuffer)
  if (resource.rva === 0 || resource.size === 0) return []
  const base = rvaToOffset(sections, resource.rva)

  const icons = []
  for (const type of readDirectory(exeBuffer, base, base)) {
    if (type.id !== RT_ICON || !type.isDirectory) continue
    for (const name of readDirectory(exeBuffer, base, type.offset)) {
      if (!name.isDirectory) continue
      for (const language of readDirectory(exeBuffer, base, name.offset)) {
        if (language.isDirectory) continue
        const dataRva = u32(exeBuffer, language.offset, 'ResourceDataEntry.OffsetToData')
        const size = u32(exeBuffer, language.offset + 4, 'ResourceDataEntry.Size')
        const at = rvaToOffset(sections, dataRva)
        need(exeBuffer, at, size, `RT_ICON #${name.id} 数据`)
        icons.push({ id: name.id, size, bytes: exeBuffer.subarray(at, at + size) })
      }
    }
  }
  return icons
}

/** The images inside an .ico container. A 256×256 entry is stored as a whole
 *  PNG file, which is what makes the comparison against a PE resource exact. */
export function readIcoImages(icoBuffer) {
  if (u16(icoBuffer, 2, 'ICONDIR.idType') !== 1) throw new PeError('不是 ICO 容器')
  const count = u16(icoBuffer, 4, 'ICONDIR.idCount')
  const images = []
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16
    const size = u32(icoBuffer, at + 8, 'ICONDIRENTRY.dwBytesInRes')
    const offset = u32(icoBuffer, at + 12, 'ICONDIRENTRY.dwImageOffset')
    need(icoBuffer, offset, size, `ICO 图像 #${i}`)
    const bytes = icoBuffer.subarray(offset, offset + size)
    images.push({
      // 0 encodes 256 in an ICONDIRENTRY.
      width: icoBuffer[at] === 0 ? 256 : icoBuffer[at],
      height: icoBuffer[at + 1] === 0 ? 256 : icoBuffer[at + 1],
      isPng: bytes.subarray(0, 8).equals(PNG_MAGIC),
      bytes
    })
  }
  return images
}
