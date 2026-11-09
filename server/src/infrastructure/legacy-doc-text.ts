/**
 * 旧版 Word（.doc，Word 97-2003 二进制格式）正文抽取。
 *
 * .docx 是 zip + XML，可以交给 mammoth；但 .doc 是 OLE2 复合文档，
 * 正文按分片表（piece table）存放在 WordDocument 流里，只能按 MS-DOC 规范自己解析：
 *   1. 读 CFB 目录，取出 WordDocument 与 0Table/1Table 两个流；
 *   2. 解析 FIB，拿到表流选择位与 CLX（分片表）位置；
 *   3. 解析 CLX 的 PlcPcd，按分片取出正文：压缩片按 CP1252，其余按 UTF-16LE；
 *   4. 清理 Word 控制字符（域代码、单元格标记、图片占位等），得到可读文本。
 *
 * 只抽正文，不还原排版：证据理解与法条引用只需要可检索的纯文本。
 */

const OLE2_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const ENDOFCHAIN = 0xfffffffe
const FREESECT = 0xffffffff

interface DirectoryEntry {
  name: string
  objectType: number
  startSector: number
  size: number
}

interface TextPiece {
  cpStart: number
  cpEnd: number
  offset: number
  compressed: boolean
}

export function isLegacyDocFile(buffer: Buffer) {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(OLE2_SIGNATURE)
}

/**
 * 定位复合文档头部里版本字段的起点。
 *
 * 标准布局里它在签名之后（偏移 8），但部分生成器（WPS 写出的 .doc 就是这样）
 * 会在签名与版本字段之间多留一段前缀，按标准偏移读出来的全是垃圾值。
 * 这里按「字节序 + 扇区位移 + 迷你扇区位移」这组特征定位，取第一个合法位置。
 */
function resolveHeaderOffset(buffer: Buffer) {
  for (let offset = 8; offset + 52 <= buffer.length && offset <= 0x40; offset += 2) {
    if (buffer.readUInt16LE(offset + 4) !== 0xfffe) continue
    const sectorShift = buffer.readUInt16LE(offset + 6)
    if (sectorShift !== 9 && sectorShift !== 12) continue
    if (buffer.readUInt16LE(offset + 8) !== 6) continue
    return offset
  }
  return 8
}

