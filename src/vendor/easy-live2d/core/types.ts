import type { Ticker } from 'pixi.js'

import type { CubismSetting } from '../utils/cubismSetting'

export interface Viewport {
  x: number
  y: number
  width: number
  height: number
}

export type ModelAssets = string | CubismSetting

export interface ParameterValueRange {
  min: number
  max: number
}

export interface MotionInfo {
  group: string
  no: number
  name: string
}

export interface ExpressionInfo {
  name: string
}

export interface VoiceParams {
  voicePath: string
  immediate?: boolean
}

export interface MotionParams {
  group: string
  no: number
  priority: number
  onStarted?: (motion: unknown) => void
  onFinished?: (motion: unknown) => void
}

export type ExpressionParams =
  | { expressionId: string, index?: never }
  | { index: number, expressionId?: never }

export interface Live2DSpriteInit {
  modelPath?: string
  modelSetting?: CubismSetting
  ticker?: Ticker
  draggable?: boolean
}

export interface Live2DSpriteDragEvent {
  x: number
  y: number
  deltaX: number
  deltaY: number
}

export interface Live2DSpriteEvents {
  hit: [{ hitAreaName: string, x: number, y: number }]
  ready: []
  dragStart: [Live2DSpriteDragEvent]
  dragMove: [Live2DSpriteDragEvent]
  dragEnd: [Live2DSpriteDragEvent]
}
