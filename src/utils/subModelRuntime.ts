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
  resetInputs?: boolean
}

export interface SubModelInputReceiver {
  resetInputs: () => void
  handleDevice: (event: DeviceInputEvent) => void
  handleGamepad: (event: GamepadInputEvent) => void
}

export function applySubModelInputFrame(frame: SubModelInputFrame, receiver: SubModelInputReceiver) {
  // An overflow may discard the release for a press sent in an earlier frame.
  // Reset before replaying the retained tail so no stale input remains held.
  if (frame.resetInputs) receiver.resetInputs()
  for (const event of frame.deviceEvents) receiver.handleDevice(event)
  for (const event of frame.gamepadEvents) receiver.handleGamepad(event)
}

/**
 * The browser may stop running requestAnimationFrame while the main window is
 * hidden.  Keep the pending input bounded so a hidden window cannot retain an
 * unbounded stream of native events.  Continuous events are coalesced below;
 * this limit primarily protects keyboard/button edges during a long pause.
 */
export const MAX_PENDING_SUB_MODEL_INPUT_EVENTS = 256

export interface SubModelInputScheduler {
  request: (callback: () => void) => number
  cancel: (handle: number) => void
}

export interface SubModelInputCoordinatorOptions {
  scheduler?: SubModelInputScheduler
  send?: (instance: SubModelInstance, frame: SubModelInputFrame) => Promise<unknown> | unknown
  maxPendingEvents?: number
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
  private frame: number | undefined
  private sequence = 0
  private disposed = false
  private flushing = false
  private droppedEvents = 0
  private resetInputs = false
  private readonly scheduler: SubModelInputScheduler
  private readonly send: (instance: SubModelInstance, frame: SubModelInputFrame) => Promise<unknown> | unknown
  private readonly maxPendingEvents: number

  constructor(
    private readonly getActiveInstances: () => SubModelInstance[],
    options: SubModelInputCoordinatorOptions = {},
  ) {
    this.scheduler = options.scheduler ?? createDefaultSubModelInputScheduler()
    this.send = options.send ?? ((instance, frame) => emitTo(
      getSubModelWindowLabel(instance.id),
      LISTEN_KEY.SUB_MODEL_INPUT_FRAME,
      frame,
    ))
    const configuredMax = options.maxPendingEvents
    this.maxPendingEvents = Number.isFinite(configuredMax)
      ? Math.max(1, Math.floor(configuredMax!))
      : MAX_PENDING_SUB_MODEL_INPUT_EVENTS
  }

  enqueueDevice(event: DeviceInputEvent) {
    if (this.disposed || !this.hasInterestedInstance(event)) return

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

    this.trimOverflow()
    this.scheduleFlush()
  }

  enqueueGamepad(event: GamepadInputEvent) {
    if (this.disposed || !this.hasInterestedInstance(event)) return

    const index = this.findLastIndex(this.gamepadEvents, item => item.kind === event.kind && item.name === event.name)

    // Axis values are continuous and safe to replace. Button edges are not:
    // replacing a press with a release can leave a model permanently pressed.
    if (event.kind === 'AxisChanged' && index !== -1) {
      this.gamepadEvents[index] = event
    } else {
      this.gamepadEvents.push(event)
    }

    this.trimOverflow()
    this.scheduleFlush()
  }

  dispose() {
    this.disposed = true

    if (this.frame !== undefined) this.scheduler.cancel(this.frame)

    this.frame = undefined
    this.deviceEvents = []
    this.gamepadEvents = []
    this.resetInputs = false
  }

  /** Number of events retained while a scheduled frame is waiting to run. */
  getPendingEventCount() {
    return this.deviceEvents.length + this.gamepadEvents.length
  }

  /** Number of events discarded by the bounded queue since construction. */
  getDroppedEventCount() {
    return this.droppedEvents
  }

