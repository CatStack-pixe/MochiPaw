<!-- SPDX-FileCopyrightText: 2025 ayangweb
  SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { convertFileSrc } from '@tauri-apps/api/core'
import { PhysicalSize } from '@tauri-apps/api/dpi'
import { emit } from '@tauri-apps/api/event'
import { Menu, PredefinedMenuItem } from '@tauri-apps/api/menu'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { exists, readDir } from '@tauri-apps/plugin-fs'
import { useDebounceFn, useEventListener } from '@vueuse/core'
import { round } from 'es-toolkit'
import { computed, onMounted, onUnmounted, ref, toRaw, watch } from 'vue'
import { useRoute } from 'vue-router'

import type { ModelMotionInfo, SubModelInstance } from '@/stores/model'

import { useAppMenu } from '@/composables/useAppMenu'
import { useDevice } from '@/composables/useDevice'
import { useGamepad } from '@/composables/useGamepad'
import { useModel } from '@/composables/useModel'
import { useTauriListen } from '@/composables/useTauriListen'
import { LISTEN_KEY } from '@/constants'
import { hideWindow, setAlwaysOnTop, setTaskbarVisibility, showWindow } from '@/plugins/window'
import { useCatStore } from '@/stores/cat'
import { useGeneralStore } from '@/stores/general.ts'
import { useModelStore } from '@/stores/model'
import { isImage } from '@/utils/is'
import live2d from '@/utils/live2d'
import { join } from '@/utils/path'
import { isWindows } from '@/utils/platform'
import { ensureRuntimeLease, reportRuntimeEventQuietly } from '@/utils/runtimeTelemetry'
import { clearObject } from '@/utils/shared'

const appWindow = getCurrentWebviewWindow()
const route = useRoute()
const subModelId = typeof route.query.instance === 'string' ? route.query.instance : undefined
const isSubModel = Boolean(subModelId)
const modelStore = useModelStore()
const catStore = useCatStore()
const generalStore = useGeneralStore()
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
})
const { startListening } = useDevice({
  currentModel: activeModel,
  mouseMirror: computed(() => appearanceSettings.value.mouseMirror),
  listeners: listenerSettings,
  enableWindowHover: !isSubModel,
})
const { getBaseMenu, getExitMenu } = useAppMenu()
const backgroundImagePath = ref<string>()
const live2dCanvas = ref<HTMLCanvasElement | null>(null)
const { stickActive } = useGamepad({
  currentModel: activeModel,
  mouseMirror: computed(() => appearanceSettings.value.mouseMirror),
  enabled: computed(() => listenerSettings.value.gamepad),
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

const SCALE_DRAG_SENSITIVITY = 0.12
const SHORTCUT_RESIZE_INTERVAL = 33
const reportSubModelWindowChange = useDebounceFn((instance: SubModelInstance) => {
  void emit(LISTEN_KEY.SUB_MODEL_WINDOW_CHANGED, structuredClone(toRaw(instance)))
}, 150)

function applyWindowScale(scale: number, modelSizeValue = modelSize.value) {
  if (!modelSizeValue) return

  const { width, height } = modelSizeValue

  appWindow.setSize(
    new PhysicalSize({
      width: Math.round(width * (scale / 100)),
      height: Math.round(height * (scale / 100)),
    }),
  )
}

onMounted(() => {
  if (!isSubModel) {
    startListening()
  }

  if (!isSubModel) return

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
    void emit(LISTEN_KEY.SUB_MODEL_VISIBILITY_CHANGED, { id: instance.id, visible: false })
  })
})

onUnmounted(() => {
  currentModelLoadVersion += 1
  handleDestroy()
})

const debouncedResize = useDebounceFn(async () => {
  await handleResize({ syncScale: !scalingWithShortcut })
}, 16)

useEventListener('resize', () => {
  debouncedResize()
})

watch([() => {
  const model = activeModel.value

  return model ? `${model.id}:${model.path}` : ''
}, live2dCanvas], async ([, canvas]) => {
  const model = activeModel.value

  // An immediate watcher can run before the component's canvas is mounted.
  // Watching the template ref retries the current model as soon as it exists.
  if (!model || !canvas) return

  const loadVersion = ++currentModelLoadVersion

  modelStore.modelReady = false

  try {
    await ensureRuntimeLease(model)

    if (loadVersion !== currentModelLoadVersion) return

    await handleLoad(canvas)

    if (loadVersion !== currentModelLoadVersion) return

    reportRuntimeEventQuietly(model, 'opened')
  } catch (error) {
    if (loadVersion !== currentModelLoadVersion) return

    console.warn('[mochi-paw] failed to load current model:', error)
    modelStore.modelReady = true
    return
  }

  const path = join(model.path, 'resources', 'background.png')

  const existed = await exists(path)

  if (loadVersion !== currentModelLoadVersion) return

  backgroundImagePath.value = existed ? convertFileSrc(path) : void 0

  clearObject([modelStore.supportKeys, modelStore.pressedKeys, modelStore.activeKeys])

  const resourcePath = join(model.path, 'resources')
  const groups = [
    { name: 'keyboards', type: 'overlay' as const },
    { name: 'faces', type: 'overlay' as const },
    { name: 'left-keys', type: 'left' as const },
    { name: 'right-keys', type: 'right' as const },
  ]

  for await (const group of groups) {
    const groupDir = join(resourcePath, group.name)
    const files = await readDir(groupDir).catch(() => [])
    const imageFiles = files.filter(file => isImage(file.name))

    for (const file of imageFiles) {
      if (loadVersion !== currentModelLoadVersion) return

      const fileName = file.name.split('.')[0]

      modelStore.supportKeys[fileName] ??= []
      modelStore.supportKeys[fileName].push({
        path: join(groupDir, file.name),
        type: group.type,
      })
    }
  }

  if (loadVersion === currentModelLoadVersion) {
    modelStore.modelReady = true
  }
}, { flush: 'post', immediate: true })

watch([() => windowSettings.value.scale, modelSize], ([scale, modelSize]) => {
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
  appWindow.setIgnoreCursorEvents(value)
}, { immediate: true })

watch(() => windowSettings.value.alwaysOnTop, setAlwaysOnTop, { immediate: true })

if (!isSubModel) {
  watch(() => generalStore.app.taskbarVisible, setTaskbarVisibility, { immediate: true })
}

watch(() => catStore.model.motionSound, live2d.setMotionSoundEnabled, { immediate: true })

watch(() => appearanceSettings.value.maxFPS, fps => live2d.setMaxFPS(fps), { immediate: true })

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
})

useTauriListen<SubModelInstance>(LISTEN_KEY.UPDATE_SUB_MODEL, ({ payload }) => {
  if (!isSubModel || payload.id !== subModelId) return

  syncedSubModel.value = payload
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
    class="relative size-screen overflow-hidden children:(absolute size-full)"
    :class="{ '-scale-x-100': appearanceSettings.mirror }"
    :style="{
      opacity: windowSettings.opacity / 100,
      borderRadius: `${windowSettings.radius}%`,
    }"
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
</template>
