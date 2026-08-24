// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import { listen } from '@tauri-apps/api/event'
import { noop } from '@vueuse/core'
import { onMounted, onUnmounted, ref } from 'vue'

import { logError, logInfo } from '@/utils/diagnostics'

export function useTauriListen<T>(...args: Parameters<typeof listen<T>>) {
  const unlisten = ref(noop)
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  onMounted(async () => {
    try {
      unlisten.value = await listen<T>(...args)
      logInfo('[tauri-listen] subscribed', { event: args[0] })
    } catch (error) {
      logError('[tauri-listen] subscription failed', { event: args[0], error })
    } finally {
      resolveReady()
    }
  })

  onUnmounted(() => {
    try {
      unlisten.value()
    } catch (error) {
      logError('[tauri-listen] unsubscribe failed', { event: args[0], error })
    }
  })

  return {
    ready,
  }
}
