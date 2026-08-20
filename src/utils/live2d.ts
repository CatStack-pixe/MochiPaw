// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import type { Ticker } from 'pixi.js'

import { convertFileSrc } from '@tauri-apps/api/core'
import { readDir, readTextFile } from '@tauri-apps/plugin-fs'
import { flatMap, groupBy } from 'es-toolkit/compat'
import JSON5 from 'json5'
import { Application } from 'pixi.js'

import type { ModelSize } from '@/composables/useModel'
import type { ModelExpressionInfo, ModelMotionInfo } from '@/stores/model'
import type { ExpressionInfo, MotionInfo } from '@/vendor/easy-live2d'

import { i18n } from '@/locales'
import { logError, logInfo, logStep, logTrace } from '@/utils/diagnostics'
import { RenderDiagnostics } from '@/utils/renderDiagnostics'
import { Config, CubismSetting, Live2DSprite, Priority } from '@/vendor/easy-live2d'

import { join } from './path'
import { withTimeout } from './promise'

Config.MouseFollow = false

interface CubismDisplayInfo {
  Parameters?: Array<{
    Id?: string
    Name?: string
  }>
}

interface CubismModelJson {
  FileReferences?: {
    DisplayInfo?: string
    Physics?: string
    Expressions?: Array<{
      Name?: string
      File?: string
    }>
    Motions?: Record<string, Array<{
      File?: string
      Sound?: string
      FadeInTime?: number
      FadeOutTime?: number
    }>>
  }
}

interface CubismExpressionJson {
  Parameters?: Array<{
    Id?: string
  }>
}

const MOTION_DISPLAY_NAMES: Record<string, string> = {
  baozhiK: 'Newspaper On',
  baozhiG: 'Newspaper Off',
  heikuangK: 'Black Frame On',
  heikuangG: 'Black Frame Off',
  lianheiK: 'Dark Face On',
  lianheiG: 'Dark Face Off',
  mojingK: 'Sunglasses On',
  mojingG: 'Sunglasses Off',
  reshuihuG: 'Kettle On',
  reshuihuK: 'Kettle Off',
  youeryuanK: 'Kindergarten On',
  youeryuanG: 'Kindergarten Off',
}

const FALLBACK_PHYSICS_PARAMETER_STRENGTHS = {
  ParamBreath: 0.38,
  ParamHairFront: 0.26,
  ParamHairSide: 0.32,
  ParamHairBack: 0.24,
} as const

const PHYSICS_INPUT_GAIN = 1.4
const LIVE2D_READY_TIMEOUT_MS = 30_000

type FallbackPhysicsParameter = keyof typeof FALLBACK_PHYSICS_PARAMETER_STRENGTHS
type FallbackPhysicsParameters = Partial<Record<FallbackPhysicsParameter, true>>

interface FallbackPhysicsVector {
  x: number
  y: number
  z: number
}

export class Live2dLoadCancelledError extends Error {
  constructor() {
    super('Live2D load cancelled')
  }
}

export function isLive2dLoadCancelledError(error: unknown) {
  return error instanceof Live2dLoadCancelledError
}

type RenderableLive2DSprite = Live2DSprite & {
  onRender: null | ((...args: unknown[]) => void)
}

type DraggableLive2DSprite = Live2DSprite & {
  setDragging: (x: number, y: number) => void
}

export function destroyLive2dSprite(model: Live2DSprite | null | undefined, app?: Application | null) {
  detachLive2dSprite(model, app)
  model?.destroy()
}

export function detachLive2dSprite(model: Live2DSprite | null | undefined, app?: Application | null) {
  if (!model) return

  const renderableModel = model as RenderableLive2DSprite

  renderableModel.visible = false
  renderableModel.renderable = false
  renderableModel.onRender = null
  app?.stage.removeChild(model)
}

export async function readCubismModelJSON(path: string) {
  logStep('live2d-resource', 'read model directory', { path })
  const files = await readDir(path)
  const modelFile = files.find(file => file.name.endsWith('.model3.json'))

  if (!modelFile) {
    logError('[live2d-resource] model config not found', { path, files: files.map(file => file.name) })
    throw new Error(i18n.global.t('utils.live2d.hints.notFound'))
  }

  logStep('live2d-resource', 'read model config', { path, modelFile: modelFile.name })
  return JSON5.parse(await readTextFile(join(path, modelFile.name))) as CubismModelJson
}

