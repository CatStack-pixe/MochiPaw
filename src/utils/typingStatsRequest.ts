// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { emitTo, listen } from '@tauri-apps/api/event'
import { nanoid } from 'nanoid'

import { LISTEN_KEY, WINDOW_LABEL } from '@/constants'

import type { TypingStatsState } from './typingStatsPersistence'

import { logDebug, logError, logInfo, logWarn } from './diagnostics'
import { PromiseTimeoutError, withTimeout } from './promise'

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
  source?: string
}

function getWindowState() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return undefined

  return {
    visibility: document.visibilityState,
    hidden: document.hidden,
    hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : undefined,
  }
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const request: TypingStatsOperationRequest = {
    operation,
    requestId: nanoid(),
  }
  const context = {
    requestId: request.requestId,
    operation,
    source: options.source,
    timeoutMs,
    window: getWindowState(),
  }

  logDebug('[typing-stats] request listener setup', context)
  let resolveAcknowledgement!: (acknowledgement: TypingStatsOperationAcknowledgement) => void
  const acknowledgement = new Promise<TypingStatsOperationAcknowledgement>((resolve) => {
    resolveAcknowledgement = resolve
  })
  let unlisten: (() => void | Promise<void>) | undefined

  try {
    unlisten = await adapter.listen((payload) => {
      if (payload.requestId !== request.requestId) return

      logInfo('[typing-stats] acknowledgement received', {
        ...context,
        accepted: payload.accepted,
        reason: payload.reason,
      })
      resolveAcknowledgement(payload)
    })

    return await withTimeout((async () => {
      logDebug('[typing-stats] request dispatching', context)
      await adapter.emit(request)
      logInfo('[typing-stats] request emitted', context)
      return await acknowledgement
    })(), timeoutMs, 'Typing statistics operation timed out.')
  } catch (error) {
    if (error instanceof PromiseTimeoutError) {
      logError('[typing-stats] request timed out', { ...context, error, window: getWindowState() })
    } else {
      logError('[typing-stats] request failed', { ...context, error, window: getWindowState() })
    }

    throw error
  } finally {
    if (unlisten) {
      try {
        await unlisten()
        logDebug('[typing-stats] request listener removed', context)
      } catch (error) {
        logWarn('[typing-stats] failed to remove request listener', { ...context, error })
      }
    }
  }
}
