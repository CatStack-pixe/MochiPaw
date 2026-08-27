<!-- SPDX-FileCopyrightText: 2025 ayangweb
  SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { HappyProvider } from '@antdv-next/happy-work-theme'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { error } from '@tauri-apps/plugin-log'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useEventListener } from '@vueuse/core'
import { ConfigProvider, theme } from 'antdv-next'
import { isString } from 'es-toolkit'
import isURL from 'is-url'
import { storeToRefs } from 'pinia'
import { nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterView } from 'vue-router'

import type { PomodoroPhase } from './utils/pomodoroClock'
import type { DeviceInputEvent, SubModelInputFrame } from './utils/subModelRuntime'

import { useKeyPress } from './composables/useKeyPress'
import { useTauriListen } from './composables/useTauriListen'
import { useWindowState } from './composables/useWindowState'
import { LANGUAGE, LISTEN_KEY, WINDOW_LABEL } from './constants'
import { getAntdLocale } from './locales/index.ts'
import { hideWindow, setWebviewMemoryTarget, showWindow, toggleWindowVisible } from './plugins/window'
import { useAppStore } from './stores/app'
import { useCatStore } from './stores/cat'
import { useGeneralStore } from './stores/general'
import { useModelStore } from './stores/model'
import { setPomodoroPersistenceWritable, usePomodoroStore } from './stores/pomodoro'
import { useShortcutStore } from './stores/shortcut.ts'
import {
  markTypingStatsPersistenceHydrated,
  setTypingStatsPersistenceWritable,
  useTypingStatsStore,
} from './stores/typingStats'
import { logError, logInfo, logStartupDiagnostics, logStep } from './utils/diagnostics'
import { requestModelStoreSave } from './utils/modelPersistence'
import { setCoreStoresPersistenceWritable } from './utils/persistence'
import { startPomodoroCoordinator } from './utils/pomodoroCoordinator'
import { requestPomodoroCommand } from './utils/pomodoroRequest'
import { getSubModelRuntimeCapacity } from './utils/subModelRuntime'
import { openSubModelWindow } from './utils/subModelWindow'
import { WebviewIdleMemoryController } from './utils/webviewIdleMemory'

const appStore = useAppStore()
const modelStore = useModelStore()
const catStore = useCatStore()
const generalStore = useGeneralStore()
const shortcutStore = useShortcutStore()
const typingStatsStore = useTypingStatsStore()
const pomodoroStore = usePomodoroStore()
const {
  visibleCat,
  visiblePreference,
  mirrorMode,
  penetrable,
  alwaysOnTop,
  gameMode,
  pomodoroStart,
  pomodoroPause,
  pomodoroResume,
  pomodoroReset,
} = storeToRefs(shortcutStore)
const appWindow = getCurrentWebviewWindow()
const isSubModelWindow = appWindow.label.startsWith('sub-model-')
setCoreStoresPersistenceWritable(!isSubModelWindow)
setPomodoroPersistenceWritable(appWindow.label === WINDOW_LABEL.MAIN)
const idleMemory = new WebviewIdleMemoryController({
  setTarget: setWebviewMemoryTarget,
  allowIdleLow: () => document.hidden || appWindow.label === WINDOW_LABEL.PREFERENCE,
  onIdleLowDecision: (event) => {
    logInfo('[webview-memory] idle target evaluated', {
      windowLabel: appWindow.label,
      ...event,
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
    })
  },
  onTargetChange: (event) => {
    logInfo('[webview-memory] target changed', {
      windowLabel: appWindow.label,
      ...event,
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
    })
  },
})
const { isRestored, restoreState } = useWindowState({ enabled: !isSubModelWindow })
const { darkAlgorithm, defaultAlgorithm } = theme
const { locale, t } = useI18n()

function runPomodoroShortcut(command: 'start' | 'pause' | 'resume' | 'reset') {
  void requestPomodoroCommand(command).catch((error) => {
    logError('[shortcut] Pomodoro command failed', { command, error })
  })
}

