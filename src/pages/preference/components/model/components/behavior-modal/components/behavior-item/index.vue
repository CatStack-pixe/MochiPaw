<!-- SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { Button, Checkbox, Divider, Input } from 'antdv-next'

import Shortcut from '@/components/shortcut/index.vue'
import { useKeyPress } from '@/composables/useKeyPress'

const emit = defineEmits(['click'])
const shortcut = defineModel<string>('shortcut')
const name = defineModel<string>('name')
const checked = defineModel<boolean>('checked')

useKeyPress(shortcut, () => {
  emit('click')
})
</script>

<template>
  <div class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2 not-last:(b-b b-b-solid b-border-sec)">
    <Checkbox
      v-if="checked !== undefined"
      v-model:checked="checked"
    />

    <Input
      v-model:value="name"
      class="min-w-0"
      size="small"
    />

    <div class="flex items-center">
      <Shortcut v-model="shortcut" />

      <Divider type="vertical" />

      <Button
        class="inline-flex items-center justify-center"
        @click="emit('click')"
      >
        <template #icon>
          <div class="i-lucide:play" />
        </template>
      </Button>
    </div>
  </div>
</template>
