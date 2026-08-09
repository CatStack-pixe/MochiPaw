<!-- SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { Button, message, Modal, Switch, Tag } from 'antdv-next'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { useGeneralStore } from '@/stores/general'
import { useTypingStatsStore } from '@/stores/typingStats'
import { logError } from '@/utils/diagnostics'
import { requestTypingStatsOperation } from '@/utils/typingStatsRequest'

const typingStatsStore = useTypingStatsStore()
const generalStore = useGeneralStore()
const { t } = useI18n()

const maxCount = computed(() => {
  return Math.max(1, ...typingStatsStore.recent30Days.map(item => item.count))
})
const hasHistory = computed(() => Object.keys(typingStatsStore.dailyCounts).length > 0)
const pendingEnabled = ref<boolean>()
const mutationPending = ref(false)
const trackingEnabled = computed({
  get: () => pendingEnabled.value ?? typingStatsStore.enabled,
  set: requestEnabledChange,
})
let midnightTimer: ReturnType<typeof setTimeout> | undefined

watch(() => typingStatsStore.enabled, (value) => {
  if (value === pendingEnabled.value) pendingEnabled.value = undefined
})

function formatCount(count: number) {
  return new Intl.NumberFormat(generalStore.appearance.language).format(count)
}

function formatDate(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map(Number)

  return new Intl.DateTimeFormat(generalStore.appearance.language, {
    day: 'numeric',
    month: 'short',
  }).format(new Date(year, month - 1, day, 12))
}

function barHeight(count: number) {
  if (count === 0) return '2px'

  return `${Math.max(4, (count / maxCount.value) * 100)}%`
}

function showDateLabel(index: number, length: number) {
  return (index % 6 === 0 && index < 24) || index === length - 1
}

function dateGridColumn(index: number, length: number) {
  if (index === length - 1) return `${length - 5} / ${length + 1}`

  return `${index + 1} / span 6`
}

function scheduleMidnightRefresh() {
  const now = new Date()
  const nextMidnight = new Date(now)

  typingStatsStore.refreshCurrentDate(now)
  nextMidnight.setHours(24, 0, 0, 0)
  midnightTimer = setTimeout(scheduleMidnightRefresh, nextMidnight.getTime() - now.getTime() + 100)
}

function requestEnabledChange(enabled: boolean) {
  if (mutationPending.value) return

  pendingEnabled.value = enabled
  mutationPending.value = true

  void requestTypingStatsOperation({ kind: 'set-enabled', enabled })
    .then((acknowledgement) => {
      if (!acknowledgement.accepted) {
        throw new Error(acknowledgement.reason ?? 'The main window rejected the tracking change.')
      }

      if (acknowledgement.state) {
        typingStatsStore.$patch(acknowledgement.state)
      }
    })
    .catch((error) => {
      logError('[typing-stats] failed to change tracking state', { enabled, error })
      message.error(t('pages.preference.typingStats.hints.saveFailed'))
    })
    .finally(() => {
      pendingEnabled.value = undefined
      mutationPending.value = false
    })
}

async function requestClearHistory() {
  if (mutationPending.value) return

  mutationPending.value = true

  try {
    const acknowledgement = await requestTypingStatsOperation({ kind: 'clear-history' })

    if (!acknowledgement.accepted) {
      throw new Error(acknowledgement.reason ?? 'The main window rejected clearing typing history.')
    }

    if (acknowledgement.state) {
      typingStatsStore.$patch(acknowledgement.state)
    }
  } catch (error) {
    logError('[typing-stats] failed to request history clearing', { error })
    message.error(t('pages.preference.typingStats.hints.saveFailed'))
    throw error
  } finally {
    mutationPending.value = false
  }
}

function confirmClearHistory() {
  Modal.confirm({
    content: t('pages.preference.typingStats.hints.clearConfirmation'),
    okText: t('pages.preference.typingStats.buttons.confirmClear'),
    okType: 'danger',
    onOk: requestClearHistory,
    title: t('pages.preference.typingStats.buttons.clearHistory'),
  })
}

onMounted(scheduleMidnightRefresh)

