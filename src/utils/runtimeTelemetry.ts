// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { exists, readFile, readTextFile, writeFile, writeTextFile } from '@tauri-apps/plugin-fs'
import JSON5 from 'json5'

import type { Model } from '@/stores/model'
import type { LogContext } from '@/utils/diagnostics'

import { logError, logInfo, logStep, logTrace } from '@/utils/diagnostics'
import { join } from '@/utils/path'
import { withTimeout } from '@/utils/promise'

const RUNTIME_API_BASE = (import.meta.env?.VITE_MOCHI_RUNTIME_API_BASE || 'https://www.catpithos.top').replace(/\/$/, '')
const LEASE_REFRESH_SKEW_SECONDS = 10 * 60
const RUNTIME_REQUEST_TIMEOUT_MS = 15_000
export const RUNTIME_PREPARATION_TIMEOUT_MS = 30_000
const DECRYPTION_MARKER = 'decryption.json'

type RuntimeEventType = 'imported' | 'opened' | 'used' | 'heartbeat' | 'failed'

interface AuthorProofEnvelope {
  payload?: {
    packageId?: string
    package_id?: string
  }
}

async function installationIdentity() {
  return invoke<{ installIdHash: string }>('runtime_installation_identity')
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function isLeaseFresh(model: Model) {
  return Boolean(model.runtimeLease && model.runtimeLease.expiresAt > nowSeconds() + LEASE_REFRESH_SKEW_SECONDS)
}

async function readAuthorProof(modelPath: string) {
  const proofPath = join(modelPath, 'mochi-proof', 'author.mpa')
  if (!await exists(proofPath)) return null
  const raw = await readTextFile(proofPath)
  const parsed = JSON5.parse(raw) as AuthorProofEnvelope
  return { parsed }
}

function base64UrlBytes(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

async function postRuntimeJson<T>(path: string, body: Record<string, unknown>, token?: string): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), RUNTIME_REQUEST_TIMEOUT_MS)
  const context = {
    path,
    authorized: Boolean(token),
    bodyKeys: Object.keys(body),
    timeoutMs: RUNTIME_REQUEST_TIMEOUT_MS,
  }

  logStep('runtime-http', 'request started', context)

  try {
    const response = await fetch(`${RUNTIME_API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    logStep('runtime-http', 'response received', { ...context, status: response.status, ok: response.ok })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const detail = typeof payload.detail === 'string' ? payload.detail : `runtime API returned HTTP ${response.status}`
      throw new Error(detail)
    }
    logStep('runtime-http', 'request completed', context)
    return payload as T
  } catch (error) {
    if (controller.signal.aborted) {
      logError('[runtime-http] request timed out', { ...context, error })
      throw new Error(`Runtime API request timed out after ${RUNTIME_REQUEST_TIMEOUT_MS / 1000} seconds.`)
    }

    logError('[runtime-http] request failed', { ...context, error })
    throw error
  } finally {
    clearTimeout(timeout)
    logTrace('[runtime-http] request cleanup completed', context)
  }
}

function proofPackageId(proof: AuthorProofEnvelope) {
  return String(proof.payload?.packageId || proof.payload?.package_id || '').trim()
}

async function runtimeBody(model: Model, eventType?: RuntimeEventType) {
  logStep('runtime', 'read author proof', {
    modelId: model.id,
    modelPath: model.path,
    eventType,
  })
  const proof = await readAuthorProof(model.path)
  if (!proof) {
    logTrace('[runtime] author proof not found', { modelId: model.id, modelPath: model.path, eventType })
    return null
  }
  const packageId = model.packageId || proofPackageId(proof.parsed)
  if (!packageId) {
    logTrace('[runtime] author proof has no package id', { modelId: model.id, modelPath: model.path, eventType })
    return null
  }
  const identity = await installationIdentity()
  logStep('runtime', 'runtime body prepared', { modelId: model.id, packageId, eventType })
  return {
    packageId,
    eventType,
    authorProof: proof.parsed,
    appVersion: await getVersion().catch(() => undefined),
    installIdHash: identity.installIdHash,
    platform: navigator.platform || 'unknown',
  }
}

async function decryptLegacyControlledPackage(model: Model, contentKey?: string) {
  const encryptedFiles = model.controlledRelease?.contentEncryption?.encryptedFiles ?? []
  if (!encryptedFiles.length) return
  const markerPath = join(model.path, 'mochi-control', DECRYPTION_MARKER)
  if (await exists(markerPath)) return
  if (!contentKey) throw new Error('Controlled package runtime lease is missing a content key.')

  const key = await crypto.subtle.importKey(
    'raw',
    base64UrlBytes(contentKey),
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  )
  for (const file of encryptedFiles) {
    if (!file.path || !file.nonce) continue
    const filePath = join(model.path, file.path)
    const ciphertext = await readFile(filePath)
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlBytes(file.nonce) },
      key,
      ciphertext,
    )
    await writeFile(filePath, new Uint8Array(plaintext))
  }
  await writeTextFile(markerPath, JSON.stringify({ schemaVersion: 1, packageId: model.packageId, decryptedAt: new Date().toISOString() }, null, 2))
}

async function prepareRuntimeLease(model: Model, context: LogContext) {
  if (model.importKind !== 'controlled' && model.proofStatus !== 'controlled-release') {
    logTrace('[runtime-lease] skipped for standard model', context)
    return
  }
  const activationToken = model.activationToken
  if (activationToken?.startsWith('mat_')) {
    logStep('runtime-lease', 'prepare dedicated runtime', context)
    const body = await runtimeBody(model)
    if (!body) throw new Error('Controlled package is missing author proof.')
    const lease = await invoke<{ leaseId: string, expiresAt: number }>('prepare_dedicated_runtime', {
      input: {
        modelPath: model.path,
        packageId: body.packageId,
        activationToken,
        authorProof: body.authorProof,
        encryptedFiles: model.controlledRelease?.contentEncryption?.encryptedFiles ?? [],
      },
    })
    model.runtimeLease = lease
    logInfo('[runtime-lease] dedicated runtime ready', { ...context, leaseId: lease.leaseId, expiresAt: lease.expiresAt })
    return
  }
  if (isLeaseFresh(model)) {
    logTrace('[runtime-lease] existing lease is fresh', { ...context, expiresAt: model.runtimeLease?.expiresAt })
    return
  }
  const dispatchToken = model.dispatchToken
  if (!dispatchToken) throw new Error('Controlled package is missing dispatch token.')
  logStep('runtime-lease', 'request remote lease', context)
  const body = await runtimeBody(model)
  if (!body) throw new Error('Controlled package is missing author proof.')
  const lease = await postRuntimeJson<{ leaseToken: string, leaseId: string, expiresAt: number, contentKey?: string }>('/runtime/leases', {
    dispatchToken,
    packageId: body.packageId,
    authorProof: body.authorProof,
  })
  await decryptLegacyControlledPackage(model, lease.contentKey)
  model.runtimeLease = {
    leaseToken: lease.leaseToken,
    leaseId: lease.leaseId,
    expiresAt: lease.expiresAt,
  }
  logInfo('[runtime-lease] remote lease ready', { ...context, leaseId: lease.leaseId, expiresAt: lease.expiresAt })
}

export async function ensureRuntimeLease(model: Model) {
  const context = {
    modelId: model.id,
    modelPath: model.path,
    importKind: model.importKind,
    proofStatus: model.proofStatus,
    hasRuntimeLease: Boolean(model.runtimeLease),
  }

  logStep('runtime-lease', 'ensure lease started', context)

  try {
    await withTimeout(
      prepareRuntimeLease(model, context),
      RUNTIME_PREPARATION_TIMEOUT_MS,
      `Runtime lease preparation timed out after ${RUNTIME_PREPARATION_TIMEOUT_MS / 1000} seconds.`,
    )
  } catch (error) {
    logError('[runtime-lease] preparation failed', { ...context, error })
    throw error
  }
}

export async function reportRuntimeEvent(model: Model, eventType: RuntimeEventType) {
  logStep('runtime-event', 'report event started', { modelId: model.id, modelPath: model.path, eventType })
  const body = await runtimeBody(model, eventType)
  if (!body) {
    logTrace('[runtime-event] skipped because runtime body is unavailable', { modelId: model.id, eventType })
    return
  }
  if (model.importKind === 'controlled' || model.proofStatus === 'controlled-release') {
    await ensureRuntimeLease(model)
    if (model.activationToken?.startsWith('mat_')) {
      await invoke('record_dedicated_runtime_event', {
        input: {
          packageId: body.packageId,
          eventType,
          appVersion: body.appVersion,
          platform: body.platform,
        },
      })
      logStep('runtime-event', 'dedicated event reported', { modelId: model.id, eventType })
      return
    }
    const leaseToken = model.runtimeLease?.leaseToken
    if (!leaseToken) throw new Error('Controlled package runtime lease is missing.')
    await postRuntimeJson('/runtime/events', body, leaseToken)
    logStep('runtime-event', 'controlled event reported', { modelId: model.id, eventType })
    return
  }
  await postRuntimeJson('/runtime/events', body)
  logStep('runtime-event', 'standard event reported', { modelId: model.id, eventType })
}

export function reportRuntimeEventQuietly(model: Model | undefined, eventType: RuntimeEventType) {
  if (!model || model.isPreset) return
  logTrace('[runtime-event] queued quiet event', { modelId: model.id, eventType })
  void reportRuntimeEvent(model, eventType).catch((error) => {
    console.warn('[mochi-paw] runtime telemetry failed:', error)
    logError('[runtime-event] quiet event failed', { modelId: model.id, eventType, error })
  })
}
