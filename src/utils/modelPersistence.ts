// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { invoke } from '@tauri-apps/api/core'
import { saveNow } from '@tauri-store/pinia'
import { nextTick } from 'vue'

import { prepareModelStoreStateForBackend } from './modelStorePersistence'

const MODEL_STORE_ID = 'model'

export interface ModelPersistenceAdapter {
  patch: (storeId: string, state: Record<string, unknown>) => Promise<void>
  save: (storeId: string) => Promise<void>
}

interface ModelPersistenceOptions {
  adapter?: ModelPersistenceAdapter
  persistModelCatalog?: boolean
}

const defaultAdapter: ModelPersistenceAdapter = {
  patch: (storeId, state) => invoke('plugin:pinia|patch', { id: storeId, state }),
  save: storeId => saveNow(storeId),
}

export async function requestModelStoreSave(
  state: Record<string, unknown>,
  options: ModelPersistenceOptions = {},
) {
  const adapter = options.adapter ?? defaultAdapter
  await nextTick()
  await adapter.patch(MODEL_STORE_ID, prepareModelStoreStateForBackend(
    state,
    true,
    options.persistModelCatalog,
  ) ?? {})
  await adapter.save(MODEL_STORE_ID)
}
