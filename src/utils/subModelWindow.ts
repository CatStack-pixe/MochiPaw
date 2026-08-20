// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { PhysicalPosition } from '@tauri-apps/api/dpi'
import { emitTo, listen } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { toRaw } from 'vue'

import type { SubModelInstance } from '@/stores/model'

import { LISTEN_KEY } from '@/constants'
import { logError, logInfo, logStep, logTrace, logWarn } from '@/utils/diagnostics'

const SUB_MODEL_WINDOW_PREFIX = 'sub-model-'
const DEFAULT_SIZE = 300
const WINDOW_READY_TIMEOUT = 10_000
let windowOpenQueue = Promise.resolve()
const runtimeStates = new Map<string, SubModelInteractionState>()
const lifecycleQueues = new Map<string, Promise<unknown>>()

export interface SubModelInteractionState {
  modelReady: boolean
  renderingEnabled: boolean
  generation?: number
}

export function shouldIgnoreSubModelCursor(
  instance: Pick<SubModelInstance, 'visible' | 'window'>,
  state: SubModelInteractionState,
) {
  return instance.window.passThrough
    || !instance.visible
    || !state.modelReady
    || !state.renderingEnabled
}

export async function updateSubModelWindowRuntimeState(
  instance: Pick<SubModelInstance, 'id' | 'modelId' | 'visible' | 'window'>,
  state: Partial<SubModelInteractionState>,
  generation?: number,
) {
  return enqueueWindowOperation(instance.id, () => updateSubModelWindowRuntimeStateNow(instance, state, generation))
}

async function updateSubModelWindowRuntimeStateNow(
  instance: Pick<SubModelInstance, 'id' | 'modelId' | 'visible' | 'window'>,
  state: Partial<SubModelInteractionState>,
  generation?: number,
) {
  const previous = runtimeStates.get(instance.id) ?? {
    modelReady: false,
    renderingEnabled: false,
    generation: 0,
  }
  const nextGeneration = generation ?? previous.generation ?? 0

  if (nextGeneration < (previous.generation ?? 0)) {
    logTrace('[sub-model-window] ignored stale runtime state', {
      instanceId: instance.id,
      generation: nextGeneration,
      currentGeneration: previous.generation,
      state,
    })
    return
  }

  const next = { ...previous, ...state }
  next.generation = nextGeneration
  runtimeStates.set(instance.id, next)
  const window = await getWindowSafely(instance.id)

  if (!window) {
    logTrace('[sub-model-window] runtime state updated without window', {
      instanceId: instance.id,
      ...next,
    })
    return
  }

  try {
    const ignoreCursorEvents = shouldIgnoreSubModelCursor(instance, next)
    await window.setIgnoreCursorEvents(ignoreCursorEvents)
    await logWindowState(window, 'applied runtime interaction state', instance)
    logInfo('[sub-model-window] runtime interaction state updated', {
      instanceId: instance.id,
      ...next,
      ignoreCursorEvents,
    })
  } catch (error) {
    await destroyWindowSafely(window, 'runtime-state-failed')
    logError('[sub-model-window] runtime interaction state failed', {
      instanceId: instance.id,
      ...next,
      error,
    })
  }
}

export function getSubModelWindowLabel(instanceId: string) {
  return `${SUB_MODEL_WINDOW_PREFIX}${instanceId}`
}

export async function openSubModelWindow(instance: SubModelInstance) {
  return enqueueWindowOperation(instance.id, () => {
    const task = windowOpenQueue.then(() => openSubModelWindowNow(instance))

    windowOpenQueue = task.then(() => undefined, () => undefined)

    return task
  })
}

async function openSubModelWindowNow(instance: SubModelInstance) {
  const label = getSubModelWindowLabel(instance.id)

  if (!instance.visible) {
    logStep('sub-model-window', 'skipped hidden window open', getInstanceContext(instance))
    await destroySubModelWindowNow(instance.id)
    return
  }

  const previousGeneration = runtimeStates.get(instance.id)?.generation ?? 0
  runtimeStates.set(instance.id, {
    modelReady: false,
    renderingEnabled: false,
    generation: previousGeneration + 1,
  })
  logStep('sub-model-window', 'begin open', getInstanceContext(instance))
  const existingWindow = await getWindowSafely(instance.id)

  if (existingWindow) {
    logWarn('[sub-model-window] replacing existing window to restore runtime handshake', {
      ...getInstanceContext(instance),
    })
    await destroyWindowSafely(existingWindow, 'replace-existing')
  }

  const runtimeReady = await listenForSubModelRuntimeReady(instance.id)
  let window: WebviewWindow | undefined

  try {
    window = new WebviewWindow(label, {
      url: `index.html/#/sub-model?instance=${encodeURIComponent(instance.id)}`,
      title: 'MochiPaw',
      width: DEFAULT_SIZE,
      height: DEFAULT_SIZE,
      ...getInitialWindowPosition(instance),
      shadow: false,
      transparent: true,
      decorations: false,
      alwaysOnTop: instance.window.alwaysOnTop,
      skipTaskbar: true,
      maximizable: false,
      visible: false,
    })

    await Promise.all([waitForWindowCreation(window), runtimeReady.ready])
    await makeWindowNonInteractive(window, 'runtime-mounted')

    if (!instance.visible) {
      await destroyWindowSafely(window, 'hidden-during-open')
      return
    }

    await syncSubModelWindowNow(instance, window)
    await window.show()
    await emitTo(label, LISTEN_KEY.SET_SUB_MODEL_RENDERING, true)
    await logWindowState(window, 'opened new window', instance)

    return window
  } catch (error) {
    await destroyWindowSafely(window, 'open-failed')
    logError('[sub-model-window] failed to open new window', { ...getInstanceContext(instance), error })
    throw error
  } finally {
    runtimeReady.dispose()
  }
}

