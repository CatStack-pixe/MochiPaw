// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export interface ImageDimensions {
  width: number
  height: number
}

export interface ImageHeaderReader {
  read: (buffer: Uint8Array) => Promise<number | null>
}

const INITIAL_HEADER_BYTES = 32
const JPEG_CHUNK_BYTES = 256 * 1024
export const MAX_IMAGE_HEADER_BYTES = 1024 * 1024

function validSize(width: number, height: number): ImageDimensions | null {
  return width > 0 && height > 0 ? { width, height } : null
}

function readUint24LE(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

/** Read dimensions from image headers without decoding the image itself. */
export function getImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length >= 24
    && [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A].every((value, index) => bytes[index] === value)
    && view.getUint32(12) === 0x49484452) {
    return validSize(view.getUint32(16), view.getUint32(20))
  }

  if (bytes.length >= 25
    && view.getUint32(0) === 0x52494646
    && view.getUint32(8) === 0x57454250) {
    const type = view.getUint32(12)
    if (type === 0x56503858 && bytes.length >= 30) {
      return validSize(readUint24LE(bytes, 24) + 1, readUint24LE(bytes, 27) + 1)
    }
    if (type === 0x56503820 && bytes.length >= 30) {
      return validSize(view.getUint16(26, true) & 0x3FFF, view.getUint16(28, true) & 0x3FFF)
    }
    if (type === 0x5650384C && bytes[20] === 0x2F) {
      return validSize(
        1 + (((bytes[22] & 0x3F) << 8) | bytes[21]),
        1 + (((bytes[24] & 0x0F) << 10) | (bytes[23] << 2) | (bytes[22] >> 6)),
      )
    }
  }

  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null
  let offset = 2
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xFF) return null
    while (bytes[offset] === 0xFF) offset += 1
    if (offset >= bytes.length) return null
    const marker = bytes[offset++]
    // Dimensions occur before scan data. Never interpret compressed pixels as
    // markers, and permit the standalone markers that have no length field.
    if (marker === 0xDA || marker === 0xD9) return null
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD8)) continue
    if (offset + 2 > bytes.length) return null
    const length = view.getUint16(offset)
    if (length < 2) return null
    if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
      if (length < 8 || offset + 7 > bytes.length) return null
      return validSize(view.getUint16(offset + 5), view.getUint16(offset + 3))
    }
    offset += length
  }
  return null
}

async function fill(reader: ImageHeaderReader, buffer: Uint8Array) {
  let used = 0
  while (used < buffer.length) {
    const count = await reader.read(buffer.subarray(used))
    if (count == null || count <= 0) break
    used += count
  }
  return used
}

/** PNG/WebP need 32 bytes; JPEG metadata is capped at 1 MiB in 256 KiB reads. */
export async function readImageDimensions(reader: ImageHeaderReader): Promise<ImageDimensions | null> {
  let bytes = new Uint8Array(INITIAL_HEADER_BYTES)
  let used = await fill(reader, bytes)
  let size = getImageDimensions(bytes.subarray(0, used))
  if (size || used < bytes.length || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return size

  while (used < MAX_IMAGE_HEADER_BYTES) {
    const next = new Uint8Array(Math.min(used + JPEG_CHUNK_BYTES, MAX_IMAGE_HEADER_BYTES))
    next.set(bytes.subarray(0, used))
    const read = await fill(reader, next.subarray(used))
    used += read
    bytes = next
    size = getImageDimensions(bytes.subarray(0, used))
    if (size || used < bytes.length) return size
  }
  return null
}