export async function resolveModelMotions(path: string, motions: MotionInfo[]) {
  logStep('live2d-resource', 'resolve motions', { path, motionCount: motions.length })
  const modelJSON = await readCubismModelJSON(path)
  const motionsFromJSON = readMotionsFromModelJSON(modelJSON)

  if (!motions.length) return motionsFromJSON

  return Promise.all(motions.map(async (motion): Promise<ModelMotionInfo> => {
    const motionConfig = modelJSON.FileReferences?.Motions?.[motion.group]?.[motion.no]
    const file = motionConfig?.File

    return {
      ...motion,
      file,
      displayName: getMotionDisplayName(file, motion.name),
    }
  }))
}

export async function resolveModelExpressions(path: string, expressions: ExpressionInfo[]) {
  logStep('live2d-resource', 'resolve expressions', { path, expressionCount: expressions.length })
  const modelJSON = await readCubismModelJSON(path)
  const parameterNames = await getParameterNames(path, modelJSON)

  return Promise.all(expressions.map(async (expression, index): Promise<ModelExpressionInfo> => {
    const expressionConfig = modelJSON.FileReferences?.Expressions?.[index]

    if (!expressionConfig?.File) return expression

    const expressionJSON = await readTextFile(join(path, expressionConfig.File))
      .then(content => JSON5.parse(content) as CubismExpressionJson)
      .catch(() => undefined)
    const displayName = expressionJSON?.Parameters
      ?.map(parameter => parameter.Id ? parameterNames.get(parameter.Id) : undefined)
      .find(Boolean)

    return {
      ...expression,
      displayName: displayName ?? expressionConfig.Name,
    }
  }))
}

function readMotionsFromModelJSON(modelJSON: CubismModelJson) {
  const motionGroups = modelJSON.FileReferences?.Motions

  if (!motionGroups) return []

  const entries = Object.entries(motionGroups).map(([group, items]) => {
    return items.map((item, no): ModelMotionInfo => {
      const name = item.File ? removeModelFileExtension(item.File) : `${group}_${no}`

      return {
        group,
        no,
        name,
        file: item.File,
        displayName: getMotionDisplayName(item.File, name),
      }
    })
  })

  return flatMap(entries, motions => motions)
}

function getMotionDisplayName(file: string | undefined, fallback: string) {
  if (!file) return fallback

  const name = removeModelFileExtension(file)

  return MOTION_DISPLAY_NAMES[name] ?? name
}

