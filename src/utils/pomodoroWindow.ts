// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { WebviewWindow } from '@tauri-apps/api/webviewWindow'

import { WINDOW_LABEL } from '@/constants'

export async function openPomodoroWindow() {
  const window = await WebviewWindow.getByLabel(WINDOW_LABEL.POMODORO)

  if (!window) return

  await window.show()
  await window.setFocus()
}
