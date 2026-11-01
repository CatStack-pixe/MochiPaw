// SPDX-FileCopyrightText: 2026 InfinityCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Node's built-in test runner is used.
import test from 'node:test'

import { clampOverlayRefreshRate, isOverlayFrameDue, resolveOverlayFPS } from './overlay'

test('clamps invalid and extreme display refresh rates', () => {
  assert.equal(clampOverlayRefreshRate(undefined), 60)
  assert.equal(clampOverlayRefreshRate(30), 30)
  assert.equal(clampOverlayRefreshRate(144), 144)
  assert.equal(clampOverlayRefreshRate(1000), 240)
})

test('never exceeds the selected overlay target', () => {
  assert.equal(resolveOverlayFPS(120, 60), 60)
  assert.equal(resolveOverlayFPS(90, 60), 60)
  assert.equal(resolveOverlayFPS(60, 144), 60)
})

test('allows the first frame and throttles subsequent frames', () => {
  assert.equal(isOverlayFrameDue(undefined, 0, 120), true)
  assert.equal(isOverlayFrameDue(0, 4, 120), false)
  assert.equal(isOverlayFrameDue(0, 9, 120), true)
})
