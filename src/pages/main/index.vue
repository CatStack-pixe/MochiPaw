<!-- SPDX-FileCopyrightText: 2025 ayangweb
  SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { convertFileSrc } from '@tauri-apps/api/core'
import { PhysicalSize } from '@tauri-apps/api/dpi'
import { emit, emitTo } from '@tauri-apps/api/event'
import { Menu, PredefinedMenuItem } from '@tauri-apps/api/menu'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { exists, readDir } from '@tauri-apps/plugin-fs'
import { useDebounceFn, useEventListener } from '@vueuse/core'
import { message } from 'antdv-next'
import { round } from 'es-toolkit'
import { computed, nextTick, onMounted, onUnmounted, ref, toRaw, watch } from 'vue'
import { useRoute } from 'vue-router'

import type { Model, ModelMotionInfo, ModelSwitchAcknowledgement, ModelSwitchRequest, SubModelInstance } from '@/stores/model'
import type { DeviceInputEvent, SubModelInputFrame } from '@/utils/subModelRuntime'
import type { TypingStatsState } from '@/utils/typingStatsPersistence'
import type { TypingStatsOperationAcknowledgement, TypingStatsOperationRequest } from '@/utils/typingStatsRequest'

import { useAppMenu } from '@/composables/useAppMenu'
import { useDevice } from '@/composables/useDevice'
import { useGamepad } from '@/composables/useGamepad'
import { useModel } from '@/composables/useModel'
import { useTauriListen } from '@/composables/useTauriListen'
import { LISTEN_KEY, WINDOW_LABEL } from '@/constants'
import { hideWindow, setAlwaysOnTop, setGameMode, setPassThrough, setTaskbarVisibility, showWindow } from '@/plugins/window'
import { useCatStore } from '@/stores/cat'
import { useGeneralStore } from '@/stores/general.ts'
import { useModelStore } from '@/stores/model'
import { usePomodoroStore } from '@/stores/pomodoro'
import {
  isCountableTypingEvent,
  useTypingStatsStore,
  waitForTypingStatsPersistenceHydration,
} from '@/stores/typingStats'
import { logDebug, logError, logInfo, logStep, logTrace, logWarn } from '@/utils/diagnostics'
import { isImage } from '@/utils/is'
import live2d from '@/utils/live2d'
import { requestModelStoreSave } from '@/utils/modelPersistence'
import { executeModelSwitchTransaction } from '@/utils/modelSwitch'
import { join } from '@/utils/path'
import { isWindows } from '@/utils/platform'
import { calculatePomodoroWindowLayout, formatPomodoroRemaining } from '@/utils/pomodoroDisplay'
import { resolveEffectiveMaxFPS } from '@/utils/renderFPS'
import { ensureRuntimeLease, reportRuntimeEventQuietly } from '@/utils/runtimeTelemetry'
import { clearObject } from '@/utils/shared'
import { SubModelInputCoordinator } from '@/utils/subModelRuntime'
import { destroySubModelWindow, updateSubModelWindowRuntimeState } from '@/utils/subModelWindow'
import { TypingStatsOperationCoordinator } from '@/utils/typingStatsCoordinator'
import { executeTypingStatsMutationTransaction, requestTypingStatsStoreSave } from '@/utils/typingStatsPersistence'

const appWindow = getCurrentWebviewWindow()
const route = useRoute()
const subModelId = typeof route.query.instance === 'string' ? route.query.instance : undefined
const isSubModel = Boolean(subModelId)
const modelStore = useModelStore()
const catStore = useCatStore()
const generalStore = useGeneralStore()
const pomodoroStore = usePomodoroStore()
const typingStatsStore = useTypingStatsStore()
const typingStatsCoordinator = new TypingStatsOperationCoordinator<TimestampedTypingInput>()
const inputCoordinator = isSubModel
  ? undefined
  : new SubModelInputCoordinator(() => modelStore.subModels.filter(instance => instance.visible))
