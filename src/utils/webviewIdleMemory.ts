// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { WebviewMemoryTarget } from '@/plugins/window'

export const WEBVIEW_IDLE_TIMEOUT = 60_000
export const WEBVIEW_MOUSE_MOVE_THROTTLE = 1_000

export interface WebviewIdleMemoryOptions {
  setTarget: (target: WebviewMemoryTarget) => Promise<boolean>
  idleTimeout?: number
  mouseMoveThrottle?: number
  now?: () => number
  setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void
}

export class WebviewIdleMemoryController {
  private readonly setTarget: WebviewIdleMemoryOptions['setTarget']
  private readonly idleTimeout: number
  private readonly mouseMoveThrottle: number
  private readonly now: () => number
  private readonly scheduleTimeout: NonNullable<WebviewIdleMemoryOptions['setTimeout']>
  private readonly cancelTimeout: NonNullable<WebviewIdleMemoryOptions['clearTimeout']>
  private target: WebviewMemoryTarget = 'normal'
  private idleTimer?: ReturnType<typeof setTimeout>
  private lastMouseMoveAt?: number
  private hidden = false
  private disposed = false

  constructor(options: WebviewIdleMemoryOptions) {
    this.setTarget = options.setTarget
    this.idleTimeout = options.idleTimeout ?? WEBVIEW_IDLE_TIMEOUT
    this.mouseMoveThrottle = options.mouseMoveThrottle ?? WEBVIEW_MOUSE_MOVE_THROTTLE
    this.now = options.now ?? Date.now
    this.scheduleTimeout = options.setTimeout ?? ((callback, delay) => globalThis.setTimeout(callback, delay))
    this.cancelTimeout = options.clearTimeout ?? (timer => globalThis.clearTimeout(timer))
  }

  start(hidden = false) {
    if (this.disposed) return

    this.hidden = hidden

    if (hidden) {
      this.changeTarget('low')
    } else {
      this.scheduleIdleTarget()
    }
  }

  activity() {
    if (this.disposed || this.hidden) return

    this.changeTarget('normal')
    this.scheduleIdleTarget()
  }

  mouseMove() {
    if (this.disposed || this.hidden) return

    const now = this.now()

    if (this.lastMouseMoveAt !== undefined && now - this.lastMouseMoveAt < this.mouseMoveThrottle) return

    this.lastMouseMoveAt = now
    this.activity()
  }

  setHidden(hidden: boolean) {
    if (this.disposed) return

    this.hidden = hidden

    if (hidden) {
      this.clearIdleTimer()
      this.changeTarget('low')
    } else {
      this.activity()
    }
  }

  activate() {
    if (this.disposed) return

    this.hidden = false
    this.activity()
  }

  dispose() {
    if (this.disposed) return

    this.disposed = true
    this.clearIdleTimer()
  }

  private scheduleIdleTarget() {
    this.clearIdleTimer()
    this.idleTimer = this.scheduleTimeout(() => {
      this.idleTimer = undefined
      this.changeTarget('low')
    }, this.idleTimeout)
  }

  private clearIdleTimer() {
    if (this.idleTimer === undefined) return

    this.cancelTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private changeTarget(target: WebviewMemoryTarget) {
    if (this.target === target) return

    this.target = target
    void this.setTarget(target).catch(() => false)
  }
}
