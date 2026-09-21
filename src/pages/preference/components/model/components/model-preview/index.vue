<!-- SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { convertFileSrc } from '@tauri-apps/api/core'
import { exists } from '@tauri-apps/plugin-fs'
import { useDocumentVisibility, useElementSize, useIntersectionObserver } from '@vueuse/core'
import { Application } from 'pixi.js'
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue'

import type { Model } from '@/stores/model'

import { logWarn } from '@/utils/diagnostics'
import { destroyLive2dSprite, readCubismModelJSON } from '@/utils/live2d'
import { join } from '@/utils/path'
import { PreviewSession } from '@/utils/previewSession'
import { withTimeout } from '@/utils/promise'
import { resolvePreviewResolution } from '@/utils/renderQuality'
import { CubismSetting, Live2DSprite } from '@/vendor/easy-live2d'

const props = defineProps<{
  model: Model
  active: boolean
}>()
const emit = defineEmits<{
  activate: []
  deactivate: []
}>()

const previewRef = useTemplateRef<HTMLDivElement>('preview')
const canvasRef = useTemplateRef<HTMLCanvasElement>('canvas')
const { width, height } = useElementSize(previewRef)
const visibility = useDocumentVisibility()
const inViewport = ref(false)
const hasBackground = ref(false)
const coverFailed = ref(false)
const ready = ref(false)
const canvasGeneration = ref(0)
const naturalSize = ref({ width: 612, height: 354 })
const shouldRender = computed(() => props.active && inViewport.value && visibility.value === 'visible')

let app: Application | undefined
let sprite: Live2DSprite | undefined
let session: PreviewSession | undefined
let loadTimer: ReturnType<typeof setTimeout> | undefined
let resizeFrame: number | undefined

useIntersectionObserver(previewRef, ([entry]) => {
  inViewport.value = entry?.isIntersecting ?? false
})

const previewAspectRatio = computed(() => `${naturalSize.value.width} / ${naturalSize.value.height}`)
const coverSrc = computed(() => convertFileSrc(join(props.model.path, 'resources', 'cover.png')))
const backgroundSrc = computed(() => convertFileSrc(join(props.model.path, 'resources', 'background.png')))

function destroyPreview() {
  canvasGeneration.value += 1
  if (loadTimer !== undefined) clearTimeout(loadTimer)
  if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
  loadTimer = undefined
  resizeFrame = undefined
  app?.stop()
  session?.dispose()
  session = undefined
  app = undefined
  sprite = undefined
  ready.value = false
}

async function loadPreview() {
  const current = new PreviewSession(error => logWarn('[preview] resource cleanup failed', { error }))
  session = current
  const path = props.model.path

  try {
    await nextTick()
    const canvas = canvasRef.value
    if (!canvas || current.disposed) return

    const nextApp = new Application()
    try {
      await nextApp.init({
        view: canvas,
        backgroundAlpha: 0,
        autoDensity: true,
        autoStart: false,
        resolution: resolvePreviewResolution(devicePixelRatio),
      })
    } catch (error) {
      if (nextApp.renderer) nextApp.destroy(false)
      else nextApp.stage.destroy({ children: true })
      throw error
    }
    if (!current.own(nextApp, value => value.destroy(false))) return
    app = nextApp
    nextApp.ticker.maxFPS = 24

    const backgroundExists = await exists(join(path, 'resources', 'background.png'))
    if (current.disposed) return
    hasBackground.value = backgroundExists
    const modelJSON = await readCubismModelJSON(path)
    if (current.disposed) return

    const modelSetting = new CubismSetting({ modelJSON })
    modelSetting.redirectPath(({ file }) => convertFileSrc(join(path, file)))
    const nextSprite = new Live2DSprite({ modelSetting, ticker: nextApp.ticker })
    current.own(nextSprite, value => destroyLive2dSprite(value, nextApp))
    sprite = nextSprite
    nextApp.stage.addChild(nextSprite)
    nextApp.start()

    await withTimeout(nextSprite.ready, 30_000, 'Model preview initialization timed out.')
    if (current.disposed) return

    const canvasSize = nextSprite.getModelCanvasSize()
    naturalSize.value = {
      width: Math.max(1, canvasSize?.width ?? nextSprite.width),
      height: Math.max(1, canvasSize?.height ?? nextSprite.height),
    }
    ready.value = true
    await nextTick()
    if (!current.disposed) scheduleResize()
  } catch (error) {
    if (current.disposed) return
    logWarn('[preview] load failed', { path, error })
    destroyPreview()
  }
}

function resizePreview() {
  if (!app || !sprite) return
  const previewWidth = Math.round(width.value)
  const previewHeight = Math.round(height.value)
  if (previewWidth < 1 || previewHeight < 1) return

  app.renderer.resize(previewWidth, previewHeight)
  sprite.scale.set(Math.min(previewWidth / naturalSize.value.width, previewHeight / naturalSize.value.height))
  sprite.x = previewWidth / 2
  sprite.y = previewHeight / 2
  sprite.anchor.set(0.5)
}

function scheduleResize() {
  if (!app) return
  if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = undefined
    resizePreview()
  })
}

watch([shouldRender, () => props.model.path], ([enabled]) => {
  destroyPreview()
  hasBackground.value = false
  if (!enabled) return
  // Passing over a card should not start expensive model/texture decoding.
  loadTimer = setTimeout(() => {
    loadTimer = undefined
    void loadPreview()
  }, 180)
}, { immediate: true })

watch(() => props.model.path, () => {
  coverFailed.value = false
  naturalSize.value = { width: 612, height: 354 }
})
watch([width, height], scheduleResize)
onBeforeUnmount(destroyPreview)
</script>

<template>
  <div
    ref="preview"
    class="relative overflow-hidden bg-[#f5f7fa]"
    :style="{ aspectRatio: previewAspectRatio }"
    @pointerenter="emit('activate')"
    @pointerleave="emit('deactivate')"
  >
    <img
      v-if="!ready && !coverFailed"
      alt=""
      class="absolute inset-0 m-auto size-full object-contain"
      decoding="async"
      loading="lazy"
      :src="coverSrc"
      @error="coverFailed = true"
    >
    <div
      v-else-if="!ready"
      class="absolute inset-0 flex items-center justify-center text-10 text-gray-400"
      aria-hidden="true"
    >
      <i class="i-solar:cat-bold" />
    </div>
    <img
      v-if="ready && hasBackground"
      alt=""
      class="absolute inset-0 size-full object-cover"
      :src="backgroundSrc"
    >
    <canvas
      v-if="shouldRender"
      :key="canvasGeneration"
      ref="canvas"
      class="absolute inset-0 size-full"
      :class="{ 'opacity-0': !ready }"
    />
    <button
      :aria-pressed="active"
      class="absolute bottom-2 right-2 rounded bg-white/90 px-2 py-1 text-xs text-gray-700 shadow"
      type="button"
      @click.stop="emit(active ? 'deactivate' : 'activate')"
    >
      {{ $t(active ? 'pages.preference.model.labels.stopPreview' : 'pages.preference.model.labels.startPreview') }}
    </button>
  </div>
</template>
