// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { save } from '@tauri-store/pinia'

const MODEL_STORE_ID = 'model'

export function requestModelStoreSave() {
  return save(MODEL_STORE_ID)
}