function readCompoundFileStreams(buffer: Buffer) {
  if (!isLegacyDocFile(buffer)) {
    throw new Error('不是有效的 OLE2 复合文档。')
  }

  const headerOffset = resolveHeaderOffset(buffer)
  const sectorSize = 1 << buffer.readUInt16LE(headerOffset + 6)
  const miniSectorSize = 1 << buffer.readUInt16LE(headerOffset + 8)
  const numFatSectors = buffer.readUInt32LE(headerOffset + 20)
  const firstDirectorySector = buffer.readUInt32LE(headerOffset + 24)
  const miniStreamCutoff = buffer.readUInt32LE(headerOffset + 32)
  const firstMiniFatSector = buffer.readUInt32LE(headerOffset + 36)
  const numMiniFatSectors = buffer.readUInt32LE(headerOffset + 40)
  const firstDifatSector = buffer.readUInt32LE(headerOffset + 44)
  const numDifatSectors = buffer.readUInt32LE(headerOffset + 48)

  const sectorOffset = (sector: number) => (sector + 1) * sectorSize
  const readSector = (sector: number) => {
    const start = sectorOffset(sector)
    return buffer.subarray(start, Math.min(start + sectorSize, buffer.length))
  }

  // FAT 扇区列表：头部 DIFAT 109 项，剩余部分沿 DIFAT 链继续取。
  const fatSectorNumbers: number[] = []
  for (let index = 0; index < 109 && fatSectorNumbers.length < numFatSectors; index += 1) {
    const sector = buffer.readUInt32LE(headerOffset + 52 + index * 4)
    if (sector === FREESECT || sector === ENDOFCHAIN) break
    fatSectorNumbers.push(sector)
  }
  const difatEntriesPerSector = sectorSize / 4 - 1
  let difatSector = firstDifatSector
  for (let round = 0; round < numDifatSectors && difatSector !== ENDOFCHAIN && difatSector !== FREESECT; round += 1) {
    const sector = readSector(difatSector)
    for (let index = 0; index < difatEntriesPerSector && fatSectorNumbers.length < numFatSectors; index += 1) {
      const value = sector.readUInt32LE(index * 4)
      if (value === FREESECT || value === ENDOFCHAIN) continue
      fatSectorNumbers.push(value)
    }
    difatSector = sector.readUInt32LE(difatEntriesPerSector * 4)
  }

  const fat: number[] = []
  for (const sectorNumber of fatSectorNumbers) {
    const sector = readSector(sectorNumber)
    for (let index = 0; index + 4 <= sector.length; index += 4) {
      fat.push(sector.readUInt32LE(index))
    }
  }

  const readChain = (startSector: number, size?: number) => {
    const chunks: Buffer[] = []
    let sector = startSector
    let total = 0
    while (sector !== ENDOFCHAIN && sector !== FREESECT && sector < fat.length) {
      chunks.push(readSector(sector))
      total += sectorSize
      if (size !== undefined && total >= size) break
      sector = fat[sector]
    }
    const joined = Buffer.concat(chunks)
    return size === undefined ? joined : joined.subarray(0, size)
  }

  const directoryData = readChain(firstDirectorySector)
  const entries: DirectoryEntry[] = []
  for (let offset = 0; offset + 128 <= directoryData.length; offset += 128) {
    const nameLength = directoryData.readUInt16LE(offset + 64)
    const name = nameLength >= 2
      ? directoryData.subarray(offset, offset + nameLength - 2).toString('utf16le')
      : ''
    entries.push({
      name,
      objectType: directoryData[offset + 66],
      startSector: directoryData.readUInt32LE(offset + 116),
      size: directoryData.readUInt32LE(offset + 120),
    })
  }

  const rootEntry = entries.find((entry) => entry.objectType === 5)
  const miniStream = rootEntry ? readChain(rootEntry.startSector, rootEntry.size) : Buffer.alloc(0)
  const miniFatData = numMiniFatSectors > 0 ? readChain(firstMiniFatSector) : Buffer.alloc(0)
  const miniFat: number[] = []
  for (let offset = 0; offset + 4 <= miniFatData.length; offset += 4) {
    miniFat.push(miniFatData.readUInt32LE(offset))
  }

  const readStream = (entry: DirectoryEntry) => {
    if (entry.size >= miniStreamCutoff) {
      return readChain(entry.startSector, entry.size)
    }
    const chunks: Buffer[] = []
    let sector = entry.startSector
    let total = 0
    while (sector !== ENDOFCHAIN && sector !== FREESECT && total < entry.size) {
      const start = sector * miniSectorSize
      chunks.push(miniStream.subarray(start, start + miniSectorSize))
      total += miniSectorSize
      sector = miniFat[sector] ?? ENDOFCHAIN
    }
    return Buffer.concat(chunks).subarray(0, entry.size)
  }

  const findStream = (name: string) => {
    const entry = entries.find((item) => item.objectType === 2 && item.name === name)
    return entry ? readStream(entry) : null
  }

  return { findStream }
}

function parsePieceTable(clx: Buffer): TextPiece[] {
  let offset = 0
  while (offset < clx.length) {
    const kind = clx[offset]
    if (kind === 0x01) {
      // Prc：字符属性表，跳过。
      const size = clx.readInt16LE(offset + 1)
      offset += 3 + size
      continue
    }
    if (kind === 0x02) {
      const size = clx.readUInt32LE(offset + 1)
      return parsePlcPcd(clx.subarray(offset + 5, offset + 5 + size))
    }
    break
  }
  throw new Error('文档缺少正文分片表，无法抽取文字。')
}

function parsePlcPcd(plc: Buffer): TextPiece[] {
  const count = Math.floor((plc.length - 4) / 12)
  if (count <= 0) {
    throw new Error('文档分片表为空，无法抽取文字。')
  }

  const cps: number[] = []
  for (let index = 0; index <= count; index += 1) {
    cps.push(plc.readUInt32LE(index * 4))
  }

  const pcdBase = (count + 1) * 4
  const pieces: TextPiece[] = []
  for (let index = 0; index < count; index += 1) {
    const base = pcdBase + index * 8
    const fc = plc.readUInt32LE(base + 2)
    const compressed = (fc & 0x40000000) !== 0
    pieces.push({
      cpStart: cps[index],
      cpEnd: cps[index + 1],
      offset: compressed ? (fc & 0x3fffffff) >>> 1 : fc & 0x3fffffff,
      compressed,
    })
  }
  return pieces
}

// CP1252 的 0x80-0x9F 与 latin1 不同，Word 的压缩分片按 CP1252 存这些符号。
const CP1252_SPECIALS: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…',
  0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š',
  0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’',
  0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
  0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ',
  0x9e: 'ž', 0x9f: 'Ÿ',
}

