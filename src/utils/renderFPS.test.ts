// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import { resolveEffectiveMaxFPS, resolveOverlayRenderFPS } from './renderFPS'

test('game mode preserves the configured maximum FPS', () => {
  for (const fps of [30, 60, 90, 120]) {
    assert.equal(resolveEffectiveMaxFPS(fps, true), fps)
  }
})

test('normal mode preserves the configured maximum FPS', () => {
  assert.equal(resolveEffectiveMaxFPS(60, false), 60)
})

test('overlay pacing caps rendering to the selected target when game mode is active', () => {
  assert.equal(resolveOverlayRenderFPS(144, true, true, 120), 120)
  assert.equal(resolveOverlayRenderFPS(144, true, true, 90), 90)
  assert.equal(resolveOverlayRenderFPS(60, true, true, 120), 60)
})

test('overlay pacing is inactive unless explicitly enabled', () => {
  assert.equal(resolveOverlayRenderFPS(144, false, true, 60), 144)
  assert.equal(resolveOverlayRenderFPS(144, true, false, 60), 144)
})
