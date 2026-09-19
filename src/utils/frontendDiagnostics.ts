// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { App, ComponentPublicInstance } from 'vue'

import { invoke } from '@tauri-apps/api/core'

import { logError, logInfo } from './diagnostics'

export type StartupStage = 'frontend-mounted' | 'startup-failed'

function stringifyReason(reason: unknown): string {
  if (reason instanceof Error) {
    return `${reason.name}: ${reason.message}${reason.stack ? `\n${reason.stack}` : ''}`
  }

  if (typeof reason === 'string') return reason
  if (reason == null) return String(reason)

  try {
    return JSON.stringify(reason, Object.getOwnPropertyNames(reason)) ?? String(reason)
  } catch {
    return String(reason)
  }
}

export function formatFrontendError(reason: unknown): string {
  return stringifyReason(reason)
}

function componentName(instance: ComponentPublicInstance | null) {
  if (!instance) return undefined

  const type = instance.$.type as { name?: string, __name?: string }
  return type.name ?? type.__name
}

export function reportFrontendError(source: string, reason: unknown, context?: Record<string, unknown>) {
  logError(`[frontend] ${source}`, {
    ...context,
    error: stringifyReason(reason),
  })
}

/**
 * Installs process-wide browser error listeners before Vue is mounted. The
 * returned disposer is useful for tests and for a controlled teardown.
 */
export function installGlobalErrorHandlers() {
  if (typeof window === 'undefined') return () => undefined

  const onError = (event: ErrorEvent) => {
    reportFrontendError('window error', event.error ?? event.message, {
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
    })
  }
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    reportFrontendError('unhandled promise rejection', event.reason)
  }

  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onUnhandledRejection)

  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onUnhandledRejection)
  }
}

export function installVueErrorHandler(app: App<Element>) {
  app.config.errorHandler = (reason, instance, info) => {
    reportFrontendError('vue error', reason, {
      info,
      component: componentName(instance),
    })
  }
}

/**
 * Persists a startup stage through the native side. This is intentionally
 * best-effort: a failed marker must never prevent the UI from starting.
 */
export async function markStartupStage(stage: StartupStage) {
  try {
    await invoke('mark_startup_stage', { stage })
    logInfo('[startup] frontend stage marked', { stage })
  } catch (reason) {
    reportFrontendError('failed to mark startup stage', reason, { stage })
  }
}
