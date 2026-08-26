// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import type { Ref } from 'vue'

import { invoke } from '@tauri-apps/api/core'
import { PhysicalPosition } from '@tauri-apps/api/dpi'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { isNil } from 'es-toolkit'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import type { ModelRuntimeOptions } from '@/composables/useModel'
import type { CursorBounds } from '@/utils/relativeMouse'
import type { DeviceInputEvent } from '@/utils/subModelRuntime'

import { setPassThrough } from '@/plugins/window'
import { useAppStore } from '@/stores/app'
import { useCatStore } from '@/stores/cat'
import { useModelStore } from '@/stores/model'
import { logError, logInfo } from '@/utils/diagnostics'
import { inBetween } from '@/utils/is'
import {
  getActiveMouseLookSmoothing,
  getMouseLookInterpolationAlpha,
} from '@/utils/mouseLookSmoothing'
import { isMac, isWindows } from '@/utils/platform'
import { mergeRelativeMouseMovement } from '@/utils/relativeMouse'
import { reportRuntimeEventQuietly } from '@/utils/runtimeTelemetry'

import { INVOKE_KEY, LISTEN_KEY, WINDOW_LABEL } from '../constants'
import { useModel } from './useModel'
import { useTauriListen } from './useTauriListen'

type CursorPoint = Extract<DeviceInputEvent, { kind: 'MouseMove' }>['value']
type RelativeMouseMove = Extract<DeviceInputEvent, { kind: 'MouseRelativeMove' }>['value']

export interface DeviceListenerOptions {
  keyboard: boolean
  mouse: boolean
  typingBehavior: boolean
}

export interface UseDeviceOptions extends ModelRuntimeOptions {
  listeners?: Readonly<Ref<DeviceListenerOptions>>
  enableWindowHover?: boolean
  listen?: boolean
  onInputEvent?: (event: DeviceInputEvent) => void
}

const RUNTIME_USED_REPORT_INTERVAL = 5 * 60 * 1000
const appWindow = getCurrentWebviewWindow()