export async function hideSubModelWindow(instanceId: string) {
  return enqueueWindowOperation(instanceId, () => hideSubModelWindowNow(instanceId))
}

async function hideSubModelWindowNow(instanceId: string) {
  const label = getSubModelWindowLabel(instanceId)
  const window = await getWindowSafely(instanceId)

  if (!window) {
    logTrace('[sub-model-window] hide skipped because window does not exist', { instanceId, label })
    return
  }

  logStep('sub-model-window', 'begin hide', { instanceId, label })
  const previousGeneration = runtimeStates.get(instanceId)?.generation ?? 0
  runtimeStates.set(instanceId, { modelReady: false, renderingEnabled: false, generation: previousGeneration + 1 })
  await makeWindowNonInteractive(window, 'hide').catch(() => undefined)
  await emitTo(label, LISTEN_KEY.SET_SUB_MODEL_RENDERING, false).catch((error) => {
    logWarn('[sub-model-window] failed to disable rendering before hide', { instanceId, label, error })
  })
  await destroyWindowSafely(window, 'hide')
}

export async function destroySubModelWindow(instanceId: string) {
  return enqueueWindowOperation(instanceId, () => destroySubModelWindowNow(instanceId))
}

async function destroySubModelWindowNow(instanceId: string) {
  const label = getSubModelWindowLabel(instanceId)
  const window = await getWindowSafely(instanceId)

  runtimeStates.delete(instanceId)

  if (!window) return

  logStep('sub-model-window', 'begin destroy', { instanceId, label })
  await destroyWindowSafely(window, 'destroy')
}

export async function cleanupOrphanSubModelWindows(instances: readonly Pick<SubModelInstance, 'id' | 'visible' | 'showOnLaunch'>[]) {
  const configuredLabels = new Set(
    instances
      .filter(instance => instance.visible && instance.showOnLaunch)
      .map(instance => getSubModelWindowLabel(instance.id)),
  )
  let windows: WebviewWindow[]

  try {
    windows = await WebviewWindow.getAll()
  } catch (error) {
    logError('[sub-model-window] failed to enumerate windows for orphan cleanup', { error })
    return 0
  }
  const orphanWindows = windows.filter((window) => {
    return window.label.startsWith(SUB_MODEL_WINDOW_PREFIX) && !configuredLabels.has(window.label)
  })

  for (const instanceId of runtimeStates.keys()) {
    if (!configuredLabels.has(getSubModelWindowLabel(instanceId))) runtimeStates.delete(instanceId)
  }

  if (!orphanWindows.length) {
    logTrace('[sub-model-window] no orphan windows found', { configuredCount: configuredLabels.size })
    return 0
  }

  logWarn('[sub-model-window] cleaning orphan windows', {
    configuredCount: configuredLabels.size,
    orphanLabels: orphanWindows.map(window => window.label),
  })
  const results = await Promise.all(orphanWindows.map(window => destroyWindowSafely(window, 'orphan-cleanup')))

  return results.filter(Boolean).length
}

export async function applySubModelWindowPosition(instance: SubModelInstance, existingWindow?: WebviewWindow | null) {
  const { x, y } = instance.window

  if (x === undefined || y === undefined) return

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    logWarn('[sub-model-window] ignored invalid persisted position', {
      ...getInstanceContext(instance),
      x,
      y,
    })
    return
  }

  const window = existingWindow ?? await getWindowSafely(instance.id)

  await window?.setPosition(new PhysicalPosition(x, y))
}

export async function applySubModelWindowSettings(instance: SubModelInstance, existingWindow?: WebviewWindow | null) {
  const window = existingWindow ?? await getWindowSafely(instance.id)

  if (!window) return

  await applySubModelWindowPosition(instance, window)
  await window.setAlwaysOnTop(instance.window.alwaysOnTop)
  await makeWindowNonInteractive(window, 'apply-settings')
  await logWindowState(window, 'applied window settings', instance)
}

export async function syncSubModelWindow(instance: SubModelInstance, existingWindow?: WebviewWindow | null) {
  return enqueueWindowOperation(instance.id, () => syncSubModelWindowNow(instance, existingWindow))
}

