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
import { initCustomFont } from './utils/font'

const appStore = useAppStore()
const modelStore = useModelStore()
const catStore = useCatStore()
const generalStore = useGeneralStore()
const shortcutStore = useShortcutStore()
const appWindow = getCurrentWebviewWindow()
const { isRestored, restoreState } = useWindowState()
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
  await initCustomFont(generalStore.appearance.fontPath, generalStore.appearance.fontFamily)
})

watch(() => generalStore.appearance.language, (value) => {
  locale.value = value ?? LANGUAGE.EN_US
})

watch(
  () => [generalStore.appearance.fontPath, generalStore.appearance.fontFamily] as const,
  ([path, family]) => initCustomFont(path, family),
)

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
