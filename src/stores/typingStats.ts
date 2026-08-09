// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import type { DeviceInputEvent } from '@/utils/subModelRuntime'

export interface DailyTypingCount {
  count: number
  date: string
}

const RECENT_DAY_COUNT = 30
const MODIFIER_KEY_PATTERN = /^(?:Shift|Control|Alt|Meta)/
const UNKNOWN_KEY_PATTERN = /^(?:Unknown|Unidentified|RawKey)/i
let persistenceWritable = true
let persistenceHydrated = false
let resolvePersistenceHydrated!: () => void
const persistenceHydratedPromise = new Promise<void>((resolve) => {
  resolvePersistenceHydrated = resolve
})

export function setTypingStatsPersistenceWritable(writable: boolean) {
  persistenceWritable = writable
}

export function markTypingStatsPersistenceHydrated() {
  if (persistenceHydrated) return

  persistenceHydrated = true
  resolvePersistenceHydrated()
}

export function waitForTypingStatsPersistenceHydration() {
  return persistenceHydratedPromise
}

export function getLocalDateKey(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

export function isCountableTypingEvent(event: DeviceInputEvent) {
  if (event.kind !== 'KeyboardPress') return false

  const key = event.value.trim()

  if (!key || MODIFIER_KEY_PATTERN.test(key) || UNKNOWN_KEY_PATTERN.test(key)) return false

  return key !== 'Fn' && key !== 'Function'
}

function getDailyCount(dailyCounts: Record<string, number>, dateKey: string) {
  const count = dailyCounts[dateKey]

  if (!Number.isFinite(count) || count < 0) return 0

  return Math.trunc(count)
}

export function buildRecentDailyCounts(
  dailyCounts: Record<string, number>,
  now: Date,
  dayCount = RECENT_DAY_COUNT,
): DailyTypingCount[] {
  const count = Math.max(0, Math.trunc(dayCount))
  const anchor = new Date(now)

  anchor.setHours(12, 0, 0, 0)

  return Array.from({ length: count }, (_, index) => {
    const date = new Date(anchor)

    date.setDate(anchor.getDate() - (count - index - 1))

    const dateKey = getLocalDateKey(date)

    return {
      count: getDailyCount(dailyCounts, dateKey),
      date: dateKey,
    }
  })
}

export const useTypingStatsStore = defineStore('typingStats', () => {
  const enabled = ref(true)
  const dailyCounts = ref<Record<string, number>>({})
  const currentDateKey = ref(getLocalDateKey(new Date()))

  const todayCount = computed(() => getDailyCount(dailyCounts.value, currentDateKey.value))
  const recent30Days = computed(() => {
    const [year, month, day] = currentDateKey.value.split('-').map(Number)

    return buildRecentDailyCounts(dailyCounts.value, new Date(year, month - 1, day, 12))
  })

  function refreshCurrentDate(now = new Date()) {
    currentDateKey.value = getLocalDateKey(now)
  }

  function recordInput(event: DeviceInputEvent, now = new Date()) {
    if (!enabled.value || !isCountableTypingEvent(event)) return false

    const dateKey = getLocalDateKey(now)
    const count = getDailyCount(dailyCounts.value, dateKey)

    currentDateKey.value = dateKey
    dailyCounts.value[dateKey] = count + 1

    return true
  }

  function clearHistory() {
    dailyCounts.value = {}
  }

  return {
    clearHistory,
    dailyCounts,
    enabled,
    recent30Days,
    recordInput,
    refreshCurrentDate,
    todayCount,
  }
}, {
  tauri: {
    filterKeys: ['enabled', 'dailyCounts'],
    filterKeysStrategy: 'pick',
    hooks: {
      beforeBackendSync: state => persistenceWritable ? state : null,
    },
    saveInterval: 1000,
    saveStrategy: 'throttle',
    syncInterval: 1000,
    syncStrategy: 'throttle',
  },
})