const syncedSubModel = ref<SubModelInstance>()
const subModel = computed(() => {
  if (!subModelId) return undefined

  return syncedSubModel.value ?? modelStore.getSubModel(subModelId)
})
const activeModel = computed(() => {
  if (!subModel.value) return modelStore.currentModel

  return modelStore.models.find(model => model.id === subModel.value?.modelId)
})
const windowSettings = computed(() => subModel.value?.window ?? catStore.window)
const appearanceSettings = computed(() => subModel.value?.appearance ?? catStore.model)
const listenerSettings = computed(() => subModel.value?.listeners ?? {
  keyboard: true,
  mouse: true,
  gamepad: true,
  typingBehavior: true,
})
const gamepadEnabled = computed(() => {
  return isSubModel ? listenerSettings.value.gamepad : activeModel.value?.mode === 'gamepad'
})
const gamepadNativeDemand = computed(() => {
  if (activeModel.value?.mode === 'gamepad') return true

  return modelStore.subModels.some((instance) => {
    const model = modelStore.models.find(item => item.id === instance.modelId)

    return instance.visible && instance.listeners.gamepad && model?.mode === 'gamepad'
  })
})
const reportSubModelWindowChange = useDebounceFn((instance: SubModelInstance) => {
  void emit(LISTEN_KEY.SUB_MODEL_WINDOW_CHANGED, structuredClone(toRaw(instance)))
}, 150)
const {
  modelSize,
  handleLoad,
  handleDestroy,
  handleResize,
  handleKeyChange,
  playMotionBehavior,
  playExpressionBehavior,
} = useModel({
  currentModel: activeModel,
  mouseMirror: computed(() => appearanceSettings.value.mouseMirror),
  syncWindowScale: !isSubModel,
  resizeWindow: isSubModel,
})
const { startListening, handleInputEvent: handleDeviceInputEvent } = useDevice({
  currentModel: activeModel,
  mouseMirror: computed(() => appearanceSettings.value.mouseMirror),
  listeners: listenerSettings,
  enableWindowHover: !isSubModel,
  listen: !isSubModel,
  onInputEvent: (event) => {
    recordTypingStatsInput(event)
    inputCoordinator?.enqueueDevice(event)
  },
})
const { getBaseMenu, getExitMenu } = useAppMenu({
  windowSettings,
  visible: computed(() => subModel.value?.visible ?? catStore.window.visible),
  onWindowSettingsChange: reportCurrentSubModelWindowChange,
  toggleVisibility: isSubModel ? toggleMenuVisibility : undefined,
})
const backgroundImagePath = ref<string>()
const live2dCanvas = ref<HTMLCanvasElement | null>(null)
const gameModeActive = ref(false)
const { stickActive, handleInputEvent: handleGamepadInputEvent } = useGamepad({
  currentModel: activeModel,
  mouseMirror: computed(() => appearanceSettings.value.mouseMirror),
  enabled: gamepadEnabled,
  listen: !isSubModel,
  nativeDemand: isSubModel ? undefined : gamepadNativeDemand,
  onInputEvent: event => inputCoordinator?.enqueueGamepad(event),
})
const pressedKeyLayers = computed(() => {
  return Object.entries(modelStore.pressedKeys).flatMap(([key, layers]) => {
    return layers.map((layer, index) => ({
      key: `${key}:${index}:${layer.path}`,
      path: layer.path,
    }))
  })
})
let pendingScaleDelta = 0
let scaleFrame = 0
let resizeFrame = 0
let scalingWithShortcut = false
let scaleSyncTimer: ReturnType<typeof setTimeout> | undefined
let lastShortcutResizeAt = 0
let currentModelLoadVersion = 0
let subModelRuntimeGeneration = 0
let explicitModelSwitchInProgress = false
let modelSwitchRequestInProgress = false
let pomodoroDisplayTimer: ReturnType<typeof setInterval> | undefined
const modelLoadTrigger = ref(0)
const pomodoroNow = ref(Date.now())

const pomodoroLayout = computed(() => {
  if (isSubModel || !modelSize.value) return

  return calculatePomodoroWindowLayout({
    modelSize: modelSize.value,
    modelScale: windowSettings.value.scale,
    displayEnabled: pomodoroStore.settings.displayEnabled,
    displayScale: pomodoroStore.settings.displayScale,
  })
})
const pomodoroDisplayText = computed(() => formatPomodoroRemaining(pomodoroStore.getRemainingMs(pomodoroNow.value)))
const modelAspectRatio = computed(() => modelSize.value ? `${modelSize.value.width} / ${modelSize.value.height}` : '1')

const SCALE_DRAG_SENSITIVITY = 0.12
const SHORTCUT_RESIZE_INTERVAL = 33

