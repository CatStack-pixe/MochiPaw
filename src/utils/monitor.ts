// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import type { Monitor, PhysicalPosition } from '@tauri-apps/api/window'

import { cursorPosition, monitorFromPoint } from '@tauri-apps/api/window'

export function getMonitorPoint(cursorPoint: PhysicalPosition) {
  return { x: cursorPoint.x, y: cursorPoint.y }
}

function createCursorMonitor() {
  let cachedMonitor: Monitor | null = null

  return async (cursorPoint?: PhysicalPosition) => {
    cursorPoint ??= await cursorPosition()

    if (cachedMonitor) {
      const { size, position } = cachedMonitor

      const inBounds = cursorPoint.x >= position.x
        && cursorPoint.x < position.x + size.width
        && cursorPoint.y >= position.y
        && cursorPoint.y < position.y + size.height

      if (inBounds) {
        return cachedMonitor
      }
    }

    // Both APIs use global physical coordinates. Converting with the current
    // window's scale factor selects the wrong monitor on mixed-DPI setups.
    const { x, y } = getMonitorPoint(cursorPoint)

    cachedMonitor = await monitorFromPoint(x, y)

    return cachedMonitor
  }
}

export const getCursorMonitor = createCursorMonitor()
