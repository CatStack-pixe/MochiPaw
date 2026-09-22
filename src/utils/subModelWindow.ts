// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { invoke } from '@tauri-apps/api/core'
import { PhysicalPosition } from '@tauri-apps/api/dpi'
import { emitTo, listen } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { platform } from '@tauri-apps/plugin-os'
import { toRaw } from 'vue'

import type { SubModelInstance } from '@/stores/model'

import { LISTEN_KEY } from '@/constants'

const SUB_MODEL_WINDOW_PREFIX = 'sub-model-'
const DEFAULT_SIZE = 300
const WINDOW_READY_TIMEOUT = 10_000
let windowOperationQueue = Promise.resolve()
const pendingCreations = new Set<string>()

export function getSubModelWindowLabel(instanceId: string) {
  return `${SUB_MODEL_WINDOW_PREFIX}${instanceId}`
}

function enqueueWindowOperation<T>(operation: () => Promise<T>) {
  const task = windowOperationQueue.then(operation)
  // A failed operation must not prevent a later show/hide request from running.
  windowOperationQueue = task.then(() => undefined, () => undefined)
  return task
}

export function openSubModelWindow(instance: SubModelInstance) {
  return enqueueWindowOperation(() => openSubModelWindowNow(instance))
}

async function openSubModelWindowNow(instance: SubModelInstance) {
  if (!instance.visible) return

  const label = getSubModelWindowLabel(instance.id)
  if (pendingCreations.has(label)) {
    throw new Error(`Sub-model window ${label} is still finishing an earlier creation. Please retry.`)
  }
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
  let creationCancelled = false

  const createWindow = async () => {
    if (platform() === 'windows') {
      await invoke('create_sub_model_window', {
        instanceId: instance.id,
        x: instance.window.x,
        y: instance.window.y,
        alwaysOnTop: instance.window.alwaysOnTop,
      })
      window = await WebviewWindow.getByLabel(label) ?? undefined
      if (!window) throw new Error(`Sub-model window ${label} was not created.`)
    } else {
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

      await waitForWindowCreation(window)
    }

    // A slow native creation may finish after runtime initialization timed out.
    // Destroy that late result too so an invisible window cannot remain alive.
    if (creationCancelled) await window.destroy().catch(() => undefined)
  }

  let creationSettled = false
  pendingCreations.add(label)
  const creation = createWindow().finally(() => {
    creationSettled = true
    pendingCreations.delete(label)
  })
  try {
    await Promise.all([creation, runtimeReady.ready])
    if (!window) throw new Error(`Sub-model window ${label} was not created.`)

    if (!instance.visible) {
      await window.destroy()
      return
    }

    await syncSubModelWindow(instance, window)
    await window.show()

    return window
  } catch (error) {
    creationCancelled = true
    // Return the initialization timeout promptly. A still-running creation owns
    // this label until it finishes and destroys its late result; other labels
    // can continue through the queue. Do not also destroy that result here.
    if (creationSettled) await window?.destroy().catch(() => undefined)
    throw error
  } finally {
    runtimeReady.dispose()
  }
}

export function hideSubModelWindow(instanceId: string) {
  return enqueueWindowOperation(async () => {
    const label = getSubModelWindowLabel(instanceId)
    if (pendingCreations.has(label)) return
    const window = await WebviewWindow.getByLabel(label)

    await emitTo(label, LISTEN_KEY.SET_SUB_MODEL_RENDERING, false).catch(() => undefined)
    await window?.destroy()
  })
}

export function destroySubModelWindow(instanceId: string) {
  return enqueueWindowOperation(async () => {
    const label = getSubModelWindowLabel(instanceId)
    if (pendingCreations.has(label)) return
    const window = await WebviewWindow.getByLabel(label)

    await window?.destroy()
  })
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
    let settled = false
    const listeners: Array<() => void> = []
    function finish(error?: unknown) {
      if (settled) return

      settled = true
      for (const unlisten of listeners) unlisten()
      listeners.length = 0
      if (error) reject(error)
      else resolve()
    }

    function track(registration: Promise<() => void>) {
      void registration.then((unlisten) => {
        if (settled) unlisten()
        else listeners.push(unlisten)
      }).catch(finish)
    }

    track(window.once('tauri://created', () => finish()))
    track(window.once<string>('tauri://error', ({ payload }) => finish(new Error(payload))))
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
