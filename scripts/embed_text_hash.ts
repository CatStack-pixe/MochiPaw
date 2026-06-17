/**
 * embed_text_hash.ts (BCSEC v2)
 *
 * 在 Tauri bundle 之前(beforeBundleCommand)运行:
 *   1. 解析 `target/<triple>/release/bongo-cat.exe` 的 PE header
 *   2. 枚举三个目标段:`.text` / `.rdata` / `.pdata`,各按 4 KiB 切页计算 SHA-256
 *      - `.rdata`:扣除 PE IAT 数据目录范围内的页(IAT 由 Loader 写入,运行时与磁盘
 *        字节不同;若该页恰好部分覆盖 IAT,则整页跳过)
 *   3. 拼装资源缓冲(BCSEC v2):
 *        [u8 magic 'B','C','S','E','C']
 *        [u8 sec_count]
 *        per_section:
 *          [u8 name_len][u8 * name_len]
 *          [u32 LE page_count]
 *          (u32 LE rva, [u8;32] sha256) * page_count
 *   4. 通过 `resedit` 注入到 RT_RCDATA / 0xCA7B
 *
 * 仅在 Windows 上有意义。其他平台静默跳过(不阻塞构建)。
 */

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { NtExecutable, NtExecutableResource } from 'resedit'

const RESOURCE_ID = 0xCA7B
const PAGE_SIZE = 4096
const TARGET_SECTIONS = ['.text', '.rdata', '.pdata'] as const

if (process.platform !== 'win32') {
  console.log('[embed_text_hash] non-windows host, skipping.')
  process.exit(0)
}

function findExe(): string | null {
  const candidates = [
    resolve('src-tauri/target/x86_64-pc-windows-msvc/release/bongo-cat.exe'),
    resolve('src-tauri/target/release/bongo-cat.exe'),
    resolve('target/x86_64-pc-windows-msvc/release/bongo-cat.exe'),
    resolve('target/release/bongo-cat.exe'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

const exe = findExe()
if (!exe) {
  console.warn('[embed_text_hash] bongo-cat.exe not found yet; skipping injection.')
  process.exit(0)
}

const buf = readFileSync(exe)
if (buf.readUInt16LE(0) !== 0x5A4D) {
  console.warn('[embed_text_hash] not a PE (no MZ); skipping.')
  process.exit(0)
}

const eLfanew = buf.readUInt32LE(0x3C)
if (buf.readUInt32LE(eLfanew) !== 0x00004550) {
  console.warn('[embed_text_hash] not a PE (no PE\\0\\0); skipping.')
  process.exit(0)
}

const fileHeader = eLfanew + 4
const numSections = buf.readUInt16LE(fileHeader + 2)
const sizeOfOptional = buf.readUInt16LE(fileHeader + 16)
const optionalHeader = fileHeader + 20

// PE32+ Optional Header:
//   Magic at +0 (0x20B = PE32+)
//   DataDirectory[] starts at +112 in PE32+
//   IAT = DataDirectory[12]: rva at +112+12*8 = +208, size at +212
const magic = buf.readUInt16LE(optionalHeader)
let iatRva = 0
let iatSize = 0
if (magic === 0x20B) {
  iatRva = buf.readUInt32LE(optionalHeader + 208)
  iatSize = buf.readUInt32LE(optionalHeader + 212)
}

interface SectionInfo {
  name: string
  virtualAddress: number
  virtualSize: number
  pointerToRawData: number
  sizeOfRawData: number
}

const sections: SectionInfo[] = []
let p = optionalHeader + sizeOfOptional
for (let i = 0; i < numSections; i++) {
  const name = buf.subarray(p, p + 8).toString('ascii').replace(/\0+$/g, '')
  sections.push({
    name,
    virtualSize: buf.readUInt32LE(p + 8),
    virtualAddress: buf.readUInt32LE(p + 12),
    sizeOfRawData: buf.readUInt32LE(p + 16),
    pointerToRawData: buf.readUInt32LE(p + 20),
  })
  p += 40
}

function pageOverlapsIat(pageRva: number, pageLen: number): boolean {
  if (iatSize === 0) return false
  const pageEnd = pageRva + pageLen
  const iatEnd = iatRva + iatSize
  return pageRva < iatEnd && iatRva < pageEnd
}

interface SectionPages {
  name: string
  pages: Array<{ rva: number, hash: Buffer }>
}

const sectionPages: SectionPages[] = []
for (const target of TARGET_SECTIONS) {
  const sec = sections.find(s => s.name === target)
  if (!sec) {
    if (target === '.text') {
      console.warn(`[embed_text_hash] .text section not found; skipping injection.`)
      process.exit(0)
    }
    // .rdata/.pdata 缺失不视为致命(某些 link 选项不会产生 .pdata)
    console.warn(`[embed_text_hash] section ${target} not found; skipping it.`)
    continue
  }
  const pages: Array<{ rva: number, hash: Buffer }> = []
  let offset = 0
  while (offset < sec.virtualSize) {
    const remaining = sec.virtualSize - offset
    const len = Math.min(PAGE_SIZE, remaining)
    const pageRva = sec.virtualAddress + offset
    // .rdata 跳过含 IAT 的页(运行时 Loader 会写)
    if (target === '.rdata' && pageOverlapsIat(pageRva, len)) {
      offset += PAGE_SIZE
      continue
    }
    const fileOff = sec.pointerToRawData + offset
    const rawAvail = Math.max(0, sec.sizeOfRawData - offset)
    const rawLen = Math.min(len, rawAvail)
    const sliceEnd = fileOff + rawLen
    const page = Buffer.alloc(len)
    if (rawLen > 0) {
      buf.subarray(fileOff, sliceEnd).copy(page, 0)
    }
    const hash = createHash('sha256').update(page).digest()
    pages.push({ rva: pageRva, hash })
    offset += PAGE_SIZE
  }
  if (pages.length > 0) {
    sectionPages.push({ name: target, pages })
  }
}

if (sectionPages.length === 0) {
  console.warn('[embed_text_hash] no sections produced; skipping.')
  process.exit(0)
}

// 估算缓冲长度
let totalLen = 5 /* magic */ + 1 /* sec_count */
for (const sp of sectionPages) {
  totalLen += 1 + sp.name.length + 4 + sp.pages.length * (4 + 32)
}

const out = Buffer.alloc(totalLen)
out.write('BCSEC', 0, 5, 'ascii')
out.writeUInt8(sectionPages.length, 5)
let writeOff = 6
for (const sp of sectionPages) {
  out.writeUInt8(sp.name.length, writeOff)
  writeOff += 1
  out.write(sp.name, writeOff, sp.name.length, 'ascii')
  writeOff += sp.name.length
  out.writeUInt32LE(sp.pages.length, writeOff)
  writeOff += 4
  for (const e of sp.pages) {
    out.writeUInt32LE(e.rva, writeOff)
    e.hash.copy(out, writeOff + 4)
    writeOff += 36
  }
}

const pe = NtExecutable.from(buf, { ignoreCert: true })
const resources = NtExecutableResource.from(pe, true)
resources.removeResourceEntry(10, RESOURCE_ID)
resources.replaceResourceEntry({
  type: 10,
  id: RESOURCE_ID,
  lang: 1033,
  codepage: 1200,
  bin: out,
})
resources.outputResource(pe)
writeFileSync(exe, Buffer.from(pe.generate()))

const summary = sectionPages
  .map(sp => `${sp.name}=${sp.pages.length}`)
  .join(', ')
console.log(`[embed_text_hash] BCSEC v2 injected (${summary}) into ${exe}`)
rmSync(tmp, { recursive: true, force: true })
