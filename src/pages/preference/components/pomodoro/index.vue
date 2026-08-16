<!-- SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { listen } from '@tauri-apps/api/event'
import { useDebounceFn } from '@vueuse/core'
import { InputNumber, message, Slider, Switch } from 'antdv-next'
import { onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { PomodoroStatePayload } from '@/utils/pomodoroRequest'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import Shortcut from '@/components/shortcut/index.vue'
import { LISTEN_KEY } from '@/constants'
import { usePomodoroStore } from '@/stores/pomodoro'
import { useShortcutStore } from '@/stores/shortcut'
import { requestPomodoroCommand } from '@/utils/pomodoroRequest'

const store = usePomodoroStore()
const shortcutStore = useShortcutStore()
const { t } = useI18n()
const pending = ref(false)
const todayCompleted = ref(store.todayCompleted)
const draft = reactive({
  workMinutes: store.settings.workMinutes,
  shortBreakMinutes: store.settings.shortBreakMinutes,
  longBreakMinutes: store.settings.longBreakMinutes,
  longBreakInterval: store.settings.longBreakInterval,
  autoStartBreak: store.settings.autoStartBreak,
  autoStartWork: store.settings.autoStartWork,
  soundEnabled: store.settings.soundEnabled,
  notificationsEnabled: store.settings.notificationsEnabled,
  displayEnabled: store.settings.displayEnabled,
  displayScale: store.settings.displayScale,
})
let unlistenState: (() => void) | undefined

function syncDraft(payload: PomodoroStatePayload) {
  store.$patch(payload)
  Object.assign(draft, payload.settings)
  todayCompleted.value = payload.runtime.completedToday
}

function hasDraftChanges() {
  return Object.entries(draft).some(([key, value]) => value !== store.settings[key as keyof typeof store.settings])
}

async function persistSettings() {
  if (pending.value) return

  pending.value = true

  try {
    const acknowledgement = await requestPomodoroCommand('update-settings', { ...draft })

    if (!acknowledgement.accepted) throw new Error(acknowledgement.reason ?? t('pages.pomodoro.hints.saveFailed'))

    if (acknowledgement.state) syncDraft(acknowledgement.state)
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    pending.value = false
    if (hasDraftChanges()) scheduleSettingsPersistence()
  }
}

const scheduleSettingsPersistence = useDebounceFn(() => {
  if (hasDraftChanges()) void persistSettings()
}, 300)

async function setTodayCompleted(value: number | null) {
  if (pending.value || value == null) return

  pending.value = true

  try {
    const acknowledgement = await requestPomodoroCommand('set-today-completed', undefined, value)

    if (!acknowledgement.accepted) throw new Error(acknowledgement.reason ?? t('pages.pomodoro.hints.commandFailed'))

    if (acknowledgement.state) syncDraft(acknowledgement.state)
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
    todayCompleted.value = store.todayCompleted
  } finally {
    pending.value = false
  }
}

onMounted(async () => {
  unlistenState = await listen<PomodoroStatePayload>(LISTEN_KEY.POMODORO_STATE_CHANGED, ({ payload }) => {
    syncDraft(payload)
  })
})

onUnmounted(() => {
  unlistenState?.()
})

watch(draft, scheduleSettingsPersistence, { deep: true })
watch(() => store.todayCompleted, (value) => {
  todayCompleted.value = value
})
</script>

<template>
  <ProList :title="t('pages.pomodoro.labels.overview')">
    <ProListItem
      :description="t('pages.pomodoro.hints.currentState')"
      :title="t(`pages.pomodoro.phases.${store.runtime.phase}`)"
    >
      <div class="flex items-center gap-2">
        <strong class="text-7">{{ Math.ceil(store.getRemainingMs() / 60_000) }}</strong>
        <span class="color-text-tertiary">{{ t('pages.pomodoro.units.minutes') }}</span>
      </div>
    </ProListItem>
    <ProListItem
      :description="t('pages.pomodoro.hints.todayCompleted', { count: todayCompleted })"
      :title="t('pages.pomodoro.labels.todayCompletedTitle')"
    >
      <InputNumber
        v-model:value="todayCompleted"
        :disabled="pending"
        :min="0"
        @change="setTodayCompleted"
      />
    </ProListItem>
  </ProList>

  <ProList :title="t('pages.pomodoro.labels.settings')">
    <ProListItem :title="t('pages.pomodoro.labels.workMinutes')">
      <InputNumber
        v-model:value="draft.workMinutes"
        :max="120"
        :min="1"
      />
    </ProListItem>
    <ProListItem :title="t('pages.pomodoro.labels.shortBreakMinutes')">
      <InputNumber
        v-model:value="draft.shortBreakMinutes"
        :max="120"
        :min="1"
      />
    </ProListItem>
    <ProListItem :title="t('pages.pomodoro.labels.longBreakMinutes')">
      <InputNumber
        v-model:value="draft.longBreakMinutes"
        :max="120"
        :min="1"
      />
    </ProListItem>
    <ProListItem :title="t('pages.pomodoro.labels.longBreakInterval')">
      <InputNumber
        v-model:value="draft.longBreakInterval"
        :max="12"
        :min="1"
      />
    </ProListItem>
    <ProListItem :title="t('pages.pomodoro.labels.autoStartBreak')">
      <Switch v-model:checked="draft.autoStartBreak" />
    </ProListItem>
    <ProListItem :title="t('pages.pomodoro.labels.autoStartWork')">
      <Switch v-model:checked="draft.autoStartWork" />
    </ProListItem>
    <ProListItem :title="t('pages.pomodoro.labels.notificationsEnabled')">
      <Switch v-model:checked="draft.notificationsEnabled" />
    </ProListItem>
    <ProListItem :title="t('pages.pomodoro.labels.soundEnabled')">
      <Switch v-model:checked="draft.soundEnabled" />
    </ProListItem>
    <ProListItem :title="t('pages.pomodoro.labels.displayEnabled')">
      <Switch v-model:checked="draft.displayEnabled" />
    </ProListItem>
    <ProListItem
      :description="t('pages.pomodoro.hints.displayScaleRange')"
      :title="t('pages.pomodoro.labels.displayScale')"
      vertical
    >
      <div class="flex items-center gap-4">
        <Slider
          v-model:value="draft.displayScale"
          class="flex-1 m-0!"
          :max="200"
          :min="50"
          :tooltip="{
            formatter(value) {
              return `${value}%`
            },
          }"
        />
        <div class="flex items-center gap-1">
          <InputNumber
            v-model:value="draft.displayScale"
            class="w-24"
            :max="200"
            :min="50"
          />
          <span>%</span>
        </div>
      </div>
    </ProListItem>
  </ProList>

  <ProList :title="t('pages.pomodoro.labels.controls')">
    <ProListItem
      :description="t('pages.pomodoro.hints.shortcutStart')"
      :title="t('pages.pomodoro.buttons.start')"
    >
      <Shortcut v-model="shortcutStore.pomodoroStart" />
    </ProListItem>
    <ProListItem
      :description="t('pages.pomodoro.hints.shortcutPause')"
      :title="t('pages.pomodoro.buttons.pause')"
    >
      <Shortcut v-model="shortcutStore.pomodoroPause" />
    </ProListItem>
    <ProListItem
      :description="t('pages.pomodoro.hints.shortcutResume')"
      :title="t('pages.pomodoro.buttons.resume')"
    >
      <Shortcut v-model="shortcutStore.pomodoroResume" />
    </ProListItem>
    <ProListItem
      :description="t('pages.pomodoro.hints.shortcutReset')"
      :title="t('pages.pomodoro.buttons.reset')"
    >
      <Shortcut v-model="shortcutStore.pomodoroReset" />
    </ProListItem>
  </ProList>
</template>
