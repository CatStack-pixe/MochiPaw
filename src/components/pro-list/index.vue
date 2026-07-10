<!-- SPDX-FileCopyrightText: 2025 ayangweb
  SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { Flex } from 'antdv-next'

const { title } = defineProps<{
  title: string
}>()
</script>

<template>
  <Flex
    class="not-last:mb-4"
    gap="small"
    vertical
  >
    <div
      class="text-4 font-medium"
      data-tauri-drag-region
    >
      {{ title }}
    </div>

    <Flex
      gap="middle"
      vertical
    >
      <slot />
    </Flex>
  </FLex>
</template>
