<!-- SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { HappyProvider } from '@antdv-next/happy-work-theme'
import { ConfigProvider, theme } from 'antdv-next'

import { getAntdLocale } from '@/locales/antd'
import { useGeneralStore } from '@/stores/general'

const generalStore = useGeneralStore()
const { darkAlgorithm, defaultAlgorithm } = theme
</script>

<template>
  <HappyProvider
    v-slot="{ wave }"
    enabled
  >
    <ConfigProvider
      :locale="getAntdLocale(generalStore.appearance.language)"
      :theme="{
        algorithm: generalStore.appearance.isDark ? darkAlgorithm : defaultAlgorithm,
      }"
      :wave="wave"
    >
      <slot />
    </ConfigProvider>
  </HappyProvider>
</template>
