export type CubismLoadErrorCode
  = | 'core-unavailable'
    | 'webgl2-unavailable'
    | 'moc-incompatible'
    | 'moc-invalid'
    | 'model-resource'
    | 'renderer-init'

export interface CubismRuntimeDiagnostics {
  coreVersion?: number
  latestMocVersion?: number
  mocVersion?: number
  drawableCount?: number
  offscreenCount?: number
  blendModeEnabled?: boolean
  frameCount?: number
  averageFrameMs?: number
  maxFrameMs?: number
  webglErrorCount?: number
}

type CubismCore = typeof Live2DCubismCore

function getCore(): CubismCore | undefined {
  return (globalThis as typeof globalThis & { Live2DCubismCore?: CubismCore }).Live2DCubismCore
}

export function getCubismRuntimeDiagnostics(): CubismRuntimeDiagnostics {
  const core = getCore()

  if (!core) return {}

  return {
    coreVersion: core.Version.csmGetVersion(),
    latestMocVersion: core.Version.csmGetLatestMocVersion(),
  }
}

export function getCubismMocVersion(buffer: ArrayBuffer) {
  const core = getCore()

  if (!core) {
    throw new Live2DLoadError(
      'core-unavailable',
      'Live2D Cubism Core 5.3 is not loaded.',
    )
  }

  return core.Version.csmGetMocVersion(buffer)
}

export class Live2DLoadError extends Error {
  readonly code: CubismLoadErrorCode
  readonly diagnostics: CubismRuntimeDiagnostics
  readonly cause?: unknown

  constructor(
    code: CubismLoadErrorCode,
    message: string,
    diagnostics: CubismRuntimeDiagnostics = {},
    cause?: unknown,
  ) {
    super(message)
    this.name = 'Live2DLoadError'
    this.code = code
    this.diagnostics = diagnostics
    this.cause = cause
  }
}

export function isLive2DLoadError(error: unknown): error is Live2DLoadError {
  return error instanceof Live2DLoadError
}
