// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { emitTo, listen } from '@tauri-apps/api/event'
import { nanoid } from 'nanoid'

import { LISTEN_KEY, WINDOW_LABEL } from '@/constants'

import type { TypingStatsState } from './typingStatsPersistence'

import { withTimeout } from './promise'

const DEFAULT_TIMEOUT_MS = 15_000

export type TypingStatsOperation
  = | { kind: 'set-enabled', enabled: boolean }
    | { kind: 'clear-history' }
    | { kind: 'flush', pauseId: string }
    | { kind: 'resume', pauseId: string }

export interface TypingStatsOperationRequest {
  operation: TypingStatsOperation
  requestId: string
}

export interface TypingStatsOperationAcknowledgement {
  accepted: boolean
  reason?: string
  requestId: string
  state?: TypingStatsState
}

export interface TypingStatsRequestAdapter {
  emit: (request: TypingStatsOperationRequest) => Promise<void>
  listen: (
    callback: (acknowledgement: TypingStatsOperationAcknowledgement) => void,
  ) => Promise<() => void | Promise<void>>
}

interface TypingStatsRequestOptions {
  adapter?: TypingStatsRequestAdapter
  timeoutMs?: number
}

const defaultAdapter: TypingStatsRequestAdapter = {
  emit: request => emitTo(
    WINDOW_LABEL.MAIN,
    LISTEN_KEY.TYPING_STATS_OPERATION_REQUESTED,
    request,
  ),
  listen: callback => listen<TypingStatsOperationAcknowledgement>(
    LISTEN_KEY.TYPING_STATS_OPERATION_APPLIED,
    ({ payload }) => callback(payload),
  ),
}

export async function requestTypingStatsOperation(
  operation: TypingStatsOperation,
  options: TypingStatsRequestOptions = {},
) {
  const adapter = options.adapter ?? defaultAdapter
  const request: TypingStatsOperationRequest = {
    operation,
    requestId: nanoid(),
  }
  let resolveAcknowledgement!: (acknowledgement: TypingStatsOperationAcknowledgement) => void
  const acknowledgement = new Promise<TypingStatsOperationAcknowledgement>((resolve) => {
    resolveAcknowledgement = resolve
  })
  const unlisten = await adapter.listen((payload) => {
    if (payload.requestId !== request.requestId) return

    resolveAcknowledgement(payload)
  })

  try {
    return await withTimeout((async () => {
      await adapter.emit(request)
      return await acknowledgement
    })(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'Typing statistics operation timed out.')
  } finally {
    await unlisten()
  }
}
