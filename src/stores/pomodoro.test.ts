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

test('records separate timeline segments when pausing and resuming', () => {
  const store = createStore()
  const start = new Date(2026, 0, 2, 10).getTime()

  store.execute('start', start)
  store.execute('pause', start + 10_000)
  store.execute('resume', start + 20_000)
  store.execute('pause', start + 30_000)

  const segments = store.runtime.timeline.segments['2026-01-02']
  assert.equal(segments?.length, 2)
  assert.deepEqual(segments?.map(({ phase, startedAt, endedAt }) => ({ phase, startedAt, endedAt })), [
    { phase: 'work', startedAt: start, endedAt: start + 10_000 },
    { phase: 'work', startedAt: start + 20_000, endedAt: start + 30_000 },
  ])
})

test('records a completed work segment and daily completion on phase transition', () => {
  const store = createStore()
  const start = new Date(2026, 0, 2, 10).getTime()

  store.execute('start', start)
  store.reconcile(start + 25 * 60_000)

  const segments = store.runtime.timeline.segments['2026-01-02']
  assert.deepEqual(segments?.map(({ phase, startedAt, endedAt }) => ({ phase, startedAt, endedAt })), [
    { phase: 'work', startedAt: start, endedAt: start + 25 * 60_000 },
  ])
  assert.equal(store.runtime.timeline.completed['2026-01-02'], 1)
})

test('splits a timeline segment across midnight', () => {
  const store = createStore()
  const start = new Date(2026, 0, 2, 23, 59, 50).getTime()

  store.execute('start', start)
  store.execute('pause', start + 20_000)

  assert.deepEqual(store.runtime.timeline.segments['2026-01-02']?.map(({ startedAt, endedAt }) => ({ startedAt, endedAt })), [
    { startedAt: start, endedAt: start + 10_000 },
  ])
  assert.deepEqual(store.runtime.timeline.segments['2026-01-03']?.map(({ startedAt, endedAt }) => ({ startedAt, endedAt })), [
    { startedAt: start + 10_000, endedAt: start + 20_000 },
  ])
})

test('keeps a partial timeline segment when resetting a running phase', () => {
  const store = createStore()
  const start = new Date(2026, 0, 2, 10).getTime()

  store.execute('start', start)
  store.execute('reset', start + 10_000)

  assert.deepEqual(store.runtime.timeline.segments['2026-01-02']?.map(({ phase, startedAt, endedAt }) => ({ phase, startedAt, endedAt })), [
    { phase: 'work', startedAt: start, endedAt: start + 10_000 },
  ])
  assert.equal(store.todayCompleted, 0)
})

test('prunes timeline entries older than the most recent 30 dates', () => {
  const store = createStore()
  const segments = Object.fromEntries(Array.from({ length: 31 }, (_, index) => {
    const date = new Date(2026, 0, index + 1)
    const dateKey = getPomodoroDateKey(date)
    const startedAt = date.getTime()
    return [dateKey, [{ id: `segment-${index}`, phase: 'work' as const, startedAt, endedAt: startedAt + 1_000 }]]
  }))

  store.runtime.timeline = { segments, completed: Object.fromEntries(Object.keys(segments).map(date => [date, 1])) }
  store.normalizePersistedState()

  assert.equal(Object.keys(store.runtime.timeline.segments).length, 30)
  assert.equal(store.runtime.timeline.segments['2026-01-01'], undefined)
  assert.equal(store.runtime.timeline.segments['2026-01-02']?.[0]?.id, 'segment-1')
  assert.equal(store.runtime.timeline.completed['2026-01-01'], undefined)
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
