<!-- SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { listen } from '@tauri-apps/api/event'
import { Button, InputNumber, message, Switch } from 'antdv-next'
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { PomodoroStatePayload } from '@/utils/pomodoroRequest'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { LISTEN_KEY } from '@/constants'
import { usePomodoroStore } from '@/stores/pomodoro'
import { requestPomodoroCommand } from '@/utils/pomodoroRequest'
import { openPomodoroWindow } from '@/utils/pomodoroWindow'

const store = usePomodoroStore()
const { t } = useI18n()
const pending = ref(false)
const draft = reactive({
  workMinutes: store.settings.workMinutes,
  shortBreakMinutes: store.settings.shortBreakMinutes,
  longBreakMinutes: store.settings.longBreakMinutes,
  longBreakInterval: store.settings.longBreakInterval,
  autoStartBreak: store.settings.autoStartBreak,
  autoStartWork: store.settings.autoStartWork,
  soundEnabled: store.settings.soundEnabled,
  notificationsEnabled: store.settings.notificationsEnabled,
})
let unlistenState: (() => void) | undefined

function syncDraft(payload: PomodoroStatePayload) {
  store.$patch(payload)
  Object.assign(draft, payload.settings)
}

async function saveSettings() {
  if (pending.value) return

  pending.value = true

  try {
    const acknowledgement = await requestPomodoroCommand('update-settings', { ...draft })

    if (!acknowledgement.accepted) throw new Error(acknowledgement.reason ?? t('pages.pomodoro.hints.saveFailed'))

    if (acknowledgement.state) syncDraft(acknowledgement.state)
    message.success(t('pages.pomodoro.hints.saved'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    pending.value = false
  }
}

async function runCommand(command: Parameters<typeof requestPomodoroCommand>[0]) {
  if (pending.value) return

  pending.value = true

  try {
    const acknowledgement = await requestPomodoroCommand(command)

    if (!acknowledgement.accepted) throw new Error(acknowledgement.reason ?? t('pages.pomodoro.hints.commandFailed'))

    if (acknowledgement.state) syncDraft(acknowledgement.state)
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
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
        <Button @click="openPomodoroWindow">
          <template #icon>
            <i class="i-lucide:external-link" />
          </template>
          {{ t('pages.pomodoro.buttons.openWindow') }}
        </Button>
      </div>
    </ProListItem>
    <ProListItem
      :description="t('pages.pomodoro.hints.todayCompleted')"
      :title="t('pages.pomodoro.labels.todayCompletedTitle')"
    >
      <strong class="text-7">{{ store.todayCompleted }}</strong>
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
    <ProListItem>
      <Button
        :loading="pending"
        type="primary"
        @click="saveSettings"
      >
        <template #icon>
          <i class="i-lucide:save" />
        </template>
        {{ t('pages.pomodoro.buttons.saveSettings') }}
      </Button>
    </ProListItem>
  </ProList>

  <ProList :title="t('pages.pomodoro.labels.controls')">
    <ProListItem :title="t('pages.pomodoro.buttons.start')">
      <div class="flex gap-2">
        <Button
          :disabled="pending"
          @click="runCommand(store.runtime.status === 'running' ? 'pause' : store.runtime.status === 'paused' ? 'resume' : 'start')"
        >
          <template #icon>
            <i :class="store.runtime.status === 'running' ? 'i-lucide:pause' : 'i-lucide:play'" />
          </template>
          {{ store.runtime.status === 'running' ? t('pages.pomodoro.buttons.pause') : store.runtime.status === 'paused' ? t('pages.pomodoro.buttons.resume') : t('pages.pomodoro.buttons.start') }}
        </Button>
        <Button
          :disabled="pending"
          @click="runCommand('reset')"
        >
          <template #icon>
            <i class="i-lucide:rotate-ccw" />
          </template>
          {{ t('pages.pomodoro.buttons.reset') }}
        </Button>
      </div>
    </ProListItem>
    <ProListItem :title="t('pages.pomodoro.buttons.clearToday')">
      <Button
        :disabled="pending || store.todayCompleted === 0"
        @click="runCommand('clear-today')"
      >
        <template #icon>
          <i class="i-lucide:trash-2" />
        </template>
        {{ t('pages.pomodoro.buttons.clearToday') }}
      </Button>
    </ProListItem>
  </ProList>
</template>
