// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { getName, getTauriVersion, getVersion } from '@tauri-apps/api/app'
import { appLogDir } from '@tauri-apps/api/path'
import { debug as writeDebug, error as writeError, info as writeInfo, trace as writeTrace, warn as writeWarn } from '@tauri-apps/plugin-log'
import { arch, hostname, platform, version } from '@tauri-apps/plugin-os'

export type LogContext = Record<string, unknown>

function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    }
  }

  if (typeof value === 'bigint') return value.toString()

  return value
}

function formatMessage(message: string, context?: LogContext) {
  if (!context) return `[mochi-paw] ${message}`

  try {
    return `[mochi-paw] ${message} ${JSON.stringify(context, (_, value) => serializeValue(value))}`
  } catch (error) {
    return `[mochi-paw] ${message} {"contextSerializationError":${JSON.stringify(String(error))}}`
  }
}

function writeLog(writer: (message: string) => Promise<void>, message: string, context?: LogContext) {
  void writer(formatMessage(message, context)).catch((error) => {
    console.warn('[mochi-paw] failed to write diagnostic log:', error)
  })
}

export function logTrace(message: string, context?: LogContext) {
  writeLog(writeTrace, message, context)
}

export function logDebug(message: string, context?: LogContext) {
  writeLog(writeDebug, message, context)
}

export function logInfo(message: string, context?: LogContext) {
  writeLog(writeInfo, message, context)
}

export function logWarn(message: string, context?: LogContext) {
  writeLog(writeWarn, message, context)
}

export function logError(message: string, context?: LogContext) {
  writeLog(writeError, message, context)
}

export function logStep(scope: string, step: string, context?: LogContext) {
  const message = `[${scope}] ${step}`

  logDebug(message, context)
  logTrace(message, context)
}

function readSync<T>(label: string, read: () => T) {
  try {
    return read()
  } catch (error) {
    logWarn('[startup] failed to read system value', { label, error })
    return undefined
  }
}

async function readAsync<T>(label: string, read: () => Promise<T>) {
  try {
    return await read()
  } catch (error) {
    logWarn('[startup] failed to read runtime value', { label, error })
    return undefined
  }
}

export async function logStartupDiagnostics(windowLabel: string) {
  logStep('startup', 'begin', { windowLabel })

  const [appName, appVersion, tauriVersion, logDirectory, hostName] = await Promise.all([
    readAsync('appName', getName),
    readAsync('appVersion', getVersion),
    readAsync('tauriVersion', getTauriVersion),
    readAsync('appLogDirectory', appLogDir),
    readAsync('hostname', hostname),
  ])
  const system = {
    platform: readSync('platform', platform),
    architecture: readSync('architecture', arch),
    version: readSync('osVersion', version),
    hostname: hostName,
  }
  const browser = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    languages: navigator.languages,
    online: navigator.onLine,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
  }
  const window = {
    href: location.href,
    visibility: document.visibilityState,
    innerWidth,
    innerHeight,
    devicePixelRatio,
    screenWidth: screen.width,
    screenHeight: screen.height,
  }

  logInfo('[startup] runtime context', {
    windowLabel,
    appName,
    appVersion,
    tauriVersion,
    logDirectory,
    system,
    browser,
    window,
  })
  logDebug('[startup] runtime context collected', { windowLabel, appVersion, appLogDirectory: logDirectory })
  logTrace('[startup] runtime context details', { windowLabel, system, browser, window })
}
