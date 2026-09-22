// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { computed, reactive } from 'vue'

import type { ModelSupportKeyLayer } from '@/stores/model'

export function createModelInputState() {
  const pressedKeys = reactive<Record<string, ModelSupportKeyLayer[]>>({})
  const activeKeys = reactive<Record<string, boolean>>({})

  // Setup-store computed values are getters, so input stays reactive without
  // entering Pinia's persistent $state or its deep synchronization watcher.
  return {
    pressedKeys: computed(() => pressedKeys),
    activeKeys: computed(() => activeKeys),
  }
}
