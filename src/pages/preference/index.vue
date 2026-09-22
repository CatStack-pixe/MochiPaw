<!-- SPDX-FileCopyrightText: 2025 ayangweb
  SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { Flex, Spin } from 'antdv-next'
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import PersistenceRecoveryAlert from '@/components/persistence-recovery-alert/index.vue'
import UpdateApp from '@/components/update-app/index.vue'
import { useAppStore } from '@/stores/app'
import { useGeneralStore } from '@/stores/general'
import { useModelStore } from '@/stores/model'
import { isMac } from '@/utils/platform'
import { isPreferenceCloseBlocked } from '@/utils/preferenceWindow'

const About = defineAsyncComponent(() => import('./components/about/index.vue'))
const Cat = defineAsyncComponent(() => import('./components/cat/index.vue'))
const General = defineAsyncComponent(() => import('./components/general/index.vue'))
const Model = defineAsyncComponent(() => import('./components/model/index.vue'))
const Pomodoro = defineAsyncComponent(() => import('./components/pomodoro/index.vue'))
const Shortcut = defineAsyncComponent(() => import('./components/shortcut/index.vue'))
const SubModel = defineAsyncComponent(() => import('./components/sub-model/index.vue'))
const TypingStats = defineAsyncComponent(() => import('./components/typing-stats/index.vue'))

const appStore = useAppStore()
const current = ref(0)
const { t } = useI18n()
const generalStore = useGeneralStore()
const modelStore = useModelStore()
const appWindow = getCurrentWebviewWindow()

// Both routing and the lazy theme provider have mounted before this signal.
onMounted(() => invoke('preference_window_ready'))

function selectTab(index: number) {
  if (!modelStore.modelReady || isPreferenceCloseBlocked()) return
  current.value = index
}

watch(() => generalStore.appearance.language, () => {
  appWindow.setTitle(t('pages.preference.title'))
}, { immediate: true })

const menus = computed(() => [
  {
    key: 'cat',
    label: t('pages.preference.cat.title'),
    icon: 'i-solar:cat-bold',
    component: Cat,
  },
  {
    key: 'general',
    label: t('pages.preference.general.title'),
    icon: 'i-solar:settings-minimalistic-bold',
    component: General,
  },
  {
    key: 'typing-stats',
    label: t('pages.preference.typingStats.title'),
    icon: 'i-solar:chart-2-bold',
    component: TypingStats,
  },
  {
    key: 'pomodoro',
    label: t('pages.pomodoro.title'),
    icon: 'i-lucide:timer',
    component: Pomodoro,
  },
  {
    key: 'model',
    label: t('pages.preference.model.title'),
    icon: 'i-solar:magic-stick-3-bold',
    component: Model,
  },
  {
    key: 'sub-model',
    label: t('pages.preference.subModel.title'),
    icon: 'i-solar:cat-bold-duotone',
    component: SubModel,
  },
  {
    key: 'shortcut',
    label: t('pages.preference.shortcut.title'),
    icon: 'i-solar:keyboard-bold',
    component: Shortcut,
  },
  {
    key: 'about',
    label: t('pages.preference.about.title'),
    icon: 'i-solar:info-circle-bold',
    component: About,
  },
])
</script>

<template>
  <Spin
    class="max-h-unset!"
    :description="t('pages.main.hints.switching')"
    fullscreen
    size="large"
    :spinning="!modelStore.modelReady"
  />

  <Flex class="h-screen">
    <div
      class="preference-navigation h-full w-30 flex flex-col items-center gap-4 overflow-auto bg-gradient-from-blue-1 bg-gradient-to-black/1 bg-gradient-linear dark:bg-none"
      :class="[isMac ? 'pt-8' : 'pt-4']"
      data-tauri-drag-region
    >
      <div class="flex flex-col items-center gap-2">
        <div class="b-1 rounded-2xl b-solid b-border-sec">
          <img
            class="size-15"
            data-tauri-drag-region
            src="/logo.png"
          >
        </div>

        <span class="font-bold">{{ appStore.name }}</span>
      </div>

      <div class="flex flex-col gap-2">
        <div
          v-for="(item, index) in menus"
          :key="item.key"
          class="size-20 flex flex-col cursor-pointer items-center justify-center gap-2 transition color-text-tertiary rounded-lg hover:bg-[--ant-color-fill-tertiary] dark:color-text-secondary"
          :class="{ 'bg-container! color-blue-5! dark:color-blue-7! font-bold dark:bg-[--ant-color-fill-quaternary]!': current === index }"
          @click="selectTab(index)"
        >
          <div
            class="size-8"
            :class="item.icon"
          />

          <span class="break-words text-center leading-tight">{{ item.label }}</span>
        </div>
      </div>
    </div>

    <div
      class="h-full min-h-0 flex-1 overflow-auto bg-[--ant-color-fill-quaternary] p-4 dark:bg-container"
      data-tauri-drag-region
    >
      <component :is="menus[current]?.component" />
    </div>
  </Flex>

  <PersistenceRecoveryAlert />
  <UpdateApp />
</template>

<style scoped>
.preference-navigation {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

.preference-navigation::-webkit-scrollbar {
  display: none;
}
</style>
