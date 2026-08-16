// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { emit, emitTo, listen } from '@tauri-apps/api/event'
import { toRaw } from 'vue'

import type { usePomodoroStore } from '@/stores/pomodoro'

import { LISTEN_KEY } from '@/constants'

import type { PomodoroPhase } from './pomodoroClock'
import type { PomodoroCommandAcknowledgement, PomodoroCommandRequest, PomodoroStatePayload } from './pomodoroRequest'

type PomodoroStore = ReturnType<typeof usePomodoroStore>

export interface PomodoroCoordinatorOptions {
  notify?: (phase: PomodoroPhase) => void | Promise<void>
  playSound?: () => void | Promise<void>
  prepareNotifications?: () => boolean | Promise<boolean>
}

function getState(store: PomodoroStore): PomodoroStatePayload {
  return {
    runtime: structuredClone(toRaw(store.runtime)),
    settings: structuredClone(toRaw(store.settings)),
  }
}

export async function startPomodoroCoordinator(
  store: PomodoroStore,
  options: PomodoroCoordinatorOptions = {},
) {
  let queue = Promise.resolve()
  let disposed = false

  const publish = async () => {
    if (!disposed) await emit(LISTEN_KEY.POMODORO_STATE_CHANGED, getState(store)).catch(() => undefined)
  }

  const announce = async (phases: PomodoroPhase[]) => {
    for (const phase of phases) {
      if (store.settings.notificationsEnabled) {
        try {
          await options.notify?.(phase)
        } catch {
          // Notification permissions and platform services are optional.
        }
      }
      if (store.settings.soundEnabled) {
        try {
          await options.playSound?.()
        } catch {
          // Audio output must never stop the timer.
        }
      }
      await emit(LISTEN_KEY.POMODORO_STAGE_COMPLETED, { phase }).catch(() => undefined)
    }
  }

  const reconcile = async () => {
    const result = store.reconcile()

    if (result.completedPhases.length > 0) {
      await announce(result.completedPhases)
      await publish()
    }
  }

  const unlisten = await listen<PomodoroCommandRequest>(
    LISTEN_KEY.POMODORO_COMMAND_REQUESTED,
    ({ payload }) => {
      queue = queue.then(async () => {
        const request = payload
        let accepted = true
        let reason: string | undefined
        let result

        try {
          if (request.settings) Object.assign(store.settings, request.settings)
          if (request.settings?.notificationsEnabled) await options.prepareNotifications?.()
          result = store.execute(request.command, Date.now())
          await announce(result.completedPhases)
          await publish()
        } catch (error) {
          accepted = false
          reason = error instanceof Error ? error.message : String(error)
        }

        const acknowledgement: PomodoroCommandAcknowledgement = {
          accepted,
          reason,
          requestId: request.requestId,
          result,
          state: getState(store),
        }

        if (request.sourceWindow) {
          await emitTo(request.sourceWindow, LISTEN_KEY.POMODORO_COMMAND_APPLIED, acknowledgement).catch(() => undefined)
        } else {
          await emit(LISTEN_KEY.POMODORO_COMMAND_APPLIED, acknowledgement).catch(() => undefined)
        }
      }).catch(() => undefined)
    },
  )

  const timer = setInterval(() => {
    void queue.then(reconcile)
  }, 500)

  await publish()

  return () => {
    disposed = true
    clearInterval(timer)
    unlisten()
  }
}
