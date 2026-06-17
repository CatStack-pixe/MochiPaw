<script setup lang="ts">
import type { ModelBehaviorConfig } from '@/stores/model'

import { Button, Divider, Input, InputNumber } from 'antdv-next'

import Shortcut from '@/components/shortcut/index.vue'
import { useKeyPress } from '@/composables/useKeyPress'

const emit = defineEmits(['click'])
const shortcut = defineModel<string>('shortcut')
const name = defineModel<string>('name')
const config = defineModel<ModelBehaviorConfig>('config', {
  required: true,
})

useKeyPress(shortcut, () => {
  emit('click')
})
</script>

<template>
  <div class="grid gap-2 px-4 py-2 not-last:(b-b b-b-solid b-border-sec)">
    <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
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

    <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7rem] gap-2 text-[11px] text-text-tertiary">
      <span>Group</span>
      <span>Mutex</span>
      <span>Reset</span>
    </div>

    <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7rem] gap-2">
      <Input
        v-model:value="config.group"
        size="small"
      />

      <Input
        v-model:value="config.mutexGroup"
        size="small"
      />

      <InputNumber
        v-model:value="config.resetDelay"
        class="w-full"
        :min="-1"
        :precision="1"
        size="small"
        :step="0.1"
      />
    </div>
  </div>
</template>