if (appWindow.label === WINDOW_LABEL.MAIN) {
  useKeyPress(visibleCat, () => {
    catStore.window.visible = !catStore.window.visible
  })

  useKeyPress(visiblePreference, () => {
    toggleWindowVisible(WINDOW_LABEL.PREFERENCE)
  })

  useKeyPress(mirrorMode, () => {
    catStore.model.mirror = !catStore.model.mirror
  })

  useKeyPress(penetrable, () => {
    catStore.window.passThrough = !catStore.window.passThrough
  })

  useKeyPress(alwaysOnTop, () => {
    catStore.window.alwaysOnTop = !catStore.window.alwaysOnTop
  })

  useKeyPress(gameMode, () => {
    catStore.window.gameMode.enabled = !catStore.window.gameMode.enabled
  })

  useKeyPress(pomodoroStart, () => runPomodoroShortcut('start'))
  useKeyPress(pomodoroPause, () => runPomodoroShortcut('pause'))
  useKeyPress(pomodoroResume, () => runPomodoroShortcut('resume'))

  useKeyPress(pomodoroReset, () => {
    runPomodoroShortcut('reset')
  })
}

async function persistInitializedModelState(result: Awaited<ReturnType<typeof modelStore.init>>) {
  logStep('model-persistence', 'persist initialized model state', {
    windowLabel: appWindow.label,
    ...result,
  })

  try {
    await nextTick()
    await requestModelStoreSave(modelStore.$state, {
      persistModelCatalog: result.customModelScanSucceeded,
    })
    logInfo('[model-persistence] initialized model state saved', {
      windowLabel: appWindow.label,
      ...result,
    })
  } catch (error) {
    logError('[model-persistence] failed to persist initialized model state', {
      windowLabel: appWindow.label,
      ...result,
      error,
    })
  }
}

async function initializeModelStore() {
  logStep('app-init', 'start model persistence', { windowLabel: appWindow.label })
  await modelStore.$tauri.start()
  logStep('app-init', 'initialize model store', { windowLabel: appWindow.label })
  const result = await modelStore.init()

  if (appWindow.label === WINDOW_LABEL.MAIN) {
    void persistInitializedModelState(result)
  }

  return result
}

void logStartupDiagnostics(appWindow.label).catch((error) => {
  logError('[startup] diagnostic collection failed', { windowLabel: appWindow.label, error })
})

function formatError(reason: unknown) {
  if (reason instanceof Error) {
    return `${reason.name}: ${reason.message}\n${reason.stack ?? ''}`
  }

  if (isString(reason)) return reason
  if (reason == null) return String(reason)

  return JSON.stringify(reason, Object.getOwnPropertyNames(reason)) ?? String(reason)
}

function handleInputFrame(frame: SubModelInputFrame) {
  const onlyMouseMoves = frame.deviceEvents.length > 0
    && frame.gamepadEvents.length === 0
    && frame.deviceEvents.every(event => event.kind === 'MouseMove')

  if (onlyMouseMoves) {
    idleMemory.mouseMove()
  } else if (frame.deviceEvents.length || frame.gamepadEvents.length) {
    idleMemory.activity()
  }
}

let unlistenFocus: (() => void) | undefined
let idleMemoryDisposed = false
let stopPomodoroCoordinator: (() => void) | undefined
let pomodoroNotificationPermission: Promise<boolean> | undefined

async function ensurePomodoroNotificationPermission() {
  try {
    const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification')

    pomodoroNotificationPermission ??= (async () => {
      if (await isPermissionGranted()) return true

      return (await requestPermission()) === 'granted'
    })()

    return await pomodoroNotificationPermission
  } catch (error) {
    logError('[pomodoro] notification permission unavailable', { error })
    return false
  }
}