function decodeCompressedPiece(bytes: Buffer) {
  let text = ''
  for (const byte of bytes) {
    text += CP1252_SPECIALS[byte] ?? String.fromCharCode(byte)
  }
  return text
}

function cleanWordText(text: string) {
  const output: string[] = []
  let inFieldInstruction = false
  let inPicture = false

  for (const character of text) {
    const code = character.charCodeAt(0)

    if (inPicture) {
      // 图片占位符后面跟着二进制图片数据，遇到 0x08 才算结束。
      if (code === 0x08) inPicture = false
      continue
    }

    if (code === 0x01) {
      inPicture = true
      continue
    }
    if (code === 0x13) {
      inFieldInstruction = true
      continue
    }
    if (code === 0x14) {
      inFieldInstruction = false
      continue
    }
    if (code === 0x15) {
      inFieldInstruction = false
      continue
    }
    if (inFieldInstruction) {
      // 域代码只保留域结果，正文里出现的 PAGE/HYPERLINK 指令没有阅读价值。
      continue
    }

    switch (code) {
      case 0x0d:
      case 0x0b:
      case 0x0c:
        output.push('\n')
        break
      case 0x07:
        output.push('\t')
        break
      case 0x1e:
        output.push('-')
        break
      case 0x1f:
        break
      case 0x02:
      case 0x03:
      case 0x04:
      case 0x05:
      case 0x08:
        break
      default:
        if (code < 0x20 && code !== 0x09 && code !== 0x0a) break
        output.push(character)
    }
  }

  return output
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function extractLegacyDocText(buffer: Buffer) {
  const { findStream } = readCompoundFileStreams(buffer)
  const wordDocument = findStream('WordDocument')
  if (!wordDocument || wordDocument.length < 64) {
    throw new Error('文档缺少 WordDocument 流，无法抽取正文。')
  }

  const wIdent = wordDocument.readUInt16LE(0)
  if (wIdent !== 0xa5ec) {
    throw new Error('不是 Word 97-2003 文档，无法抽取正文。')
  }

  const flags = wordDocument.readUInt16LE(10)
  if ((flags & 0x0100) !== 0) {
    throw new Error('文档已加密，无法抽取正文。')
  }
  const useTableStream = (flags & 0x0200) !== 0

  const csw = wordDocument.readUInt16LE(32)
  const cslwOffset = 34 + csw * 2
  const cslw = wordDocument.readUInt16LE(cslwOffset)
  const fibRgLwOffset = cslwOffset + 2
  const cbRgFcLcbOffset = fibRgLwOffset + cslw * 4
  const cbRgFcLcb = wordDocument.readUInt16LE(cbRgFcLcbOffset)
  const fibRgFcLcbOffset = cbRgFcLcbOffset + 2

  const ccpText = wordDocument.readUInt32LE(fibRgLwOffset + 3 * 4)
  // fcClx / lcbClx 是 FibRgFcLcb97 的第 33 组。
  const fcClx = wordDocument.readUInt32LE(fibRgFcLcbOffset + 33 * 8)
  const lcbClx = wordDocument.readUInt32LE(fibRgFcLcbOffset + 33 * 8 + 4)
  if (lcbClx <= 0 || cbRgFcLcb <= 33) {
    throw new Error('文档缺少正文分片表，无法抽取文字。')
  }

  const tableStream = findStream(useTableStream ? '1Table' : '0Table')
  if (!tableStream) {
    throw new Error('文档缺少表格流，无法抽取正文。')
  }

  const clx = tableStream.subarray(fcClx, fcClx + lcbClx)
  const pieces = parsePieceTable(clx)

  const parts: string[] = []
  for (const piece of pieces) {
    const charCount = piece.cpEnd - piece.cpStart
    if (charCount <= 0) continue
    const limitedCount = ccpText > 0 ? Math.max(0, Math.min(piece.cpEnd, ccpText) - piece.cpStart) : charCount
    if (limitedCount <= 0) continue
    const byteLength = piece.compressed ? limitedCount : limitedCount * 2
    const raw = wordDocument.subarray(piece.offset, piece.offset + byteLength)
    if (raw.length < byteLength) continue
    parts.push(piece.compressed ? decodeCompressedPiece(raw) : raw.toString('utf16le'))
  }

  const text = cleanWordText(parts.join(''))
  if (!text) {
    throw new Error('文档正文为空。')
  }
  return text
}
