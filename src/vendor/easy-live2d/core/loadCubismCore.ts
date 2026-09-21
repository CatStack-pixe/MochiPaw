import { Live2DLoadError } from './runtimeDiagnostics'

let pending: Promise<void> | null = null

function coreReady(): boolean {
  const core = (globalThis as typeof globalThis & {
    Live2DCubismCore?: typeof Live2DCubismCore
  }).Live2DCubismCore
  try {
    // Script evaluation can finish before an asynchronous Core runtime is ready.
    return Boolean(core?.Version.csmGetVersion())
  } catch {
    return false
  }
}

/** One in-flight script/runtime initialization per WebView; failures can retry. */
export function loadCubismCore(): Promise<void> {
  if (pending) return pending
  if (coreReady()) return Promise.resolve()

  pending = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    let poll: ReturnType<typeof setTimeout> | undefined
    const timeout = setTimeout(() => {
      fail('Live2D Cubism Core initialization timed out.')
    }, 30_000)
    const cleanup = () => {
      clearTimeout(timeout)
      if (poll !== undefined) clearTimeout(poll)
      script.onload = null
      script.onerror = null
      script.remove()
    }
    const fail = (message: string) => {
      cleanup()
      reject(new Live2DLoadError('core-unavailable', message))
    }
    const checkReady = () => {
      if (coreReady()) {
        cleanup()
        resolve()
      } else {
        poll = setTimeout(checkReady, 10)
      }
    }
    script.async = true
    script.src = '/js/live2dcubismcore.min.js'
    script.onload = checkReady
    script.onerror = () => fail('Failed to load Live2D Cubism Core.')
    try {
      document.head.appendChild(script)
    } catch (error) {
      cleanup()
      reject(error)
    }
  }).finally(() => {
    pending = null
  })
  return pending
}