async function sendPomodoroNotification(phase: PomodoroPhase) {
  if (!await ensurePomodoroNotificationPermission()) return

  const { sendNotification } = await import('@tauri-apps/plugin-notification')

  await sendNotification({
    title: t('pages.pomodoro.notifications.title'),
    body: t(`pages.pomodoro.notifications.${phase}`),
  })
}

let pomodoroAudioContext: AudioContext | undefined

async function playPomodoroSound() {
  const AudioContextClass = window.AudioContext
  if (!AudioContextClass) return

  pomodoroAudioContext ??= new AudioContextClass()
  if (pomodoroAudioContext.state === 'suspended') await pomodoroAudioContext.resume()

  const context = pomodoroAudioContext
  const oscillator = context.createOscillator()
  const gain = context.createGain()

  oscillator.frequency.value = 880
  gain.gain.setValueAtTime(0.08, context.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.35)
  oscillator.connect(gain)
  gain.connect(context.destination)
  oscillator.start()
  oscillator.stop(context.currentTime + 0.35)
}

onMounted(async () => {
  idleMemory.start(document.hidden)
  logInfo('[window] initial focus and visibility state', {
    windowLabel: appWindow.label,
    visibility: document.visibilityState,
    hidden: document.hidden,
    hasFocus: document.hasFocus(),
  })

  const unlisten = await appWindow.onFocusChanged(({ payload: focused }) => {
    logInfo('[window] focus changed', {
      windowLabel: appWindow.label,
      focused,
      visibility: document.visibilityState,
      hidden: document.hidden,
      hasFocus: document.hasFocus(),
    })
    if (focused) idleMemory.activate()
  })

  if (idleMemoryDisposed) {
    unlisten()
  } else {
    unlistenFocus = unlisten
  }
})

onUnmounted(() => {
  idleMemoryDisposed = true
  unlistenFocus?.()
  idleMemory.dispose()
  stopPomodoroCoordinator?.()
})

useEventListener(document, 'visibilitychange', () => {
  logInfo('[window] visibility changed', {
    windowLabel: appWindow.label,
    visibility: document.visibilityState,
    hidden: document.hidden,
    hasFocus: document.hasFocus(),
  })
  idleMemory.setHidden(document.hidden)
})

useEventListener(window, 'keydown', () => idleMemory.activity())
useEventListener(window, 'pointerdown', () => idleMemory.activity())
useEventListener(window, 'pointermove', () => idleMemory.mouseMove())
useEventListener(window, 'touchstart', () => idleMemory.activity(), { passive: true })
useEventListener(window, 'wheel', () => idleMemory.activity(), { passive: true })

useTauriListen<DeviceInputEvent>(LISTEN_KEY.DEVICE_CHANGED, ({ payload }) => {
  if (payload.kind === 'MouseMove') {
    idleMemory.mouseMove()
  } else {
    idleMemory.activity()
  }
})

useTauriListen(LISTEN_KEY.GAMEPAD_CHANGED, () => idleMemory.activity())

useTauriListen<SubModelInputFrame>(LISTEN_KEY.SUB_MODEL_INPUT_FRAME, ({ payload }) => {
  handleInputFrame(payload)
})

