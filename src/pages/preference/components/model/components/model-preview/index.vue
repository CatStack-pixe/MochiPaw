<script setup lang="ts">
import { convertFileSrc } from '@tauri-apps/api/core'
import { useElementSize } from '@vueuse/core'
import { CubismSetting, Live2DSprite } from 'easy-live2d'
import { Application, Ticker } from 'pixi.js'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'

import type { Model } from '@/stores/model'

import { readCubismModelJSON } from '@/utils/live2d'
import { join } from '@/utils/path'

const props = defineProps<{
  model: Model
}>()

const LIVE2D_PREVIEW_MODELS = new Set(['luoxi-standard'])

const previewRef = useTemplateRef<HTMLDivElement>('preview')
const canvasRef = useTemplateRef<HTMLCanvasElement>('canvas')
const { width, height } = useElementSize(previewRef)
const loadFailed = ref(false)

let app: Application | undefined
let sprite: Live2DSprite | undefined

const coverSrc = computed(() => {
  return convertFileSrc(join(props.model.path, 'resources', 'cover.png'))
})

const shouldUseLive2dPreview = computed(() => {
  return LIVE2D_PREVIEW_MODELS.has(props.model.path.split(/[\\/]/).at(-1) ?? '')
})

async function destroyPreview() {
  sprite?.destroy()
  sprite = undefined

  if (!app) return

  app.destroy()
  app = undefined
}

async function loadPreview() {
  await destroyPreview()

  loadFailed.value = false

  if (!shouldUseLive2dPreview.value) return

  await nextTick()

  const canvas = canvasRef.value

  if (!canvas) return

  try {
    app = new Application()

    await app.init({
      view: canvas,
      resizeTo: canvas.parentElement ?? canvas,
      backgroundAlpha: 0,
      autoDensity: true,
      resolution: devicePixelRatio,
    })

    const modelJSON = await readCubismModelJSON(props.model.path)
    const modelSetting = new CubismSetting({ modelJSON })

    modelSetting.redirectPath(({ file }) => {
      return convertFileSrc(join(props.model.path, file))
    })

    sprite = new Live2DSprite({
      modelSetting,
      ticker: Ticker.shared,
    })

    app.stage.addChild(sprite)

    await sprite.ready

    resizePreview()
  } catch {
    loadFailed.value = true
    await destroyPreview()
  }
}

function resizePreview() {
  if (!app || !sprite) return

  const scale = Math.min(app.screen.width / sprite.width, app.screen.height / sprite.height)

  sprite.scale.set(scale)
  sprite.x = app.screen.width / 2
  sprite.y = app.screen.height / 2
  sprite.anchor.set(0.5)
}

onMounted(loadPreview)

watch(() => props.model.path, loadPreview)
watch([width, height], () => {
  requestAnimationFrame(resizePreview)
})

onBeforeUnmount(() => {
  destroyPreview()
})
</script>

<template>
  <div
    ref="preview"
    class="relative aspect-[612/354] overflow-hidden bg-[#f5f7fa]"
  >
    <canvas
      v-if="shouldUseLive2dPreview && !loadFailed"
      ref="canvas"
      class="absolute inset-0 size-full"
    />

    <img
      v-else
      alt="model preview"
      class="block size-full object-cover"
      :src="coverSrc"
    >
  </div>
</template>
