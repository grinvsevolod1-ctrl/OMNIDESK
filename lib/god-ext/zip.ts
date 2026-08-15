// Minimal ZIP writer — no external dependencies.
//
// The extension generator needs to hand the operator a single .zip. Rather
// than pull in jszip/archiver, we emit the ZIP container by hand: DEFLATE
// comes from Node's built-in zlib, and everything else (local file headers,
// the central directory, CRC-32) is a few dozen lines of well-specified
// binary layout. This keeps the dependency footprint at zero and the output
// fully deterministic (handy for tests and reproducible downloads).
//
// Spec reference: PKWARE APPNOTE.TXT, sections 4.3.7 (local header),
// 4.3.12 (central directory), 4.3.16 (end of central directory).

import { deflateRawSync } from 'node:zlib'

export interface ZipEntry {
  /** Path inside the archive, forward-slash separated (e.g. "icon32.png"). */
  name: string
  data: Buffer
}

/** CRC-32 (IEEE 802.3), the checksum ZIP stores for every entry. */
const CRC_TABLE: number[] = (() => {
  const table: number[] = new Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Build a ZIP archive from in-memory entries. Every entry is DEFLATE-
 * compressed (method 8). Returns the complete archive as one Buffer.
 *
 * Kept intentionally simple: no ZIP64, so it supports archives and members
 * under 4 GB — far beyond the ~300 KB extension bundle this serves.
 */
export function buildZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const compressed = deflateRawSync(entry.data, { level: 9 })
    // Store uncompressed if DEFLATE somehow grew the data (tiny files).
    const useStore = compressed.length >= entry.data.length
    const method = useStore ? 0 : 8
    const body = useStore ? entry.data : compressed

    // ---- Local file header (30 bytes + name) ----
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // signature "PK\x03\x04"
    local.writeUInt16LE(20, 4) // version needed to extract (2.0)
    local.writeUInt16LE(0, 6) // general purpose flags
    local.writeUInt16LE(method, 8) // compression method
    local.writeUInt16LE(0, 10) // mod time (fixed — deterministic output)
    local.writeUInt16LE(0x21, 12) // mod date (fixed: 1980-01-01)
    local.writeUInt32LE(crc, 14) // CRC-32
    local.writeUInt32LE(body.length, 18) // compressed size
    local.writeUInt32LE(entry.data.length, 22) // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26) // file name length
    local.writeUInt16LE(0, 28) // extra field length

    chunks.push(local, nameBuf, body)

    // ---- Central directory record (46 bytes + name) ----
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0) // signature "PK\x01\x02"
    cd.writeUInt16LE(20, 4) // version made by
    cd.writeUInt16LE(20, 6) // version needed
    cd.writeUInt16LE(0, 8) // flags
    cd.writeUInt16LE(method, 10) // method
    cd.writeUInt16LE(0, 12) // mod time
    cd.writeUInt16LE(0x21, 14) // mod date
    cd.writeUInt32LE(crc, 16) // CRC-32
    cd.writeUInt32LE(body.length, 20) // compressed size
    cd.writeUInt32LE(entry.data.length, 24) // uncompressed size
    cd.writeUInt16LE(nameBuf.length, 28) // name length
    cd.writeUInt16LE(0, 30) // extra length
    cd.writeUInt16LE(0, 32) // comment length
    cd.writeUInt16LE(0, 34) // disk number start
    cd.writeUInt16LE(0, 36) // internal attributes
    cd.writeUInt32LE(0, 38) // external attributes
    cd.writeUInt32LE(offset, 42) // offset of local header
    central.push(cd, nameBuf)

    offset += local.length + nameBuf.length + body.length
  }

  const centralBuf = Buffer.concat(central)
  const centralOffset = offset

  // ---- End of central directory (22 bytes) ----
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // signature "PK\x05\x06"
  eocd.writeUInt16LE(0, 4) // disk number
  eocd.writeUInt16LE(0, 6) // central dir start disk
  eocd.writeUInt16LE(entries.length, 8) // entries on this disk
  eocd.writeUInt16LE(entries.length, 10) // total entries
  eocd.writeUInt32LE(centralBuf.length, 12) // central dir size
  eocd.writeUInt32LE(centralOffset, 16) // central dir offset
  eocd.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...chunks, centralBuf, eocd])
}
