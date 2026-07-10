<!-- SPDX-FileCopyrightText: 2025 ayangweb
  SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { confirm, message } from '@tauri-apps/plugin-dialog'
import { Space } from 'antdv-next'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { isRunningAsAdministrator, relaunchAsAdministrator } from '@/plugins/adminStatus'

const authorized = ref(true)
const restarting = ref(false)
const { t } = useI18n()

onMounted(async () => {
  authorized.value = await isRunningAsAdministrator()

  if (authorized.value) return

  showAdministratorGuide()
})

async function showAdministratorGuide() {
  if (restarting.value) return

  const confirmed = await confirm(t('pages.preference.general.hints.administratorPermissionGuide'), {
    title: t('pages.preference.general.labels.administratorPermission'),
    okLabel: t('pages.preference.general.buttons.restartAsAdministrator'),
    cancelLabel: t('pages.preference.general.buttons.setLater'),
    kind: 'warning',
  })

  if (!confirmed) return

  try {
    restarting.value = true

    await relaunchAsAdministrator()
  } catch (error) {
    console.error(error)
    await message(t('pages.preference.general.hints.administratorRelaunchFailed'), {
      title: t('pages.preference.general.labels.administratorPermission'),
      kind: 'error',
    })
  } finally {
    restarting.value = false
  }
}
</script>

<template>
  <ProList
    :title="$t('pages.preference.general.labels.permissionsSettings')"
  >
    <ProListItem
      :description="$t('pages.preference.general.hints.administratorPermission')"
      :title="$t('pages.preference.general.labels.administratorPermission')"
    >
      <Space
        v-if="authorized"
        class="text-success font-bold"
        :size="4"
      >
        <div class="i-solar:verified-check-bold text-4.5" />

        <span class="whitespace-nowrap">{{ $t('pages.preference.general.status.adminEnabled') }}</span>
      </Space>

      <Space
        v-else
        class="cursor-pointer text-error font-bold"
        :size="4"
        @click="showAdministratorGuide"
      >
        <div
          class="i-solar:restart-bold text-4.5"
          :class="{ 'animate-spin': restarting }"
        />

        <span class="whitespace-nowrap">{{ $t('pages.preference.general.buttons.restartAsAdministrator') }}</span>
      </Space>
    </ProListItem>
  </ProList>
</template>
