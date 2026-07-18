// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { getVersion } from '@tauri-apps/api/app'
import { exists, readTextFile } from '@tauri-apps/plugin-fs'
import JSON5 from 'json5'

import type { Model } from '@/stores/model'

import { join } from '@/utils/path'

const RUNTIME_API_BASE = (import.meta.env.VITE_MOCHI_RUNTIME_API_BASE || 'https://www.catpithos.top').replace(/\/$/, '')
const LEASE_REFRESH_SKEW_SECONDS = 10 * 60

type RuntimeEventType = 'imported' | 'opened' | 'used' | 'heartbeat' | 'failed'

interface AuthorProofEnvelope {
  payload?: {
    packageId?: string
    package_id?: string
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
  }
}

export async function ensureRuntimeLease(model: Model) {
  if (model.importKind !== 'controlled' && model.proofStatus !== 'controlled-release') return
  if (isLeaseFresh(model)) return
  const dispatchToken = model.dispatchToken
  if (!dispatchToken) throw new Error('Controlled package is missing dispatch token.')
  const body = await runtimeBody(model)
  if (!body) throw new Error('Controlled package is missing author proof.')
  const lease = await postRuntimeJson<{ leaseToken: string, leaseId: string, expiresAt: number }>('/runtime/leases', {
    dispatchToken,
    packageId: body.packageId,
    authorProof: body.authorProof,
  })
  model.runtimeLease = lease
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
