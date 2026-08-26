// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import {
  applyRelativeMouseMovement,
  mergeRelativeMouseMovement,
  normalizeCursorPosition,
  normalizeMouseLookPosition,
} from './relativeMouse'

test('selects window or monitor bounds for the corresponding mouse-look algorithm', () => {
  const windowBounds = { x: 1000, y: 500, width: 500, height: 500 }
  const monitorBounds = { x: 0, y: 0, width: 2000, height: 1000 }

  assert.deepEqual(
    normalizeMouseLookPosition({ x: 1250, y: 750 }, true, windowBounds, monitorBounds),
    { x: 0.5, y: 0.5 },
  )
  assert.deepEqual(
    normalizeMouseLookPosition({ x: 1000, y: 500 }, false, windowBounds, monitorBounds),
    { x: 0.5, y: 0.5 },
  )
})

test('keeps mouse-look normalization defensive when the selected bounds are missing', () => {
  const windowBounds = { x: 1000, y: 500, width: 500, height: 500 }
  const monitorBounds = { x: 0, y: 0, width: 2000, height: 1000 }

  assert.equal(normalizeMouseLookPosition({ x: 1250, y: 750 }, true, undefined, monitorBounds), undefined)
  assert.equal(normalizeMouseLookPosition({ x: 1000, y: 500 }, false, windowBounds, undefined), undefined)
  assert.equal(normalizeMouseLookPosition({ x: 0, y: 0 }, true, { x: 0, y: 0, width: 0, height: 100 }, monitorBounds), undefined)
})

test('normalizes an absolute cursor position relative to the pet window', () => {
  assert.deepEqual(normalizeCursorPosition(
    { x: 1250, y: 750 },
    { x: 1000, y: 500, width: 500, height: 500 },
  ), { x: 0.5, y: 0.5 })

  assert.deepEqual(normalizeCursorPosition(
    { x: -960, y: 540 },
    { x: -1920, y: 0, width: 1920, height: 1080 },
  ), { x: 0.5, y: 0.5 })
})

test('clamps cursor positions outside a window spanning a negative monitor', () => {
  assert.deepEqual(normalizeCursorPosition(
    { x: -2200, y: 1400 },
    { x: -1920, y: 0, width: 1920, height: 1080 },
  ), { x: 0, y: 1 })
})

test('uses physical window dimensions for mixed-DPI layouts', () => {
  assert.deepEqual(normalizeCursorPosition(
    { x: 2880, y: 900 },
    { x: 2400, y: 600, width: 960, height: 600 },
  ), { x: 0.5, y: 0.5 })
})

test('applies positive and negative relative movement from the synchronized position', () => {
  assert.deepEqual(
    applyRelativeMouseMovement({ x: 0.5, y: 0.5 }, 24, -48),
    { x: 0.6, y: 0.3 },
  )
})

test('keeps the virtual cursor inside normalized monitor bounds', () => {
  assert.deepEqual(
    applyRelativeMouseMovement({ x: 0.95, y: 0.05 }, 240, -240),
    { x: 1, y: 0 },
  )
})

test('merges relative events before the next animation frame', () => {
  assert.deepEqual(
    mergeRelativeMouseMovement({ dx: 7, dy: -3 }, { dx: -2, dy: 8 }),
    { dx: 5, dy: 5 },
  )
  assert.deepEqual(mergeRelativeMouseMovement(undefined, { dx: 2, dy: 3 }), { dx: 2, dy: 3 })
})
