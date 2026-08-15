// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { emitTo, listen } from '@tauri-apps/api/event'
import { nanoid } from 'nanoid'

import type { PomodoroCommand } from '@/stores/pomodoro'
import type { PomodoroRuntime, PomodoroSettings, PomodoroTransitionResult } from '@/utils/pomodoroClock'

import { LISTEN_KEY, WINDOW_LABEL } from '@/constants'

import { withTimeout } from './promise'

export interface PomodoroStatePayload {
  runtime: PomodoroRuntime
  settings: PomodoroSettings
}

export interface PomodoroCommandRequest {
  command: PomodoroCommand
  requestId: string
  settings?: Partial<PomodoroSettings>
}

export interface PomodoroCommandAcknowledgement {
  accepted: boolean
  reason?: string
  requestId: string
  state?: PomodoroStatePayload
  result?: PomodoroTransitionResult
}

export async function requestPomodoroCommand(
  command: PomodoroCommand,
  settings?: Partial<PomodoroSettings>,
) {
  const request: PomodoroCommandRequest = {
    command,
    requestId: nanoid(),
    settings,
  }
  let resolveAcknowledgement!: (value: PomodoroCommandAcknowledgement) => void
  const acknowledgement = new Promise<PomodoroCommandAcknowledgement>((resolve) => {
    resolveAcknowledgement = resolve
  })
  const unlisten = await listen<PomodoroCommandAcknowledgement>(
    LISTEN_KEY.POMODORO_COMMAND_APPLIED,
    ({ payload }) => {
      if (payload.requestId === request.requestId) resolveAcknowledgement(payload)
    },
  )

  try {
    return await withTimeout((async () => {
      await emitTo(WINDOW_LABEL.MAIN, LISTEN_KEY.POMODORO_COMMAND_REQUESTED, request)
      return await acknowledgement
    })(), 15_000, 'Pomodoro operation timed out.')
  } finally {
    await unlisten()
  }
}
