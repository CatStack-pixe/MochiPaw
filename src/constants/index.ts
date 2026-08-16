// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

export const GITHUB_LINK = 'https://github.com/CatStack-pixe/MochiPaw'

export const LISTEN_KEY = {
  SHOW_WINDOW: 'show-window',
  HIDE_WINDOW: 'hide-window',
  DEVICE_CHANGED: 'device-changed',
  UPDATE_APP: 'update-app',
  GAMEPAD_CHANGED: 'gamepad-changed',
  START_MOTION: 'start-motion',
  SET_EXPRESSION: 'set-expression',
  SET_SUB_MODEL_RENDERING: 'set-sub-model-rendering',
  SUB_MODEL_VISIBILITY_CHANGED: 'sub-model-visibility-changed',
  SUB_MODEL_WINDOW_CHANGED: 'sub-model-window-changed',
  UPDATE_SUB_MODEL: 'update-sub-model',
  SUB_MODEL_RUNTIME_READY: 'sub-model-runtime-ready',
  SUB_MODEL_INPUT_FRAME: 'sub-model-input-frame',
  MODEL_SWITCH_REQUESTED: 'model-switch-requested',
  MODEL_SWITCH_APPLIED: 'model-switch-applied',
  TYPING_STATS_OPERATION_REQUESTED: 'typing-stats-operation-requested',
  TYPING_STATS_OPERATION_APPLIED: 'typing-stats-operation-applied',
  POMODORO_COMMAND_REQUESTED: 'pomodoro-command-requested',
  POMODORO_COMMAND_APPLIED: 'pomodoro-command-applied',
  POMODORO_STATE_CHANGED: 'pomodoro-state-changed',
  POMODORO_STAGE_COMPLETED: 'pomodoro-stage-completed',
  GAME_MODE_CHANGED: 'game-mode-changed',
}

export const INVOKE_KEY = {
  COPY_DIR: 'copy_dir',
  EXTRACT_ZIP: 'extract_zip',
  START_DEVICE_LISTENING: 'start_device_listening',
  GET_DEVICE_INPUT_STATUS: 'get_device_input_status',
  GET_UPDATE_CAPABILITY: 'get_update_capability',
  START_GAMEPAD_LISTING: 'start_gamepad_listing',
  STOP_GAMEPAD_LISTING: 'stop_gamepad_listing',
  SET_GAMEPAD_LISTENER_ENABLED: 'set_gamepad_listener_enabled',
}

export const LANGUAGE = {
  ZH_CN: 'zh-CN',
  ZH_TW: 'zh-TW',
  EN_US: 'en-US',
  VI_VN: 'vi-VN',
  PT_BR: 'pt-BR',
} as const

export const WINDOW_LABEL = {
  MAIN: 'main',
  PREFERENCE: 'preference',
} as const
