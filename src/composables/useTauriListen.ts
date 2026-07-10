// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import { listen } from '@tauri-apps/api/event'
import { noop } from '@vueuse/core'
import { onMounted, onUnmounted, ref } from 'vue'

export function useTauriListen<T>(...args: Parameters<typeof listen<T>>) {
  const unlisten = ref(noop)

  onMounted(async () => {
    unlisten.value = await listen<T>(...args)
  })

  onUnmounted(() => {
    unlisten.value()
  })
}
