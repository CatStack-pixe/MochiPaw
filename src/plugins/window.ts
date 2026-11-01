// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import { invoke } from '@tauri-apps/api/core'
import { emit, emitTo } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow, WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { error } from '@tauri-apps/plugin-log'
import { platform } from '@tauri-apps/plugin-os'

import type { OverlayBackend } from '@/utils/overlay'

import { LISTEN_KEY, WINDOW_LABEL } from '../constants'
import { logInfo } from '../utils/diagnostics'

export type WindowLabel = typeof WINDOW_LABEL[keyof typeof WINDOW_LABEL]
export type WebviewMemoryTarget = 'normal' | 'low'

export interface GameModeOptions extends Record<string, unknown> {
  enabled: boolean
  processes: string[]
  alwaysOnTop: boolean
  passThrough: boolean
}

export interface OverlaySessionOptions extends Record<string, unknown> {
  enabled: boolean
  processes?: string[]
  backend?: OverlayBackend
  modelId?: string
  targetFPS?: 60 | 90 | 120
  passThrough?: boolean
}

export interface OverlayWindowState {
  enabled: boolean
  active: boolean
  backend?: OverlayBackend
  backendActive?: boolean
  processName?: string
  processId?: number
  windowHandle?: number
  x: number
  y: number
  width: number
  height: number
  dpiScale: number
  minimized: boolean
  targetFPS?: 60 | 90 | 120
  modelId?: string
  gamebarActive?: boolean
  error?: string
}

const COMMAND = {
  SHOW_WINDOW: 'plugin:custom-window|show_window',
  HIDE_WINDOW: 'plugin:custom-window|hide_window',
  SET_ALWAYS_ON_TOP: 'plugin:custom-window|set_always_on_top',
  SET_PASS_THROUGH: 'plugin:custom-window|set_pass_through',
  SET_TASKBAR_VISIBILITY: 'plugin:custom-window|set_taskbar_visibility',
  SET_WEBVIEW_MEMORY_TARGET: 'plugin:custom-window|set_webview_memory_target',
  SET_GAME_MODE: 'plugin:custom-window|set_game_mode',
  SET_OVERLAY_SESSION: 'plugin:custom-window|set_overlay_session',
  GET_OVERLAY_WINDOW_STATE: 'plugin:custom-window|get_overlay_window_state',
}

let passThroughQueue: Promise<void> = Promise.resolve()

function formatWindowError(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }

  if (typeof error === 'string') return error

  return JSON.stringify(error)
}

function catchWindowError(action: string) {
  return (reason: unknown) => {
    error(`[window:${action}] ${formatWindowError(reason)}`)
  }
}

export function showWindow(label?: WindowLabel) {
  if (label === WINDOW_LABEL.PREFERENCE) {
    return invoke('show_preference_window').catch(catchWindowError('show-preferences'))
  }

  if (label) {
    return emit(LISTEN_KEY.SHOW_WINDOW, label).catch(catchWindowError('emit-show'))
  } else {
    return invoke(COMMAND.SHOW_WINDOW).catch(catchWindowError('show'))
  }
}

export function hideWindow(label?: WindowLabel) {
  if ((label ?? getCurrentWebviewWindow().label) === WINDOW_LABEL.PREFERENCE) {
    return emitTo(WINDOW_LABEL.PREFERENCE, 'close-preference-window')
      .catch(catchWindowError('close-preferences'))
  }

  if (label) {
    return emit(LISTEN_KEY.HIDE_WINDOW, label).catch(catchWindowError('emit-hide'))
  } else {
    return invoke(COMMAND.HIDE_WINDOW).catch(catchWindowError('hide'))
  }
}

export function setAlwaysOnTop(alwaysOnTop: boolean) {
  return invoke(COMMAND.SET_ALWAYS_ON_TOP, { alwaysOnTop }).catch(catchWindowError('always-on-top'))
}

export function setPassThrough(passThrough: boolean) {
  const request = passThroughQueue.then(() => invoke(COMMAND.SET_PASS_THROUGH, { passThrough }))

  passThroughQueue = request.then(() => undefined, () => undefined)

  return request.catch(catchWindowError('pass-through'))
}

export async function setGameMode(options: GameModeOptions): Promise<boolean> {
  try {
    return await invoke<boolean>(COMMAND.SET_GAME_MODE, options)
  } catch (reason) {
    catchWindowError('game-mode')(reason)
    return false
  }
}

export async function setOverlaySession(options: OverlaySessionOptions): Promise<OverlayWindowState | undefined> {
  try {
    return await invoke<OverlayWindowState>(COMMAND.SET_OVERLAY_SESSION, options)
  } catch (reason) {
    catchWindowError('overlay-session')(reason)
    return undefined
  }
}

export async function getOverlayWindowState(): Promise<OverlayWindowState | undefined> {
  try {
    return await invoke<OverlayWindowState>(COMMAND.GET_OVERLAY_WINDOW_STATE)
  } catch (reason) {
    catchWindowError('overlay-state')(reason)
    return undefined
  }
}

export async function toggleWindowVisible(label?: WindowLabel) {
  const appWindow = label
    ? await WebviewWindow.getByLabel(label)
    : getCurrentWebviewWindow()

  if (!appWindow) return showWindow(label)

  const visible = await appWindow.isVisible()

  if (visible) {
    return hideWindow(label)
  }

  return showWindow(label)
}

export function requestPreferenceUpdate(visibleMessage = true) {
  return invoke('request_preference_update', { visibleMessage })
    .catch(catchWindowError('request-preference-update'))
}

export async function setTaskbarVisibility(visible: boolean) {
  return invoke(COMMAND.SET_TASKBAR_VISIBILITY, { visible }).catch(catchWindowError('taskbar'))
}

export async function setWebviewMemoryTarget(target: WebviewMemoryTarget): Promise<boolean> {
  // This is a WebView2-only control. Other platforms deliberately return false
  // in Rust; avoid their no-op IPC and per-input diagnostic log traffic.
  if (platform() !== 'windows') return false
  const windowLabel = getCurrentWebviewWindow().label

  logInfo('[webview-memory] target requested', { windowLabel, target })

  try {
    const applied = await invoke<boolean>(COMMAND.SET_WEBVIEW_MEMORY_TARGET, { target })
    logInfo('[webview-memory] target result', { windowLabel, target, applied })
    return applied
  } catch (reason) {
    catchWindowError('webview-memory-target')(reason)
    return false
  }
}