interface TimestampedTypingInput {
  event: DeviceInputEvent
  now: Date
}

function applyTypingInput(input: TimestampedTypingInput) {
  typingStatsStore.recordInput(input.event, input.now)
}

function recordTypingStatsInput(event: DeviceInputEvent) {
  if (!isCountableTypingEvent(event)) return

  typingStatsCoordinator.record({ event, now: new Date() }, applyTypingInput)
}

function reportCurrentSubModelWindowChange() {
  const instance = subModel.value

  if (instance) {
    reportSubModelWindowChange(instance)
  }
}

async function toggleMenuVisibility() {
  const instance = subModel.value

  if (!instance) return

  instance.visible = !instance.visible
  live2d.setRenderingEnabled(instance.visible)
  if (subModelId) {
    const generation = ++subModelRuntimeGeneration
    void updateSubModelWindowRuntimeState(instance, {
      modelReady: instance.visible && modelStore.modelReady,
      renderingEnabled: instance.visible,
    }, generation)
  }
  await emit(LISTEN_KEY.SUB_MODEL_VISIBILITY_CHANGED, { id: instance.id, visible: instance.visible })

  if (!instance.visible) {
    await destroySubModelWindow(instance.id)
  }
}

function applyWindowScale(scale: number, modelSizeValue = modelSize.value) {
  if (!modelSizeValue) return

  if (isSubModel) {
    const { width, height } = modelSizeValue

    appWindow.setSize(new PhysicalSize({
      width: Math.round(width * (scale / 100)),
      height: Math.round(height * (scale / 100)),
    }))
    return
  }

  const layout = calculatePomodoroWindowLayout({
    modelSize: modelSizeValue,
    modelScale: scale,
    displayEnabled: pomodoroStore.settings.displayEnabled,
    displayScale: pomodoroStore.settings.displayScale,
  })

  appWindow.setSize(new PhysicalSize(layout.window))
}

function resolveModelSwitchTarget(request: ModelSwitchRequest) {
  const storedModel = modelStore.models.find(model => model.id === request.model.id)

  if (!storedModel) {
    throw new Error(`Model ${request.model.id} is not installed in the main window.`)
  }

  if (storedModel.path !== request.model.path) {
    logWarn('[model-switch] ignored stale model path from event snapshot', {
      requestId: request.requestId,
      modelId: storedModel.id,
      storedPath: storedModel.path,
      requestedPath: request.model.path,
    })
  }

  return storedModel
}

function acknowledgeModelSwitch(acknowledgement: ModelSwitchAcknowledgement) {
  void emitTo(WINDOW_LABEL.PREFERENCE, LISTEN_KEY.MODEL_SWITCH_APPLIED, acknowledgement)
    .then(() => logStep('model-switch', 'sent acknowledgement to preference window', acknowledgement))
    .catch(error => logError('[model-switch] failed to send acknowledgement', { ...acknowledgement, error }))
}

