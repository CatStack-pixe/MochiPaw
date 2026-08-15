<!-- SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { Button, Flex, message, Tag } from 'antdv-next'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { PomodoroPhase } from '@/utils/pomodoroClock'
import type { PomodoroStatePayload } from '@/utils/pomodoroRequest'

import { LISTEN_KEY } from '@/constants'
import { usePomodoroStore } from '@/stores/pomodoro'
import { requestPomodoroCommand } from '@/utils/pomodoroRequest'

const store = usePomodoroStore()
const { t } = useI18n()
const appWindow = getCurrentWebviewWindow()
const now = ref(Date.now())
const pending = ref(false)
let tickTimer: ReturnType<typeof setInterval> | undefined
let unlistenState: (() => void) | undefined

const remainingMs = computed(() => store.getRemainingMs(now.value))
const phaseDuration = computed(() => {
  const minutes = store.runtime.phase === 'work'
    ? store.settings.workMinutes
    : store.runtime.phase === 'shortBreak' ? store.settings.shortBreakMinutes : store.settings.longBreakMinutes

  return minutes * 60_000
})
const progress = computed(() => Math.min(100, Math.max(0, (1 - remainingMs.value / phaseDuration.value) * 100)))
const phaseLabel = computed(() => t(`pages.pomodoro.phases.${store.runtime.phase}`))
const statusLabel = computed(() => t(`pages.pomodoro.status.${store.runtime.status}`))
const roundCurrent = computed(() => (store.runtime.completedRounds % store.settings.longBreakInterval) + 1)
const actionLabel = computed(() => store.runtime.status === 'running'
  ? t('pages.pomodoro.buttons.pause')
  : store.runtime.status === 'paused' ? t('pages.pomodoro.buttons.resume') : t('pages.pomodoro.buttons.start'))

function formatRemaining(value: number) {
  const seconds = Math.max(0, Math.ceil(value / 1000))
  const minutes = Math.floor(seconds / 60)

  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

async function command(command: Parameters<typeof requestPomodoroCommand>[0]) {
  if (pending.value) return

  pending.value = true

  try {
    const acknowledgement = await requestPomodoroCommand(command)

    if (!acknowledgement.accepted) throw new Error(acknowledgement.reason ?? t('pages.pomodoro.hints.commandFailed'))

    if (acknowledgement.state) {
      store.$patch(acknowledgement.state)
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    pending.value = false
  }
}

function toggleRunning() {
  return command(store.runtime.status === 'running' ? 'pause' : store.runtime.status === 'paused' ? 'resume' : 'start')
}

function phaseIcon(phase: PomodoroPhase) {
  return phase === 'work' ? 'i-lucide:brain' : phase === 'shortBreak' ? 'i-lucide:coffee' : 'i-lucide:moon'
}

onMounted(async () => {
  tickTimer = setInterval(() => {
    now.value = Date.now()
  }, 250)

  unlistenState = await listen<PomodoroStatePayload>(LISTEN_KEY.POMODORO_STATE_CHANGED, ({ payload }) => {
    store.$patch(payload)
    now.value = Date.now()
  })
})

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
  unlistenState?.()
})
</script>

<template>
  <div class="pomodoro-window">
    <Flex
      align="center"
      class="mb-3"
      data-tauri-drag-region
      justify="space-between"
    >
      <Flex
        align="center"
        class="gap-2"
      >
        <i class="i-lucide:timer size-5" />
        <span class="font-semibold">{{ t('pages.pomodoro.title') }}</span>
      </Flex>
      <Button
        :aria-label="t('pages.pomodoro.buttons.close')"
        class="icon-button"
        type="text"
        @click="appWindow.hide()"
      >
        <template #icon>
          <i class="i-lucide:x" />
        </template>
      </Button>
    </Flex>

    <div class="text-center">
      <div class="mb-2 flex items-center justify-center gap-2 color-text-secondary">
        <i
          class="size-4"
          :class="[phaseIcon(store.runtime.phase)]"
        />
        <span>{{ phaseLabel }}</span>
        <Tag>{{ statusLabel }}</Tag>
      </div>
      <div class="pomodoro-time">
        {{ formatRemaining(remainingMs) }}
      </div>
      <div class="pomodoro-progress">
        <div :style="{ width: `${progress}%` }" />
      </div>
      <div class="mt-2 color-text-tertiary text-sm">
        {{ t('pages.pomodoro.labels.round', { current: roundCurrent, total: store.settings.longBreakInterval }) }}
        <span class="mx-1">·</span>
        {{ t('pages.pomodoro.labels.todayCompleted', { count: store.todayCompleted }) }}
      </div>
    </div>

    <Flex
      class="mt-4 gap-2"
      justify="center"
    >
      <Button
        :loading="pending"
        type="primary"
        @click="toggleRunning"
      >
        <template #icon>
          <i :class="store.runtime.status === 'running' ? 'i-lucide:pause' : 'i-lucide:play'" />
        </template>
        {{ actionLabel }}
      </Button>
      <Button
        :disabled="pending"
        @click="command('reset')"
      >
        <template #icon>
          <i class="i-lucide:rotate-ccw" />
        </template>
        {{ t('pages.pomodoro.buttons.reset') }}
      </Button>
      <Button
        :disabled="pending"
        @click="command('skip')"
      >
        <template #icon>
          <i class="i-lucide:skip-forward" />
        </template>
        {{ t('pages.pomodoro.buttons.skip') }}
      </Button>
    </Flex>
  </div>
</template>

<style scoped>
.pomodoro-window {
  min-height: 100vh;
  padding: 18px;
  color: var(--ant-color-text);
  background: var(--ant-color-bg-container);
}

.icon-button {
  width: 28px;
  height: 28px;
}

.pomodoro-time {
  font-size: 54px;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  line-height: 1.1;
}

.pomodoro-progress {
  height: 6px;
  overflow: hidden;
  margin-top: 14px;
  border-radius: 3px;
  background: var(--ant-color-fill-secondary);
}

.pomodoro-progress > div {
  height: 100%;
  border-radius: inherit;
  background: var(--ant-color-primary);
  transition: width 200ms linear;
}
</style>
