// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Ref } from 'vue'

import { onUnmounted, watch } from 'vue'

import { requestPreferenceUpdate } from '@/plugins/window'
import { useGeneralStore } from '@/stores/general'
import { logError } from '@/utils/diagnostics'

const CHECK_INTERVAL = 24 * 60 * 60 * 1000

/** Only the persistent main window owns the automatic update timer. */
export function useBackgroundUpdate(ready: Readonly<Ref<boolean>>) {
  const generalStore = useGeneralStore()
  let timer: ReturnType<typeof setInterval> | undefined
  let checking = false
  let disposed = false

  async function checkUpdate() {
    if (checking || disposed || !ready.value || !generalStore.update.autoCheck) return
    checking = true
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check({ timeout: 5000 })
      if (!update) return

      // Updater resources belong to their creating webview. The preferences UI
      // acquires its own resource only when there is an update to present.
      await update.close()
      if (!disposed && generalStore.update.autoCheck) await requestPreferenceUpdate(false)
    } catch (error) {
      logError('[update] background check failed', { error })
    } finally {
      checking = false
    }
  }

  watch([ready, () => generalStore.update.autoCheck], ([initialized, enabled]) => {
    if (timer) clearInterval(timer)
    timer = undefined
    if (!initialized || !enabled) return

    void checkUpdate()
    timer = setInterval(() => void checkUpdate(), CHECK_INTERVAL)
  }, { immediate: true })

  onUnmounted(() => {
    disposed = true
    if (timer) clearInterval(timer)
  })
}
