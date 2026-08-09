// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export const PERSISTENCE_STORE_IDS = [
  'app',
  'cat',
  'general',
  'model',
  'shortcut',
  'typingStats',
] as const

export type PersistenceStoreId = typeof PERSISTENCE_STORE_IDS[number]

export interface RecoveredPersistenceStore {
  storeId: string
  backupPath: string
  reason: string
}

export interface FailedPersistenceStoreRecovery {
  storeId: string
  path: string
  reason: string
}

export interface PersistenceRecoveryReport {
  recovered: RecoveredPersistenceStore[]
  failures: FailedPersistenceStoreRecovery[]
}

export interface PersistenceRecoveryDisplayEntry {
  storeId: string
  storeName: string
  path: string
  reason: string
}

export interface PersistenceRecoveryViewModel {
  recovered: PersistenceRecoveryDisplayEntry[]
  failures: PersistenceRecoveryDisplayEntry[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeRecoveredEntry(value: unknown): RecoveredPersistenceStore | undefined {
  if (!isRecord(value)
    || !isNonEmptyString(value.storeId)
    || !isNonEmptyString(value.backupPath)
    || !isNonEmptyString(value.reason)) {
    return undefined
  }

  return {
    storeId: value.storeId,
    backupPath: value.backupPath,
    reason: value.reason,
  }
}

function normalizeFailedEntry(value: unknown): FailedPersistenceStoreRecovery | undefined {
  if (!isRecord(value)
    || !isNonEmptyString(value.storeId)
    || !isNonEmptyString(value.path)
    || !isNonEmptyString(value.reason)) {
    return undefined
  }

  return {
    storeId: value.storeId,
    path: value.path,
    reason: value.reason,
  }
}

export function normalizePersistenceRecoveryReport(value: unknown): PersistenceRecoveryReport | null {
  if (!isRecord(value)) return null

  const recovered = Array.isArray(value.recovered)
    ? value.recovered.map(normalizeRecoveredEntry).filter(item => item !== undefined)
    : []
  const failures = Array.isArray(value.failures)
    ? value.failures.map(normalizeFailedEntry).filter(item => item !== undefined)
    : []

  if (recovered.length === 0 && failures.length === 0) return null

  return { recovered, failures }
}

export function formatPersistenceRecoveryReport(
  report: PersistenceRecoveryReport,
  storeNames: Partial<Record<PersistenceStoreId, string>>,
): PersistenceRecoveryViewModel {
  const getStoreName = (storeId: string) => storeNames[storeId as PersistenceStoreId] ?? storeId

  return {
    recovered: report.recovered.map(item => ({
      storeId: item.storeId,
      storeName: getStoreName(item.storeId),
      path: item.backupPath,
      reason: item.reason,
    })),
    failures: report.failures.map(item => ({
      storeId: item.storeId,
      storeName: getStoreName(item.storeId),
      path: item.path,
      reason: item.reason,
    })),
  }
}
