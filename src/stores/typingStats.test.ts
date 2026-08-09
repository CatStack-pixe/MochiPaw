import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

import type { DeviceInputEvent } from '@/utils/subModelRuntime'

import {
  buildRecentDailyCounts,
  getLocalDateKey,
  isCountableTypingEvent,
  useTypingStatsStore,
} from './typingStats'

function keyboardPress(value: string): DeviceInputEvent {
  return { kind: 'KeyboardPress', value }
}

function createStore() {
  setActivePinia(createPinia())
  return useTypingStatsStore()
}

test('ignores modifiers, unknown keys, and empty keyboard presses', () => {
  for (const key of [
    '',
    '   ',
    'ShiftLeft',
    'ControlRight',
    'AltGr',
    'MetaLeft',
    'Fn',
    'Function',
    'Unknown(123)',
    'RawKey(456)',
    'Unidentified',
  ]) {
    assert.equal(isCountableTypingEvent(keyboardPress(key)), false, key)
  }
})

test('counts text and non-modifier control keys', () => {
  for (const key of ['KeyA', 'Return', 'Backspace', 'UpArrow', 'F1', 'CapsLock']) {
    assert.equal(isCountableTypingEvent(keyboardPress(key)), true, key)
  }
})

test('ignores keyboard releases and mouse events', () => {
  assert.equal(isCountableTypingEvent({ kind: 'KeyboardRelease', value: 'KeyA' }), false)
  assert.equal(isCountableTypingEvent({ kind: 'MousePress', value: 'Left' }), false)
  assert.equal(isCountableTypingEvent({ kind: 'MouseMove', value: { x: 1, y: 2 } }), false)
})

test('records each repeated press and pauses while disabled', () => {
  const store = createStore()
  const now = new Date(2026, 0, 31, 23, 59)

  assert.equal(store.recordInput(keyboardPress('KeyA'), now), true)
  assert.equal(store.recordInput(keyboardPress('KeyA'), now), true)
  assert.equal(store.todayCount, 2)

  store.enabled = false

  assert.equal(store.recordInput(keyboardPress('KeyA'), now), false)
  assert.equal(store.todayCount, 2)
})

test('archives presses using the local date across midnight', () => {
  const store = createStore()
  const beforeMidnight = new Date(2026, 0, 31, 23, 59, 59)
  const afterMidnight = new Date(2026, 1, 1, 0, 0, 1)

  store.recordInput(keyboardPress('Return'), beforeMidnight)
  store.recordInput(keyboardPress('Backspace'), afterMidnight)

  assert.deepEqual(store.dailyCounts, {
    '2026-01-31': 1,
    '2026-02-01': 1,
  })
  assert.equal(store.todayCount, 1)
})

test('builds an ordered recent series and fills missing dates with zero', () => {
  const series = buildRecentDailyCounts({
    '2026-02-01': 4,
    '2026-02-03': 7,
  }, new Date(2026, 1, 3, 18), 4)

  assert.deepEqual(series, [
    { count: 0, date: '2026-01-31' },
    { count: 4, date: '2026-02-01' },
    { count: 0, date: '2026-02-02' },
    { count: 7, date: '2026-02-03' },
  ])
})

test('exposes 30 recent days and refreshes the current day without input', () => {
  const store = createStore()

  store.dailyCounts = {
    '2026-04-10': 3,
    '2026-04-11': 8,
  }
  store.refreshCurrentDate(new Date(2026, 3, 10, 23, 59))

  assert.equal(store.recent30Days.length, 30)
  assert.equal(store.todayCount, 3)

  store.refreshCurrentDate(new Date(2026, 3, 11, 0, 0))

  assert.equal(store.todayCount, 8)
  assert.equal(store.recent30Days.at(-1)?.date, '2026-04-11')
})

test('clears history without changing the enabled preference', () => {
  const store = createStore()

  store.enabled = false
  store.dailyCounts = { '2026-01-01': 12 }
  store.clearHistory()

  assert.deepEqual(store.dailyCounts, {})
  assert.equal(store.enabled, false)
})

test('initializes new users with privacy-preserving defaults', () => {
  const store = createStore()

  store.$patch({})

  assert.deepEqual(store.$state, {
    dailyCounts: {},
    enabled: true,
  })
  assert.equal(getLocalDateKey(new Date(2026, 0, 2)), '2026-01-02')

  store.recordInput(keyboardPress('KeySecret'), new Date(2026, 0, 2, 12))

  assert.deepEqual(store.$state, {
    dailyCounts: { '2026-01-02': 1 },
    enabled: true,
  })
  assert.equal(JSON.stringify(store.$state).includes('KeySecret'), false)
})
