// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { defineStore } from 'pinia'
import { computed, reactive } from 'vue'

import type {
  PomodoroRuntime,
  PomodoroSettings,
  PomodoroTransitionResult,
} from '@/utils/pomodoroClock'

import {
  advancePomodoro,
  DEFAULT_POMODORO_SETTINGS,
  getRemainingMs,
  INITIAL_POMODORO_RUNTIME,
  pausePomodoro,
  phaseDurationMs,
  resetPomodoro,
  resumePomodoro,
  sanitizePomodoroSettings,
  startPomodoro,
} from '@/utils/pomodoroClock'

let persistenceWritable = true

export function setPomodoroPersistenceWritable(writable: boolean) {
  persistenceWritable = writable
}

export function getPomodoroDateKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

function cloneRuntime(): PomodoroRuntime {
  return { ...INITIAL_POMODORO_RUNTIME, completedDate: getPomodoroDateKey() }
}

export type PomodoroCommand = 'start' | 'pause' | 'resume' | 'reset' | 'skip' | 'update-settings' | 'set-today-completed'

export const usePomodoroStore = defineStore('pomodoro', () => {
  const settings = reactive<PomodoroSettings>({ ...DEFAULT_POMODORO_SETTINGS })
  const runtime = reactive<PomodoroRuntime>(cloneRuntime())
  const remainingMs = computed(() => getRemainingMs(runtime, settings))
  const todayCompleted = computed(() => runtime.completedToday)

  function normalizePersistedState() {
    Object.assign(settings, sanitizePomodoroSettings(settings))
    runtime.phase = ['work', 'shortBreak', 'longBreak'].includes(runtime.phase) ? runtime.phase : 'work'
    runtime.status = ['idle', 'running', 'paused'].includes(runtime.status) ? runtime.status : 'idle'
    runtime.endAt = Number.isFinite(runtime.endAt) ? runtime.endAt : null
    runtime.pausedRemainingMs = Number.isFinite(runtime.pausedRemainingMs) ? Math.max(0, runtime.pausedRemainingMs ?? 0) : null
    runtime.completedRounds = Number.isFinite(runtime.completedRounds) && runtime.completedRounds >= 0 ? Math.trunc(runtime.completedRounds) : 0
    runtime.completedToday = Number.isFinite(runtime.completedToday) && runtime.completedToday >= 0 ? Math.trunc(runtime.completedToday) : 0
    runtime.completedDate ||= getPomodoroDateKey()
    runtime.sessionId ||= `${Date.now()}-${Math.random().toString(36).slice(2)}`

    if (runtime.status === 'running' && runtime.endAt == null) {
      runtime.status = 'paused'
      runtime.pausedRemainingMs = phaseDurationMs(runtime.phase, settings)
    }
  }

  function reconcile(now = Date.now()): PomodoroTransitionResult {
    const today = getPomodoroDateKey(new Date(now))

    if (runtime.completedDate !== today) {
      runtime.completedDate = today
      runtime.completedToday = 0
    }

    const advanced = advancePomodoro(runtime, settings, now)

    Object.assign(runtime, advanced.runtime)

    if (advanced.result.completedWork > 0) {
      runtime.completedToday += advanced.result.completedWork
    }

    return advanced.result
  }

  function execute(
    command: PomodoroCommand,
    now = Date.now(),
    options: { todayCompleted?: number } = {},
  ): PomodoroTransitionResult {
    reconcile(now)

    if (command === 'reset') {
      const completedToday = runtime.completedToday
      Object.assign(runtime, resetPomodoro())
      runtime.completedDate = getPomodoroDateKey(new Date(now))
      runtime.completedToday = completedToday
      return { completedWork: 0, transitions: [], completedPhases: [] }
    }

    if (command === 'start') {
      Object.assign(runtime, startPomodoro(runtime, settings, now))
      return { completedWork: 0, transitions: [], completedPhases: [] }
    }

    if (command === 'pause') {
      Object.assign(runtime, pausePomodoro(runtime, settings, now))
      return { completedWork: 0, transitions: [], completedPhases: [] }
    }

    if (command === 'resume') {
      Object.assign(runtime, resumePomodoro(runtime, settings, now))
      return { completedWork: 0, transitions: [], completedPhases: [] }
    }

    if (command === 'update-settings') {
      Object.assign(settings, sanitizePomodoroSettings(settings))
      return { completedWork: 0, transitions: [], completedPhases: [] }
    }

    if (command === 'set-today-completed') {
      runtime.completedToday = Number.isFinite(options.todayCompleted)
        ? Math.max(0, Math.trunc(options.todayCompleted!))
        : runtime.completedToday
      return { completedWork: 0, transitions: [], completedPhases: [] }
    }

    const previousStatus = runtime.status
    const previousEndAt = runtime.endAt

    if (previousStatus !== 'running') {
      Object.assign(runtime, startPomodoro(runtime, settings, now))
    }

    runtime.endAt = now
    const result = reconcile(now)

    if (result.transitions.length === 0) {
      runtime.status = previousStatus
      runtime.endAt = previousEndAt
    }

    return result
  }

  return {
    execute,
    getRemainingMs: (now = Date.now()) => getRemainingMs(runtime, settings, now),
    normalizePersistedState,
    reconcile,
    remainingMs,
    runtime,
    settings,
    todayCompleted,
  }
}, {
  tauri: {
    filterKeys: ['settings', 'runtime'],
    filterKeysStrategy: 'pick',
    hooks: {
      beforeBackendSync: state => persistenceWritable ? state : null,
    },
    saveInterval: 500,
    saveStrategy: 'throttle',
    syncInterval: 500,
    syncStrategy: 'throttle',
  },
})
