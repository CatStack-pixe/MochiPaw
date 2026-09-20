<!-- SPDX-FileCopyrightText: 2025 ayangweb
  SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { useEventListener } from '@vueuse/core'
import { message, Switch } from 'antdv-next'
import { onMounted } from 'vue'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { useAutostart } from '@/composables/useAutostart'
import { useGeneralStore } from '@/stores/general'
import { logError } from '@/utils/diagnostics'
import { isLinux, isMac, isWindows } from '@/utils/platform'

import Language from './components/language/index.vue'
import LinuxInputStatus from './components/linux-input-status/index.vue'
import MacosPermissions from './components/macos-permissions/index.vue'
import ThemeMode from './components/theme-mode/index.vue'
import WindowsPermissions from './components/windows-permissions/index.vue'

const generalStore = useGeneralStore()

const { enabled, loading, ready, refresh, setEnabled } = useAutostart((value) => {
  generalStore.app.autostart = value
})

function reportAutostartError(error: unknown) {
  logError('[autostart] registration failed', { error })
  message.error(error instanceof Error ? error.message : String(error))
}

onMounted(() => {
  void refresh().catch(reportAutostartError)
})

// Preferences is hidden and reused, so mounting alone misses Task Manager
// changes made while the window is in the background.
useEventListener('focus', () => {
  void refresh().catch(reportAutostartError)
})

function changeAutostart(value: boolean | string | number) {
  void setEnabled(value === true).catch(reportAutostartError)
}
</script>

<template>
  <MacosPermissions v-if="isMac" />

  <WindowsPermissions v-if="isWindows" />

  <ProList
    v-if="isLinux"
    :title="$t('pages.preference.general.labels.permissionsSettings')"
  >
    <LinuxInputStatus />
  </ProList>

  <ProList :title="$t('pages.preference.general.labels.appSettings')">
    <ProListItem :title="$t('pages.preference.general.labels.launchOnStartup')">
      <Switch
        :checked="enabled"
        :disabled="!ready || loading"
        :loading="loading"
        @change="changeAutostart"
      />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.general.hints.showTaskbarIcon')"
      :title="$t('pages.preference.general.labels.showTaskbarIcon')"
    >
      <Switch v-model:checked="generalStore.app.taskbarVisible" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.general.hints.showTrayIcon')"
      :title="$t('pages.preference.general.labels.showTrayIcon')"
    >
      <Switch v-model:checked="generalStore.app.trayVisible" />
    </ProListItem>
  </ProList>

  <ProList :title="$t('pages.preference.general.labels.appearanceSettings')">
    <ThemeMode />

    <Language />
  </ProList>

  <ProList :title="$t('pages.preference.general.labels.updateSettings')">
    <ProListItem :title="$t('pages.preference.general.labels.autoCheckUpdate')">
      <Switch v-model:checked="generalStore.update.autoCheck" />
    </ProListItem>
  </ProList>
</template>