onMounted(async () => {
  logInfo('[app-init] started', { windowLabel: appWindow.label, isSubModelWindow })
  if (isSubModelWindow) {
    await initializeModelStore()
    await catStore.$tauri.start()
    logStep('app-init', 'initialize cat store', { windowLabel: appWindow.label })
    catStore.init()
    await generalStore.$tauri.start()
    logStep('app-init', 'initialize general store', { windowLabel: appWindow.label })
    await generalStore.init()
    await restoreState()
    logInfo('[app-init] submodel initialization completed', { windowLabel: appWindow.label })
    return
  }

  logStep('app-init', 'start app persistence', { windowLabel: appWindow.label })
  await appStore.$tauri.start()
  logStep('app-init', 'initialize app store', { windowLabel: appWindow.label })
  await appStore.init()

  // Register the main-window Pomodoro command listener before model scanning so
  // Preferences commands cannot be lost during a slow startup.
  if (appWindow.label === WINDOW_LABEL.MAIN) {
    await pomodoroStore.$tauri.start()
    pomodoroStore.normalizePersistedState()
    pomodoroStore.reconcile()
    stopPomodoroCoordinator = await startPomodoroCoordinator(pomodoroStore, {
      notify: sendPomodoroNotification,
      playSound: playPomodoroSound,
      prepareNotifications: ensurePomodoroNotificationPermission,
    })
  }

  await initializeModelStore()
  logStep('app-init', 'start cat persistence', { windowLabel: appWindow.label })
  await catStore.$tauri.start()
  logStep('app-init', 'initialize cat store', { windowLabel: appWindow.label })
  catStore.init()
  logStep('app-init', 'start general persistence', { windowLabel: appWindow.label })
  await generalStore.$tauri.start()
  logStep('app-init', 'initialize general store', { windowLabel: appWindow.label })
  await generalStore.init()
  logStep('app-init', 'start shortcut persistence', { windowLabel: appWindow.label })
  await shortcutStore.$tauri.start()
  logStep('app-init', 'start typing stats persistence', { windowLabel: appWindow.label })
  setTypingStatsPersistenceWritable(appWindow.label === WINDOW_LABEL.MAIN)
  await typingStatsStore.$tauri.start()
  markTypingStatsPersistenceHydrated()
  if (appWindow.label !== WINDOW_LABEL.MAIN) {
    await pomodoroStore.$tauri.start()
    pomodoroStore.normalizePersistedState()
    pomodoroStore.reconcile()
  }
  await restoreState()
  logStep('app-init', 'application state restored', { windowLabel: appWindow.label })

  if (appWindow.label === WINDOW_LABEL.MAIN) {
    for (const instance of modelStore.subModels.filter(item => item.visible && item.showOnLaunch)) {
      const capacity = await getSubModelRuntimeCapacity(
        modelStore.subModels,
        modelStore.models,
        modelStore.currentModel,
      )

      if (!capacity.allowed) {
        instance.visible = false
        error(`[sub-model] skipped ${instance.id}: runtime resource budget exceeded`)
        continue
      }

      try {
        logStep('app-init', 'restore submodel window', { instanceId: instance.id, modelId: instance.modelId })
        await openSubModelWindow(instance)
      } catch (reason) {
        instance.visible = false
        error(`[sub-model] failed to restore ${instance.id}: ${formatError(reason)}`)
        logError('[app-init] failed to restore submodel window', { instanceId: instance.id, modelId: instance.modelId, error: reason })
      }
    }
  }

  logInfo('[app-init] completed', { windowLabel: appWindow.label })
})

watch(() => generalStore.appearance.language, (value) => {
  locale.value = value ?? LANGUAGE.EN_US
})

useTauriListen(LISTEN_KEY.SHOW_WINDOW, ({ payload }) => {
  if (appWindow.label !== payload) return

  idleMemory.activate()
  showWindow()
})

useTauriListen(LISTEN_KEY.HIDE_WINDOW, ({ payload }) => {
  if (appWindow.label !== payload) return

  idleMemory.setHidden(true)
  hideWindow()
})

useEventListener('unhandledrejection', ({ reason }) => {
  error(formatError(reason))
})

useEventListener('click', (event) => {
  const link = (event.target as HTMLElement).closest('a')

  if (!link) return

  const { href, target } = link

  if (target === '_blank') return

  event.preventDefault()

  if (!isURL(href)) return

  openUrl(href)
})
</script>

<template>
  <HappyProvider
    v-slot="{ wave }"
    enabled
  >
    <ConfigProvider
      :locale="getAntdLocale(generalStore.appearance.language)"
      :theme="{
        algorithm: generalStore.appearance.isDark ? darkAlgorithm : defaultAlgorithm,
      }"
      :wave="wave"
    >
      <RouterView v-if="isRestored" />
    </ConfigProvider>
  </HappyProvider>
</template>
