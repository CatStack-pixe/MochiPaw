// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import { defineStore } from 'pinia'
import { ref } from 'vue'

export type HotKey
  = | 'visibleCat'
    | 'mirrorMode'
    | 'penetrable'
    | 'alwaysOnTop'
    | 'gameMode'
    | 'pomodoroStart'
    | 'pomodoroPause'
    | 'pomodoroResume'
    | 'pomodoroReset'

export const useShortcutStore = defineStore('shortcut', () => {
  const visibleCat = ref('')
  const visiblePreference = ref('')
  const mirrorMode = ref('')
  const penetrable = ref('')
  const alwaysOnTop = ref('')
  const gameMode = ref('Ctrl+Shift+G')
  const pomodoroStart = ref('')
  const pomodoroPause = ref('')
  const pomodoroResume = ref('')
  const pomodoroReset = ref('')

  return {
    visibleCat,
    visiblePreference,
    mirrorMode,
    penetrable,
    alwaysOnTop,
    gameMode,
    pomodoroStart,
    pomodoroPause,
    pomodoroResume,
    pomodoroReset,
  }
})