useTauriListen<ModelSwitchRequest>(LISTEN_KEY.MODEL_SWITCH_REQUESTED, async ({ payload }) => {
  const context = {
    requestId: payload.requestId,
    modelId: payload.model.id,
    modelPath: payload.model.path,
    modelMode: payload.model.mode,
    isPreset: payload.model.isPreset,
  }
  logInfo('[model-switch] main window received request', context)

  if (modelSwitchRequestInProgress) {
    acknowledgeModelSwitch({
      requestId: payload.requestId,
      modelId: payload.model.id,
      accepted: false,
      reason: 'Another model switch is already in progress.',
    })
    return
  }

  modelSwitchRequestInProgress = true

  try {
    const targetModel = resolveModelSwitchTarget(payload)
    const previousModel = modelStore.currentModel
    const previousModelId = modelStore.currentModelId
    const previousModelFingerprint = modelStore.currentModelFingerprint
    const previousSelectionMigrationPending = modelStore.selectionMigrationPending
    const canvas = live2dCanvas.value

    if (!canvas) throw new Error('The main model canvas is not ready.')

    explicitModelSwitchInProgress = true
    modelStore.currentModel = targetModel
    await nextTick()

    const result = await executeModelSwitchTransaction({
      loadTarget: async () => {
        const loaded = await loadModel(targetModel, canvas, modelLoadTrigger.value)
        if (!loaded) throw new Error('The model load was superseded before it completed.')
      },
      commitSelection: () => {
        modelStore.currentModelId = targetModel.id
        modelStore.currentModelFingerprint = targetModel.fingerprint ?? null
        modelStore.selectionMigrationPending = false
      },
      persistSelection: () => requestModelStoreSave(modelStore.$state, {
        persistModelCatalog: modelStore.customModelScanSucceeded,
      }),
      rollbackSelection: async (selectionCommitted) => {
        modelStore.currentModel = previousModel
        modelStore.currentModelId = previousModelId
        modelStore.currentModelFingerprint = previousModelFingerprint
        modelStore.selectionMigrationPending = previousSelectionMigrationPending

        if (selectionCommitted) {
          await requestModelStoreSave(modelStore.$state, {
            persistModelCatalog: modelStore.customModelScanSucceeded,
          })
        }
      },
      restorePrevious: async () => {
        if (!previousModel) return
        await nextTick()
        await loadModel(previousModel, canvas, modelLoadTrigger.value)
      },
    })

    acknowledgeModelSwitch({
      requestId: payload.requestId,
      modelId: targetModel.id,
      ...result,
    })
  } catch (error) {
    logError('[model-switch] main window failed to apply request', { ...context, error })
    modelStore.modelReady = true
    acknowledgeModelSwitch({
      requestId: payload.requestId,
      modelId: payload.model.id,
      accepted: false,
      reason: String(error),
    })
  } finally {
    explicitModelSwitchInProgress = false
    modelSwitchRequestInProgress = false
  }
})

function getTypingStatsState(): TypingStatsState {
  return {
    dailyCounts: { ...typingStatsStore.dailyCounts },
    enabled: typingStatsStore.enabled,
  }
}

function applyTypingStatsState(state: TypingStatsState) {
  typingStatsStore.dailyCounts = { ...state.dailyCounts }
  typingStatsStore.enabled = state.enabled
}

function acknowledgeTypingStatsOperation(acknowledgement: TypingStatsOperationAcknowledgement) {
  void emit(LISTEN_KEY.TYPING_STATS_OPERATION_APPLIED, acknowledgement)
    .catch(error => logError('[typing-stats] failed to send acknowledgement', {
      ...acknowledgement,
      error,
    }))
}

