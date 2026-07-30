// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { PhysicalPosition } from '@tauri-apps/api/dpi'
import { emitTo, listen } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { toRaw } from 'vue'

import type { SubModelInstance } from '@/stores/model'

import { LISTEN_KEY } from '@/constants'

const SUB_MODEL_WINDOW_PREFIX = 'sub-model-'
const DEFAULT_SIZE = 300
const WINDOW_READY_TIMEOUT = 10_000
let windowOpenQueue = Promise.resolve()

export function getSubModelWindowLabel(instanceId: string) {
  return `${SUB_MODEL_WINDOW_PREFIX}${instanceId}`
}

export async function openSubModelWindow(instance: SubModelInstance) {
  const task = windowOpenQueue.then(() => openSubModelWindowNow(instance))

  windowOpenQueue = task.then(() => undefined, () => undefined)

  return task
}

async function openSubModelWindowNow(instance: SubModelInstance) {
  if (!instance.visible) return

  const label = getSubModelWindowLabel(instance.id)
  const existingWindow = await WebviewWindow.getByLabel(label)

  if (existingWindow) {
    await syncSubModelWindow(instance, existingWindow)
    await existingWindow.show()
    await emitTo(label, LISTEN_KEY.SET_SUB_MODEL_RENDERING, true)
    await existingWindow.setFocus()
    return existingWindow
  }

  const runtimeReady = await listenForSubModelRuntimeReady(instance.id)
  let window: WebviewWindow | undefined

  try {
    window = new WebviewWindow(label, {
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

    await Promise.all([waitForWindowCreation(window), runtimeReady.ready])

    if (!instance.visible) {
      await window.destroy()
      return
    }

    await syncSubModelWindow(instance, window)
    await window.show()

    return window
  } catch (error) {
    await window?.destroy().catch(() => undefined)
    throw error
  } finally {
    runtimeReady.dispose()
  }
}

export async function hideSubModelWindow(instanceId: string) {
  const label = getSubModelWindowLabel(instanceId)
  const window = await WebviewWindow.getByLabel(label)

  await emitTo(label, LISTEN_KEY.SET_SUB_MODEL_RENDERING, false).catch(() => undefined)
  await window?.destroy()
}

export async function destroySubModelWindow(instanceId: string) {
  const window = await WebviewWindow.getByLabel(getSubModelWindowLabel(instanceId))

  await window?.destroy()
}

export async function applySubModelWindowPosition(instance: SubModelInstance, existingWindow?: WebviewWindow | null) {
  const { x, y } = instance.window

  if (typeof x !== 'number' || typeof y !== 'number') return

  const window = existingWindow ?? await WebviewWindow.getByLabel(getSubModelWindowLabel(instance.id))

  await window?.setPosition(new PhysicalPosition(x, y))
}

export async function applySubModelWindowSettings(instance: SubModelInstance, existingWindow?: WebviewWindow | null) {
  const window = existingWindow ?? await WebviewWindow.getByLabel(getSubModelWindowLabel(instance.id))

  if (!window) return

  await Promise.all([
    applySubModelWindowPosition(instance, window).catch(() => undefined),
    window.setAlwaysOnTop(instance.window.alwaysOnTop).catch(() => undefined),
    window.setIgnoreCursorEvents(instance.window.passThrough).catch(() => undefined),
  ])
}

export async function syncSubModelWindow(instance: SubModelInstance, existingWindow?: WebviewWindow | null) {
  const label = getSubModelWindowLabel(instance.id)

  await Promise.all([
    applySubModelWindowSettings(instance, existingWindow),
    emitTo(label, LISTEN_KEY.UPDATE_SUB_MODEL, structuredClone(toRaw(instance))).catch(() => undefined),
  ])
}

async function waitForWindowCreation(window: WebviewWindow) {
  return new Promise<void>((resolve, reject) => {
    void window.once('tauri://created', () => resolve())
    void window.once<string>('tauri://error', ({ payload }) => reject(new Error(payload)))
  })
}

async function listenForSubModelRuntimeReady(instanceId: string) {
  let resolve!: () => void
  let reject!: (error: Error) => void
  let timeout: ReturnType<typeof setTimeout> | undefined
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    resolve = resolveReady
    reject = rejectReady
  })
  const unlisten = await listen<{ id: string }>(LISTEN_KEY.SUB_MODEL_RUNTIME_READY, ({ payload }) => {
    if (payload.id !== instanceId) return

    if (timeout) clearTimeout(timeout)
    resolve()
  })

  timeout = setTimeout(() => {
    reject(new Error(`Timed out waiting for sub-model ${instanceId} to initialize.`))
  }, WINDOW_READY_TIMEOUT)

  return {
    ready,
    dispose() {
      if (timeout) clearTimeout(timeout)
      unlisten()
    },
  }
}
