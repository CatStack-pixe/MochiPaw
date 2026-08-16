import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Vitest is not installed; this test runs through tsx's Node test runner.
import test from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

import { DEFAULT_POMODORO_SETTINGS } from '@/utils/pomodoroClock'

import { getPomodoroDateKey, usePomodoroStore } from './pomodoro'

function createStore() {
  setActivePinia(createPinia())
  return usePomodoroStore()
}

test('starts with a ready work phase and default settings', () => {
  const store = createStore()

  assert.equal(store.runtime.phase, 'work')
  assert.equal(store.runtime.status, 'idle')
  assert.deepEqual(store.settings, DEFAULT_POMODORO_SETTINGS)
})

test('counts a completed work phase once and advances to a break', () => {
  const store = createStore()
  const start = new Date(2026, 0, 2, 10).getTime()

  store.execute('start', start)
  const result = store.reconcile(start + 25 * 60_000)

  assert.equal(result.completedWork, 1)
  assert.equal(store.todayCompleted, 1)
  assert.equal(store.runtime.phase, 'shortBreak')

  store.reconcile(start + 25 * 60_000 + 1_000)
  assert.equal(store.todayCompleted, 1)
})

test('resets today count when reconciling after midnight', () => {
  const store = createStore()
  const firstDay = new Date(2026, 0, 2, 23, 59).getTime()

  store.runtime.completedDate = getPomodoroDateKey(new Date(firstDay))
  store.runtime.completedToday = 3
  store.reconcile(new Date(2026, 0, 3, 0, 1).getTime())

  assert.equal(store.todayCompleted, 0)
  assert.equal(store.runtime.completedDate, '2026-01-03')
})

test('skip advances a paused phase without double counting', () => {
  const store = createStore()
  const now = new Date(2026, 0, 2, 10).getTime()

  store.execute('start', now)
  store.execute('pause', now + 10_000)
  const result = store.execute('skip', now + 20_000)

  assert.equal(result.completedWork, 1)
  assert.equal(store.todayCompleted, 1)
  assert.equal(store.runtime.phase, 'shortBreak')
})

test('reset clears the current session but keeps today completed count', () => {
  const store = createStore()
  const now = new Date(2026, 0, 2, 10).getTime()

  store.execute('start', now)
  store.reconcile(now + 25 * 60_000)
  store.execute('reset', now + 26 * 60_000)

  assert.equal(store.todayCompleted, 1)
  assert.equal(store.runtime.completedRounds, 0)
  assert.equal(store.runtime.phase, 'work')
  assert.equal(store.runtime.status, 'idle')
})

test('allows the user to set today completed count directly', () => {
  const store = createStore()

  store.execute('set-today-completed', Date.now(), { todayCompleted: 7.8 })
  assert.equal(store.todayCompleted, 7)

  store.execute('set-today-completed', Date.now(), { todayCompleted: -1 })
  assert.equal(store.todayCompleted, 0)
})
