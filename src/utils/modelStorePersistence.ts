// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export const MODEL_STORE_SCHEMA_VERSION = 2

const PERSISTED_MODEL_STORE_KEYS = [
  'schemaVersion',
  'currentModelId',
  'currentModelFingerprint',
  'selectionMigrationPending',
  'models',
  'shortcuts',
  'behaviorNames',
  'behaviorGroups',
  'subModels',
] as const

interface ModelSelectionCandidate {
  id: string
  fingerprint?: string
}

interface LegacyModelSelection extends ModelSelectionCandidate {}

export function prepareModelStoreStateForFrontend(state: Record<string, unknown>) {
  const prepared = pickPersistedModelStoreState(state)

  if (isRecord(state.currentModel)) {
    prepared.currentModel = state.currentModel
  }

  return prepared
}

export function prepareModelStoreStateForBackend(
  state: Record<string, unknown>,
  writable: boolean,
  persistModelCatalog = true,
) {
  if (!writable) return undefined

  const persisted = pickPersistedModelStoreState(state)

  if (!persistModelCatalog) delete persisted.models

  return persisted
}

export function pickPersistedModelStoreState(state: Record<string, unknown>) {
  const persisted: Record<string, unknown> = {
    schemaVersion: MODEL_STORE_SCHEMA_VERSION,
  }

  for (const key of PERSISTED_MODEL_STORE_KEYS) {
    if (key === 'schemaVersion' || !(key in state)) continue

    persisted[key] = key === 'models' && Array.isArray(state.models)
      ? state.models.map(stripModelRuntimeState)
      : state[key]
  }

  return persisted
}

export function resolvePersistedModelSelection<T extends ModelSelectionCandidate>(
  models: T[],
  currentModelId?: string,
  legacyCurrentModel?: LegacyModelSelection,
  allowFingerprintMigration = !normalizeModelId(currentModelId),
) {
  const persistedId = normalizeModelId(currentModelId)
  const legacyId = normalizeModelId(legacyCurrentModel?.id)
  const requestedId = persistedId ?? legacyId
  let model = requestedId ? models.find(candidate => candidate.id === requestedId) : undefined

  if (!model && allowFingerprintMigration && legacyCurrentModel?.fingerprint) {
    model = models.find(candidate => candidate.fingerprint === legacyCurrentModel.fingerprint)
  }

  const matchedPersistedSelection = Boolean(model)
  model ??= models[0]
  const resolvedModelId = matchedPersistedSelection ? model?.id : requestedId ?? model?.id

  return {
    model,
    currentModelId: resolvedModelId,
    currentModelFingerprint: matchedPersistedSelection
      ? model?.fingerprint
      : legacyCurrentModel?.fingerprint,
    selectionMigrated: Boolean(resolvedModelId && resolvedModelId !== persistedId),
    usedRuntimeFallback: Boolean(requestedId && !matchedPersistedSelection && model),
  }
}

function stripModelRuntimeState(value: unknown) {
  if (!isRecord(value)) return value

  const { runtimeLease: _, ...persistedModel } = value
  return persistedModel
}

function normalizeModelId(value: unknown) {
  if (typeof value !== 'string') return undefined

  const id = value.trim()
  return id || undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
