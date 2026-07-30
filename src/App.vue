<!-- SPDX-FileCopyrightText: 2025 ayangweb
  SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { HappyProvider } from '@antdv-next/happy-work-theme'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { error } from '@tauri-apps/plugin-log'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useEventListener } from '@vueuse/core'
import { ConfigProvider, theme } from 'antdv-next'
import { isString } from 'es-toolkit'
import isURL from 'is-url'
import { onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterView } from 'vue-router'

import { useTauriListen } from './composables/useTauriListen'
import { useWindowState } from './composables/useWindowState'
import { LANGUAGE, LISTEN_KEY } from './constants'
import { getAntdLocale } from './locales/index.ts'
import { hideWindow, showWindow } from './plugins/window'
import { useAppStore } from './stores/app'
import { useCatStore } from './stores/cat'
import { useGeneralStore } from './stores/general'
import { useModelStore } from './stores/model'
import { useShortcutStore } from './stores/shortcut.ts'
import { getSubModelRuntimeCapacity } from './utils/subModelRuntime'
import { openSubModelWindow } from './utils/subModelWindow'

const appStore = useAppStore()
const modelStore = useModelStore()
const catStore = useCatStore()
const generalStore = useGeneralStore()
const shortcutStore = useShortcutStore()
const appWindow = getCurrentWebviewWindow()
const isSubModelWindow = appWindow.label.startsWith('sub-model-')
const { isRestored, restoreState } = useWindowState({ enabled: !isSubModelWindow })
const { darkAlgorithm, defaultAlgorithm } = theme
const { locale } = useI18n()

function formatError(reason: unknown) {
  if (reason instanceof Error) {
    return `${reason.name}: ${reason.message}\n${reason.stack ?? ''}`
  }

  if (isString(reason)) return reason
  if (reason == null) return String(reason)

  return JSON.stringify(reason, Object.getOwnPropertyNames(reason)) ?? String(reason)
}

onMounted(async () => {
  if (isSubModelWindow) {
    await modelStore.$tauri.start()
    await modelStore.init()
    await catStore.$tauri.start()
    catStore.init()
    await generalStore.$tauri.start()
    await generalStore.init()
    await restoreState()
    return
  }

  await appStore.$tauri.start()
  await appStore.init()
  await modelStore.$tauri.start()
  await modelStore.init()
  await catStore.$tauri.start()
  catStore.init()
  await generalStore.$tauri.start()
  await generalStore.init()
  await shortcutStore.$tauri.start()
  await restoreState()

  for (const instance of modelStore.subModels.filter(item => item.visible && item.showOnLaunch)) {
    const capacity = await getSubModelRuntimeCapacity(
      modelStore.subModels,
      modelStore.models,
      modelStore.currentModel,
    )

    if (!capacity.allowed) {
      instance.visible = false
      error(`[sub-model] skipped ${instance.id}: runtime resource budget exceeded`)
      continue
    }

    try {
      await openSubModelWindow(instance)
    } catch (reason) {
      instance.visible = false
      error(`[sub-model] failed to restore ${instance.id}: ${formatError(reason)}`)
    }
  }
})

watch(() => generalStore.appearance.language, (value) => {
  locale.value = value ?? LANGUAGE.EN_US
})

useTauriListen(LISTEN_KEY.SHOW_WINDOW, ({ payload }) => {
  if (appWindow.label !== payload) return

  showWindow()
})

useTauriListen(LISTEN_KEY.HIDE_WINDOW, ({ payload }) => {
  if (appWindow.label !== payload) return

  hideWindow()
})

useEventListener('unhandledrejection', ({ reason }) => {
  error(formatError(reason))
})

useEventListener('click', (event) => {
  const link = (event.target as HTMLElement).closest('a')

  if (!link) return

  const { href, target } = link

  if (target === '_blank') return

  event.preventDefault()

  if (!isURL(href)) return

  openUrl(href)
})
</script>

<template>
  <HappyProvider
    v-slot="{ wave }"
    enabled
  >
    <ConfigProvider
      :locale="getAntdLocale(generalStore.appearance.language)"
      :theme="{
        algorithm: generalStore.appearance.isDark ? darkAlgorithm : defaultAlgorithm,
      }"
      :wave="wave"
    >
      <RouterView v-if="isRestored" />
    </ConfigProvider>
  </HappyProvider>
</template>