async function applyTypingStatsOperation(request: TypingStatsOperationRequest) {
  const context = {
    requestId: request.requestId,
    operation: request.operation,
  }

  logDebug('[typing-stats] main operation received', context)
  await waitForTypingStatsPersistenceHydration()
  logDebug('[typing-stats] main persistence hydrated', context)

  const { operation } = request
  let result: Pick<TypingStatsOperationAcknowledgement, 'accepted' | 'reason'>

  if (operation.kind === 'resume') {
    try {
      const replayedInputCount = typingStatsCoordinator.resumeInputs(operation.pauseId, applyTypingInput)

      if (replayedInputCount > 0) {
        await requestTypingStatsStoreSave(getTypingStatsState())
      }
      result = { accepted: true }
    } catch (error) {
      result = {
        accepted: false,
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  } else if (operation.kind === 'flush') {
    typingStatsCoordinator.pauseInputs(operation.pauseId)

    try {
      await requestTypingStatsStoreSave(getTypingStatsState())
      result = { accepted: true }
    } catch (error) {
      typingStatsCoordinator.resumeInputs(operation.pauseId, applyTypingInput)
      result = {
        accepted: false,
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  } else {
    result = await executeTypingStatsMutationTransaction({
      snapshot: getTypingStatsState,
      apply: () => {
        if (operation.kind === 'set-enabled') {
          typingStatsStore.enabled = operation.enabled
        } else {
          typingStatsStore.clearHistory()
        }
      },
      persist: () => requestTypingStatsStoreSave(getTypingStatsState()),
      restore: async (snapshot) => {
        applyTypingStatsState(snapshot)
        await requestTypingStatsStoreSave(snapshot)
      },
    })
  }

  acknowledgeTypingStatsOperation({
    requestId: request.requestId,
    state: getTypingStatsState(),
    ...result,
  })
  logInfo('[typing-stats] main operation applied', { ...context, ...result })
}

useTauriListen<TypingStatsOperationRequest>(LISTEN_KEY.TYPING_STATS_OPERATION_REQUESTED, ({ payload }) => {
  if (isSubModel) return

  void typingStatsCoordinator.run(() => applyTypingStatsOperation(payload))
    .catch((error) => {
      logError('[typing-stats] main operation failed', {
        requestId: payload.requestId,
        operation: payload.operation,
        error,
      })
      acknowledgeTypingStatsOperation({
        accepted: false,
        reason: error instanceof Error ? error.message : String(error),
        requestId: payload.requestId,
        state: getTypingStatsState(),
      })
    })
})

onMounted(async () => {
  if (!isSubModel) {
    pomodoroDisplayTimer = setInterval(() => {
      pomodoroNow.value = Date.now()
    }, 250)
    await waitForTypingStatsPersistenceHydration()
    startListening()
    return
  }

  appWindow.onMoved(({ payload }) => {
    const instance = subModel.value

    if (!instance) return

    instance.window.x = payload.x
    instance.window.y = payload.y
    reportSubModelWindowChange(instance)
  })

  appWindow.onCloseRequested(() => {
    const instance = subModel.value

    if (!instance) return

    instance.visible = false
    live2d.setRenderingEnabled(false)
    const generation = ++subModelRuntimeGeneration
    void updateSubModelWindowRuntimeState(instance, {
      modelReady: false,
      renderingEnabled: false,
    }, generation)
    void emit(LISTEN_KEY.SUB_MODEL_VISIBILITY_CHANGED, { id: instance.id, visible: false })
  })
})

onUnmounted(() => {
  logStep('model-load', 'window unmounted', { windowLabel: appWindow.label })
  inputCoordinator?.dispose()
  currentModelLoadVersion += 1
  handleDestroy()
  if (pomodoroDisplayTimer) clearInterval(pomodoroDisplayTimer)
})

const debouncedResize = useDebounceFn(async () => {
  await handleResize({ syncScale: !scalingWithShortcut })
}, 16)

useEventListener('resize', () => {
  debouncedResize()
})

async function loadModel(model: Model, canvas: HTMLCanvasElement, loadTrigger: number) {
  const loadVersion = ++currentModelLoadVersion
  const runtimeGeneration = isSubModel ? ++subModelRuntimeGeneration : undefined
  const modelContext = {
    windowLabel: appWindow.label,
    loadVersion,
    modelId: model.id,
    modelPath: model.path,
    modelMode: model.mode,
    isPreset: model.isPreset,
    importKind: model.importKind,
    proofStatus: model.proofStatus,
    loadTrigger,
  }

  logInfo('[model-load] started', modelContext)
  logStep('model-load', 'set modelReady=false', modelContext)

  if (isSubModel && subModelId) {
    const instance = subModel.value
    if (instance) {
      await updateSubModelWindowRuntimeState(instance, {
        modelReady: false,
        renderingEnabled: false,
      }, runtimeGeneration)
    }
  }

  modelStore.modelReady = false
  let runtimeReady = false

  try {
    logStep('model-load', 'prepare runtime lease', modelContext)
    await ensureRuntimeLease(model)
    logStep('model-load', 'runtime lease ready', modelContext)

    if (loadVersion !== currentModelLoadVersion) {
      logStep('model-load', 'cancelled after runtime lease preparation', {
        ...modelContext,
        currentLoadVersion: currentModelLoadVersion,
      })
      return false
    }

    logStep('model-load', 'initialize Live2D', modelContext)
    await handleLoad(canvas)
    logStep('model-load', 'Live2D initialized', modelContext)

    if (loadVersion !== currentModelLoadVersion) {
      logStep('model-load', 'cancelled after Live2D initialization', {
        ...modelContext,
        currentLoadVersion: currentModelLoadVersion,
      })
      return false
    }

    logStep('model-load', 'report opened event', modelContext)
    reportRuntimeEventQuietly(model, 'opened')

    const path = join(model.path, 'resources', 'background.png')
    logStep('model-load', 'check background resource', { ...modelContext, path })
    const existed = await exists(path)

    if (loadVersion !== currentModelLoadVersion) {
      logStep('model-load', 'cancelled after background resource check', {
        ...modelContext,
        currentLoadVersion: currentModelLoadVersion,
      })
      return false
    }

    backgroundImagePath.value = existed ? convertFileSrc(path) : void 0
    logTrace('[model-load] background resource applied', { ...modelContext, path, exists: existed })

    clearObject([modelStore.supportKeys, modelStore.pressedKeys, modelStore.activeKeys])
    logStep('model-load', 'cleared input resource state', modelContext)

    const resourcePath = join(model.path, 'resources')
    const groups = [
      { name: 'keyboards', type: 'overlay' as const },
      { name: 'faces', type: 'overlay' as const },
      { name: 'left-keys', type: 'left' as const },
      { name: 'right-keys', type: 'right' as const },
    ]

    for await (const group of groups) {
      const groupDir = join(resourcePath, group.name)
      logStep('model-load', 'scan input resource group', { ...modelContext, group: group.name, groupDir })
      const files = await readDir(groupDir).catch(() => [])
      const imageFiles = files.filter(file => isImage(file.name))
      logDebug('[model-load] input resource group scanned', {
        ...modelContext,
        group: group.name,
        fileCount: files.length,
        imageCount: imageFiles.length,
      })
      logTrace('[model-load] input resource group files', {
        ...modelContext,
        group: group.name,
        files: imageFiles.map(file => file.name),
      })

      for (const file of imageFiles) {
        if (loadVersion !== currentModelLoadVersion) {
          logStep('model-load', 'cancelled while scanning input resources', {
            ...modelContext,
            currentLoadVersion: currentModelLoadVersion,
            group: group.name,
          })
          return false
        }

        const fileName = file.name.split('.')[0]

        modelStore.supportKeys[fileName] ??= []
        modelStore.supportKeys[fileName].push({
          path: join(groupDir, file.name),
          type: group.type,
        })
        logTrace('[model-load] registered input resource', {
          ...modelContext,
          group: group.name,
          file: file.name,
          shortcut: fileName,
          type: group.type,
        })
      }
    }
    logInfo('[model-load] completed', modelContext)
    if (isSubModel && subModelId && loadVersion === currentModelLoadVersion) {
      const instance = subModel.value
      if (instance) {
        if (loadVersion !== currentModelLoadVersion) return false
        await updateSubModelWindowRuntimeState(instance, {
          modelReady: true,
          renderingEnabled: true,
        }, runtimeGeneration)
      }
      runtimeReady = true
    }
  } catch (error) {
    if (loadVersion !== currentModelLoadVersion) {
      logStep('model-load', 'ignored error from stale load', {
        ...modelContext,
        currentLoadVersion: currentModelLoadVersion,
        error,
      })
      return false
    }

    console.warn('[mochi-paw] failed to load current model:', error)
    logError('[model-load] failed', { ...modelContext, error })
    message.error(String(error))
    throw error
  } finally {
    if (loadVersion === currentModelLoadVersion) {
      modelStore.modelReady = true
      if (isSubModel && subModelId && !runtimeReady) {
        const instance = subModel.value
        if (instance) {
          await updateSubModelWindowRuntimeState(instance, {
            modelReady: false,
            renderingEnabled: false,
          }, runtimeGeneration)
        }
      }
      logStep('model-load', 'set modelReady=true', modelContext)
    } else {
      logTrace('[model-load] left modelReady to newer load', {
        ...modelContext,
        currentLoadVersion: currentModelLoadVersion,
      })
    }
  }

  return true
}

watch([() => {
  const model = activeModel.value

  return model ? `${model.id}:${model.path}` : ''
}, live2dCanvas, modelLoadTrigger], async ([, canvas, loadTrigger]) => {
  const model = activeModel.value

  if (explicitModelSwitchInProgress) {
    logTrace('[model-load] watcher deferred to explicit model switch', {
      windowLabel: appWindow.label,
      modelId: model?.id,
      loadTrigger,
    })
    return
  }

  // An immediate watcher can run before the component's canvas is mounted.
  // Watching the template ref retries the current model as soon as it exists.
  if (!model || !canvas) {
    logTrace('[model-load] watcher skipped because model or canvas is unavailable', {
      windowLabel: appWindow.label,
      hasModel: Boolean(model),
      hasCanvas: Boolean(canvas),
      loadTrigger,
    })
    return
  }

  try {
    await loadModel(model, canvas, loadTrigger)
  } catch {
    // loadModel already reports user-visible and diagnostic errors.
  }
}, { flush: 'post', immediate: true })

watch([
  () => windowSettings.value.scale,
  () => pomodoroStore.settings.displayEnabled,
  () => pomodoroStore.settings.displayScale,
  modelSize,
], ([scale, , , modelSize]) => {
  if (!modelSize) return

  cancelAnimationFrame(resizeFrame)

  resizeFrame = requestAnimationFrame(() => {
    if (scalingWithShortcut) {
      const now = performance.now()

      if (now - lastShortcutResizeAt < SHORTCUT_RESIZE_INTERVAL) return

      lastShortcutResizeAt = now
    }

    applyWindowScale(scale, modelSize)
  })
}, { immediate: true })

watch([modelStore.pressedKeys, stickActive], ([keys, stickActive]) => {
  const layers = Object.values(keys).flat()
  const hasLeft = layers.some(layer => layer.type === 'left')
  const hasRight = layers.some(layer => layer.type === 'right')

  handleKeyChange(true, stickActive.left || hasLeft)
  handleKeyChange(false, stickActive.right || hasRight)
}, { deep: true })

if (!isSubModel) {
  watch(() => catStore.window.visible, async (value) => {
    value ? showWindow() : hideWindow()
  })
}

watch(() => windowSettings.value.passThrough, (value) => {
  if (isWindows && !isSubModel) {
    setPassThrough(value)
  } else if (isSubModel) {
    const instance = subModel.value
    if (instance) void updateSubModelWindowRuntimeState(instance, {})
  } else {
    appWindow.setIgnoreCursorEvents(value)
  }
}, { immediate: true })

watch(() => windowSettings.value.alwaysOnTop, setAlwaysOnTop, { immediate: true })

if (!isSubModel) {
  watch([
    () => catStore.window.gameMode.enabled,
    () => catStore.window.gameMode.processes,
    () => catStore.window.alwaysOnTop,
    () => catStore.window.passThrough,
  ], ([enabled, processes, alwaysOnTop, passThrough]) => {
    void setGameMode({ enabled, processes, alwaysOnTop, passThrough }).then((active) => {
      logInfo('[game-mode] configuration applied', {
        windowLabel: appWindow.label,
        enabled,
        processes,
        alwaysOnTop,
        passThrough,
        active,
      })
      gameModeActive.value = active
    })
  }, { deep: true, immediate: true })
}

if (!isSubModel) {
  watch(() => generalStore.app.taskbarVisible, setTaskbarVisibility, { immediate: true })
}

watch(() => catStore.model.motionSound, live2d.setMotionSoundEnabled, { immediate: true })

watch([() => appearanceSettings.value.maxFPS, gameModeActive], ([fps, active]) => {
  const effectiveFPS = resolveEffectiveMaxFPS(fps, active)
  logInfo('[render] max FPS updated', {
    windowLabel: appWindow.label,
    configuredFPS: fps,
    gameModeActive: active,
    effectiveFPS,
  })
  live2d.setMaxFPS(effectiveFPS)
}, { immediate: true })

useTauriListen<boolean>(LISTEN_KEY.GAME_MODE_CHANGED, ({ payload }) => {
  if (isSubModel) return

  logInfo('[game-mode] active state changed', {
    windowLabel: appWindow.label,
    active: payload,
  })
  gameModeActive.value = payload
})

useTauriListen<{
  id: string
  motion: ModelMotionInfo
  groupId?: string
}>(LISTEN_KEY.START_MOTION, ({ payload }) => {
  playMotionBehavior(payload.id, payload.motion, payload.groupId)
})

useTauriListen<{
  id: string
  index: number
  groupId?: string
}>(LISTEN_KEY.SET_EXPRESSION, ({ payload }) => {
  playExpressionBehavior(payload.id, payload.index, payload.groupId)
})

useTauriListen<boolean>(LISTEN_KEY.SET_SUB_MODEL_RENDERING, ({ payload }) => {
  if (!isSubModel) return

  live2d.setRenderingEnabled(payload)
  const instance = subModel.value
  if (instance) {
    const generation = payload ? subModelRuntimeGeneration : ++subModelRuntimeGeneration
    void updateSubModelWindowRuntimeState(instance, { renderingEnabled: payload }, generation)
  }
})

const subModelConfigListener = useTauriListen<SubModelInstance>(LISTEN_KEY.UPDATE_SUB_MODEL, ({ payload }) => {
  if (!isSubModel || payload.id !== subModelId) return

  syncedSubModel.value = payload
  void updateSubModelWindowRuntimeState(payload, {
    modelReady: modelStore.modelReady && Boolean(live2d.model),
    renderingEnabled: Boolean(live2d.model),
  }, subModelRuntimeGeneration)
})

const subModelInputListener = useTauriListen<SubModelInputFrame>(LISTEN_KEY.SUB_MODEL_INPUT_FRAME, ({ payload }) => {
  if (!isSubModel) return

  for (const event of payload.deviceEvents) {
    handleDeviceInputEvent(event)
  }

  for (const event of payload.gamepadEvents) {
    handleGamepadInputEvent(event)
  }
})

onMounted(async () => {
  if (!isSubModel || !subModelId) return

  await Promise.all([subModelConfigListener.ready, subModelInputListener.ready])
  await emit(LISTEN_KEY.SUB_MODEL_RUNTIME_READY, { id: subModelId })
})

function handleMouseDown(event: MouseEvent) {
  if (windowSettings.value.passThrough || event.button !== 0) return

  appWindow.startDragging()
}

async function handleContextmenu(event: MouseEvent) {
  event.preventDefault()

  if (event.ctrlKey) return

  const menu = await Menu.new({
    items: [
      ...await getBaseMenu(),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      ...await getExitMenu(),
    ],
  })

  // Temporarily disable always-on-top on Windows so the context menu is not covered
  if (isWindows && windowSettings.value.alwaysOnTop) {
    setAlwaysOnTop(false)
  }

  await menu.popup()

  // Restore always-on-top after the menu is closed
  if (!isWindows || !windowSettings.value.alwaysOnTop) return

  setAlwaysOnTop(true)
}

function handleMouseMove(event: MouseEvent) {
  const { buttons, ctrlKey, movementX, movementY } = event

  if (windowSettings.value.passThrough || buttons !== 2 || !ctrlKey) return

  pendingScaleDelta += (movementX + movementY) * SCALE_DRAG_SENSITIVITY

  if (scaleFrame) return

  scaleFrame = requestAnimationFrame(() => {
    scaleFrame = 0

    if (Math.abs(pendingScaleDelta) < 0.1) {
      pendingScaleDelta = 0
      return
    }

    const nextScale = Math.max(10, Math.min(windowSettings.value.scale + pendingScaleDelta, 500))

    pendingScaleDelta = 0
    scalingWithShortcut = true
    windowSettings.value.scale = round(nextScale)

    reportCurrentSubModelWindowChange()

    if (scaleSyncTimer) {
      clearTimeout(scaleSyncTimer)
    }

    scaleSyncTimer = setTimeout(() => {
      applyWindowScale(windowSettings.value.scale)
      scalingWithShortcut = false
    }, 120)
  })
}
</script>

<template>
  <div
    class="main-window flex flex-col overflow-hidden"
    :style="{
      opacity: windowSettings.opacity / 100,
      borderRadius: `${windowSettings.radius}%`,
    }"
  >
    <div
      class="model-area relative w-full shrink-0 overflow-hidden children:(absolute size-full)"
      :class="{ '-scale-x-100': appearanceSettings.mirror }"
      :style="{ aspectRatio: modelAspectRatio }"
      @contextmenu="handleContextmenu"
      @mousedown="handleMouseDown"
      @mousemove="handleMouseMove"
    >
      <img
        v-if="backgroundImagePath"
        class="object-cover"
        :src="backgroundImagePath"
      >

      <canvas
        id="live2dCanvas"
        ref="live2dCanvas"
      />

      <img
        v-for="{ key, path } in pressedKeyLayers"
        :key="key"
        class="object-cover"
        :src="convertFileSrc(path)"
      >

      <div
        v-show="!modelStore.modelReady"
        class="flex items-center justify-center bg-black"
      />
    </div>

    <div
      v-if="pomodoroLayout?.timer.height"
      class="timer-display w-full flex shrink-0 items-center justify-center font-semibold font-mono"
      :style="{
        height: `${pomodoroLayout.timer.height}px`,
        fontSize: `${pomodoroLayout.timer.fontSize}px`,
        lineHeight: '1',
      }"
    >
      {{ pomodoroDisplayText }}
    </div>
  </div>
</template>

<style scoped>
.timer-display {
  color: rgb(255 255 255 / 95%);
  text-shadow:
    0 1px 3px rgb(0 0 0 / 90%),
    0 0 1px rgb(0 0 0 / 100%);
}
</style>
