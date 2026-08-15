import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'

import {
  advancePomodoro,
  DEFAULT_POMODORO_SETTINGS,
  getRemainingMs,
  INITIAL_POMODORO_RUNTIME,
  pausePomodoro,
  startPomodoro,
} from './pomodoroClock'

const settings = { ...DEFAULT_POMODORO_SETTINGS }

test('starts a work phase with an absolute end time', () => {
  const runtime = startPomodoro({ ...INITIAL_POMODORO_RUNTIME }, settings, 1_000)

  assert.equal(runtime.status, 'running')
  assert.equal(runtime.endAt, 1_501_000)
  assert.equal(getRemainingMs(runtime, settings, 1_000), 1_500_000)
})

test('pauses and resumes without losing elapsed time', () => {
  const running = startPomodoro({ ...INITIAL_POMODORO_RUNTIME }, settings, 1_000)
  const paused = pausePomodoro(running, settings, 31_000)

  assert.equal(paused.status, 'paused')
  assert.equal(paused.pausedRemainingMs, 1_470_000)
  assert.equal(startPomodoro(paused, settings, 100_000).endAt, 1_570_000)
})

test('moves to a short break after one completed work phase', () => {
  const running = startPomodoro({ ...INITIAL_POMODORO_RUNTIME }, settings, 0)
  const { runtime, result } = advancePomodoro(running, settings, 1_500_000)

  assert.deepEqual(result.transitions, ['shortBreak'])
  assert.deepEqual(result.completedPhases, ['work'])
  assert.equal(result.completedWork, 1)
  assert.equal(runtime.phase, 'shortBreak')
  assert.equal(runtime.status, 'running')
  assert.equal(runtime.endAt, 1_800_000)
})

test('uses a long break at the configured interval', () => {
  const running = startPomodoro({
    ...INITIAL_POMODORO_RUNTIME,
    completedRounds: 3,
  }, settings, 0)
  const { runtime, result } = advancePomodoro(running, settings, 1_500_000)

  assert.deepEqual(result.transitions, ['longBreak'])
  assert.deepEqual(result.completedPhases, ['work'])
  assert.equal(runtime.phase, 'longBreak')
})

test('catches up multiple phases after a long sleep', () => {
  const running = startPomodoro({ ...INITIAL_POMODORO_RUNTIME }, settings, 0)
  const { runtime, result } = advancePomodoro(running, settings, 3_600_000)

  assert.equal(result.completedWork, 2)
  assert.equal(result.transitions.length, 4)
  assert.equal(runtime.phase, 'work')
  assert.equal(runtime.status, 'running')
})

test('stops at the next phase when automatic transitions are disabled', () => {
  const running = startPomodoro({ ...INITIAL_POMODORO_RUNTIME }, { ...settings, autoStartBreak: false }, 0)
  const { runtime } = advancePomodoro(running, { ...settings, autoStartBreak: false }, 1_500_000)

  assert.equal(runtime.phase, 'shortBreak')
  assert.equal(runtime.status, 'paused')
  assert.equal(runtime.pausedRemainingMs, 300_000)
})
