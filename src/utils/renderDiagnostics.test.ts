// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import type { RenderDiagnosticsSnapshot } from './renderDiagnostics'

import { RenderDiagnostics } from './renderDiagnostics'

test('aggregates actual FPS once per report interval', () => {
  let now = 0
  const reports: RenderDiagnosticsSnapshot[] = []
  const diagnostics = new RenderDiagnostics({
    targetFPS: 60,
    now: () => now,
    onReport: snapshot => reports.push(snapshot),
  })

  diagnostics.start()
  for (let index = 0; index < 60; index += 1) {
    now += 16.67
    diagnostics.recordFrame(16.67)
  }

  assert.equal(reports.length, 1)
  assert.equal(reports[0].frameCount, 60)
  assert.equal(Math.round(reports[0].actualFPS), 60)
  assert.equal(reports[0].longFrameCount, 0)
  assert.equal(reports[0].targetFPS, 60)
  assert.ok(Math.abs(reports[0].averageObservedDeltaMS - 16.67) < 0.01)
  assert.ok(Math.abs(reports[0].maxObservedDeltaMS - 16.67) < 0.01)
})

test('records long frames and normalizes invalid deltas', () => {
  let now = 0
  const reports: RenderDiagnosticsSnapshot[] = []
  const diagnostics = new RenderDiagnostics({
    targetFPS: 60,
    now: () => now,
    onReport: snapshot => reports.push(snapshot),
  })

  diagnostics.start()
  diagnostics.recordFrame(Number.NaN)
  diagnostics.recordFrame(-1)
  now = 1_000
  diagnostics.recordFrame(120)

  assert.equal(reports.length, 1)
  assert.equal(reports[0].frameCount, 3)
  assert.equal(reports[0].longFrameCount, 1)
  assert.equal(reports[0].minDeltaMS, 0)
  assert.equal(reports[0].maxDeltaMS, 120)
  assert.equal(reports[0].averageDeltaMS, 40)
  assert.equal(reports[0].maxObservedDeltaMS, 1_000)
})