onUnmounted(() => {
  if (midnightTimer) clearTimeout(midnightTimer)
})
</script>

<template>
  <ProList :title="t('pages.preference.typingStats.labels.overview')">
    <ProListItem
      :title="t('pages.preference.typingStats.labels.today')"
      vertical
    >
      <div class="flex items-end justify-between gap-4">
        <div class="min-w-0 flex items-baseline gap-2">
          <strong class="break-all text-9 font-semibold leading-none">
            {{ formatCount(typingStatsStore.todayCount) }}
          </strong>
          <span class="color-text-tertiary">
            {{ t('pages.preference.typingStats.labels.presses') }}
          </span>
        </div>

        <Tag :color="typingStatsStore.enabled ? 'success' : 'default'">
          {{ t(`pages.preference.typingStats.status.${typingStatsStore.enabled ? 'active' : 'paused'}`) }}
        </Tag>
      </div>
    </ProListItem>
  </ProList>

  <ProList :title="t('pages.preference.typingStats.labels.last30Days')">
    <ProListItem
      :title="t('pages.preference.typingStats.labels.trend')"
      vertical
    >
      <div
        :aria-label="t('pages.preference.typingStats.hints.trendLabel')"
        class="typing-trend"
        role="img"
      >
        <template
          v-for="(item, index) in typingStatsStore.recent30Days"
          :key="item.date"
        >
          <div
            class="typing-trend-track"
            :style="{ gridColumn: index + 1 }"
            :title="t('pages.preference.typingStats.hints.dayCount', { count: formatCount(item.count), date: formatDate(item.date) })"
          >
            <div
              class="typing-trend-bar"
              :class="{ 'typing-trend-bar-empty': item.count === 0 }"
              :style="{ height: barHeight(item.count) }"
            />
          </div>

          <span
            v-if="showDateLabel(index, typingStatsStore.recent30Days.length)"
            class="typing-trend-date"
            :class="{ 'typing-trend-date-last': index === typingStatsStore.recent30Days.length - 1 }"
            :style="{ gridColumn: dateGridColumn(index, typingStatsStore.recent30Days.length) }"
          >
            {{ formatDate(item.date) }}
          </span>
        </template>
      </div>
    </ProListItem>
  </ProList>

  <ProList :title="t('pages.preference.typingStats.labels.settings')">
    <ProListItem
      :description="t('pages.preference.typingStats.hints.privacy')"
      :title="t('pages.preference.typingStats.labels.enabled')"
    >
      <Switch
        v-model:checked="trackingEnabled"
        :loading="mutationPending"
      />
    </ProListItem>

    <ProListItem
      :description="t('pages.preference.typingStats.hints.clearHistory')"
      :title="t('pages.preference.typingStats.labels.history')"
    >
      <Button
        danger
        :disabled="!hasHistory || mutationPending"
        :loading="mutationPending"
        @click="confirmClearHistory"
      >
        <template #icon>
          <i class="i-lucide:trash-2" />
        </template>
        {{ t('pages.preference.typingStats.buttons.clearHistory') }}
      </Button>
    </ProListItem>
  </ProList>
</template>

<style scoped>
.typing-trend {
  display: grid;
  grid-template-columns: repeat(30, minmax(6px, 1fr));
  grid-template-rows: 156px 24px;
  gap: 4px;
  width: 100%;
  height: 184px;
}

.typing-trend-track {
  grid-row: 1;
  display: flex;
  align-items: flex-end;
  min-height: 0;
  overflow: hidden;
  background: var(--ant-color-fill-quaternary);
  border-radius: 3px 3px 0 0;
}

.typing-trend-bar {
  width: 100%;
  min-height: 2px;
  background: var(--ant-color-primary);
  border-radius: 3px 3px 0 0;
  transition: height 180ms ease;
}

.typing-trend-bar-empty {
  background: var(--ant-color-fill-secondary);
}

.typing-trend-date {
  grid-row: 2;
  min-width: 0;
  overflow: hidden;
  color: var(--ant-color-text-tertiary);
  font-size: 11px;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.typing-trend-date-last {
  text-align: right;
}
</style>
