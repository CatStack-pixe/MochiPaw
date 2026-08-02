// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { emitTo } from '@tauri-apps/api/event'

import type { Model, SubModelInstance } from '@/stores/model'

import { LISTEN_KEY } from '@/constants'

import { getModelResourceMetric } from './modelResourceMetrics'
import { getSubModelWindowLabel } from './subModelWindow'

export interface CursorPoint {
  x: number
  y: number
}

export interface RelativeMouseMove {
  dx: number
  dy: number
}

export type DeviceInputEvent
  = | { kind: 'MousePress' | 'MouseRelease' | 'KeyboardPress' | 'KeyboardRelease', value: string }
    | { kind: 'MouseMove', value: CursorPoint }
    | { kind: 'MouseRelativeMove', value: RelativeMouseMove }

export interface GamepadInputEvent {
  kind: 'ButtonChanged' | 'AxisChanged'
  name: string
  value: number
}

export interface SubModelInputFrame {
  sequence: number
  deviceEvents: DeviceInputEvent[]
  gamepadEvents: GamepadInputEvent[]
}

export interface SubModelRuntimeCapacity {
  allowed: boolean
  activeCount: number
  maxActiveCount: number
  reservedBytes: number
  budgetBytes: number
}

const MEBIBYTE = 1024 * 1024
const DEFAULT_RESOURCE_BUDGET_BYTES = 2 * 1024 * MEBIBYTE
const RENDERER_RESERVATION_BYTES = 128 * MEBIBYTE
const MODEL_MEMORY_MULTIPLIER = 1.5

export const MAX_VISIBLE_SUB_MODELS = 7

function getReservedModelBytes(estimatedMemoryBytes: number) {
  return RENDERER_RESERVATION_BYTES + Math.ceil(estimatedMemoryBytes * MODEL_MEMORY_MULTIPLIER)
}

export async function getSubModelRuntimeCapacity(
  instances: SubModelInstance[],
  models: Model[],
  primaryModel: Model | undefined,
): Promise<SubModelRuntimeCapacity> {
  const activeInstances = instances.filter(instance => instance.visible)
  const activeModels = activeInstances
    .map(instance => models.find(model => model.id === instance.modelId))
    .filter((model): model is Model => Boolean(model))

  if (primaryModel) activeModels.unshift(primaryModel)

  const metrics = await Promise.all(activeModels.map(model => getModelResourceMetric(model)))
  const reservedBytes = metrics.reduce((total, metric) => {
    return total + getReservedModelBytes(metric.estimatedMemoryBytes)
  }, 0)

  return {
    allowed: activeInstances.length <= MAX_VISIBLE_SUB_MODELS && reservedBytes <= DEFAULT_RESOURCE_BUDGET_BYTES,
    activeCount: activeInstances.length,
    maxActiveCount: MAX_VISIBLE_SUB_MODELS,
    reservedBytes,
    budgetBytes: DEFAULT_RESOURCE_BUDGET_BYTES,
  }
}

export class SubModelInputCoordinator {
  private deviceEvents: DeviceInputEvent[] = []
  private gamepadEvents: GamepadInputEvent[] = []
  private frame = 0
  private sequence = 0

  constructor(private readonly getActiveInstances: () => SubModelInstance[]) {}

  enqueueDevice(event: DeviceInputEvent) {
    if (event.kind === 'MouseMove') {
      const index = this.findLastIndex(this.deviceEvents, item => item.kind === 'MouseMove')

      if (index !== -1) {
        this.deviceEvents[index] = event
      } else {
        this.deviceEvents.push(event)
      }
    } else if (event.kind === 'MouseRelativeMove') {
      const index = this.findLastIndex(this.deviceEvents, item => item.kind === 'MouseRelativeMove')

      if (index !== -1) {
        const previous = this.deviceEvents[index] as Extract<DeviceInputEvent, { kind: 'MouseRelativeMove' }>

        this.deviceEvents[index] = {
          kind: 'MouseRelativeMove',
          value: {
            dx: previous.value.dx + event.value.dx,
            dy: previous.value.dy + event.value.dy,
          },
        }
      } else {
        this.deviceEvents.push(event)
      }
    } else {
      this.deviceEvents.push(event)
    }

    this.scheduleFlush()
  }

  enqueueGamepad(event: GamepadInputEvent) {
    const index = this.findLastIndex(this.gamepadEvents, item => item.kind === event.kind && item.name === event.name)

    if (index !== -1) {
      this.gamepadEvents[index] = event
    } else {
      this.gamepadEvents.push(event)
    }

    this.scheduleFlush()
  }

  dispose() {
    if (this.frame) cancelAnimationFrame(this.frame)

    this.frame = 0
    this.deviceEvents = []
    this.gamepadEvents = []
  }

  private findLastIndex<T>(items: T[], predicate: (item: T) => boolean) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (predicate(items[index])) return index
    }

    return -1
  }

  private scheduleFlush() {
    if (this.frame) return

    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      void this.flush()
    })
  }

  private async flush() {
    if (!this.deviceEvents.length && !this.gamepadEvents.length) return

    const frame: SubModelInputFrame = {
      sequence: ++this.sequence,
      deviceEvents: this.deviceEvents,
      gamepadEvents: this.gamepadEvents,
    }

    this.deviceEvents = []
    this.gamepadEvents = []

    await Promise.all(this.getActiveInstances().map((instance) => {
      return emitTo(getSubModelWindowLabel(instance.id), LISTEN_KEY.SUB_MODEL_INPUT_FRAME, frame)
        .catch(() => undefined)
    }))
  }
}
