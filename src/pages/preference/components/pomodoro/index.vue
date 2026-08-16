<!-- SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { listen } from '@tauri-apps/api/event'
import { useDebounceFn } from '@vueuse/core'
import { Button, Divider, InputNumber, message, Select, Slider, Switch } from 'antdv-next'
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { PomodoroPhase, PomodoroTimelineSegment } from '@/utils/pomodoroClock'
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
const { locale, t } = useI18n()
const pending = ref(false)
const selectedDate = ref(getDateKey())
const timelineNow = ref(Date.now())
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
let timelineTimer: number | undefined

function syncDraft(payload: PomodoroStatePayload) {
  store.$patch(payload)
  Object.assign(draft, payload.settings)
}

function getDateKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

function startOfDate(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map(Number)

  return new Date(year, month - 1, day).getTime()
}

function formatDate(dateKey: string) {
  return new Intl.DateTimeFormat(locale.value, { month: 'short', day: 'numeric' }).format(new Date(startOfDate(dateKey)))
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp))
}

function formatDuration(startedAt: number, endedAt: number) {
  const minutes = Math.max(1, Math.round((endedAt - startedAt) / 60_000))

  return `${minutes} ${t('pages.pomodoro.units.minutes')}`
}

const dateOptions = computed(() => {
  const today = new Date()

  return Array.from({ length: 30 }, (_, index) => {
    const date = new Date(today)
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() - index)
    const value = getDateKey(date)

    return { label: index === 0 ? t('pages.pomodoro.labels.today') : formatDate(value), value }
  })
})

const selectedDateStart = computed(() => startOfDate(selectedDate.value))
const selectedDateEnd = computed(() => {
  const date = new Date(selectedDateStart.value)
  date.setHours(24, 0, 0, 0)

  return date.getTime()
})
const chartEnd = computed(() => selectedDate.value === getDateKey(new Date(timelineNow.value))
  ? Math.max(timelineNow.value, selectedDateStart.value + 60 * 60_000)
  : selectedDateEnd.value)
const chartDuration = computed(() => Math.max(1, chartEnd.value - selectedDateStart.value))

const selectedSegments = computed(() => {
  const source = [...(store.runtime.timeline.segments[selectedDate.value] ?? [])]

  if (selectedDate.value === getDateKey(new Date(timelineNow.value))
    && store.runtime.status === 'running'
    && store.runtime.phaseStartedAt != null) {
    source.push({
      id: `${store.runtime.sessionId}-live`,
      phase: store.runtime.phase,
      startedAt: store.runtime.phaseStartedAt,
      endedAt: timelineNow.value,
    })
  }

  return source
    .map(segment => ({
      ...segment,
      startedAt: Math.max(segment.startedAt, selectedDateStart.value),
      endedAt: Math.min(segment.endedAt, chartEnd.value),
    }))
    .filter(segment => segment.endedAt > segment.startedAt)
})

const selectedCompleted = computed(() => selectedDate.value === store.runtime.completedDate
  ? store.runtime.completedToday
  : store.runtime.timeline.completed[selectedDate.value] ?? 0)
const selectedConnectors = computed(() => selectedSegments.value.flatMap((segment, index) => {
  const previous = selectedSegments.value[index - 1]

  return previous && segment.startedAt - previous.endedAt <= 1_000 ? [{ previous, segment }] : []
}))

function xPosition(timestamp: number) {
  return ((timestamp - selectedDateStart.value) / chartDuration.value) * 1000
}

function phaseY(phase: PomodoroPhase) {
  return phase === 'work' ? 54 : phase === 'shortBreak' ? 112 : 170
}

function phaseColor(phase: PomodoroPhase) {
  return phase === 'work' ? 'var(--ant-color-primary)' : phase === 'shortBreak' ? 'var(--ant-color-success)' : 'var(--ant-color-warning)'
}

function segmentTooltip(segment: PomodoroTimelineSegment) {
  return `${t(`pages.pomodoro.phases.${segment.phase}`)} - ${formatTime(segment.startedAt)} - ${formatTime(segment.endedAt)} - ${formatDuration(segment.startedAt, segment.endedAt)}`
}

