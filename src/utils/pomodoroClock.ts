// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export type PomodoroPhase = 'work' | 'shortBreak' | 'longBreak'
export type PomodoroStatus = 'idle' | 'running' | 'paused'

export interface PomodoroSettings {
  workMinutes: number
  shortBreakMinutes: number
  longBreakMinutes: number
  longBreakInterval: number
  autoStartBreak: boolean
  autoStartWork: boolean
  soundEnabled: boolean
  notificationsEnabled: boolean
  displayEnabled: boolean
  displayScale: number
}

export interface PomodoroRuntime {
  phase: PomodoroPhase
  status: PomodoroStatus
  endAt: number | null
  pausedRemainingMs: number | null
  completedRounds: number
  completedToday: number
  completedDate: string
  sessionId: string
}

export interface PomodoroTransitionResult {
  completedWork: number
  transitions: PomodoroPhase[]
  completedPhases: PomodoroPhase[]
}

export const DEFAULT_POMODORO_SETTINGS: PomodoroSettings = {
  workMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  longBreakInterval: 4,
  autoStartBreak: true,
  autoStartWork: true,
  soundEnabled: true,
  notificationsEnabled: true,
  displayEnabled: true,
  displayScale: 100,
}

export const INITIAL_POMODORO_RUNTIME: PomodoroRuntime = {
  phase: 'work',
  status: 'idle',
  endAt: null,
  pausedRemainingMs: null,
  completedRounds: 0,
  completedToday: 0,
  completedDate: '',
  sessionId: '',
}

const MIN_MINUTES = 1
const MAX_MINUTES = 120
const MIN_DISPLAY_SCALE = 50
const MAX_DISPLAY_SCALE = 200

export function clampMinutes(value: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback

  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.trunc(value)))
}

export function clampPomodoroDisplayScale(value: number, fallback = DEFAULT_POMODORO_SETTINGS.displayScale) {
  if (!Number.isFinite(value)) return fallback

  return Math.min(MAX_DISPLAY_SCALE, Math.max(MIN_DISPLAY_SCALE, Math.trunc(value)))
}

export function sanitizePomodoroSettings(
  settings: Partial<PomodoroSettings> | undefined,
): PomodoroSettings {
  return {
    workMinutes: clampMinutes(settings?.workMinutes ?? DEFAULT_POMODORO_SETTINGS.workMinutes, DEFAULT_POMODORO_SETTINGS.workMinutes),
    shortBreakMinutes: clampMinutes(settings?.shortBreakMinutes ?? DEFAULT_POMODORO_SETTINGS.shortBreakMinutes, DEFAULT_POMODORO_SETTINGS.shortBreakMinutes),
    longBreakMinutes: clampMinutes(settings?.longBreakMinutes ?? DEFAULT_POMODORO_SETTINGS.longBreakMinutes, DEFAULT_POMODORO_SETTINGS.longBreakMinutes),
    longBreakInterval: Math.min(12, Math.max(1, Math.trunc(settings?.longBreakInterval ?? DEFAULT_POMODORO_SETTINGS.longBreakInterval))),
    autoStartBreak: settings?.autoStartBreak ?? DEFAULT_POMODORO_SETTINGS.autoStartBreak,
    autoStartWork: settings?.autoStartWork ?? DEFAULT_POMODORO_SETTINGS.autoStartWork,
    soundEnabled: settings?.soundEnabled ?? DEFAULT_POMODORO_SETTINGS.soundEnabled,
    notificationsEnabled: settings?.notificationsEnabled ?? DEFAULT_POMODORO_SETTINGS.notificationsEnabled,
    displayEnabled: settings?.displayEnabled ?? DEFAULT_POMODORO_SETTINGS.displayEnabled,
    displayScale: clampPomodoroDisplayScale(settings?.displayScale ?? DEFAULT_POMODORO_SETTINGS.displayScale),
  }
}

