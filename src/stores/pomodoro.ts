// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { defineStore } from 'pinia'
import { computed, reactive } from 'vue'

import type {
  PomodoroRuntime,
  PomodoroSettings,
  PomodoroTimelineState,
  PomodoroTransitionResult,
} from '@/utils/pomodoroClock'

import {
  advancePomodoro,
  createSessionId,
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
  return {
    ...INITIAL_POMODORO_RUNTIME,
    completedDate: getPomodoroDateKey(),
    timeline: createTimeline(),
  }
}

function createTimeline(): PomodoroTimelineState {
  return { segments: {}, completed: {} }
}

function normalizeTimeline(value: unknown): PomodoroTimelineState {
  if (!value || typeof value !== 'object') return createTimeline()

  const candidate = value as Partial<PomodoroTimelineState>
  const segments = Object.fromEntries(Object.entries(candidate.segments ?? {}).flatMap(([date, entries]) => {
    if (!Array.isArray(entries)) return []

    const validEntries = entries.filter((entry): entry is PomodoroTimelineState['segments'][string][number] => {
      if (!entry || typeof entry !== 'object') return false

      const item = entry as { id?: unknown, phase?: unknown, startedAt?: unknown, endedAt?: unknown }
      return typeof item.id === 'string'
        && ['work', 'shortBreak', 'longBreak'].includes(item.phase as string)
        && Number.isFinite(item.startedAt)
        && Number.isFinite(item.endedAt)
        && Number(item.endedAt) > Number(item.startedAt)
    })

    return validEntries.length > 0 ? [[date, validEntries]] : []
  }))
  const completed = Object.fromEntries(Object.entries(candidate.completed ?? {}).flatMap(([date, count]) => {
    if (!Number.isFinite(count) || Number(count) < 0) return []

    return [[date, Math.trunc(Number(count))]]
  }))

  return { segments, completed }
}

function pruneTimeline(timeline: PomodoroTimelineState) {
  const dates = new Set([...Object.keys(timeline.segments), ...Object.keys(timeline.completed)].sort())
  const retained = new Set([...dates].slice(-30))

  for (const date of dates) {
    if (!retained.has(date)) {
      delete timeline.segments[date]
      delete timeline.completed[date]
    }
  }
}

export type PomodoroCommand = 'start' | 'pause' | 'resume' | 'reset' | 'skip' | 'update-settings'

