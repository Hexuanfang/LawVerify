import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractLegacyDocText, isLegacyDocFile } from '../src/infrastructure/legacy-doc-text.ts'

const SECTOR_SIZE = 512
const FAT_SECT = 0xfffffffd
const ENDOFCHAIN = 0xfffffffe
const FREESECT = 0xffffffff
const WORD_DOCUMENT_SECTORS = 16
const TABLE_SECTORS = 16
const TEXT_OFFSET = 1024

// 合成一个最小可用的 .doc：OLE2 复合文档 + FIB + 正文分片表。
// headerPrefix 用来模拟 WPS 写出的文件——签名后面多一段前缀，标准偏移读出来全是垃圾值。
function buildLegacyDoc(text, headerPrefix = 0) {
  const wordDocument = Buffer.alloc(WORD_DOCUMENT_SECTORS * SECTOR_SIZE)
  const table = Buffer.alloc(TABLE_SECTORS * SECTOR_SIZE)

  wordDocument.writeUInt16LE(0xa5ec, 0)
  wordDocument.writeUInt16LE(0x00c1, 2)
  wordDocument.writeUInt16LE(0x0000, 10)
  wordDocument.writeUInt16LE(14, 32)
  wordDocument.writeUInt16LE(22, 62)
  wordDocument.writeUInt32LE(text.length, 64 + 3 * 4)
  wordDocument.writeUInt16LE(93, 152)
  wordDocument.writeUInt32LE(0, 154 + 33 * 8)
  wordDocument.writeUInt32LE(21, 154 + 33 * 8 + 4)
  Buffer.from(text, 'utf16le').copy(wordDocument, TEXT_OFFSET)

  // CLX：0x02 = Pcdt，随后是 PlcPcd（CP 数组 + 分片描述符）。
  const clx = Buffer.alloc(21)
  clx.writeUInt8(0x02, 0)
  clx.writeUInt32LE(16, 1)
  clx.writeUInt32LE(0, 5)
  clx.writeUInt32LE(text.length, 9)
  clx.writeUInt32LE(TEXT_OFFSET, 15)
  clx.copy(table, 0)

  const header = Buffer.alloc(SECTOR_SIZE)
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0)
  const fieldOffset = 8 + headerPrefix
  header.writeUInt16LE(0x003e, fieldOffset)
  header.writeUInt16LE(3, fieldOffset + 2)
  header.writeUInt16LE(0xfffe, fieldOffset + 4)
  header.writeUInt16LE(9, fieldOffset + 6)
  header.writeUInt16LE(6, fieldOffset + 8)
  header.writeUInt32LE(1, fieldOffset + 20)
  header.writeUInt32LE(1, fieldOffset + 24)
  header.writeUInt32LE(4096, fieldOffset + 32)
  header.writeUInt32LE(ENDOFCHAIN, fieldOffset + 44)
  header.writeUInt32LE(0, fieldOffset + 48)
  header.writeUInt32LE(0, fieldOffset + 52)

  const fat = Buffer.alloc(SECTOR_SIZE)
  const entries = new Array(SECTOR_SIZE / 4).fill(FREESECT)
  entries[0] = FAT_SECT
  entries[1] = ENDOFCHAIN
  for (let index = 0; index < WORD_DOCUMENT_SECTORS; index += 1) {
    entries[2 + index] = index === WORD_DOCUMENT_SECTORS - 1 ? ENDOFCHAIN : 3 + index
  }
  const tableStart = 2 + WORD_DOCUMENT_SECTORS
  for (let index = 0; index < TABLE_SECTORS; index += 1) {
    entries[tableStart + index] = index === TABLE_SECTORS - 1 ? ENDOFCHAIN : tableStart + index + 1
  }
  entries.forEach((value, index) => fat.writeUInt32LE(value, index * 4))

  const directory = Buffer.alloc(SECTOR_SIZE)
  const writeEntry = (index, name, objectType, startSector, size) => {
    const base = index * 128
    directory.write(name, base, 'utf16le')
    directory.writeUInt16LE((name.length + 1) * 2, base + 64)
    directory.writeUInt8(objectType, base + 66)
    directory.writeUInt32LE(startSector, base + 116)
    directory.writeUInt32LE(size, base + 120)
  }
  writeEntry(0, 'Root Entry', 5, ENDOFCHAIN, 0)
  writeEntry(1, 'WordDocument', 2, 2, WORD_DOCUMENT_SECTORS * SECTOR_SIZE)
  writeEntry(2, '0Table', 2, tableStart, TABLE_SECTORS * SECTOR_SIZE)

  return Buffer.concat([header, fat, directory, wordDocument, table])
}

test('旧版 .doc 能抽出正文', () => {
  const file = buildLegacyDoc('尊敬的张祎法官：\r这是一封律师函。')
  assert.equal(isLegacyDocFile(file), true)

  const text = extractLegacyDocText(file)
  assert.match(text, /尊敬的张祎法官：/)
  assert.match(text, /这是一封律师函。/)
  assert.ok(!text.includes('\r'), '段落标记要换成换行，不能残留控制字符')
})

test('头部多一段前缀的 .doc（WPS 写法）同样能解析', () => {
  const file = buildLegacyDoc('附件一：证据目录。', 16)
  assert.match(extractLegacyDocText(file), /附件一：证据目录。/)
})

test('域代码被丢弃、域结果保留', () => {
  const file = buildLegacyDoc('见附件\x13 HYPERLINK "http://x" \x14附件一\x15。')
  const text = extractLegacyDocText(file)
  assert.ok(!text.includes('HYPERLINK'), '域指令属于控制信息，不应进入正文')
  assert.match(text, /附件一/)
})

test('不是 OLE2 的文件不会被当成旧版 .doc', () => {
  assert.equal(isLegacyDocFile(Buffer.from('PK\x03\x04docx')), false)
  assert.throws(() => extractLegacyDocText(Buffer.from('plain text')), /OLE2/)
})
