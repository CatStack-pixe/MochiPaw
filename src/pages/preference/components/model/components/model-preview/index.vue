<!-- SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { convertFileSrc } from '@tauri-apps/api/core'
import { exists } from '@tauri-apps/plugin-fs'
import { useElementSize } from '@vueuse/core'
import { CubismSetting, Live2DSprite } from 'easy-live2d'
import { Application, Ticker } from 'pixi.js'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'

import type { Model } from '@/stores/model'

import { detachLive2dSprite, readCubismModelJSON } from '@/utils/live2d'
import { join } from '@/utils/path'

const props = defineProps<{
  model: Model
}>()

const previewRef = useTemplateRef<HTMLDivElement>('preview')
const canvasRef = useTemplateRef<HTMLCanvasElement>('canvas')
const { width, height } = useElementSize(previewRef)
const hasBackground = ref(false)
const loadFailed = ref(false)
const naturalSize = ref({ width: 612, height: 354 })

let app: Application | undefined
let sprite: Live2DSprite | undefined
let loadId = 0

const previewAspectRatio = computed(() => {
  return `${naturalSize.value.width} / ${naturalSize.value.height}`
})

const coverSrc = computed(() => {
  return convertFileSrc(join(props.model.path, 'resources', 'cover.png'))
})

const backgroundSrc = computed(() => {
  return convertFileSrc(join(props.model.path, 'resources', 'background.png'))
})

function destroyPreview() {
  app?.stop()
  detachLive2dSprite(sprite, app)
  sprite = undefined

  if (!app) return

  app.destroy(false)
  app = undefined
}

async function loadPreview() {
  const currentLoadId = ++loadId

  destroyPreview()

  loadFailed.value = false
  naturalSize.value = { width: 612, height: 354 }
  hasBackground.value = await exists(join(props.model.path, 'resources', 'background.png'))

  await nextTick()

  const canvas = canvasRef.value
  const preview = previewRef.value

  if (!canvas || !preview) return

  try {
    const nextApp = new Application()

    await nextApp.init({
      view: canvas,
      backgroundAlpha: 0,
      autoDensity: true,
      resolution: devicePixelRatio,
    })

    if (currentLoadId !== loadId) {
      nextApp.destroy(false)
      return
    }

    app = nextApp

    const modelJSON = await readCubismModelJSON(props.model.path)

    if (currentLoadId !== loadId) {
      if (app === nextApp) {
        app = undefined
      }

      nextApp.destroy(false)
      return
    }

    const modelSetting = new CubismSetting({ modelJSON })

    modelSetting.redirectPath(({ file }) => {
      return convertFileSrc(join(props.model.path, file))
    })

    const nextSprite = new Live2DSprite({
      modelSetting,
      ticker: Ticker.shared,
    })

    sprite = nextSprite
    nextApp.stage.addChild(nextSprite)

    if (currentLoadId !== loadId) {
      detachLive2dSprite(nextSprite, nextApp)

      if (sprite === nextSprite) {
        sprite = undefined
      }

      if (app === nextApp) {
        app = undefined
      }

      nextApp.destroy(false)
      return
    }

    await nextSprite.ready

    if (currentLoadId !== loadId || sprite !== nextSprite) {
      if (sprite === nextSprite) {
        detachLive2dSprite(nextSprite, nextApp)
        sprite = undefined
      }

      return
    }

    naturalSize.value = {
      width: Math.max(1, nextSprite.width),
      height: Math.max(1, nextSprite.height),
    }

    await nextTick()
    resizePreview()
  } catch {
    loadFailed.value = true
    destroyPreview()
  }
}

function resizePreview() {
  if (!app || !sprite) return

  const previewWidth = Math.max(1, Math.round(width.value))
  const previewHeight = Math.max(1, Math.round(height.value))

  app.renderer.resize(previewWidth, previewHeight)

  const scale = Math.min(
    previewWidth / naturalSize.value.width,
    previewHeight / naturalSize.value.height,
  )

  sprite.scale.set(scale)
  sprite.x = previewWidth / 2
  sprite.y = previewHeight / 2
  sprite.anchor.set(0.5)
}

onMounted(loadPreview)

watch(() => props.model.path, loadPreview)
watch([width, height], () => {
  requestAnimationFrame(resizePreview)
})

onBeforeUnmount(() => {
  loadId += 1
  destroyPreview()
})
</script>

<template>
  <div
    ref="preview"
    class="relative overflow-hidden bg-[#f5f7fa]"
    :style="{ aspectRatio: previewAspectRatio }"
  >
    <template v-if="!loadFailed">
      <img
        v-if="hasBackground"
        alt=""
        class="absolute inset-0 size-full object-cover"
        :src="backgroundSrc"
      >

      <canvas
        ref="canvas"
        class="absolute inset-0 size-full"
      />
    </template>

    <img
      v-else
      alt="model preview"
      class="absolute inset-0 m-auto size-full object-contain"
      :src="coverSrc"
    >
  </div>
</template>
