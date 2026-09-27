// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import { listen } from '@tauri-apps/api/event'
import { onMounted, onUnmounted } from 'vue'

import { logError, logInfo } from '@/utils/diagnostics'

export function useTauriListen<T>(...args: Parameters<typeof listen<T>>) {
  let unlisten: (() => void) | undefined
  let disposed = false
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  async function stopListening(stop: () => void) {
    try {
      // Tauri's unlisten callback is typed as void but returns an IPC promise.
      await stop()
    } catch (error) {
      logError('[tauri-listen] unsubscribe failed', { event: args[0], error })
    }
  }

  onMounted(async () => {
    try {
      const stop = await listen<T>(args[0], (event) => {
        if (!disposed) args[1](event)
      }, args[2])
      if (disposed) {
        await stopListening(stop)
      } else {
        unlisten = stop
        logInfo('[tauri-listen] subscribed', { event: args[0] })
      }
    } catch (error) {
      logError('[tauri-listen] subscription failed', { event: args[0], error })
    } finally {
      resolveReady()
    }
  })

  onUnmounted(() => {
    disposed = true
    const stop = unlisten
    unlisten = undefined
    if (stop) void stopListening(stop)
  })

  return {
    ready,
  }
}
