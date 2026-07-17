export type WindowRecoveryTrigger = 'manual' | 'moved' | 'resized' | 'scale-changed'

export function clampWindowPositionToMonitor(
  windowPosition: { x: number, y: number },
  windowSize: { width: number, height: number },
  monitor: { x: number, y: number, width: number, height: number },
) {
  const maxX = Math.max(monitor.x, monitor.x + monitor.width - windowSize.width)
  const maxY = Math.max(monitor.y, monitor.y + monitor.height - windowSize.height)

  return {
    x: Math.max(monitor.x, Math.min(windowPosition.x, maxX)),
    y: Math.max(monitor.y, Math.min(windowPosition.y, maxY)),
  }
}

export function getWindowRecoveryPosition(
  trigger: WindowRecoveryTrigger,
  windowPosition: { x: number, y: number },
  windowSize: { width: number, height: number },
  monitor: { x: number, y: number, width: number, height: number },
) {
  if (trigger !== 'manual') return

  return clampWindowPositionToMonitor(windowPosition, windowSize, monitor)
}
