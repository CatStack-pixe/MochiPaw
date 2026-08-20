// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import { resolveEffectiveMaxFPS } from './renderFPS'

test('game mode preserves the configured maximum FPS', () => {
  for (const fps of [30, 60, 90, 120]) {
    assert.equal(resolveEffectiveMaxFPS(fps, true), fps)
  }
})

test('normal mode preserves the configured maximum FPS', () => {
  assert.equal(resolveEffectiveMaxFPS(60, false), 60)
})
