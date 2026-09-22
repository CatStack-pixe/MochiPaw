// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import type { Event } from '@tauri-apps/api/event'

import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import { getCurrentWebviewWindow, WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { availableMonitors } from '@tauri-apps/api/window'
import { isNumber } from 'es-toolkit/compat'
import { onMounted, onUnmounted, ref } from 'vue'

import { WINDOW_LABEL } from '@/constants'
import { useAppStore } from '@/stores/app'
import { logError, logInfo } from '@/utils/diagnostics'
import { getCursorMonitor } from '@/utils/monitor'
import { withTimeout } from '@/utils/promise'
import { getWindowRecoveryPosition } from '@/utils/windowPosition'

export type WindowState = Record<string, Partial<PhysicalPosition & PhysicalSize> | undefined>

const appWindow = getCurrentWebviewWindow()
const { label } = appWindow
const WINDOW_STATE_OPERATION_TIMEOUT_MS = 5_000

async function runWindowStateOperation<T>(operation: string, action: () => Promise<T>) {
  try {
    return await withTimeout(
      action(),
      WINDOW_STATE_OPERATION_TIMEOUT_MS,
      `Window state ${operation} timed out.`,
    )
  } catch (error) {
    logError('[window-state] restore operation failed', {
      windowLabel: label,
      operation,
      error,
    })
    return undefined
  }
}

export async function returnMainWindowToScreen() {
  const mainWindow = await WebviewWindow.getByLabel(WINDOW_LABEL.MAIN)
  const monitor = await getCursorMonitor()

  if (!mainWindow || !monitor) return

  const [windowPosition, windowSize] = await Promise.all([
    mainWindow.outerPosition(),
    mainWindow.outerSize(),
  ])
  const { position, size } = monitor
  const nextPosition = getWindowRecoveryPosition(
    'manual',
    windowPosition,
    windowSize,
    { x: position.x, y: position.y, width: size.width, height: size.height },
  )

  if (!nextPosition) return

  if (nextPosition.x === windowPosition.x && nextPosition.y === windowPosition.y) return

  await mainWindow.setPosition(new PhysicalPosition(nextPosition.x, nextPosition.y))
}

export function useWindowState(options: { enabled?: boolean } = {}) {
  const appStore = useAppStore()
  const isRestored = ref(false)
  const enabled = options.enabled ?? true
  let disposed = false
  const windowListeners: Array<() => void> = []

  const stopWindowListener = async (unlisten: () => void) => {
    try {
      await unlisten()
    } catch (error) {
      logError('[window-state] listener cleanup failed', { windowLabel: label, error })
    }
  }

  const trackWindowListener = (registration: Promise<() => void>) => {
    void registration.then((unlisten) => {
      if (disposed) void stopWindowListener(unlisten)
      else windowListeners.push(unlisten)
    }).catch((error) => {
      logError('[window-state] listener registration failed', { windowLabel: label, error })
    })
  }

  onMounted(() => {
    if (!enabled) return

    trackWindowListener(appWindow.onMoved(onChange))
    trackWindowListener(appWindow.onResized(onChange))
  })

  onUnmounted(() => {
    disposed = true
    for (const unlisten of windowListeners) void stopWindowListener(unlisten)
    windowListeners.length = 0
  })

  const onChange = async (event: Event<PhysicalPosition | PhysicalSize>) => {
    if (disposed) return
    const minimized = await appWindow.isMinimized()

    if (disposed || minimized) return

    appStore.windowState[label] ??= {}

    Object.assign(appStore.windowState[label], event.payload)
  }

  const restoreState = async () => {
    if (!enabled) {
      isRestored.value = true
      return
    }

    const { x, y, width, height } = appStore.windowState[label] ?? {}

    logInfo('[window-state] restore started', {
      windowLabel: label,
      hasPosition: isNumber(x) && isNumber(y),
      hasSize: isNumber(width) && isNumber(height),
    })

    try {
      if (isNumber(x) && isNumber(y)) {
        const monitors = await runWindowStateOperation('list monitors', availableMonitors)

        const monitor = monitors?.find((monitor) => {
          const { position, size } = monitor

          const inBoundsX = x >= position.x && x <= position.x + size.width
          const inBoundsY = y >= position.y && y <= position.y + size.height

          return inBoundsX && inBoundsY
        })

        if (monitor) {
          await runWindowStateOperation(
            'set position',
            () => appWindow.setPosition(new PhysicalPosition(x, y)),
          )
        }
      }

      if (isNumber(width) && isNumber(height) && width > 0 && height > 0) {
        await runWindowStateOperation(
          'set size',
          () => appWindow.setSize(new PhysicalSize(width, height)),
        )
      }
    } catch (error) {
      logError('[window-state] restore failed', { windowLabel: label, error })
    } finally {
      // A failed restore must not keep the RouterView, and therefore the model
      // renderer and cross-window listeners, permanently unmounted.
      isRestored.value = true
      logInfo('[window-state] restore completed', { windowLabel: label })
    }
  }

  return {
    isRestored,
    restoreState,
  }
}
