// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Tests use the project's Node test runner.
import test from 'node:test'

import { getImageDimensions, MAX_IMAGE_HEADER_BYTES, readImageDimensions } from './imageHeader'

function reader(bytes: Uint8Array, maxRead = Number.POSITIVE_INFINITY) {
  let offset = 0
  const requests: number[] = []
  return {
    requests,
    consumed: () => offset,
    async read(buffer: Uint8Array) {
      requests.push(buffer.length)
      const length = Math.min(buffer.length, bytes.length - offset, maxRead)
      if (!length) return null
      buffer.set(bytes.subarray(offset, offset + length))
      offset += length
      return length
    },
  }
}

function png() {
  const bytes = new Uint8Array(64)
  bytes.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
  const view = new DataView(bytes.buffer)
  view.setUint32(12, 0x49484452)
  view.setUint32(16, 8192)
  view.setUint32(20, 4096)
  return bytes
}

test('PNG scanning reads only 32 bytes even when the file contains more data', async () => {
  const file = reader(png())
  assert.deepEqual(await readImageDimensions(file), { width: 8192, height: 4096 })
  assert.equal(file.consumed(), 32)
  assert.deepEqual(file.requests, [32])
})

test('short filesystem reads are accumulated before parsing the header', async () => {
  const file = reader(png(), 7)
  assert.deepEqual(await readImageDimensions(file), { width: 8192, height: 4096 })
  assert.equal(file.consumed(), 32)
})

test('lossless WebP ignores alpha/version bits and accepts a 25-byte header', () => {
  const bytes = new Uint8Array(25)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x52494646)
  view.setUint32(8, 0x57454250)
  view.setUint32(12, 0x5650384C)
  bytes[20] = 0x2F
  // Width 513, height 2049, alpha present. Dimensions occupy only 28 bits.
  view.setUint32(21, 512 | (2048 << 14) | (1 << 28), true)
  assert.deepEqual(getImageDimensions(bytes), { width: 513, height: 2049 })
})

test('JPEG scanning crosses metadata boundaries and recognizes progressive SOF', async () => {
  const bytes = new Uint8Array(350_000)
  bytes.set([0xFF, 0xD8])
  let offset = 2
  // Several legal APP1 segments put SOF beyond the first bounded read.
  for (let index = 0; index < 5; index += 1) {
    bytes.set([0xFF, 0xE1, 0xFF, 0x00], offset)
    offset += 2 + 0xFF00
  }
  bytes.set([0xFF, 0xC2, 0, 8, 8, 0x04, 0, 0x08, 0, 0], offset)
  const file = reader(bytes)
  assert.deepEqual(await readImageDimensions(file), { width: 2048, height: 1024 })
  assert.ok(file.requests.every(length => length <= 256 * 1024))
})

test('unknown, truncated, and oversized JPEG headers stop within the read budget', async () => {
  assert.equal(getImageDimensions(new Uint8Array(0)), null)
  assert.equal(getImageDimensions(png().subarray(0, 20)), null)
  const bytes = new Uint8Array(MAX_IMAGE_HEADER_BYTES + 100)
  bytes.set([0xFF, 0xD8])
  const file = reader(bytes)
  assert.equal(await readImageDimensions(file), null)
  assert.equal(file.consumed(), MAX_IMAGE_HEADER_BYTES)
  assert.ok(file.requests.every(length => length <= 256 * 1024))
  const unknown = reader(new Uint8Array(1024))
  assert.equal(await readImageDimensions(unknown), null)
  assert.equal(unknown.consumed(), 32)
})