export function phaseDurationMs(phase: PomodoroPhase, settings: PomodoroSettings) {
  const minutes = phase === 'work'
    ? settings.workMinutes
    : phase === 'shortBreak' ? settings.shortBreakMinutes : settings.longBreakMinutes

  return clampMinutes(minutes, DEFAULT_POMODORO_SETTINGS.workMinutes) * 60_000
}

export function getRemainingMs(
  runtime: PomodoroRuntime,
  settings: PomodoroSettings,
  now = Date.now(),
) {
  if (runtime.status === 'running' && runtime.endAt != null) {
    return Math.max(0, runtime.endAt - now)
  }

  if (runtime.status === 'paused' && runtime.pausedRemainingMs != null) {
    return Math.max(0, runtime.pausedRemainingMs)
  }

  return phaseDurationMs(runtime.phase, settings)
}

function nextPhase(runtime: PomodoroRuntime, settings: PomodoroSettings): { phase: PomodoroPhase, completedWork: number } {
  if (runtime.phase === 'work') {
    const completedWork = 1
    const phase = (runtime.completedRounds + completedWork) % settings.longBreakInterval === 0 ? 'longBreak' : 'shortBreak'

    return { phase, completedWork }
  }

  return { phase: 'work', completedWork: 0 }
}

export function createSessionId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function startPomodoro(runtime: PomodoroRuntime, settings: PomodoroSettings, now = Date.now()): PomodoroRuntime {
  const remaining = getRemainingMs(runtime, settings, now)

  return {
    ...runtime,
    status: 'running',
    endAt: now + remaining,
    pausedRemainingMs: null,
    sessionId: runtime.sessionId || createSessionId(),
  }
}

export function pausePomodoro(runtime: PomodoroRuntime, settings: PomodoroSettings, now = Date.now()): PomodoroRuntime {
  if (runtime.status !== 'running') return runtime

  return {
    ...runtime,
    status: 'paused',
    endAt: null,
    pausedRemainingMs: getRemainingMs(runtime, settings, now),
  }
}

export function resumePomodoro(runtime: PomodoroRuntime, settings: PomodoroSettings, now = Date.now()) {
  return startPomodoro(runtime, settings, now)
}

export function resetPomodoro(): PomodoroRuntime {
  return {
    ...INITIAL_POMODORO_RUNTIME,
    completedDate: new Date().toISOString().slice(0, 10),
    sessionId: createSessionId(),
  }
}

export function advancePomodoro(
  runtime: PomodoroRuntime,
  settings: PomodoroSettings,
  now = Date.now(),
): { runtime: PomodoroRuntime, result: PomodoroTransitionResult } {
  if (runtime.status !== 'running' || runtime.endAt == null || runtime.endAt > now) {
    return { runtime, result: { completedWork: 0, transitions: [], completedPhases: [] } }
  }

  let next = { ...runtime }
  let cursor = runtime.endAt
  let completedWork = 0
  const transitions: PomodoroPhase[] = []
  const completedPhases: PomodoroPhase[] = []

  while (next.status === 'running' && next.endAt != null && next.endAt <= now) {
    completedPhases.push(next.phase)
    const transition = nextPhase(next, settings)
    const nextEndAt = cursor + phaseDurationMs(transition.phase, settings)

    next = {
      ...next,
      phase: transition.phase,
      completedRounds: next.completedRounds + transition.completedWork,
      endAt: nextEndAt,
      pausedRemainingMs: null,
      sessionId: createSessionId(),
    }
    completedWork += transition.completedWork
    transitions.push(transition.phase)
    cursor = nextEndAt

    const shouldAutoStart = transition.phase === 'work' ? settings.autoStartWork : settings.autoStartBreak

    if (!shouldAutoStart || nextEndAt > now) {
      if (!shouldAutoStart) {
        next.status = 'paused'
        next.endAt = null
        next.pausedRemainingMs = phaseDurationMs(next.phase, settings)
      }
      break
    }
  }

  return { runtime: next, result: { completedWork, transitions, completedPhases } }
}
