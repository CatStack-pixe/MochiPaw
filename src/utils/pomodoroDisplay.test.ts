import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import {
  DEFAULT_POMODORO_SETTINGS,
  getRemainingMs,
  INITIAL_POMODORO_RUNTIME,
} from './pomodoroClock'
import {
  calculatePomodoroWindowLayout,
  formatPomodoroRemaining,
} from './pomodoroDisplay'

const modelSize = { width: 400, height: 600 }

test('formats countdown values with minute carry and zero padding', () => {
  assert.equal(formatPomodoroRemaining(0), '00:00')
  assert.equal(formatPomodoroRemaining(60_000), '01:00')
  assert.equal(formatPomodoroRemaining(61_001), '01:02')
})

test('formats each Pomodoro phase from its current remaining duration', () => {
  const phases = [
    ['work', '25:00'],
    ['shortBreak', '05:00'],
    ['longBreak', '15:00'],
  ] as const

  for (const [phase, expected] of phases) {
    const remaining = getRemainingMs({ ...INITIAL_POMODORO_RUNTIME, phase }, DEFAULT_POMODORO_SETTINGS)
    assert.equal(formatPomodoroRemaining(remaining), expected)
  }
})

test('keeps the model aspect ratio while adding an independent timer area', () => {
  const layout = calculatePomodoroWindowLayout({
    modelSize,
    modelScale: 150,
    displayEnabled: true,
    displayScale: 100,
  })

  assert.deepEqual(layout.model, { width: 600, height: 900 })
  assert.equal(layout.model.width / layout.model.height, modelSize.width / modelSize.height)
  assert.equal(layout.timer.fontSize, 36)
  assert.equal(layout.window.height, layout.model.height + layout.timer.height)
})

test('display scale only changes the timer area', () => {
  const normal = calculatePomodoroWindowLayout({ modelSize, modelScale: 100, displayEnabled: true, displayScale: 100 })
  const larger = calculatePomodoroWindowLayout({ modelSize, modelScale: 100, displayEnabled: true, displayScale: 200 })

  assert.deepEqual(larger.model, normal.model)
  assert.ok(larger.timer.fontSize > normal.timer.fontSize)
  assert.ok(larger.timer.height > normal.timer.height)
})

test('disabled display restores the model-only window size', () => {
  const layout = calculatePomodoroWindowLayout({ modelSize, modelScale: 100, displayEnabled: false, displayScale: 200 })

  assert.equal(layout.timer.height, 0)
  assert.deepEqual(layout.window, layout.model)
})
