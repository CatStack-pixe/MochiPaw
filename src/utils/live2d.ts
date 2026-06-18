import type { ExpressionInfo, MotionInfo } from 'easy-live2d'

import { convertFileSrc } from '@tauri-apps/api/core'
import { readDir, readTextFile } from '@tauri-apps/plugin-fs'
import { Config, CubismSetting, Live2DSprite, Priority } from 'easy-live2d'
import { flatMap, groupBy } from 'es-toolkit/compat'
import JSON5 from 'json5'
import { Application, Ticker } from 'pixi.js'

import type { ModelSize } from '@/composables/useModel'
import type { ModelExpressionInfo, ModelMotionInfo } from '@/stores/model'

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

  public setExpression(index: number) {
    return this.model?.setExpression({ index })
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
