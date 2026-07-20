// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { getVersion } from '@tauri-apps/api/app'
import { exists, readFile, readTextFile, writeFile, writeTextFile } from '@tauri-apps/plugin-fs'
import JSON5 from 'json5'

import type { Model } from '@/stores/model'

import { join } from '@/utils/path'

const RUNTIME_API_BASE = (import.meta.env.VITE_MOCHI_RUNTIME_API_BASE || 'https://www.catpithos.top').replace(/\/$/, '')
const LEASE_REFRESH_SKEW_SECONDS = 10 * 60
const DECRYPTION_MARKER = 'decryption.json'
const INSTALLATION_STORAGE_KEY = 'mochi-paw-runtime-installation-id'
const DEVICE_PUBLIC_KEY_STORAGE_KEY = 'mochi-paw-runtime-device-public-key'

type RuntimeEventType = 'imported' | 'opened' | 'used' | 'heartbeat' | 'failed'

interface AuthorProofEnvelope {
  payload?: {
    packageId?: string
    package_id?: string
  }
}

function persistentRuntimeValue(storageKey: string) {
  const existing = localStorage.getItem(storageKey)
  if (existing) return existing
  const value = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
  localStorage.setItem(storageKey, value)
  return value
}

async function sha256Base64Url(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function installationIdentity() {
  return {
    installIdHash: await sha256Base64Url(persistentRuntimeValue(INSTALLATION_STORAGE_KEY)),
    // The backend binds this handle today; a keychain-backed signing key replaces it in the next protocol revision.
    devicePublicKey: persistentRuntimeValue(DEVICE_PUBLIC_KEY_STORAGE_KEY),
  }
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function isLeaseFresh(model: Model) {
  return Boolean(model.runtimeLease?.leaseToken && model.runtimeLease.expiresAt > nowSeconds() + LEASE_REFRESH_SKEW_SECONDS)
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

async function decryptDedicatedPackage(model: Model, leaseToken?: string) {
  const encryptedFiles = model.controlledRelease?.contentEncryption?.encryptedFiles ?? []

  if (!encryptedFiles.length) return
  const markerPath = join(model.path, 'mochi-control', DECRYPTION_MARKER)
  if (await exists(markerPath)) return
  if (!leaseToken) throw new Error('Controlled package runtime lease is missing.')

  for (const file of encryptedFiles) {
    if (!file.path || !file.nonce) continue
    if (file.algorithm && file.algorithm !== 'AES-256-GCM') {
      throw new Error(`Unsupported controlled package encryption: ${file.algorithm}`)
    }

    const filePath = join(model.path, file.path)
    const ciphertext = await readFile(filePath)
    const resource = await postRuntimeJson<{ dataBase64: string }>('/runtime/resources', {
      packageId: model.packageId,
      path: file.path,
      nonce: file.nonce,
      ciphertext: bytesToBase64Url(ciphertext),
    }, leaseToken)
    await writeFile(filePath, base64UrlBytes(resource.dataBase64))
  }

  await writeTextFile(markerPath, JSON.stringify({
    schemaVersion: 1,
    packageId: model.packageId,
    decryptedAt: new Date().toISOString(),
  }, null, 2))
}

async function postRuntimeJson<T>(path: string, body: Record<string, unknown>, token?: string): Promise<T> {
  const response = await fetch(`${RUNTIME_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = typeof payload.detail === 'string' ? payload.detail : `runtime API returned HTTP ${response.status}`
    throw new Error(detail)
  }
  return payload as T
}

function proofPackageId(proof: AuthorProofEnvelope) {
  return String(proof.payload?.packageId || proof.payload?.package_id || '').trim()
}

async function runtimeBody(model: Model, eventType?: RuntimeEventType) {
  const proof = await readAuthorProof(model.path)
  if (!proof) return null
  const packageId = model.packageId || proofPackageId(proof.parsed)
  if (!packageId) return null
  return {
    packageId,
    eventType,
    authorProof: proof.parsed,
    appVersion: await getVersion().catch(() => undefined),
    installIdHash: await sha256Base64Url(persistentRuntimeValue(INSTALLATION_STORAGE_KEY)),
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

export async function ensureRuntimeLease(model: Model) {
  if (model.importKind !== 'controlled' && model.proofStatus !== 'controlled-release') return
  if (isLeaseFresh(model)) {
    if (model.activationToken?.startsWith('mat_')) await decryptDedicatedPackage(model, model.runtimeLease?.leaseToken)
    return
  }
  const activationToken = model.activationToken
  if (activationToken?.startsWith('mat_')) {
    const body = await runtimeBody(model)
    if (!body) throw new Error('Controlled package is missing author proof.')
    const identity = await installationIdentity()
    let lease: { leaseToken: string, leaseId: string, expiresAt: number }
    try {
      lease = await postRuntimeJson('/runtime/leases/refresh', {
        packageId: body.packageId,
        ...identity,
      })
    } catch {
      lease = await postRuntimeJson('/runtime/activations', {
        activationToken,
        packageId: body.packageId,
        authorProof: body.authorProof,
        ...identity,
      })
    }
    await decryptDedicatedPackage(model, lease.leaseToken)
    model.runtimeLease = lease
    return
  }
  const dispatchToken = model.dispatchToken
  if (!dispatchToken) throw new Error('Controlled package is missing dispatch token.')
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
}

export async function reportRuntimeEvent(model: Model, eventType: RuntimeEventType) {
  const body = await runtimeBody(model, eventType)
  if (!body) return
  if (model.importKind === 'controlled' || model.proofStatus === 'controlled-release') {
    await ensureRuntimeLease(model)
    const leaseToken = model.runtimeLease?.leaseToken
    if (!leaseToken) throw new Error('Controlled package runtime lease is missing.')
    await postRuntimeJson('/runtime/events', body, leaseToken)
    return
  }
  await postRuntimeJson('/runtime/events', body)
}

export function reportRuntimeEventQuietly(model: Model | undefined, eventType: RuntimeEventType) {
  if (!model || model.isPreset) return
  void reportRuntimeEvent(model, eventType).catch((error) => {
    console.warn('[mochi-paw] runtime telemetry failed:', error)
  })
}
