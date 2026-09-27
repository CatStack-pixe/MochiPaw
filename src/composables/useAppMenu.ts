// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import type { CheckMenuItemOptions, MenuOptions } from '@tauri-apps/api/menu'
import type { Ref } from 'vue'

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
  /** Stable IDs keep Tauri's menu callback registry bounded across rebuilds. */
  idPrefix?: string
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
  const itemId = (name: string) => options.idPrefix ? `${options.idPrefix}-${name}` : undefined

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

  const getScaleMenuItems = () => {
    const scaleOptions = range(50, 151, 25)

    const items: CheckMenuItemOptions[] = scaleOptions.map((item) => {
      return {
        id: itemId(`scale-${item}`),
        text: `${item}%`,
        checked: windowSettings.value.scale === item,
        action: () => {
          windowSettings.value.scale = item
          notifyWindowSettingsChange()
        },
      }
    })

    if (!scaleOptions.includes(windowSettings.value.scale)) {
      items.unshift({
        id: itemId('scale-current'),
        text: `${windowSettings.value.scale}%`,
        checked: true,
        enabled: false,
      })
    }

    return items
  }

  const getOpacityMenuItems = () => {
    const opacityOptions = range(25, 101, 25)

    const items: CheckMenuItemOptions[] = opacityOptions.map((item) => {
      return {
        id: itemId(`opacity-${item}`),
        text: `${item}%`,
        checked: windowSettings.value.opacity === item,
        action: () => {
          windowSettings.value.opacity = item
          notifyWindowSettingsChange()
        },
      }
    })

    if (!opacityOptions.includes(windowSettings.value.opacity)) {
      items.unshift({
        id: itemId('opacity-current'),
        text: `${windowSettings.value.opacity}%`,
        checked: true,
        enabled: false,
      })
    }

    return items
  }

  // Pass nested options to Menu.new so only the root gets a resource ID.
  // Explicitly creating each child would require closing every child handle.
  const getBaseMenu = (): NonNullable<MenuOptions['items']> => {
    return [
      {
        id: itemId('preference'),
        text: t('composables.useAppMenu.labels.preference'),
        accelerator: isMac ? 'Cmd+,' : '',
        action: () => showWindow(WINDOW_LABEL.PREFERENCE),
      },
      {
        id: itemId('visibility'),
        text: visible.value ? t('composables.useAppMenu.labels.hideCat') : t('composables.useAppMenu.labels.showCat'),
        action: toggleVisibility,
      },
      {
        id: itemId('pomodoro'),
        text: t('pages.pomodoro.title'),
        items: [
          {
            id: itemId('pomodoro-start'),
            text: t('pages.pomodoro.buttons.start'),
            action: () => requestPomodoroCommand('start'),
          },
          {
            id: itemId('pomodoro-pause'),
            text: t('pages.pomodoro.buttons.pause'),
            action: () => requestPomodoroCommand('pause'),
          },
          {
            id: itemId('pomodoro-reset'),
            text: t('pages.pomodoro.buttons.reset'),
            action: () => requestPomodoroCommand('reset'),
          },
        ],
      },
      { item: 'Separator' },
      {
        id: itemId('pass-through'),
        text: t('composables.useAppMenu.labels.passThrough'),
        checked: windowSettings.value.passThrough,
        action: () => {
          windowSettings.value.passThrough = !windowSettings.value.passThrough
          notifyWindowSettingsChange()
        },
      },
      {
        id: itemId('scale'),
        text: t('composables.useAppMenu.labels.windowSize'),
        items: getScaleMenuItems(),
      },
      {
        id: itemId('opacity'),
        text: t('composables.useAppMenu.labels.opacity'),
        items: getOpacityMenuItems(),
      },
    ]
  }

  const getExitMenu = (): NonNullable<MenuOptions['items']> => {
    const restartApp = async () => {
      await runAfterSavingPersistentStores(relaunch)
    }
    const quitApp = async () => {
      await runAfterSavingPersistentStores(() => exit(0))
    }

    return [
      {
        id: itemId('restart'),
        text: t('composables.useAppMenu.labels.restartApp'),
        action: restartApp,
      },
      {
        id: itemId('quit'),
        text: t('composables.useAppMenu.labels.quitApp'),
        accelerator: isMac ? 'Cmd+Q' : '',
        action: quitApp,
      },
    ]
  }

  return {
    getBaseMenu,
    getExitMenu,
  }
}
