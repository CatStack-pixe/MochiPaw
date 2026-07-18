<!-- SPDX-FileCopyrightText: 2025 ayangweb
  SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { convertFileSrc } from '@tauri-apps/api/core'
import { PhysicalSize } from '@tauri-apps/api/dpi'
import { Menu, PredefinedMenuItem } from '@tauri-apps/api/menu'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { exists, readDir } from '@tauri-apps/plugin-fs'
import { useDebounceFn, useEventListener } from '@vueuse/core'
import { round } from 'es-toolkit'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import type { ModelMotionInfo } from '@/stores/model'

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

const { startListening } = useDevice()
const appWindow = getCurrentWebviewWindow()
const {
  modelSize,
  handleLoad,
  handleDestroy,
  handleResize,
  handleKeyChange,
  playMotionBehavior,
  playExpressionBehavior,
} = useModel()
const catStore = useCatStore()
const { getBaseMenu, getExitMenu } = useAppMenu()
const modelStore = useModelStore()
const generalStore = useGeneralStore()
const backgroundImagePath = ref<string>()
const { stickActive } = useGamepad()
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

onMounted(startListening)

onUnmounted(handleDestroy)

const debouncedResize = useDebounceFn(async () => {
  await handleResize({ syncScale: !scalingWithShortcut })
}, 16)

useEventListener('resize', () => {
  debouncedResize()
})

watch(() => {
  const model = modelStore.currentModel

  return model ? `${model.id}:${model.path}` : ''
}, async () => {
  const model = modelStore.currentModel
  const loadVersion = ++currentModelLoadVersion

  if (!model) return

  modelStore.modelReady = false

  await nextTick()

  try {
    await ensureRuntimeLease(model)

    if (loadVersion !== currentModelLoadVersion) return

    await handleLoad()

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

watch([() => catStore.window.scale, modelSize], ([scale, modelSize]) => {
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

watch(() => catStore.window.visible, async (value) => {
  value ? showWindow() : hideWindow()
})

watch(() => catStore.window.passThrough, (value) => {
  appWindow.setIgnoreCursorEvents(value)
}, { immediate: true })

watch(() => catStore.window.alwaysOnTop, setAlwaysOnTop, { immediate: true })

watch(() => generalStore.app.taskbarVisible, setTaskbarVisibility, { immediate: true })

watch(() => catStore.model.motionSound, live2d.setMotionSoundEnabled, { immediate: true })

watch(() => catStore.model.maxFPS, live2d.setMaxFPS, { immediate: true })

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

function handleMouseDown(event: MouseEvent) {
  if (catStore.window.passThrough || event.button !== 0) return

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
  if (isWindows && catStore.window.alwaysOnTop) {
    setAlwaysOnTop(false)
  }

  await menu.popup()

  // Restore always-on-top after the menu is closed
  if (!isWindows || !catStore.window.alwaysOnTop) return

  setAlwaysOnTop(true)
}

function handleMouseMove(event: MouseEvent) {
  const { buttons, ctrlKey, movementX, movementY } = event

  if (catStore.window.passThrough || buttons !== 2 || !ctrlKey) return

  pendingScaleDelta += (movementX + movementY) * SCALE_DRAG_SENSITIVITY

  if (scaleFrame) return

  scaleFrame = requestAnimationFrame(() => {
    scaleFrame = 0

    if (Math.abs(pendingScaleDelta) < 0.1) {
      pendingScaleDelta = 0
      return
    }

    const nextScale = Math.max(10, Math.min(catStore.window.scale + pendingScaleDelta, 500))

    pendingScaleDelta = 0
    scalingWithShortcut = true
    catStore.window.scale = round(nextScale)

    if (scaleSyncTimer) {
      clearTimeout(scaleSyncTimer)
    }

    scaleSyncTimer = setTimeout(() => {
      applyWindowScale(catStore.window.scale)
      scalingWithShortcut = false
    }, 120)
  })
}
</script>

<template>
  <div
    class="relative size-screen overflow-hidden children:(absolute size-full)"
    :class="{ '-scale-x-100': catStore.model.mirror }"
    :style="{
      opacity: catStore.window.opacity / 100,
      borderRadius: `${catStore.window.radius}%`,
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

    <canvas id="live2dCanvas" />

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
