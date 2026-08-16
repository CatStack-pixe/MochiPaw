// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import type { Ref } from 'vue'

import { CheckMenuItem, MenuItem, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu'
import { exit, relaunch } from '@tauri-apps/plugin-process'
import { range } from 'es-toolkit'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import type { CatStore } from '@/stores/cat'

import { WINDOW_LABEL } from '@/constants'
import { showWindow } from '@/plugins/window'
import { useCatStore } from '@/stores/cat'
import { runAfterSavingPersistentStores } from '@/utils/persistence'
import { isMac } from '@/utils/platform'
import { requestPomodoroCommand } from '@/utils/pomodoroRequest'

type AppMenuWindowSettings = Pick<CatStore['window'], 'passThrough' | 'scale' | 'opacity'>

export interface AppMenuOptions {
  windowSettings?: Readonly<Ref<AppMenuWindowSettings>>
  visible?: Readonly<Ref<boolean>>
  onWindowSettingsChange?: () => void
  toggleVisibility?: () => void | Promise<void>
}

export function useAppMenu(options: AppMenuOptions = {}) {
  const catStore = useCatStore()
  const { t } = useI18n()
  const windowSettings = options.windowSettings ?? computed(() => catStore.window)
  const visible = options.visible ?? computed(() => catStore.window.visible)

  const notifyWindowSettingsChange = () => {
    options.onWindowSettingsChange?.()
  }

  const toggleVisibility = () => {
    if (options.toggleVisibility) {
      void options.toggleVisibility()
      return
    }

    catStore.window.visible = !catStore.window.visible
  }

  const getScaleMenuItems = async () => {
    const scaleOptions = range(50, 151, 25)

    const items = scaleOptions.map((item) => {
      return CheckMenuItem.new({
        text: `${item}%`,
        checked: windowSettings.value.scale === item,
        action: () => {
          windowSettings.value.scale = item
          notifyWindowSettingsChange()
        },
      })
    })

    if (!scaleOptions.includes(windowSettings.value.scale)) {
      items.unshift(CheckMenuItem.new({
        text: `${windowSettings.value.scale}%`,
        checked: true,
        enabled: false,
      }))
    }

    return Promise.all(items)
  }

  const getOpacityMenuItems = async () => {
    const opacityOptions = range(25, 101, 25)

    const items = opacityOptions.map((item) => {
      return CheckMenuItem.new({
        text: `${item}%`,
        checked: windowSettings.value.opacity === item,
        action: () => {
          windowSettings.value.opacity = item
          notifyWindowSettingsChange()
        },
      })
    })

    if (!opacityOptions.includes(windowSettings.value.opacity)) {
      items.unshift(CheckMenuItem.new({
        text: `${windowSettings.value.opacity}%`,
        checked: true,
        enabled: false,
      }))
    }

    return Promise.all(items)
  }

  const getBaseMenu = async () => {
    return await Promise.all([
      MenuItem.new({
        text: t('composables.useAppMenu.labels.preference'),
        accelerator: isMac ? 'Cmd+,' : '',
        action: () => showWindow(WINDOW_LABEL.PREFERENCE),
      }),
      MenuItem.new({
        text: visible.value ? t('composables.useAppMenu.labels.hideCat') : t('composables.useAppMenu.labels.showCat'),
        action: toggleVisibility,
      }),
      Submenu.new({
        text: t('pages.pomodoro.title'),
        items: await Promise.all([
          MenuItem.new({
            text: t('pages.pomodoro.buttons.start'),
            action: () => requestPomodoroCommand('start'),
          }),
          MenuItem.new({
            text: t('pages.pomodoro.buttons.pause'),
            action: () => requestPomodoroCommand('pause'),
          }),
          MenuItem.new({
            text: t('pages.pomodoro.buttons.reset'),
            action: () => requestPomodoroCommand('reset'),
          }),
        ]),
      }),
      PredefinedMenuItem.new({ item: 'Separator' }),
      CheckMenuItem.new({
        text: t('composables.useAppMenu.labels.passThrough'),
        checked: windowSettings.value.passThrough,
        action: () => {
          windowSettings.value.passThrough = !windowSettings.value.passThrough
          notifyWindowSettingsChange()
        },
      }),
      Submenu.new({
        text: t('composables.useAppMenu.labels.windowSize'),
        items: await getScaleMenuItems(),
      }),
      Submenu.new({
        text: t('composables.useAppMenu.labels.opacity'),
        items: await getOpacityMenuItems(),
      }),
    ])
  }

  const getExitMenu = async () => {
    const restartApp = async () => {
      await runAfterSavingPersistentStores(relaunch)
    }
    const quitApp = async () => {
      await runAfterSavingPersistentStores(() => exit(0))
    }

    return await Promise.all([
      MenuItem.new({
        text: t('composables.useAppMenu.labels.restartApp'),
        action: restartApp,
      }),
      MenuItem.new({
        text: t('composables.useAppMenu.labels.quitApp'),
        accelerator: isMac ? 'Cmd+Q' : '',
        action: quitApp,
      }),
    ])
  }

  return {
    getBaseMenu,
    getExitMenu,
  }
}