function tickLabels() {
  const labels = []
  const step = chartDuration.value / 4

  for (let index = 0; index <= 4; index++) {
    const timestamp = selectedDateStart.value + step * index
    labels.push({ x: xPosition(timestamp), label: formatTime(timestamp) })
  }

  return labels
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

type PomodoroControlCommand = 'start' | 'pause' | 'resume' | 'reset'

async function runCommand(command: PomodoroControlCommand) {
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
  timelineTimer = window.setInterval(() => {
    timelineNow.value = Date.now()
  }, 1_000)
  unlistenState = await listen<PomodoroStatePayload>(LISTEN_KEY.POMODORO_STATE_CHANGED, ({ payload }) => {
    syncDraft(payload)
  })
})

onUnmounted(() => {
  unlistenState?.()
  if (timelineTimer) window.clearInterval(timelineTimer)
})

watch(draft, scheduleSettingsPersistence, { deep: true })
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
      :description="t('pages.pomodoro.hints.timelineDescription')"
      :title="t('pages.pomodoro.labels.timeline')"
      vertical
    >
      <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-baseline gap-2">
          <strong class="text-8 font-semibold leading-none">{{ selectedCompleted }}</strong>
          <span class="color-text-tertiary">{{ t('pages.pomodoro.labels.completed') }}</span>
        </div>
        <Select
          v-model:value="selectedDate"
          class="w-40"
          :options="dateOptions"
        />
      </div>

      <div
        :aria-label="t('pages.pomodoro.hints.timelineLabel')"
        class="pomodoro-timeline"
        role="img"
      >
        <svg
          aria-hidden="true"
          class="pomodoro-timeline-svg"
          preserveAspectRatio="none"
          viewBox="0 0 1000 210"
        >
          <line
            v-for="y in [54, 112, 170]"
            :key="y"
            class="pomodoro-timeline-guide"
            x1="0"
            x2="1000"
            :y1="y"
            :y2="y"
          />
          <path
            v-for="connector in selectedConnectors"
            :key="`${connector.previous.id}-${connector.segment.id}`"
            class="pomodoro-timeline-connector"
            :d="`M ${xPosition(connector.previous.endedAt)} ${phaseY(connector.previous.phase)} C ${xPosition(connector.previous.endedAt) + 8} ${phaseY(connector.previous.phase)}, ${xPosition(connector.segment.startedAt) - 8} ${phaseY(connector.segment.phase)}, ${xPosition(connector.segment.startedAt)} ${phaseY(connector.segment.phase)}`"
            :stroke="phaseColor(connector.segment.phase)"
          />
          <g
            v-for="segment in selectedSegments"
            :key="segment.id"
          >
            <title>{{ segmentTooltip(segment) }}</title>
            <line
              class="pomodoro-timeline-segment"
              :stroke="phaseColor(segment.phase)"
              :x1="xPosition(segment.startedAt)"
              :x2="xPosition(segment.endedAt)"
              :y1="phaseY(segment.phase)"
              :y2="phaseY(segment.phase)"
            />
          </g>
        </svg>
        <div
          aria-hidden="true"
          class="pomodoro-timeline-lanes"
        >
          <span>{{ t('pages.pomodoro.phases.work') }}</span>
          <span>{{ t('pages.pomodoro.phases.shortBreak') }}</span>
          <span>{{ t('pages.pomodoro.phases.longBreak') }}</span>
        </div>
        <div
          aria-hidden="true"
          class="pomodoro-timeline-axis"
        >
          <span
            v-for="tick in tickLabels()"
            :key="tick.label"
            :style="{ left: `${tick.x / 10}%` }"
          >
            {{ tick.label }}
          </span>
        </div>
        <p
          v-if="selectedSegments.length === 0"
          class="pomodoro-timeline-empty"
        >
          {{ t('pages.pomodoro.hints.timelineEmpty') }}
        </p>
      </div>
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
      <div class="flex items-center gap-2">
        <Shortcut v-model="shortcutStore.pomodoroStart" />
        <Divider
          class="m-0!"
          type="vertical"
        />
        <Button
          :aria-label="t('pages.pomodoro.buttons.start')"
          :disabled="pending"
          :loading="pending"
          :title="t('pages.pomodoro.buttons.start')"
          @click="runCommand('start')"
        >
          <template #icon>
            <div class="i-lucide:play size-4" />
          </template>
        </Button>
      </div>
    </ProListItem>
    <ProListItem
      :description="t('pages.pomodoro.hints.shortcutPause')"
      :title="t('pages.pomodoro.buttons.pause')"
    >
      <div class="flex items-center gap-2">
        <Shortcut v-model="shortcutStore.pomodoroPause" />
        <Divider
          class="m-0!"
          type="vertical"
        />
        <Button
          :aria-label="t('pages.pomodoro.buttons.pause')"
          :disabled="pending"
          :loading="pending"
          :title="t('pages.pomodoro.buttons.pause')"
          @click="runCommand('pause')"
        >
          <template #icon>
            <div class="i-lucide:pause size-4" />
          </template>
        </Button>
      </div>
    </ProListItem>
    <ProListItem
      :description="t('pages.pomodoro.hints.shortcutResume')"
      :title="t('pages.pomodoro.buttons.resume')"
    >
      <div class="flex items-center gap-2">
        <Shortcut v-model="shortcutStore.pomodoroResume" />
        <Divider
          class="m-0!"
          type="vertical"
        />
        <Button
          :aria-label="t('pages.pomodoro.buttons.resume')"
          :disabled="pending"
          :loading="pending"
          :title="t('pages.pomodoro.buttons.resume')"
          @click="runCommand('resume')"
        >
          <template #icon>
            <div class="i-lucide:play size-4" />
          </template>
        </Button>
      </div>
    </ProListItem>
    <ProListItem
      :description="t('pages.pomodoro.hints.shortcutReset')"
      :title="t('pages.pomodoro.buttons.reset')"
    >
      <div class="flex items-center gap-2">
        <Shortcut v-model="shortcutStore.pomodoroReset" />
        <Divider
          class="m-0!"
          type="vertical"
        />
        <Button
          :aria-label="t('pages.pomodoro.buttons.reset')"
          :disabled="pending"
          :loading="pending"
          :title="t('pages.pomodoro.buttons.reset')"
          @click="runCommand('reset')"
        >
          <template #icon>
            <div class="i-lucide:rotate-ccw size-4" />
          </template>
        </Button>
      </div>
    </ProListItem>
  </ProList>
