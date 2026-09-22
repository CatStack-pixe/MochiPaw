// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import type { Ref } from 'vue'

import { getName, getVersion } from '@tauri-apps/api/app'
import { Menu } from '@tauri-apps/api/menu'
import { resolveResource } from '@tauri-apps/api/path'
import { TrayIcon } from '@tauri-apps/api/tray'
import { openUrl } from '@tauri-apps/plugin-opener'
import { watchDebounced } from '@vueuse/core'
import { onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { useCatStore } from '@/stores/cat'
import { useGeneralStore } from '@/stores/general'
import { logWarn } from '@/utils/diagnostics'

import { GITHUB_LINK } from '../constants'
import { requestPreferenceUpdate } from '../plugins/window'
import { isMac } from '../utils/platform'
import { useAppMenu } from './useAppMenu'

const TRAY_ID = 'BONGO_CAT_TRAY'

export function useTray(ready: Readonly<Ref<boolean>>) {
  const catStore = useCatStore()
  const generalStore = useGeneralStore()
  const { getBaseMenu, getExitMenu } = useAppMenu({ idPrefix: TRAY_ID })
  const { t } = useI18n()

  let tray: TrayIcon | null = null
  let menu: Menu | null = null
  let disposed = false
  let menuDirty = true
  let requested = false
  let updatePromise: Promise<void> | undefined

  const getTrayMenu = async () => {
    const appVersion = await getVersion()

    // Nested options create one root resource; separately-created submenu/item
    // handles each need their own close and are not closed with the parent.
    return Menu.new({ id: `${TRAY_ID}-menu`, items: [
      ...getBaseMenu(),
      { item: 'Separator' },
      {
        id: `${TRAY_ID}-update`,
        text: t('composables.useTray.checkUpdate'),
        action: () => requestPreferenceUpdate(),
      },
      {
        id: `${TRAY_ID}-source`,
        text: t('composables.useTray.openSource'),
        action: () => openUrl(GITHUB_LINK),
      },
      { item: 'Separator' },
      {
        id: `${TRAY_ID}-version`,
        text: `v${appVersion}`,
        enabled: false,
      },
      ...getExitMenu(),
    ] })
  }

  const closeResource = async (resource: Menu | TrayIcon | null) => {
    if (!resource) return
    try {
      await resource.close()
    } catch (error) {
      logWarn('[tray] resource cleanup failed', { error, rid: resource.rid })
    }
  }

  const syncTray = async () => {
    while (requested && ready.value && !disposed) {
      requested = false
      const replaceMenu = menuDirty || !tray
      menuDirty = false
      let nextMenu: Menu | null = null
      try {
        // getById returns the existing resource ID, not a fresh resource.
        // Keep that handle for this composable's lifetime; never close a lookup.
        tray ??= await TrayIcon.getById(TRAY_ID)
        if (disposed) return

        if (replaceMenu || !tray) nextMenu = await getTrayMenu()
        if (disposed) return

        if (!tray) {
          const [appName, appVersion, icon] = await Promise.all([
            getName(),
            getVersion(),
            resolveResource(isMac ? 'assets/tray-mac.png' : 'assets/tray.png'),
          ])
          if (disposed) return
          tray = await TrayIcon.new({
            menu: nextMenu!,
            icon,
            id: TRAY_ID,
            tooltip: `${appName} v${appVersion}`,
            iconAsTemplate: true,
            menuOnLeftClick: true,
          })
        } else if (nextMenu) {
          await tray.setMenu(nextMenu)
        }

        if (nextMenu) {
          const previous = menu
          menu = nextMenu
          nextMenu = null
          await closeResource(previous)
        }
        if (!disposed) await tray.setVisible(generalStore.app.trayVisible)
      } catch (error) {
        // Keep the installed menu alive when construction/replacement fails.
        // A later state change retries; do not spin on a persistent IPC error.
        menuDirty = true
        logWarn('[tray] update failed', { error })
      } finally {
        await closeResource(nextMenu)
      }
    }
  }

  const requestSync = () => {
    if (disposed || !ready.value) return
    requested = true
    if (updatePromise) return
    // One worker owns menu replacement and visibility. State changes while it
    // awaits IPC are coalesced and applied after the in-flight update settles.
    updatePromise = syncTray().finally(() => {
      updatePromise = undefined
      if (requested && !disposed && ready.value) requestSync()
    })
  }

  const updateTrayMenu = () => {
    menuDirty = true
    requestSync()
  }

  watch([() => catStore.window.visible, () => catStore.window.passThrough, () => generalStore.appearance.language], updateTrayMenu)
  watchDebounced([() => catStore.window.scale, () => catStore.window.opacity], updateTrayMenu, { debounce: 200 })
  watch([ready, () => generalStore.app.trayVisible], () => {
    requestSync()
  }, { immediate: true })

  onBeforeUnmount(() => {
    disposed = true
    requested = false
    // Creation/setMenu may already be in flight. Release only after the worker
    // settles so no continuation can reinstall a menu after cleanup.
    void (updatePromise ?? Promise.resolve()).then(async () => {
      await closeResource(tray)
      tray = null
      await closeResource(menu)
      menu = null
    })
  })
}
