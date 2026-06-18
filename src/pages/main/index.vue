<script setup lang="ts">
import { convertFileSrc } from '@tauri-apps/api/core'
import { PhysicalSize } from '@tauri-apps/api/dpi'
import { Menu, PredefinedMenuItem } from '@tauri-apps/api/menu'
import { sep } from '@tauri-apps/api/path'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { exists, readDir } from '@tauri-apps/plugin-fs'
import { useDebounceFn, useEventListener } from '@vueuse/core'
import { round } from 'es-toolkit'
import { nth } from 'es-toolkit/compat'
import { onMounted, onUnmounted, ref, watch } from 'vue'

import type { ModelExpressionInfo, ModelMotionInfo } from '@/stores/model'

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
import { clearObject } from '@/utils/shared'

const { startListening } = useDevice()
const appWindow = getCurrentWebviewWindow()
const { modelSize, handleLoad, handleDestroy, handleResize, handleKeyChange } = useModel()
const catStore = useCatStore()
const { getBaseMenu, getExitMenu } = useAppMenu()
const modelStore = useModelStore()
const generalStore = useGeneralStore()
const backgroundImagePath = ref<string>()
const { stickActive } = useGamepad()
let pendingScaleDelta = 0
let scaleFrame = 0
let resizeFrame = 0
let scalingWithShortcut = false
let scaleSyncTimer: ReturnType<typeof setTimeout> | undefined
let lastShortcutResizeAt = 0

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

watch(() => modelStore.currentModel, async (model) => {
  if (!model) return

  await handleLoad()

  const path = join(model.path, 'resources', 'background.png')

  const existed = await exists(path)

  backgroundImagePath.value = existed ? convertFileSrc(path) : void 0

  clearObject([modelStore.supportKeys, modelStore.pressedKeys])

  const resourcePath = join(model.path, 'resources')
  const groups = ['left-keys', 'right-keys']

  for await (const groupName of groups) {
    const groupDir = join(resourcePath, groupName)
    const files = await readDir(groupDir).catch(() => [])
    const imageFiles = files.filter(file => isImage(file.name))

    for (const file of imageFiles) {
      const fileName = file.name.split('.')[0]

      modelStore.supportKeys[fileName] = join(groupDir, file.name)
    }
  }

  modelStore.modelReady = true
}, { deep: true, immediate: true })

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
  const dirs = Object.values(keys).map((path) => {
    return nth(path.split(sep()), -2)!
  })

  const hasLeft = dirs.some(dir => dir.startsWith('left'))
  const hasRight = dirs.some(dir => dir.startsWith('right'))

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

useTauriListen<ModelMotionInfo>(LISTEN_KEY.START_MOTION, ({ payload }) => {
  live2d.startMotion(payload)
})

useTauriListen<{
  expression: ModelExpressionInfo
  index: number
}>(LISTEN_KEY.SET_EXPRESSION, ({ payload }) => {
  live2d.setExpression(payload.index)
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
      v-for="path in modelStore.pressedKeys"
      :key="path"
      class="object-cover"
      :src="convertFileSrc(path)"
    >

    <div
      v-show="!modelStore.modelReady"
      class="flex items-center justify-center bg-black"
    />
  </div>
</template>