</template>

<style scoped>
.pomodoro-timeline {
  position: relative;
  min-height: 238px;
  padding: 10px 0 28px 72px;
}

.pomodoro-timeline-svg {
  display: block;
  width: 100%;
  height: 190px;
  overflow: visible;
}

.pomodoro-timeline-guide {
  stroke: var(--ant-color-fill-quaternary);
  stroke-width: 1;
  stroke-dasharray: 4 6;
}

.pomodoro-timeline-segment {
  stroke-linecap: round;
  stroke-width: 14;
  vector-effect: non-scaling-stroke;
}

.pomodoro-timeline-connector {
  fill: none;
  stroke-linecap: round;
  stroke-width: 14;
  vector-effect: non-scaling-stroke;
}

.pomodoro-timeline-lanes {
  position: absolute;
  top: 20px;
  bottom: 55px;
  left: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  color: var(--ant-color-text-tertiary);
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
}

.pomodoro-timeline-axis {
  position: absolute;
  right: 0;
  bottom: 5px;
  left: 72px;
  height: 16px;
  color: var(--ant-color-text-tertiary);
  font-size: 11px;
}

.pomodoro-timeline-axis span {
  position: absolute;
  transform: translateX(-50%);
  white-space: nowrap;
}

.pomodoro-timeline-axis span:first-child {
  transform: none;
}

.pomodoro-timeline-axis span:last-child {
  transform: translateX(-100%);
}

.pomodoro-timeline-empty {
  position: absolute;
  top: 50%;
  right: 0;
  left: 72px;
  margin: 0;
  color: var(--ant-color-text-tertiary);
  text-align: center;
  transform: translateY(-50%);
}
</style>