  private findLastIndex<T>(items: T[], predicate: (item: T) => boolean) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (predicate(items[index])) return index
    }

    return -1
  }

  private scheduleFlush() {
    if (this.disposed || this.flushing || this.frame !== undefined || !this.getActiveInstances().some(instance => instance.visible !== false)) return

    this.frame = this.scheduler.request(() => {
      this.frame = undefined
      void this.flush()
    })
  }

  private async flush() {
    if (this.disposed || (!this.resetInputs && !this.deviceEvents.length && !this.gamepadEvents.length)) return

    const activeInstances = this.getActiveInstances().filter(instance => instance.visible !== false)
    if (!activeInstances.length) {
      this.deviceEvents = []
      this.gamepadEvents = []
      this.resetInputs = false
      return
    }

    const frame: SubModelInputFrame = {
      sequence: ++this.sequence,
      deviceEvents: this.deviceEvents,
      gamepadEvents: this.gamepadEvents,
      resetInputs: this.resetInputs || undefined,
    }

    this.deviceEvents = []
    this.gamepadEvents = []
    this.resetInputs = false

    this.flushing = true
    try {
      await Promise.all(activeInstances.map((instance) => {
        const filteredFrame = this.filterFrameForInstance(frame, instance)
        if (!filteredFrame.resetInputs && !filteredFrame.deviceEvents.length && !filteredFrame.gamepadEvents.length) return undefined

        return Promise.resolve().then(() => {
          if (!this.disposed) return this.send(instance, filteredFrame)
        }).catch(() => undefined)
      }))
    } finally {
      this.flushing = false
      // Backpressure keeps slow IPC from retaining an unbounded number of
      // in-flight frames. Only the bounded/coalesced pending queue may grow.
      if (this.resetInputs || this.deviceEvents.length || this.gamepadEvents.length) this.scheduleFlush()
    }
  }

  private hasInterestedInstance(event: DeviceInputEvent | GamepadInputEvent) {
    return this.getActiveInstances().some((instance) => {
      if (instance.visible === false) return false

      return this.isEventEnabledForInstance(event, instance)
    })
  }

  private filterFrameForInstance(frame: SubModelInputFrame, instance: SubModelInstance): SubModelInputFrame {
    return {
      sequence: frame.sequence,
      resetInputs: frame.resetInputs,
      deviceEvents: instance.listeners.keyboard || instance.listeners.mouse
        ? frame.deviceEvents.filter(event => this.isEventEnabledForInstance(event, instance))
        : [],
      gamepadEvents: instance.listeners.gamepad ? frame.gamepadEvents : [],
    }
  }

  private isEventEnabledForInstance(event: DeviceInputEvent | GamepadInputEvent, instance: SubModelInstance) {
    if (event.kind === 'ButtonChanged' || event.kind === 'AxisChanged') return instance.listeners.gamepad
    if (event.kind === 'KeyboardPress' || event.kind === 'KeyboardRelease') return instance.listeners.keyboard
    return instance.listeners.mouse
  }

  private trimOverflow() {
    while (this.getPendingEventCount() > this.maxPendingEvents) {
      this.resetInputs = true
      const dropped = this.dropOldestContinuousEvent()

      if (!dropped) {
        if (this.deviceEvents.length) this.deviceEvents.shift()
        else this.gamepadEvents.shift()
      }

      this.droppedEvents += 1
    }
  }

  private dropOldestContinuousEvent() {
    const deviceIndex = this.deviceEvents.findIndex(event => event.kind === 'MouseMove' || event.kind === 'MouseRelativeMove')
    if (deviceIndex !== -1) {
      this.deviceEvents.splice(deviceIndex, 1)
      return true
    }

    const gamepadIndex = this.gamepadEvents.findIndex(event => event.kind === 'AxisChanged')
    if (gamepadIndex !== -1) {
      this.gamepadEvents.splice(gamepadIndex, 1)
      return true
    }

    return false
  }
}

function createDefaultSubModelInputScheduler(): SubModelInputScheduler {
  let nextHandle = 1
  const pending = new Map<number, {
    animationFrame?: number
    timeout?: ReturnType<typeof setTimeout>
  }>()

  return {
    request(callback) {
      const handle = nextHandle++
      const entry: {
        animationFrame?: number
        timeout?: ReturnType<typeof setTimeout>
      } = {}
      const run = () => {
        if (!pending.has(handle)) return

        pending.delete(handle)
        if (entry.animationFrame !== undefined && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(entry.animationFrame)
        }
        if (entry.timeout !== undefined) clearTimeout(entry.timeout)
        callback()
      }

      if (typeof requestAnimationFrame === 'function') {
        entry.animationFrame = requestAnimationFrame(run)
      }
      // Hidden webviews can stop rAF completely. The timer is only a fallback;
      // browsers may throttle it, so the queue remains bounded above.
      entry.timeout = setTimeout(run, 100)
      pending.set(handle, entry)
      return handle
    },
    cancel(handle) {
      const entry = pending.get(handle)
      if (!entry) return

      pending.delete(handle)
      if (entry.animationFrame !== undefined && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(entry.animationFrame)
      }
      if (entry.timeout !== undefined) clearTimeout(entry.timeout)
    },
  }
}