export function useDevice(options: UseDeviceOptions = {}) {
  const modelStore = useModelStore()
  const currentModel = options.currentModel ?? computed(() => modelStore.currentModel)
  const releaseTimers = new Map<string, NodeJS.Timeout>()
  const appStore = useAppStore()
  const catStore = useCatStore()
  const latestCursorPoint = ref<CursorPoint>()
  const smoothedCursorPoint = ref<CursorPoint>()
  const relativeMouseMove = ref<RelativeMouseMove>()
  const scaleFactor = ref(1)
  let windowBounds: CursorBounds | undefined
  let windowBoundsRefresh: Promise<void> | undefined
  let stopWindowBoundsListeners: (() => void)[] = []
  const listeners = options.listeners ?? computed<DeviceListenerOptions>(() => ({
    keyboard: true,
    mouse: true,
    typingBehavior: true,
  }))
  const { handlePress, handleRelease, handleMouseChange, handleMouseMove, handleRelativeMouseMove, handleDestroy } = useModel(options)
  let lastRuntimeUsedReportAt = 0
  let cursorSmoothingFrame = 0
  let lastCursorSmoothingAt = 0
  let relativeMouseFrame = 0

  const refreshWindowBounds = () => {
    if (windowBoundsRefresh) return windowBoundsRefresh

    windowBoundsRefresh = Promise.all([
      appWindow.outerPosition(),
      appWindow.outerSize(),
    ]).then(([position, size]) => {
      if (size.width <= 0 || size.height <= 0) return

      windowBounds = {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
      }
    }).catch((error) => {
      logError('[device] failed to refresh window bounds', { windowLabel: appWindow.label, error })
    }).finally(() => {
      windowBoundsRefresh = undefined
    })

    return windowBoundsRefresh
  }

  const updateMainWindowPassThrough = (passThrough: boolean) => {
    if (isWindows) return setPassThrough(passThrough)

    return appWindow.setIgnoreCursorEvents(passThrough)
  }

  const reportRuntimeUsed = () => {
    const now = Date.now()
    if (now - lastRuntimeUsedReportAt < RUNTIME_USED_REPORT_INTERVAL) return
    lastRuntimeUsedReportAt = now
    reportRuntimeEventQuietly(currentModel.value, 'used')
  }

  const stopCursorSmoothing = () => {
    if (cursorSmoothingFrame) {
      cancelAnimationFrame(cursorSmoothingFrame)
      cursorSmoothingFrame = 0
    }

    lastCursorSmoothingAt = 0
    latestCursorPoint.value = undefined
    smoothedCursorPoint.value = undefined
    relativeMouseMove.value = undefined

    if (relativeMouseFrame) {
      cancelAnimationFrame(relativeMouseFrame)
      relativeMouseFrame = 0
    }
  }

  const scheduleCursorSmoothing = () => {
    if (catStore.model.ignoreMouse || !listeners.value.mouse || cursorSmoothingFrame || !latestCursorPoint.value) return

    cursorSmoothingFrame = requestAnimationFrame(runCursorSmoothing)
  }

  const runCursorSmoothing = (timestamp: number) => {
    cursorSmoothingFrame = 0

    const destination = latestCursorPoint.value

    if (!destination) return

    const current = smoothedCursorPoint.value ?? destination
    const deltaMS = lastCursorSmoothingAt
      ? timestamp - lastCursorSmoothingAt
      : 1000 / 60

    lastCursorSmoothingAt = timestamp

    const alpha = getMouseLookInterpolationAlpha(
      getActiveMouseLookSmoothing(catStore.model),
      deltaMS,
    )

    const interpolated = {
      x: current.x + (destination.x - current.x) * alpha,
      y: current.y + (destination.y - current.y) * alpha,
    }

    if (Math.hypot(destination.x - interpolated.x, destination.y - interpolated.y) < 0.5) {
      smoothedCursorPoint.value = { ...destination }

      latestCursorPoint.value = void 0
      lastCursorSmoothingAt = 0
    } else {
      smoothedCursorPoint.value = interpolated
    }

    void handleCursorMove(smoothedCursorPoint.value)

    if (latestCursorPoint.value) {
      scheduleCursorSmoothing()
    }
  }

  onMounted(async () => {
    try {
      scaleFactor.value = isMac ? await appWindow.scaleFactor() : 1
      await refreshWindowBounds()

      const [stopMoved, stopResized, stopScaleChanged] = await Promise.all([
        appWindow.onMoved(({ payload }) => {
          if (!windowBounds) {
            void refreshWindowBounds()
            return
          }

          windowBounds = { ...windowBounds, x: payload.x, y: payload.y }
        }),
        appWindow.onResized(({ payload }) => {
          if (!windowBounds) {
            void refreshWindowBounds()
            return
          }

          windowBounds = { ...windowBounds, width: payload.width, height: payload.height }
        }),
        appWindow.onScaleChanged(({ payload }) => {
          if (isMac) scaleFactor.value = payload.scaleFactor

          if (!windowBounds) {
            void refreshWindowBounds()
            return
          }

          windowBounds = {
            ...windowBounds,
            width: payload.size.width,
            height: payload.size.height,
          }
        }),
      ])

      stopWindowBoundsListeners = [stopMoved, stopResized, stopScaleChanged]
    } catch (error) {
      logError('[device] failed to initialize window scale listener', { windowLabel: appWindow.label, error })
    }
  })

  onUnmounted(() => {
    for (const stopListening of stopWindowBoundsListeners) {
      stopListening()
    }

    stopWindowBoundsListeners = []
    stopCursorSmoothing()

    for (const timer of releaseTimers.values()) {
      clearTimeout(timer)
    }

    releaseTimers.clear()
    handleDestroy()
  })

  watch([() => catStore.model.ignoreMouse, () => listeners.value.mouse], ([ignoreMouse, mouseEnabled]) => {
    if (ignoreMouse || !mouseEnabled) {
      stopCursorSmoothing()
      return
    }

    scheduleCursorSmoothing()
  }, { immediate: true })

  watch(() => listeners.value.keyboard, (keyboardEnabled) => {
    if (keyboardEnabled) return

    for (const key of Object.keys(modelStore.activeKeys)) {
      handleRelease(key)
    }
  }, { immediate: true })

  watch(() => listeners.value.mouse, (mouseEnabled) => {
    if (mouseEnabled) return

    handleMouseChange('Left', false)
    handleMouseChange('Right', false)
  }, { immediate: true })

  const startListening = () => {
    logInfo('[device] starting native listener', { windowLabel: appWindow.label })
    return invoke(INVOKE_KEY.START_DEVICE_LISTENING)
      .then(() => {
        logInfo('[device] native listener start acknowledged', { windowLabel: appWindow.label })
      })
      .catch((error) => {
        logError('[device] native listener start failed', { windowLabel: appWindow.label, error })
        throw error
      })
  }

  const getSupportedKeys = (key: string) => {
    const aliases: Record<string, string[]> = {
      ArrowDown: ['DownArrow'],
      ArrowLeft: ['LeftArrow'],
      ArrowRight: ['RightArrow'],
      ArrowUp: ['UpArrow'],
      BackQuote: ['Backquote'],
      DownArrow: ['ArrowDown'],
      LeftArrow: ['ArrowLeft'],
      Return: ['Enter'],
      RightArrow: ['ArrowRight'],
      UpArrow: ['ArrowUp'],
    }
    const candidates = [
      key,
      ...aliases[key] ?? [],
    ]

    if (key.startsWith('F')) {
      candidates.push(key.replace(/F(\d+)/, 'Fn'))
    }

    for (const item of ['Meta', 'Shift', 'Alt', 'Control']) {
      if (!key.startsWith(item)) continue

      candidates.push(item)
    }

    if (key.startsWith('Num')) {
      candidates.push(key.replace(/^Num/, 'Kp'))
    }

    if (key.startsWith('Kp')) {
      candidates.push(key.replace(/^Kp/, 'Num'))
    }

    return [...new Set(candidates)]
  }

  const onHideOnHover = (() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let wasInWindow = false

    return (x: number, y: number) => {
      const { x: winX, y: winY, width, height } = appStore.windowState[WINDOW_LABEL.MAIN] ?? {}

      if (isNil(winX) || isNil(winY) || isNil(width) || isNil(height)) return

      const isInWindow = inBetween(x, winX, winX + width)
        && inBetween(y, winY, winY + height)

      if (isInWindow === wasInWindow) return

      if (timer) {
        clearTimeout(timer)

        timer = void 0
      }

      if (isInWindow) {
        timer = setTimeout(() => {
          document.body.style.setProperty('opacity', '0')

          void updateMainWindowPassThrough(true)
        }, catStore.window.hideOnHoverDelay * 1000)
      } else {
        document.body.style.setProperty('opacity', 'unset')

        void updateMainWindowPassThrough(catStore.window.passThrough)
      }

      wasInWindow = isInWindow
    }
  })()

  const handleCursorMove = (cursorPoint: CursorPoint) => {
    const x = cursorPoint.x * scaleFactor.value
    const y = cursorPoint.y * scaleFactor.value
    const physicalCursorPoint = new PhysicalPosition(x, y)

    if (catStore.model.windowRelativeMouseLook && !windowBounds) {
      void refreshWindowBounds()
    } else {
      void handleMouseMove(physicalCursorPoint, windowBounds)
    }

    if (!options.enableWindowHover || !catStore.window.hideOnHover) return

    onHideOnHover(x, y)
  }

  const scheduleRelativeMouseMove = () => {
    if (catStore.model.ignoreMouse || !listeners.value.mouse || relativeMouseFrame || !relativeMouseMove.value) return

    relativeMouseFrame = requestAnimationFrame(() => {
      relativeMouseFrame = 0

      const movement = relativeMouseMove.value
      relativeMouseMove.value = undefined

      if (movement) handleRelativeMouseMove(movement.dx, movement.dy)
    })
  }

  const handleAutoRelease = (key: string, delay = 100) => {
    if (releaseTimers.has(key)) {
      clearTimeout(releaseTimers.get(key))
    }

    handlePress(key, { triggerExpression: listeners.value.typingBehavior })

    const timer = setTimeout(() => {
      handleRelease(key)

      releaseTimers.delete(key)
    }, delay)

    releaseTimers.set(key, timer)
  }

  const handleManualRelease = (key: string) => {
    if (releaseTimers.has(key)) {
      clearTimeout(releaseTimers.get(key))
      releaseTimers.delete(key)
    }

    handleRelease(key)
  }

  const handleInputEvent = (event: DeviceInputEvent) => {
    const { kind, value } = event

    if (kind === 'KeyboardPress' || kind === 'KeyboardRelease') {
      if (!listeners.value.keyboard) return

      const nextValues = getSupportedKeys(value)
        .filter((key) => {
          return modelStore.supportKeys[key]?.length
            || Object.keys(modelStore.supportKeys).some(shortcut => shortcut.split('+').includes(key))
            || modelStore.activeKeys[key]
        })

      if (!nextValues.length) return

      if (nextValues.includes('CapsLock')) {
        return handleAutoRelease('CapsLock')
      }

      if (kind === 'KeyboardPress') {
        reportRuntimeUsed()

        if (isWindows) {
          const delay = catStore.model.autoReleaseDelay * 1000

          for (const nextValue of nextValues) {
            handleAutoRelease(nextValue, delay)
          }

          return
        }

        for (const nextValue of nextValues) {
          handlePress(nextValue, { triggerExpression: listeners.value.typingBehavior })
        }

        return
      }

      for (const nextValue of nextValues) {
        handleManualRelease(nextValue)
      }

      return
    }

    switch (kind) {
      case 'MousePress':
        if (!listeners.value.mouse) return
        reportRuntimeUsed()
        return handleMouseChange(value)
      case 'MouseRelease':
        if (!listeners.value.mouse) return
        return handleMouseChange(value, false)
      case 'MouseMove':
        if (!listeners.value.mouse) return
        latestCursorPoint.value = value
        return scheduleCursorSmoothing()
      case 'MouseRelativeMove':
        if (!listeners.value.mouse) return
        relativeMouseMove.value = mergeRelativeMouseMovement(relativeMouseMove.value, value)
        return scheduleRelativeMouseMove()
    }
  }

  if (options.listen !== false) {
    useTauriListen<DeviceInputEvent>(LISTEN_KEY.DEVICE_CHANGED, ({ payload }) => {
      handleInputEvent(payload)
      options.onInputEvent?.(payload)
    })
  }

  return {
    handleInputEvent,
    startListening,
  }
}
