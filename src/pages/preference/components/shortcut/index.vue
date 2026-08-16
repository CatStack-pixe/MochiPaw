<!-- SPDX-FileCopyrightText: 2025 ayangweb
  SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import Shortcut from '@/components/shortcut/index.vue'
import { useShortcutStore } from '@/stores/shortcut.ts'

const shortcutStore = useShortcutStore()
</script>

<template>
  <ProList :title="$t('pages.preference.shortcut.title')">
    <ProListItem
      :description="$t('pages.preference.shortcut.hints.toggleCat')"
      :title="$t('pages.preference.shortcut.labels.toggleCat')"
    >
      <Shortcut v-model="shortcutStore.visibleCat" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.shortcut.hints.togglePreferences')"
      :title="$t('pages.preference.shortcut.labels.togglePreferences')"
    >
      <Shortcut v-model="shortcutStore.visiblePreference" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.shortcut.hints.mirrorMode')"
      :title="$t('pages.preference.shortcut.labels.mirrorMode')"
    >
      <Shortcut v-model="shortcutStore.mirrorMode" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.shortcut.hints.passThrough')"
      :title="$t('pages.preference.shortcut.labels.passThrough')"
    >
      <Shortcut v-model="shortcutStore.penetrable" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.shortcut.hints.alwaysOnTop')"
      :title="$t('pages.preference.shortcut.labels.alwaysOnTop')"
    >
      <Shortcut v-model="shortcutStore.alwaysOnTop" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.shortcut.hints.gameMode')"
      :title="$t('pages.preference.shortcut.labels.gameMode')"
    >
      <Shortcut v-model="shortcutStore.gameMode" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.shortcut.hints.pomodoroToggle')"
      :title="$t('pages.preference.shortcut.labels.pomodoroToggle')"
    >
      <Shortcut v-model="shortcutStore.pomodoroToggle" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.shortcut.hints.pomodoroReset')"
      :title="$t('pages.preference.shortcut.labels.pomodoroReset')"
    >
      <Shortcut v-model="shortcutStore.pomodoroReset" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.shortcut.hints.pomodoroSkip')"
      :title="$t('pages.preference.shortcut.labels.pomodoroSkip')"
    >
      <Shortcut v-model="shortcutStore.pomodoroSkip" />
    </ProListItem>
  </ProList>
</template>