async function syncSubModelWindowNow(instance: SubModelInstance, existingWindow?: WebviewWindow | null) {
  const label = getSubModelWindowLabel(instance.id)
  const window = existingWindow ?? await getWindowSafely(instance.id)

  if (!window) {
    logTrace('[sub-model-window] sync skipped because window does not exist', getInstanceContext(instance))
    return
  }

  if (!instance.visible) {
    logWarn('[sub-model-window] destroying hidden window during sync', getInstanceContext(instance))
    const previousGeneration = runtimeStates.get(instance.id)?.generation ?? 0
    runtimeStates.set(instance.id, { modelReady: false, renderingEnabled: false, generation: previousGeneration + 1 })
    await destroyWindowSafely(window, 'sync-hidden')
    return
  }

  logStep('sub-model-window', 'begin sync', getInstanceContext(instance))

  try {
    // Keep the transparent window harmless until its runtime confirms that the
    // model is rendered and applies the configured interaction state.
    await makeWindowNonInteractive(window, 'sync')
    await applySubModelWindowPosition(instance, window)
    await window.setAlwaysOnTop(instance.window.alwaysOnTop)
    await emitTo(label, LISTEN_KEY.UPDATE_SUB_MODEL, structuredClone(toRaw(instance)))
    await logWindowState(window, 'synced window', instance)
  } catch (error) {
    await destroyWindowSafely(window, 'sync-failed')
    logError('[sub-model-window] sync failed and window was destroyed', {
      ...getInstanceContext(instance),
      error,
    })
    throw error
  }
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
    logError('[sub-model-window] runtime initialization timed out', {
      instanceId,
      label: getSubModelWindowLabel(instanceId),
      timeoutMs: WINDOW_READY_TIMEOUT,
    })
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

function getInstanceContext(instance: Pick<SubModelInstance, 'id' | 'modelId' | 'visible' | 'window'>) {
  return {
    instanceId: instance.id,
    modelId: instance.modelId,
    label: getSubModelWindowLabel(instance.id),
    visible: instance.visible,
    position: { x: instance.window.x, y: instance.window.y },
    passThrough: instance.window.passThrough,
    alwaysOnTop: instance.window.alwaysOnTop,
  }
}

function getInitialWindowPosition(instance: SubModelInstance) {
  const { x, y } = instance.window

  if (x === undefined || y === undefined) return {}
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y }

  logWarn('[sub-model-window] ignored invalid persisted initial position', {
    ...getInstanceContext(instance),
    x,
    y,
  })

  return {}
}

async function makeWindowNonInteractive(window: WebviewWindow, reason: string) {
  try {
    await window.setIgnoreCursorEvents(true)
    logTrace('[sub-model-window] forced cursor pass-through', { label: window.label, reason })
  } catch (error) {
    logError('[sub-model-window] failed to force cursor pass-through', { label: window.label, reason, error })
    throw error
  }
}

async function destroyWindowSafely(window: WebviewWindow | undefined, reason: string) {
  if (!window) return true

  await makeWindowNonInteractive(window, `${reason}-before-destroy`).catch(() => undefined)
  await window.hide().catch((error) => {
    logWarn('[sub-model-window] failed to hide window before destroy', { label: window.label, reason, error })
  })

  try {
    await window.destroy()
    logInfo('[sub-model-window] destroyed window', { label: window.label, reason })
    return true
  } catch (error) {
    logError('[sub-model-window] failed to destroy window', { label: window.label, reason, error })
    return false
  }
}

async function logWindowState(
  window: WebviewWindow,
  action: string,
  instance?: Pick<SubModelInstance, 'id' | 'modelId' | 'visible' | 'window'>,
) {
  const runtimeState = instance
    ? runtimeStates.get(instance.id) ?? { modelReady: false, renderingEnabled: false, generation: 0 }
    : undefined
  const [position, size, visible] = await Promise.all([
    window.outerPosition().catch(error => ({ error })),
    window.outerSize().catch(error => ({ error })),
    window.isVisible().catch(error => ({ error })),
  ])

  logInfo(`[sub-model-window] ${action}`, {
    ...(instance ? getInstanceContext(instance) : { label: window.label }),
    actualPosition: position,
    actualSize: size,
    actualVisible: visible,
    runtimeState,
    desiredIgnoreCursorEvents: instance && runtimeState
      ? shouldIgnoreSubModelCursor(instance, runtimeState)
      : undefined,
  })
}

function enqueueWindowOperation<T>(instanceId: string, operation: () => Promise<T>) {
  const previous = lifecycleQueues.get(instanceId) ?? Promise.resolve()
  const task = previous
    .catch(() => undefined)
    .then(operation)

  lifecycleQueues.set(instanceId, task)
  void task.then(
    () => {
      if (lifecycleQueues.get(instanceId) === task) lifecycleQueues.delete(instanceId)
    },
    () => {
      if (lifecycleQueues.get(instanceId) === task) lifecycleQueues.delete(instanceId)
    },
  )

  return task
}

async function getWindowSafely(instanceId: string) {
  const label = getSubModelWindowLabel(instanceId)

  try {
    return await WebviewWindow.getByLabel(label)
  } catch (error) {
    logWarn('[sub-model-window] failed to find window', { instanceId, label, error })
    return null
  }
}
