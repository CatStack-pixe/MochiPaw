// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import JSON5 from 'json5'
import { Application } from 'pixi.js'

import { CubismSetting, Live2DSprite, Priority } from '@/vendor/easy-live2d'

import './style.css'

type ModelId = 'standard' | 'keyboard' | 'gamepad'
type TargetFPS = 60 | 90 | 120

declare global {
  interface Window {
    chrome?: {
      webview?: {
        addEventListener: (type: 'message', listener: (event: MessageEvent<unknown>) => void) => void
        postMessage: (message: unknown) => void
      }
    }
  }
}

const canvas = document.querySelector<HTMLCanvasElement>('#pet')!
const status = document.querySelector<HTMLOutputElement>('#status')!
const motionButton = document.querySelector<HTMLButtonElement>('#motion')!
const expressionButton = document.querySelector<HTMLButtonElement>('#expression')!
const app = new Application()

let sprite: Live2DSprite | undefined
let loadGeneration = 0
let modelId: ModelId = 'standard'
let targetFPS: TargetFPS = 60
let overlayVisible = false
let motionIndex = 0
let expressionIndex = 0
let resizeObserver: ResizeObserver | undefined
let sampledFrames = 0
let sampleStartedAt = 0

interface WidgetHostMessage {
  type?: string
  targetFPS?: number
  modelId?: string
  visible?: boolean
  controlsVisible?: boolean
}

function handleWidgetHostMessage(message: WidgetHostMessage) {
  if (message.type === 'set-overlay-fps' && [60, 90, 120].includes(message.targetFPS ?? -1)) {
    targetFPS = message.targetFPS as TargetFPS
    app.ticker.maxFPS = targetFPS
    setStatus(`${modelId} · 0 / ${targetFPS} FPS`)
  } else if (
    message.type === 'set-model'
    && ['standard', 'keyboard', 'gamepad'].includes(message.modelId ?? '')
    && message.modelId !== modelId
  ) {
    modelId = message.modelId as ModelId
    void loadModel(modelId)
  } else if (message.type === 'set-visible') {
    overlayVisible = Boolean(message.visible)
    sampledFrames = 0
    sampleStartedAt = performance.now()
    if (overlayVisible) app.start()
    else app.stop()
  } else if (message.type === 'set-controls-visible') {
    const controls = document.querySelector<HTMLElement>('.controls')
    if (controls) controls.hidden = message.controlsVisible === false
  }
}

function setStatus(message: string) {
  status.value = message
}

function getModelBaseUrl(modelId: ModelId) {
  return new URL(`../../gamebar-assets/models/${modelId}/`, document.location.href)
}

function fitModel() {
  const model = sprite
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (!model || width <= 0 || height <= 0) return

  app.renderer.resize(width, height)
  const naturalSize = model.getModelCanvasSize()
  const modelWidth = naturalSize?.width ?? model.width
  const modelHeight = naturalSize?.height ?? model.height
  const scale = Math.min(width / modelWidth, height / modelHeight)
  model.scale.set(scale)
  model.anchor.set(0.5)
  model.x = width / 2
  model.y = height / 2
}

async function loadModel(modelId: ModelId) {
  const generation = ++loadGeneration
  const previous = sprite
  sprite = undefined
  if (previous) {
    app.stage.removeChild(previous)
    previous.destroy()
  }
  setStatus(`Loading ${modelId} model…`)

  const modelBaseUrl = getModelBaseUrl(modelId)
  const modelJsonUrl = new URL('cat.model3.json', modelBaseUrl)
  try {
    const response = await fetch(modelJsonUrl)
    if (!response.ok) throw new Error(`Model file request failed (${response.status})`)
    const modelJSON = JSON5.parse(await response.text()) as object
    if (generation !== loadGeneration) return

    const setting = new CubismSetting({ modelJSON })
    setting.redirectPath(({ file }) => new URL(file, modelBaseUrl).href)
    const nextSprite = new Live2DSprite({ modelSetting: setting, ticker: app.ticker })
    sprite = nextSprite
    app.stage.addChild(nextSprite)
    app.start()
    await nextSprite.ready
    if (generation !== loadGeneration || sprite !== nextSprite) {
      app.stage.removeChild(nextSprite)
      nextSprite.destroy()
      return
    }

    motionIndex = 0
    expressionIndex = 0
    fitModel()
    if (overlayVisible) app.start()
    else app.stop()
    setStatus(`${modelId} · 0 / ${targetFPS} FPS`)
  } catch (error) {
    if (generation !== loadGeneration) return
    app.stop()
    setStatus(`Live2D load failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function initialize() {
  await app.init({
    canvas,
    backgroundAlpha: 0,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    antialias: true,
    autoStart: false,
  })
  app.ticker.maxFPS = targetFPS
  sampleStartedAt = performance.now()
  app.ticker.add(() => {
    sampledFrames += 1
    const now = performance.now()
    const elapsed = now - sampleStartedAt
    if (elapsed < 1000) return

    const actualFPS = Math.round(sampledFrames * 1000 / elapsed)
    sampledFrames = 0
    sampleStartedAt = now
    if (sprite) setStatus(`${modelId} · ${actualFPS} / ${targetFPS} FPS`)
    sendToWidgetHost({ type: 'fps-stat', actualFPS, targetFPS })
  })
  resizeObserver = new ResizeObserver(fitModel)
  resizeObserver.observe(canvas)

  motionButton.addEventListener('click', () => {
    const current = sprite
    if (!current) return
    const motions = current.getMotions()
    if (!motions.length) return
    const motion = motions[motionIndex++ % motions.length]
    void current.startMotion({
      group: motion.group,
      no: motion.no,
      priority: Priority.Normal,
    })
  })
  expressionButton.addEventListener('click', () => {
    const current = sprite
    if (!current) return
    const expressions = current.getExpressions()
    if (!expressions.length) return
    current.setExpression({ index: expressionIndex++ % expressions.length })
  })

  window.chrome?.webview?.addEventListener('message', (event: MessageEvent<unknown>) => {
    handleWidgetHostMessage(event.data as WidgetHostMessage)
  })
  window.addEventListener('message', (event: MessageEvent<WidgetHostMessage>) => {
    handleWidgetHostMessage(event.data)
  })

  await loadModel(modelId)
  app.stop()
  sendToWidgetHost({ type: 'widget-ready', targetFPS })
}

function sendToWidgetHost(message: Record<string, unknown>) {
  if (window.chrome?.webview) {
    window.chrome.webview.postMessage(message)
    return
  }

  const external = (window as Window & { external?: { notify?: (value: string) => void } }).external
  external?.notify?.(JSON.stringify(message))
}

window.addEventListener('beforeunload', () => {
  loadGeneration += 1
  resizeObserver?.disconnect()
  if (sprite) {
    app.stage.removeChild(sprite)
    sprite.destroy()
  }
  app.destroy({ removeView: false }, { children: true })
})

void initialize().catch((error: unknown) => {
  setStatus(`Overlay initialization failed: ${error instanceof Error ? error.message : String(error)}`)
})
