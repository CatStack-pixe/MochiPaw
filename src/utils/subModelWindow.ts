// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { emitTo } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'

import type { SubModelInstance } from '@/stores/model'

import { LISTEN_KEY } from '@/constants'

const SUB_MODEL_WINDOW_PREFIX = 'sub-model-'
const DEFAULT_SIZE = 300

export function getSubModelWindowLabel(instanceId: string) {
  return `${SUB_MODEL_WINDOW_PREFIX}${instanceId}`
}

export async function openSubModelWindow(instance: SubModelInstance) {
  const label = getSubModelWindowLabel(instance.id)
  const existingWindow = await WebviewWindow.getByLabel(label)

  if (existingWindow) {
    await existingWindow.show()
    await emitTo(label, LISTEN_KEY.SET_SUB_MODEL_RENDERING, true)
    await existingWindow.setFocus()
    return existingWindow
  }

  const window = new WebviewWindow(label, {
    url: `index.html/#/sub-model?instance=${encodeURIComponent(instance.id)}`,
    title: 'MochiPaw',
    width: DEFAULT_SIZE,
    height: DEFAULT_SIZE,
    x: instance.window.x,
    y: instance.window.y,
    shadow: false,
    transparent: true,
    decorations: false,
    alwaysOnTop: instance.window.alwaysOnTop,
    skipTaskbar: true,
    maximizable: false,
    visible: false,
  })

  await waitForWindowCreation(window)
  await window.show()

  return window
}

export async function hideSubModelWindow(instanceId: string) {
  const label = getSubModelWindowLabel(instanceId)
  const window = await WebviewWindow.getByLabel(label)

  await emitTo(label, LISTEN_KEY.SET_SUB_MODEL_RENDERING, false)
  await window?.hide()
}

export async function destroySubModelWindow(instanceId: string) {
  const window = await WebviewWindow.getByLabel(getSubModelWindowLabel(instanceId))

  await window?.destroy()
}

async function waitForWindowCreation(window: WebviewWindow) {
  return new Promise<void>((resolve, reject) => {
    void window.once('tauri://created', () => resolve())
    void window.once<string>('tauri://error', ({ payload }) => reject(new Error(payload)))
  })
}
