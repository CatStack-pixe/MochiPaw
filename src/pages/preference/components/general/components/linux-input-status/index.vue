<!-- SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { Button, Space } from 'antdv-next'
import { computed } from 'vue'

import ProListItem from '@/components/pro-list-item/index.vue'
import { useDeviceInputStatus } from '@/composables/useDeviceInputStatus'

const { status, error, refreshing, retrying, retry } = useDeviceInputStatus({ poll: true })
const ready = computed(() => status.value?.available && !error.value)
const details = computed(() => [...new Set([status.value?.error, error.value].filter(Boolean))].join('\n'))

const descriptionKey = computed(() => {
  if (!status.value) {
    return error.value
      ? 'pages.preference.general.hints.inputStatusFailed'
      : 'pages.preference.general.hints.inputStatusPending'
  }
  if (status.value.backend === 'rdev') return 'pages.preference.general.hints.x11Input'
  if (ready.value) {
    return status.value.backend === 'wayland-service'
      ? 'pages.preference.general.hints.waylandServiceReady'
      : 'pages.preference.general.hints.waylandEvdevReady'
  }
  return 'pages.preference.general.hints.waylandUnavailable'
})

const statusKey = computed(() => {
  if (!status.value && !error.value) return 'pages.preference.general.status.checking'
  if (!ready.value) return 'pages.preference.general.status.unavailable'
  if (status.value?.backend === 'rdev') return 'pages.preference.general.status.x11Ready'
  return status.value?.backend === 'wayland-service'
    ? 'pages.preference.general.status.serviceReady'
    : 'pages.preference.general.status.evdevReady'
})

function handleRetry() {
  void retry().catch(() => undefined)
}
</script>

<template>
  <ProListItem
    :title="$t('pages.preference.general.labels.linuxInput')"
    vertical
  >
    <template #description>
      <div>{{ $t(descriptionKey) }}</div>
      <div
        v-if="details"
        class="mt-2 whitespace-pre-wrap"
        role="status"
      >
        {{ details }}
      </div>
    </template>

    <Space>
      <span aria-live="polite">{{ $t(statusKey) }}</span>
      <Button
        v-if="!ready"
        :disabled="refreshing"
        :loading="retrying"
        @click="handleRetry"
      >
        {{ $t('pages.preference.general.buttons.retryInput') }}
      </Button>
    </Space>
  </ProListItem>
</template>
