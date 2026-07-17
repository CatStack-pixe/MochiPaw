// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import type { Event } from '@tauri-apps/api/event'

import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import { getCurrentWebviewWindow, WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { availableMonitors } from '@tauri-apps/api/window'
import { isNumber } from 'es-toolkit/compat'
import { onMounted, ref } from 'vue'

import { WINDOW_LABEL } from '@/constants'
import { useAppStore } from '@/stores/app'
import { getCursorMonitor } from '@/utils/monitor'
import { getWindowRecoveryPosition } from '@/utils/windowPosition'

export type WindowState = Record<string, Partial<PhysicalPosition & PhysicalSize> | undefined>

const appWindow = getCurrentWebviewWindow()
const { label } = appWindow

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

export function useWindowState() {
  const appStore = useAppStore()
  const isRestored = ref(false)

  onMounted(() => {
    appWindow.onMoved(onChange)

    appWindow.onResized(onChange)
  })

  const onChange = async (event: Event<PhysicalPosition | PhysicalSize>) => {
    const minimized = await appWindow.isMinimized()

    if (minimized) return

    appStore.windowState[label] ??= {}

    Object.assign(appStore.windowState[label], event.payload)
  }

  const restoreState = async () => {
    const { x, y, width, height } = appStore.windowState[label] ?? {}

    if (isNumber(x) && isNumber(y)) {
      const monitors = await availableMonitors()

      const monitor = monitors.find((monitor) => {
        const { position, size } = monitor

        const inBoundsX = x >= position.x && x <= position.x + size.width
        const inBoundsY = y >= position.y && y <= position.y + size.height

        return inBoundsX && inBoundsY
      })

      if (monitor) {
        await appWindow.setPosition(new PhysicalPosition(x, y))
      }
    }

    if (width && height) {
      await appWindow.setSize(new PhysicalSize(width, height))
    }

    isRestored.value = true
  }

  return {
    isRestored,
    restoreState,
  }
}