export const usePomodoroStore = defineStore('pomodoro', () => {
  const settings = reactive<PomodoroSettings>({ ...DEFAULT_POMODORO_SETTINGS })
  const runtime = reactive<PomodoroRuntime>(cloneRuntime())
  const remainingMs = computed(() => getRemainingMs(runtime, settings))
  const todayCompleted = computed(() => runtime.completedToday)

  function appendTimelineSegment(phase: PomodoroRuntime['phase'], startedAt: number, endedAt: number) {
    if (!(endedAt > startedAt)) return

    let cursor = startedAt
    while (cursor < endedAt) {
      const date = new Date(cursor)
      const dateKey = getPomodoroDateKey(date)
      const nextDate = new Date(date)
      nextDate.setHours(24, 0, 0, 0)
      const segmentEnd = Math.min(endedAt, nextDate.getTime())
      const segments = runtime.timeline.segments[dateKey] ??= []

      segments.push({
        id: createSessionId(),
        phase,
        startedAt: cursor,
        endedAt: segmentEnd,
      })
      cursor = segmentEnd
    }
  }

  function closeRunningTimelineSegment(now: number) {
    if (runtime.status !== 'running' || runtime.phaseStartedAt == null) return

    appendTimelineSegment(runtime.phase, runtime.phaseStartedAt, now)
    runtime.phaseStartedAt = null
  }

  function recordCompletedWork(completedPhases: PomodoroRuntime['phase'][], completionTimes: number[]) {
    completedPhases.forEach((phase, index) => {
      if (phase !== 'work') return

      const dateKey = getPomodoroDateKey(new Date(completionTimes[index] ?? Date.now()))
      runtime.timeline.completed[dateKey] = (runtime.timeline.completed[dateKey] ?? 0) + 1
    })
  }

  function normalizePersistedState() {
    Object.assign(settings, sanitizePomodoroSettings(settings))
    runtime.phase = ['work', 'shortBreak', 'longBreak'].includes(runtime.phase) ? runtime.phase : 'work'
    runtime.status = ['idle', 'running', 'paused'].includes(runtime.status) ? runtime.status : 'idle'
    runtime.endAt = Number.isFinite(runtime.endAt) ? runtime.endAt : null
    runtime.pausedRemainingMs = Number.isFinite(runtime.pausedRemainingMs) ? Math.max(0, runtime.pausedRemainingMs ?? 0) : null
    runtime.phaseStartedAt = Number.isFinite(runtime.phaseStartedAt) ? runtime.phaseStartedAt : null
    runtime.completedRounds = Number.isFinite(runtime.completedRounds) && runtime.completedRounds >= 0 ? Math.trunc(runtime.completedRounds) : 0
    runtime.completedToday = Number.isFinite(runtime.completedToday) && runtime.completedToday >= 0 ? Math.trunc(runtime.completedToday) : 0
    runtime.completedDate ||= getPomodoroDateKey()
    runtime.sessionId ||= `${Date.now()}-${Math.random().toString(36).slice(2)}`
    runtime.timeline = normalizeTimeline(runtime.timeline)
    pruneTimeline(runtime.timeline)

    if (runtime.status === 'running' && runtime.endAt == null) {
      runtime.status = 'paused'
      runtime.pausedRemainingMs = phaseDurationMs(runtime.phase, settings)
    }
  }

  function reconcile(now = Date.now()): PomodoroTransitionResult {
    const today = getPomodoroDateKey(new Date(now))

    if (runtime.completedDate !== today) {
      const todayStart = new Date(now)
      todayStart.setHours(0, 0, 0, 0)
      if (runtime.status === 'running' && runtime.phaseStartedAt != null && runtime.phaseStartedAt < todayStart.getTime()) {
        appendTimelineSegment(runtime.phase, runtime.phaseStartedAt, todayStart.getTime())
        runtime.phaseStartedAt = todayStart.getTime()
      }
      runtime.completedDate = today
      runtime.completedToday = 0
    }

    const previousEndAt = runtime.endAt
    const previousPhaseStartedAt = runtime.phaseStartedAt
    const advanced = advancePomodoro(runtime, settings, now)

    if (advanced.result.completedPhases.length > 0 && previousEndAt != null) {
      let cursor = previousEndAt
      let startedAt = previousPhaseStartedAt ?? Math.max(0, cursor - phaseDurationMs(runtime.phase, settings))
      const completionTimes: number[] = []

      advanced.result.completedPhases.forEach((phase, index) => {
        appendTimelineSegment(phase, startedAt, cursor)
        completionTimes.push(cursor)
        const nextPhase = advanced.result.transitions[index]

        if (nextPhase) {
          startedAt = cursor
          cursor += phaseDurationMs(nextPhase, settings)
        }
      })
      recordCompletedWork(advanced.result.completedPhases, completionTimes)
    }

    Object.assign(runtime, advanced.runtime)

    if (advanced.result.completedWork > 0) {
      runtime.completedToday += advanced.result.completedWork
    }

    pruneTimeline(runtime.timeline)

    return advanced.result
  }

  function execute(
    command: PomodoroCommand,
    now = Date.now(),
  ): PomodoroTransitionResult {
    reconcile(now)

    if (command === 'reset') {
      const completedToday = runtime.completedToday
      const timeline = runtime.timeline
      closeRunningTimelineSegment(now)
      Object.assign(runtime, resetPomodoro())
      runtime.completedDate = getPomodoroDateKey(new Date(now))
      runtime.completedToday = completedToday
      runtime.timeline = timeline
      return { completedWork: 0, transitions: [], completedPhases: [] }
    }

    if (command === 'start') {
      Object.assign(runtime, startPomodoro(runtime, settings, now))
      return { completedWork: 0, transitions: [], completedPhases: [] }
    }

    if (command === 'pause') {
      closeRunningTimelineSegment(now)
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

    const previousStatus = runtime.status
    const previousEndAt = runtime.endAt

    if (command === 'skip') closeRunningTimelineSegment(now)

    if (previousStatus !== 'running') {
      Object.assign(runtime, startPomodoro(runtime, settings, now))
    }

    if (command === 'skip') runtime.phaseStartedAt = now
    runtime.endAt = now
    const result = reconcile(now)

    if (result.transitions.length === 0) {
      runtime.status = previousStatus
      runtime.endAt = previousEndAt
    }

    pruneTimeline(runtime.timeline)

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
