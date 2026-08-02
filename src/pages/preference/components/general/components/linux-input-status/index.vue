<!-- SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { computed } from 'vue'

import ProListItem from '@/components/pro-list-item/index.vue'
import { useDeviceInputStatus } from '@/composables/useDeviceInputStatus'

const { status } = useDeviceInputStatus()

const descriptionKey = computed(() => {
  if (status.value?.backend === 'wayland-appimage') return 'pages.preference.general.hints.waylandAppImage'
  if (status.value?.available) return 'pages.preference.general.hints.waylandReady'
  return 'pages.preference.general.hints.waylandUnavailable'
})
</script>

<template>
  <ProListItem
    :description="$t(descriptionKey)"
    :title="$t('pages.preference.general.labels.waylandInput')"
  >
    <span>{{ status?.available ? $t('pages.preference.general.status.authorized') : $t('pages.preference.general.status.unavailable') }}</span>
  </ProListItem>
</template>
