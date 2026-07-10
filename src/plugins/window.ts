// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { error } from '@tauri-apps/plugin-log'

import type { WINDOW_LABEL } from '../constants'

import { LISTEN_KEY } from '../constants'

export type WindowLabel = typeof WINDOW_LABEL[keyof typeof WINDOW_LABEL]

const COMMAND = {
  SHOW_WINDOW: 'plugin:custom-window|show_window',
  HIDE_WINDOW: 'plugin:custom-window|hide_window',
  SET_ALWAYS_ON_TOP: 'plugin:custom-window|set_always_on_top',
  SET_TASKBAR_VISIBILITY: 'plugin:custom-window|set_taskbar_visibility',
}

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
  if (label) {
    return emit(LISTEN_KEY.SHOW_WINDOW, label).catch(catchWindowError('emit-show'))
  } else {
    return invoke(COMMAND.SHOW_WINDOW).catch(catchWindowError('show'))
  }
}

export function hideWindow(label?: WindowLabel) {
  if (label) {
    return emit(LISTEN_KEY.HIDE_WINDOW, label).catch(catchWindowError('emit-hide'))
  } else {
    return invoke(COMMAND.HIDE_WINDOW).catch(catchWindowError('hide'))
  }
}

export function setAlwaysOnTop(alwaysOnTop: boolean) {
  return invoke(COMMAND.SET_ALWAYS_ON_TOP, { alwaysOnTop }).catch(catchWindowError('always-on-top'))
}

export async function toggleWindowVisible(label?: WindowLabel) {
  const appWindow = getCurrentWebviewWindow()

  if (appWindow.label !== label) return

  const visible = await appWindow.isVisible()

  if (visible) {
    return hideWindow(label)
  }

  return showWindow(label)
}

export async function setTaskbarVisibility(visible: boolean) {
  return invoke(COMMAND.SET_TASKBAR_VISIBILITY, { visible }).catch(catchWindowError('taskbar'))
}
