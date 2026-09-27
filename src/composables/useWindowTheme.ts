// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Ref } from 'vue'

import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { onMounted, onUnmounted, watch } from 'vue'

import { WINDOW_LABEL } from '@/constants'
import { useGeneralStore } from '@/stores/general'
import { logError } from '@/utils/diagnostics'

/** Theme tracking stays alive when preferences and their settings tabs close. */
export function useWindowTheme(ready: Readonly<Ref<boolean>>) {
  const appWindow = getCurrentWebviewWindow()
  const generalStore = useGeneralStore()
  const ownsAppearance = appWindow.label === WINDOW_LABEL.MAIN
  let unlisten: (() => void) | undefined
  let disposed = false
  let generation = 0

  onMounted(async () => {
    const stop = await appWindow.onThemeChanged(({ payload }) => {
      if (ownsAppearance && ready.value && generalStore.appearance.theme === 'auto') {
        generalStore.appearance.isDark = payload === 'dark'
      }
    })
    if (disposed) stop()
    else unlisten = stop
  })

  watch([ready, () => generalStore.appearance.theme], async ([initialized, theme]) => {
    if (!initialized) return
    const request = ++generation
    try {
      const selectedTheme = theme === 'auto' ? null : theme
      await appWindow.setTheme(selectedTheme)
      const resolved = selectedTheme ?? await appWindow.theme()
      if (ownsAppearance && !disposed && request === generation) {
        generalStore.appearance.isDark = resolved === 'dark'
      }
    } catch (error) {
      logError('[window-theme] theme update failed', { error })
    }
  }, { immediate: true })

  watch(() => generalStore.appearance.isDark, (dark) => {
    document.documentElement.classList.toggle('dark', dark)
  }, { immediate: true })

  onUnmounted(() => {
    disposed = true
    unlisten?.()
  })
}
