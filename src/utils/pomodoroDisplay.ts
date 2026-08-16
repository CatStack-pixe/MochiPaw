// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ModelSize } from '@/composables/useModel'

export interface PomodoroWindowLayout {
  model: ModelSize
  timer: {
    height: number
    fontSize: number
  }
  window: ModelSize
}

export interface PomodoroWindowLayoutOptions {
  modelSize: ModelSize
  modelScale: number
  displayEnabled: boolean
  displayScale: number
}

export const POMODORO_DISPLAY_BASE_FONT_SIZE = 24
export const POMODORO_DISPLAY_MIN_FONT_SIZE = 12
export const POMODORO_DISPLAY_VERTICAL_PADDING = 8

export function calculatePomodoroWindowLayout({
  modelSize,
  modelScale,
  displayEnabled,
  displayScale,
}: PomodoroWindowLayoutOptions): PomodoroWindowLayout {
  const scale = Math.max(0, modelScale) / 100
  const relativeDisplayScale = Math.max(0, displayScale) / 100
  const model = {
    width: Math.max(1, Math.round(modelSize.width * scale)),
    height: Math.max(1, Math.round(modelSize.height * scale)),
  }
  const fontSize = displayEnabled
    ? Math.max(POMODORO_DISPLAY_MIN_FONT_SIZE, POMODORO_DISPLAY_BASE_FONT_SIZE * scale * relativeDisplayScale)
    : 0
  const timerHeight = displayEnabled
    ? Math.max(1, Math.ceil(fontSize * 1.2 + POMODORO_DISPLAY_VERTICAL_PADDING * 2))
    : 0

  return {
    model,
    timer: {
      height: timerHeight,
      fontSize,
    },
    window: {
      width: model.width,
      height: model.height + timerHeight,
    },
  }
}

export function formatPomodoroRemaining(remainingMs: number) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