function removeModelFileExtension(file: string) {
  return file
    .replace(/\.(?:motion3|exp3|model3)\.json$/i, '')
    .replace(/\.[^.]+$/, '')
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function smoothingFactor(rate: number, deltaSeconds: number) {
  return 1 - Math.exp(-rate * deltaSeconds)
}

function applyPhysicsInputGain(value: number) {
  return clamp(value * PHYSICS_INPUT_GAIN, -1, 1)
}

function applyPhysicsAngleGain(value: number) {
  return applyPhysicsInputGain(value / 30) * 30
}

function hasNativePhysics(modelJSON: CubismModelJson) {
  return Boolean(modelJSON.FileReferences?.Physics?.trim())
}

async function getParameterNames(path: string, modelJSON: CubismModelJson) {
  const displayInfo = modelJSON.FileReferences?.DisplayInfo

  if (!displayInfo) return new Map<string, string>()

  const displayInfoJSON = await readTextFile(join(path, displayInfo))
    .then(content => JSON5.parse(content) as CubismDisplayInfo)
    .catch(() => undefined)

  return new Map(
    displayInfoJSON?.Parameters
      ?.filter(parameter => parameter.Id && parameter.Name)
      .map(parameter => [parameter.Id!, parameter.Name!]) ?? [],
  )
}

class Live2d {
  private app: Application | null = null
  private appInitPromise: Promise<void> | null = null
  private fallbackPhysicsAngles: FallbackPhysicsVector = { x: 0, y: 0, z: 0 }
  private fallbackPhysicsParameters: FallbackPhysicsParameters = {}
  private fallbackPhysicsSmoothedAngles: FallbackPhysicsVector = { x: 0, y: 0, z: 0 }
  private fallbackPhysicsTime = 0
  private fallbackPhysicsVelocity: FallbackPhysicsVector = { x: 0, y: 0, z: 0 }
  private loadVersion = 0
  private maxFPS = 30
  private renderingEnabled = true
  private renderDiagnostics: RenderDiagnostics | null = null
  public model: Live2DSprite | null = null

  constructor() { }

  private async initApp(view: HTMLCanvasElement) {
    if (this.app) {
      logStep('live2d', 'reuse Pixi application', { hasInitPromise: Boolean(this.appInitPromise) })
      await this.appInitPromise
      return
    }

    logStep('live2d', 'create Pixi application', {
      canvasWidth: view.width,
      canvasHeight: view.height,
      devicePixelRatio,
      maxFPS: this.maxFPS,
    })
    this.app = new Application()

    this.appInitPromise = this.app.init({
      view,
      resizeTo: view.parentElement ?? window,
      backgroundAlpha: 0,
      autoDensity: true,
      resolution: devicePixelRatio,
      autoStart: false,
    })

    try {
      await this.appInitPromise
      this.app.ticker.maxFPS = this.maxFPS
      this.app.stop()
      this.renderDiagnostics = new RenderDiagnostics({
        targetFPS: this.maxFPS,
        onReport: (snapshot) => {
          logInfo('[live2d] render statistics', {
            ...snapshot,
            visibility: document.visibilityState,
            hidden: document.hidden,
            hasFocus: document.hasFocus(),
            renderingEnabled: this.renderingEnabled,
            modelLoaded: Boolean(this.model),
            tickerStarted: this.app?.ticker.started ?? false,
          })
        },
      })
      this.app.ticker.add(this.recordRenderFrame)
      logStep('live2d', 'Pixi application initialized', { maxFPS: this.maxFPS })
    } finally {
      this.appInitPromise = null
    }
  }

  public async load(path: string, view: HTMLCanvasElement) {
    const version = ++this.loadVersion
    const context = { path, loadVersion: version }

    logInfo('[live2d] load started', context)

    await this.initApp(view)
    logStep('live2d', 'Pixi application ready for model load', context)

    if (version !== this.loadVersion) {
      logStep('live2d', 'load cancelled before model replacement', {
        ...context,
        currentLoadVersion: this.loadVersion,
      })
      throw new Live2dLoadCancelledError()
    }

    logStep('live2d', 'destroy current model before replacement', context)
    this.destroyCurrentModel()

    if (version !== this.loadVersion) {
      logStep('live2d', 'load cancelled after model replacement', {
        ...context,
        currentLoadVersion: this.loadVersion,
      })
      throw new Live2dLoadCancelledError()
    }

    const modelJSON = await readCubismModelJSON(path)
    logStep('live2d', 'model config loaded', context)

    if (version !== this.loadVersion) {
      logStep('live2d', 'load cancelled after config read', {
        ...context,
        currentLoadVersion: this.loadVersion,
      })
      throw new Live2dLoadCancelledError()
    }

    const modelSetting = new CubismSetting({
      modelJSON,
    })

    modelSetting.redirectPath(({ file }) => {
      return convertFileSrc(join(path, file))
    })

    const app = this.app

    if (!app) {
      throw new Error('Live2D renderer is not available')
    }

    const model = new Live2DSprite({
      modelSetting,
      ticker: app.ticker,
    })

    this.model = model
    app.stage.addChild(model)
    logStep('live2d', 'model sprite created and attached', context)
    // Live2DSprite resolves `ready` from its render callback. The app ticker is
    // intentionally stopped while idle, so it must run before awaiting ready.
    this.startTicker('model-load')
    logStep('live2d', 'Pixi ticker started for model ready', context)

    try {
      logStep('live2d', 'wait for model ready', { ...context, timeoutMs: LIVE2D_READY_TIMEOUT_MS })
      await withTimeout(
        model.ready,
        LIVE2D_READY_TIMEOUT_MS,
        `Live2D model initialization timed out after ${LIVE2D_READY_TIMEOUT_MS / 1000} seconds.`,
      )

      if (!this.renderingEnabled) {
        this.stopTicker('rendering-disabled-after-load')
        logTrace('[live2d] stopped ticker because rendering is disabled', context)
      }

      if (version !== this.loadVersion || this.model !== model) {
        if (this.model === model) {
          this.destroyCurrentModel()
        }

        logStep('live2d', 'load cancelled after model ready', {
          ...context,
          currentLoadVersion: this.loadVersion,
        })
        throw new Live2dLoadCancelledError()
      }

      const { width, height } = model

      const motions = groupBy(await resolveModelMotions(path, model.getMotions()), 'group')
      logStep('live2d', 'motions resolved', {
        ...context,
        motionGroupCount: Object.keys(motions).length,
        motionCount: Object.values(motions).flat().length,
      })

      if (version !== this.loadVersion || this.model !== model) {
        if (this.model === model) {
          this.destroyCurrentModel()
        }

        logStep('live2d', 'load cancelled after motion resolution', {
          ...context,
          currentLoadVersion: this.loadVersion,
        })
        throw new Live2dLoadCancelledError()
      }

      const expressions = await resolveModelExpressions(path, model.getExpressions())
      logStep('live2d', 'expressions resolved', { ...context, expressionCount: expressions.length })

      if (version !== this.loadVersion || this.model !== model) {
        if (this.model === model) {
          this.destroyCurrentModel()
        }

        logStep('live2d', 'load cancelled after expression resolution', {
          ...context,
          currentLoadVersion: this.loadVersion,
        })
        throw new Live2dLoadCancelledError()
      }

      this.setupFallbackPhysics(modelJSON)
      logInfo('[live2d] load completed', {
        ...context,
        width,
        height,
        motionGroupCount: Object.keys(motions).length,
        expressionCount: expressions.length,
      })

      return {
        width,
        height,
        motions,
        expressions,
      }
    } catch (error) {
      if (this.model === model) {
        logStep('live2d', 'destroy failed or cancelled model', context)
        this.destroyCurrentModel()
      }

      if (isLive2dLoadCancelledError(error)) {
        logTrace('[live2d] load cancelled', { ...context, error })
      } else {
        logError('[live2d] load failed', { ...context, error })
      }

      throw error
    }
  }

  public destroy() {
    this.loadVersion += 1
    logStep('live2d', 'destroy renderer', { loadVersion: this.loadVersion })
    this.destroyCurrentModel()
    this.app?.destroy(false)
    this.renderDiagnostics?.stop()
    this.renderDiagnostics = null
    this.app = null
    this.appInitPromise = null
  }

  private destroyCurrentModel() {
    const model = this.model

    this.stopFallbackPhysics()
    this.model = null

    logTrace('[live2d] destroy current model', { hadModel: Boolean(model) })

    this.destroySprite(model)
    this.stopTicker('model-destroyed')
  }

  private destroySprite(model: Live2DSprite | null) {
    destroyLive2dSprite(model, this.app)
  }

  public resizeModel(modelSize: ModelSize, viewportSize: ModelSize = { width: innerWidth, height: innerHeight }) {
    if (!this.model) return

    const { width, height } = modelSize

    const scaleX = viewportSize.width / width
    const scaleY = viewportSize.height / height
    const scale = Math.min(scaleX, scaleY)

    this.model.scale.set(scale)
    this.model.x = viewportSize.width / 2
    this.model.y = viewportSize.height / 2
    this.model.anchor.set(0.5)
    if (this.renderingEnabled) {
      this.startTicker('model-resized')
    }
  }

  public startMotion(motion: MotionInfo) {
    return this.model?.startMotion({
      ...motion,
      priority: Priority.Normal,
    })
  }

  public setExpression(index: number) {
    return this.model?.setExpression({ index })
  }

  public clearExpression() {
    // easy-live2d exposes expression selection but not clearing. Stopping its
    // expression motion manager restores the model parameters saved before it ran.
    const expressionManager = (this.model as unknown as {
      _model?: {
        expressionCtrl?: {
          _expressionManager?: {
            stopAllMotions: () => void
          }
        }
      }
    })?._model?.expressionCtrl?._expressionManager

    expressionManager?.stopAllMotions()
  }

  public getParameterValueRange(id: string) {
    return this.model?.getParameterValueRangeById(id)
  }

  public setParameterValue(id: string, value: number | boolean) {
    this.trackFallbackPhysicsInput(id, Number(value))

    return this.model?.setParameterValueById(id, Number(value))
  }

  public setLookTarget(x: number, y: number) {
    const targetX = applyPhysicsInputGain(x)
    const targetY = applyPhysicsInputGain(y)
    const model = this.model as DraggableLive2DSprite | null

    this.fallbackPhysicsAngles.x = targetX * 30
    this.fallbackPhysicsAngles.y = targetY * 30
    this.fallbackPhysicsAngles.z = targetX * targetY * -30

    model?.setDragging(targetX, targetY)
  }

  public setMotionSoundEnabled(enabled: boolean) {
    Config.MotionSound = enabled
  }

  public setMaxFPS(fps: number) {
    this.maxFPS = fps
    this.renderDiagnostics?.setTargetFPS(fps)
    logInfo('[live2d] max FPS changed', { maxFPS: fps })

    if (this.app?.ticker) {
      this.app.ticker.maxFPS = fps
    }
  }

  public setRenderingEnabled(enabled: boolean) {
    this.renderingEnabled = enabled

    if (!enabled) {
      this.stopTicker('rendering-disabled')
      return
    }

    if (this.model) {
      this.startTicker('rendering-enabled')
    }
  }

  private startTicker(reason: string) {
    this.app?.start()
    this.renderDiagnostics?.start()
    logTrace('[live2d] ticker started', {
      reason,
      maxFPS: this.maxFPS,
      visibility: document.visibilityState,
      hidden: document.hidden,
      hasFocus: document.hasFocus(),
      tickerStarted: this.app?.ticker.started ?? false,
    })
  }

  private stopTicker(reason: string) {
    this.app?.stop()
    this.renderDiagnostics?.stop()
    logTrace('[live2d] ticker stopped', {
      reason,
      maxFPS: this.maxFPS,
      visibility: document.visibilityState,
      hidden: document.hidden,
      hasFocus: document.hasFocus(),
      tickerStarted: this.app?.ticker.started ?? false,
    })
  }

  private readonly recordRenderFrame = (ticker: Ticker) => {
    this.renderDiagnostics?.recordFrame(ticker.deltaMS)
  }

  private setupFallbackPhysics(modelJSON: CubismModelJson) {
    this.stopFallbackPhysics()

    if (hasNativePhysics(modelJSON) || !this.model || !this.app) return

    const parameters = Object.keys(FALLBACK_PHYSICS_PARAMETER_STRENGTHS)
      .filter((id): id is FallbackPhysicsParameter => Boolean(this.model?.getParameterValueRangeById(id)))

    if (!parameters.length) return

    this.fallbackPhysicsParameters = Object.fromEntries(parameters.map(id => [id, true])) as FallbackPhysicsParameters
    this.fallbackPhysicsAngles = { x: 0, y: 0, z: 0 }
    this.fallbackPhysicsSmoothedAngles = { x: 0, y: 0, z: 0 }
    this.fallbackPhysicsVelocity = { x: 0, y: 0, z: 0 }
    this.fallbackPhysicsTime = 0
    this.app.ticker.add(this.updateFallbackPhysics)
  }

  private stopFallbackPhysics() {
    this.app?.ticker.remove(this.updateFallbackPhysics)
    this.fallbackPhysicsParameters = {}
    this.fallbackPhysicsTime = 0
  }

  private readonly updateFallbackPhysics = (ticker: Ticker) => {
    if (!this.model || !Object.keys(this.fallbackPhysicsParameters).length) return

    const deltaSeconds = clamp(ticker.deltaMS / 1000 || 1 / 60, 1 / 120, 0.1)
    const previousAngles = { ...this.fallbackPhysicsSmoothedAngles }
    const angleFactor = smoothingFactor(8, deltaSeconds)

    this.fallbackPhysicsTime += deltaSeconds
    this.fallbackPhysicsSmoothedAngles.x += (this.fallbackPhysicsAngles.x - this.fallbackPhysicsSmoothedAngles.x) * angleFactor
    this.fallbackPhysicsSmoothedAngles.y += (this.fallbackPhysicsAngles.y - this.fallbackPhysicsSmoothedAngles.y) * angleFactor
    this.fallbackPhysicsSmoothedAngles.z += (this.fallbackPhysicsAngles.z - this.fallbackPhysicsSmoothedAngles.z) * angleFactor
    this.fallbackPhysicsVelocity.x += (
      (this.fallbackPhysicsSmoothedAngles.x - previousAngles.x) / deltaSeconds
      - this.fallbackPhysicsVelocity.x
    ) * smoothingFactor(10, deltaSeconds)
    this.fallbackPhysicsVelocity.y += (
      (this.fallbackPhysicsSmoothedAngles.y - previousAngles.y) / deltaSeconds
      - this.fallbackPhysicsVelocity.y
    ) * smoothingFactor(10, deltaSeconds)
    this.fallbackPhysicsVelocity.z += (
      (this.fallbackPhysicsSmoothedAngles.z - previousAngles.z) / deltaSeconds
      - this.fallbackPhysicsVelocity.z
    ) * smoothingFactor(10, deltaSeconds)

    const idle = Math.sin(this.fallbackPhysicsTime * 1.8)
    const idleSlow = Math.sin(this.fallbackPhysicsTime * 1.15 + 1.2)
    const idleSide = Math.sin(this.fallbackPhysicsTime * 1.45 + 2.4)
    const angleX = clamp(this.fallbackPhysicsSmoothedAngles.x / 30, -1, 1)
    const angleY = clamp(this.fallbackPhysicsSmoothedAngles.y / 30, -1, 1)
    const angleZ = clamp(this.fallbackPhysicsSmoothedAngles.z / 30, -1, 1)
    const velocityX = clamp(this.fallbackPhysicsVelocity.x / 300, -1, 1)
    const velocityY = clamp(this.fallbackPhysicsVelocity.y / 300, -1, 1)
    const velocityZ = clamp(this.fallbackPhysicsVelocity.z / 300, -1, 1)

    this.setFallbackParameter('ParamBreath', 0.45 + 0.55 * idle)
    this.setFallbackParameter('ParamHairFront', idle * 0.4 - angleY * 0.45 - velocityY * 0.22)
    this.setFallbackParameter('ParamHairSide', idleSide * 0.28 - angleX * 0.55 - velocityX * 0.28)
    this.setFallbackParameter('ParamHairBack', idleSlow * 0.36 - angleZ * 0.48 - velocityZ * 0.22)
  }

  private setFallbackParameter(id: FallbackPhysicsParameter, normalizedValue: number) {
    if (!this.model || !this.fallbackPhysicsParameters[id]) return

    const range = this.model.getParameterValueRangeById(id)

    if (!range) return

    const { min, max } = range
    const center = min <= 0 && max >= 0 ? 0 : (min + max) / 2
    const radius = Math.min(Math.abs(min - center), Math.abs(max - center))
    const strength = FALLBACK_PHYSICS_PARAMETER_STRENGTHS[id]
    const value = clamp(center + clamp(normalizedValue, -1, 1) * radius * strength, min, max)

    this.model.setParameterValueById(id, value)
  }

  private trackFallbackPhysicsInput(id: string, value: number) {
    switch (id) {
      case 'ParamAngleX':
        this.fallbackPhysicsAngles.x = applyPhysicsAngleGain(value)
        return
      case 'ParamAngleY':
        this.fallbackPhysicsAngles.y = applyPhysicsAngleGain(value)
        return
      case 'ParamAngleZ':
        this.fallbackPhysicsAngles.z = applyPhysicsAngleGain(value)
    }
  }
}

const live2d = new Live2d()

export default live2d
