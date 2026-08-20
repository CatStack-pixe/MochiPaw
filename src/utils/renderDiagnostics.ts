// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export interface RenderDiagnosticsSnapshot {
  elapsedMs: number
  frameCount: number
  actualFPS: number
  averageDeltaMS: number
  minDeltaMS: number
  maxDeltaMS: number
  averageObservedDeltaMS: number
  minObservedDeltaMS: number
  maxObservedDeltaMS: number
  longFrameCount: number
  targetFPS: number
}

export interface RenderDiagnosticsOptions {
  targetFPS: number
  reportIntervalMs?: number
  now?: () => number
  onReport?: (snapshot: RenderDiagnosticsSnapshot) => void
}

export class RenderDiagnostics {
  private readonly reportIntervalMs: number
  private readonly now: () => number
  private readonly onReport?: (snapshot: RenderDiagnosticsSnapshot) => void
  private targetFPS: number
  private startedAt?: number
  private lastReportAt?: number
  private frameCount = 0
  private totalDeltaMS = 0
  private minDeltaMS = Number.POSITIVE_INFINITY
  private maxDeltaMS = 0
  private lastFrameAt?: number
  private observedFrameCount = 0
  private totalObservedDeltaMS = 0
  private minObservedDeltaMS = Number.POSITIVE_INFINITY
  private maxObservedDeltaMS = 0
  private longFrameCount = 0

  constructor(options: RenderDiagnosticsOptions) {
    this.targetFPS = options.targetFPS
    this.reportIntervalMs = options.reportIntervalMs ?? 1_000
    this.now = options.now ?? (() => performance.now())
    this.onReport = options.onReport
  }

  setTargetFPS(targetFPS: number) {
    this.targetFPS = targetFPS
  }

  start() {
    const now = this.now()

    if (this.startedAt === undefined) this.startedAt = now
    this.lastReportAt ??= now
  }

  stop() {
    this.startedAt = undefined
    this.lastReportAt = undefined
    this.lastFrameAt = undefined
    this.resetCounters()
  }

  recordFrame(deltaMS: number) {
    if (this.startedAt === undefined) this.start()

    const now = this.now()
    const normalizedDeltaMS = Number.isFinite(deltaMS) && deltaMS >= 0 ? deltaMS : 0
    const observedDeltaMS = this.lastFrameAt === undefined ? undefined : Math.max(0, now - this.lastFrameAt)

    this.lastFrameAt = now
    this.frameCount += 1
    this.totalDeltaMS += normalizedDeltaMS
    this.minDeltaMS = Math.min(this.minDeltaMS, normalizedDeltaMS)
    this.maxDeltaMS = Math.max(this.maxDeltaMS, normalizedDeltaMS)
    if (observedDeltaMS !== undefined) {
      this.observedFrameCount += 1
      this.totalObservedDeltaMS += observedDeltaMS
      this.minObservedDeltaMS = Math.min(this.minObservedDeltaMS, observedDeltaMS)
      this.maxObservedDeltaMS = Math.max(this.maxObservedDeltaMS, observedDeltaMS)
    }

    const expectedDeltaMS = this.targetFPS > 0 ? 1_000 / this.targetFPS : 16.67
    if ((observedDeltaMS ?? normalizedDeltaMS) > Math.max(expectedDeltaMS * 2, 100)) {
      this.longFrameCount += 1
    }

    if (this.lastReportAt === undefined || now - this.lastReportAt < this.reportIntervalMs) return

    const snapshot: RenderDiagnosticsSnapshot = {
      elapsedMs: now - (this.lastReportAt ?? now),
      frameCount: this.frameCount,
      actualFPS: this.frameCount / ((now - (this.lastReportAt ?? now)) / 1_000),
      averageDeltaMS: this.totalDeltaMS / this.frameCount,
      minDeltaMS: this.minDeltaMS,
      maxDeltaMS: this.maxDeltaMS,
      averageObservedDeltaMS: this.observedFrameCount
        ? this.totalObservedDeltaMS / this.observedFrameCount
        : 0,
      minObservedDeltaMS: this.observedFrameCount ? this.minObservedDeltaMS : 0,
      maxObservedDeltaMS: this.maxObservedDeltaMS,
      longFrameCount: this.longFrameCount,
      targetFPS: this.targetFPS,
    }

    this.onReport?.(snapshot)
    this.lastReportAt = now
    this.resetCounters()
    return snapshot
  }

  private resetCounters() {
    this.frameCount = 0
    this.totalDeltaMS = 0
    this.minDeltaMS = Number.POSITIVE_INFINITY
    this.maxDeltaMS = 0
    this.observedFrameCount = 0
    this.totalObservedDeltaMS = 0
    this.minObservedDeltaMS = Number.POSITIVE_INFINITY
    this.maxObservedDeltaMS = 0
    this.longFrameCount = 0
  }
}
