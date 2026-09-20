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
  normalizeRelativeMouseSensitivity,
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

test('halves the previous relative response by default on both axes', () => {
  assert.deepEqual(
    applyRelativeMouseMovement({ x: 0.5, y: 0.5 }, 24, -48),
    { x: 0.55, y: 0.4 },
  )
})

test('supports custom multipliers and restores the previous response at 1x', () => {
  const position = { x: 0.5, y: 0.5 }
  assert.deepEqual(applyRelativeMouseMovement(position, 24, -48, 1), { x: 0.6, y: 0.3 })
  assert.deepEqual(applyRelativeMouseMovement(position, 24, -48, 0.25), { x: 0.525, y: 0.45 })
  const doubled = applyRelativeMouseMovement(position, 24, -48, 2)
  assert.ok(Math.abs(doubled.x - 0.7) < 1e-12)
  assert.ok(Math.abs(doubled.y - 0.1) < 1e-12)
  assert.deepEqual(applyRelativeMouseMovement(position, 24, -48, 0), position)
  assert.deepEqual(position, { x: 0.5, y: 0.5 })
})

test('normalizes missing, malformed and out-of-range persisted multipliers', () => {
  for (const value of [undefined, null, '1', true, {}, Number.NaN, Infinity, -Infinity]) {
    assert.equal(normalizeRelativeMouseSensitivity(value), 0.5)
  }
  assert.equal(normalizeRelativeMouseSensitivity(-1), 0)
  assert.equal(normalizeRelativeMouseSensitivity(6), 5)
  for (const value of [0, 0.25, 0.5, 1, 2, 5]) {
    assert.equal(normalizeRelativeMouseSensitivity(value), value)
  }
  assert.deepEqual(
    applyRelativeMouseMovement({ x: 0.5, y: 0.5 }, 24, -48, Number.NaN),
    { x: 0.55, y: 0.4 },
  )
})

test('scales movement before clamping and retains the full range at half sensitivity', () => {
  const position = applyRelativeMouseMovement({ x: 0.5, y: 0.5 }, 192, -192)
  assert.ok(Math.abs(position.x - 0.9) < 1e-12)
  assert.ok(Math.abs(position.y - 0.1) < 1e-12)
  assert.deepEqual(
    applyRelativeMouseMovement({ x: 0.5, y: 0.5 }, 240, -240),
    { x: 1, y: 0 },
  )
})

test('resumes absolute menu tracking independently of the relative multiplier', () => {
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 }
  const menuPosition = normalizeMouseLookPosition({ x: 960, y: 540 }, false, undefined, bounds)!
  assert.deepEqual(applyRelativeMouseMovement(menuPosition, 48, -48), { x: 0.6, y: 0.4 })
  assert.deepEqual(
    normalizeMouseLookPosition({ x: 1440, y: 270 }, false, undefined, bounds),
    { x: 0.75, y: 0.25 },
  )
})

test('applies the multiplier once to a frame of accumulated raw movement', () => {
  const movement = mergeRelativeMouseMovement({ dx: 12, dy: -24 }, { dx: 12, dy: -24 })
  assert.deepEqual(
    applyRelativeMouseMovement({ x: 0.5, y: 0.5 }, movement.dx, movement.dy, 0.5),
    { x: 0.55, y: 0.4 },
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
