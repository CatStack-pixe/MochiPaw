import type { ExpressionInfo, MotionInfo } from 'easy-live2d'

import { convertFileSrc } from '@tauri-apps/api/core'
import { readDir, readTextFile } from '@tauri-apps/plugin-fs'
import { Config, CubismSetting, Live2DSprite, Priority } from 'easy-live2d'
import { flatMap, groupBy } from 'es-toolkit/compat'
import JSON5 from 'json5'
import { Application, Ticker } from 'pixi.js'

import type { ModelSize } from '@/composables/useModel'
import type { ModelBehaviorConfig, ModelExpressionInfo, ModelMotionInfo, ModelMotionTarget } from '@/stores/model'

import { i18n } from '@/locales'

import { join } from './path'

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
    Value?: number
  }>
}

interface CubismMotionJson {
  Curves?: Array<{
    Target?: string
    Id?: string
    Segments?: number[]
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

export async function readCubismModelJSON(path: string) {
  const files = await readDir(path)
  const modelFile = files.find(file => file.name.endsWith('.model3.json'))

  if (!modelFile) {
    throw new Error(i18n.global.t('utils.live2d.hints.notFound'))
  }

  return JSON5.parse(await readTextFile(join(path, modelFile.name))) as CubismModelJson
}

export async function resolveModelMotions(path: string, motions: MotionInfo[]) {
  const modelJSON = await readCubismModelJSON(path)
  const motionsFromJSON = await readMotionsFromModelJSON(path, modelJSON)

  if (!motions.length) return motionsFromJSON

  return Promise.all(motions.map(async (motion): Promise<ModelMotionInfo> => {
    const motionConfig = modelJSON.FileReferences?.Motions?.[motion.group]?.[motion.no]
    const file = motionConfig?.File
    const motionTargets = file ? await readMotionTargets(path, file) : {}

    return {
      ...motion,
      file,
      displayName: getMotionDisplayName(file, motion.name),
      ...motionTargets,
    }
  }))
}

export async function resolveModelExpressions(path: string, expressions: ExpressionInfo[]) {
  const modelJSON = await readCubismModelJSON(path)
  const parameterNames = await getParameterNames(path, modelJSON)
  const expressionTargets = await Promise.all(
    modelJSON.FileReferences?.Expressions?.map(async (expression) => {
      return expression.File ? await readExpressionTargets(path, expression.File) : []
    }) ?? [],
  )
  const expressionTargetIds = [...new Set(
    flatMap(expressionTargets, targets => targets?.map(target => target.id) ?? []),
  )]
  const defaultExpressionTargets = expressionTargetIds.map((id): ModelMotionTarget => ({ id, value: 0 }))

  return Promise.all(expressions.map(async (expression, index): Promise<ModelExpressionInfo> => {
    const expressionConfig = modelJSON.FileReferences?.Expressions?.[index]

    if (!expressionConfig?.File) {
      return {
        ...expression,
        defaultTargets: defaultExpressionTargets,
        mutexTargetIds: expressionTargetIds,
      }
    }

    const expressionJSON = await readTextFile(join(path, expressionConfig.File))
      .then(content => JSON5.parse(content) as CubismExpressionJson)
      .catch(() => undefined)
    const displayName = expressionJSON?.Parameters
      ?.map(parameter => parameter.Id ? parameterNames.get(parameter.Id) : undefined)
      .find(Boolean)

    return {
      ...expression,
      displayName: displayName ?? expressionConfig.Name,
      targets: expressionTargets[index],
      defaultTargets: defaultExpressionTargets,
      mutexTargetIds: expressionTargetIds,
    }
  }))
}

async function readMotionsFromModelJSON(path: string, modelJSON: CubismModelJson) {
  const motionGroups = modelJSON.FileReferences?.Motions

  if (!motionGroups) return []

  const entries = await Promise.all(Object.entries(motionGroups).map(async ([group, items]) => {
    return Promise.all(items.map(async (item, no): Promise<ModelMotionInfo> => {
      const name = item.File ? removeModelFileExtension(item.File) : `${group}_${no}`
      const motionTargets = item.File ? await readMotionTargets(path, item.File) : {}

      return {
        group,
        no,
        name,
        file: item.File,
        displayName: getMotionDisplayName(item.File, name),
        ...motionTargets,
      }
    }))
  }))

  return flatMap(entries, motions => motions)
}

async function readMotionTargets(path: string, file: string) {
  const motionJSON = await readTextFile(join(path, file))
    .then(content => JSON5.parse(content) as CubismMotionJson)
    .catch(() => undefined)

  const parameterCurves = motionJSON?.Curves
    ?.filter(curve => curve.Target === 'Parameter' && curve.Id && curve.Segments?.length)

  return {
    targets: parameterCurves?.map((curve): ModelMotionTarget => ({
      id: curve.Id!,
      value: curve.Segments![curve.Segments!.length - 1],
    })),
    defaultTargets: parameterCurves?.map((curve): ModelMotionTarget => ({
      id: curve.Id!,
      value: curve.Segments![1] ?? 0,
    })),
  }
}

async function readExpressionTargets(path: string, file: string) {
  const expressionJSON = await readTextFile(join(path, file))
    .then(content => JSON5.parse(content) as CubismExpressionJson)
    .catch(() => undefined)

  return expressionJSON?.Parameters
    ?.filter(parameter => parameter.Id)
    .map((parameter): ModelMotionTarget => ({
      id: parameter.Id!,
      value: parameter.Value ?? 1,
    }))
}

function getMotionDisplayName(file: string | undefined, fallback: string) {
  if (!file) return fallback

  const name = removeModelFileExtension(file)

  return MOTION_DISPLAY_NAMES[name] ?? name
}

function removeModelFileExtension(file: string) {
  return file
    .replace(/\.(?:motion3|exp3|model3)\.json$/i, '')
    .replace(/\.[^.]+$/i, '')
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
  public model: Live2DSprite | null = null
  private behaviorResetTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor() { }

  private initApp() {
    if (this.app) return

    const view = document.getElementById('live2dCanvas') as HTMLCanvasElement

    this.app = new Application()

    return this.app.init({
      view,
      resizeTo: window,
      backgroundAlpha: 0,
      autoDensity: true,
      resolution: devicePixelRatio,
    })
  }

  public async load(path: string) {
    await this.initApp()

    this.destroy()

    const modelJSON = await readCubismModelJSON(path)

    const modelSetting = new CubismSetting({
      modelJSON,
    })

    modelSetting.redirectPath(({ file }) => {
      return convertFileSrc(join(path, file))
    })

    this.model = new Live2DSprite({
      modelSetting,
      ticker: Ticker.shared,
    })

    this.app?.stage.addChild(this.model)

    await this.model.ready

    const { width, height } = this.model

    const motions = groupBy(await resolveModelMotions(path, this.model.getMotions()), 'group')
    const expressions = await resolveModelExpressions(path, this.model.getExpressions())

    return {
      width,
      height,
      motions,
      expressions,
    }
  }

  public destroy() {
    if (!this.model) return

    this.model?.destroy()

    this.model = null
  }

  public resizeModel(modelSize: ModelSize) {
    if (!this.model) return

    const { width, height } = modelSize

    const scaleX = innerWidth / width
    const scaleY = innerHeight / height
    const scale = Math.min(scaleX, scaleY)

    this.model.scale.set(scale)
    this.model.x = innerWidth / 2
    this.model.y = innerHeight / 2
    this.model.anchor.set(0.5)
  }

  public startMotion(motion: MotionInfo) {
    return this.model?.startMotion({
      ...motion,
      priority: Priority.Normal,
    })
  }

  private clearBehaviorResetTimer(group: string) {
    const timer = this.behaviorResetTimers.get(group)

    if (!timer) return

    clearTimeout(timer)
    this.behaviorResetTimers.delete(group)
  }

  private scheduleBehaviorReset(group: string, targets: ModelMotionTarget[] | undefined, delay: number) {
    this.clearBehaviorResetTimer(group)

    if (!targets?.length || delay < 0) return

    this.behaviorResetTimers.set(group, setTimeout(() => {
      for (const target of targets) {
        this.setParameterValue(target.id, target.value)
      }

      this.behaviorResetTimers.delete(group)
    }, delay * 1000))
  }

  public playBehaviorMotion(motion: ModelMotionInfo, config?: ModelBehaviorConfig, mutexTargets: ModelMotionTarget[] = []) {
    if (motion.targets?.length) {
      const group = config?.group || motion.group

      this.clearBehaviorResetTimer(group)

      for (const target of mutexTargets) {
        if (motion.targets.some(item => item.id === target.id)) continue

        this.setParameterValue(target.id, target.value)
      }

      for (const target of motion.targets) {
        this.setParameterValue(target.id, target.value)
      }

      this.scheduleBehaviorReset(group, motion.defaultTargets, config?.resetDelay ?? -1)

      return
    }

    return this.startMotion(motion)
  }

  public setExpression(index: number) {
    return this.model?.setExpression({ index })
  }

  public playBehaviorExpression(expression: ModelExpressionInfo, index: number, config?: ModelBehaviorConfig, mutexTargets: ModelMotionTarget[] = []) {
    const targets = expression.targets ?? []
    const group = config?.group || 'expression'

    this.clearBehaviorResetTimer(group)

    for (const target of mutexTargets) {
      if (targets.some(item => item.id === target.id)) continue

      this.setParameterValue(target.id, target.value)
    }

    if (targets.length) {
      for (const target of targets) {
        this.setParameterValue(target.id, target.value)
      }

      this.scheduleBehaviorReset(group, expression.defaultTargets, config?.resetDelay ?? -1)

      return
    }

    if (expression.defaultTargets?.length) {
      for (const target of expression.defaultTargets) {
        this.setParameterValue(target.id, target.value)
      }
    }

    return this.setExpression(index)
  }

  public getParameterValueRange(id: string) {
    return this.model?.getParameterValueRangeById(id)
  }

  public setParameterValue(id: string, value: number | boolean) {
    return this.model?.setParameterValueById(id, Number(value))
  }

  public setMotionSoundEnabled(enabled: boolean) {
    Config.MotionSound = enabled
  }

  public setMaxFPS(fps: number) {
    Ticker.shared.maxFPS = fps
  }
}

const live2d = new Live2d()

export default live2d
