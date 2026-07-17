<!-- SPDX-FileCopyrightText: 2025 ayangweb
  SPDX-FileCopyrightText: 2026 InfinityXCat
  SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0
 -->

<script setup lang="ts">
import { Button, Divider, Flex, InputNumber, Select, Slider, SpaceAddon, SpaceCompact, Switch } from 'antdv-next'
import { computed } from 'vue'

import ProListItem from '@/components/pro-list-item/index.vue'
import ProList from '@/components/pro-list/index.vue'
import { returnMainWindowToScreen } from '@/composables/useWindowState'
import { useCatStore } from '@/stores/cat'
import { useModelStore } from '@/stores/model'
import { isWindows } from '@/utils/platform'

const catStore = useCatStore()
const modelStore = useModelStore()

async function handleReturnToScreen() {
  await returnMainWindowToScreen()
}

const typingBehaviorGroupOptions = computed(() => {
  if (!modelStore.currentModel) {
    return [{
      label: 'default',
      value: 'default',
    }]
  }

  const groups = modelStore.behaviorGroups[modelStore.currentModel.id] ?? []

  return (groups.length ? groups : [{ id: 'default', name: 'default' }]).map(group => ({
    label: group.name || group.id,
    value: group.id,
  }))
})
</script>

<template>
  <ProList :title="$t('pages.preference.cat.labels.modelSettings')">
    <ProListItem
      :description="$t('pages.preference.cat.hints.mirrorMode')"
      :title="$t('pages.preference.cat.labels.mirrorMode')"
    >
      <Switch v-model:checked="catStore.model.mirror" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.cat.hints.mouseMirror')"
      :title="$t('pages.preference.cat.labels.mouseMirror')"
    >
      <Switch v-model:checked="catStore.model.mouseMirror" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.cat.hints.ignoreMouse')"
      :title="$t('pages.preference.cat.labels.ignoreMouse')"
    >
      <Switch v-model:checked="catStore.model.ignoreMouse" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.cat.hints.motionSound')"
      :title="$t('pages.preference.cat.labels.motionSound')"
    >
      <Switch v-model:checked="catStore.model.motionSound" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.cat.hints.behavior')"
      :title="$t('pages.preference.cat.labels.behavior')"
    >
      <Switch v-model:checked="catStore.model.behavior" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.cat.hints.typingExpression')"
      :title="$t('pages.preference.cat.labels.typingExpression')"
    >
      <Flex align="center">
        <Switch v-model:checked="catStore.model.typingExpression" />

        <Flex
          align="center"
          class="overflow-hidden transition-all"
          :class="[catStore.model.typingExpression ? 'w-100 opacity-100' : 'w-0 opacity-0']"
        >
          <Divider type="vertical" />

          <SpaceCompact class="mr-2">
            <InputNumber
              v-model:value="catStore.model.typingExpressionMinDelay"
              class="w-18"
              :max="catStore.model.typingExpressionMaxDelay"
              :min="0"
              :step="0.1"
            />

            <SpaceAddon>-</SpaceAddon>

            <InputNumber
              v-model:value="catStore.model.typingExpressionMaxDelay"
              class="w-18"
              :min="catStore.model.typingExpressionMinDelay"
              :step="0.1"
            />

            <SpaceAddon>s</SpaceAddon>
          </SpaceCompact>

          <Select
            v-model:value="catStore.model.typingBehaviorGroup"
            class="w-34"
            :options="typingBehaviorGroupOptions"
            :placeholder="$t('pages.preference.cat.labels.typingBehaviorGroup')"
          />
        </Flex>
      </Flex>
    </ProListItem>

    <ProListItem
      v-if="isWindows"
      :description="$t('pages.preference.cat.hints.autoReleaseDelay')"
      :title="$t('pages.preference.cat.labels.autoReleaseDelay')"
    >
      <SpaceCompact>
        <InputNumber
          v-model:value="catStore.model.autoReleaseDelay"
          class="w-20"
        />

        <SpaceAddon>s</SpaceAddon>
      </SpaceCompact>
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.cat.hints.maxFPS')"
      :title="$t('pages.preference.cat.labels.maxFPS')"
    >
      <InputNumber
        v-model:value="catStore.model.maxFPS"
        class="w-20"
        :min="0"
      />
    </ProListItem>
  </ProList>

  <ProList :title="$t('pages.preference.cat.labels.windowSettings')">
    <ProListItem
      :description="$t('pages.preference.cat.hints.passThrough')"
      :title="$t('pages.preference.cat.labels.passThrough')"
    >
      <Switch v-model:checked="catStore.window.passThrough" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.cat.hints.alwaysOnTop')"
      :title="$t('pages.preference.cat.labels.alwaysOnTop')"
    >
      <Switch v-model:checked="catStore.window.alwaysOnTop" />
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.cat.hints.hideOnHover')"
      :title="$t('pages.preference.cat.labels.hideOnHover')"
    >
      <Flex align="center">
        <Switch v-model:checked="catStore.window.hideOnHover" />

        <Flex
          align="center"
          class="overflow-hidden transition-all"
          :class="[catStore.window.hideOnHover ? 'w-28 opacity-100' : 'w-0 opacity-0']"
        >
          <Divider type="vertical" />

          <SpaceCompact>
            <InputNumber
              v-model:value="catStore.window.hideOnHoverDelay"
              class="w-16"
              :min="0"
            />

            <SpaceAddon>s</SpaceAddon>
          </SpaceCompact>
        </Flex>
      </Flex>
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.cat.hints.returnToScreen')"
      :title="$t('pages.preference.cat.labels.returnToScreen')"
    >
      <Button @click="handleReturnToScreen">
        {{ $t('pages.preference.cat.labels.returnToScreen') }}
      </Button>
    </ProListItem>

    <ProListItem
      :description="$t('pages.preference.cat.hints.windowSize')"
      :title="$t('pages.preference.cat.labels.windowSize')"
      vertical
    >
      <Flex
        align="center"
        class="gap-4"
      >
        <Slider
          v-model:value="catStore.window.scale"
          class="flex-1 m-0!"
          :max="500"
          :min="10"
          :tooltip="{
            formatter(value) {
              return `${value}%`
            },
          }"
        />

        <SpaceCompact>
          <InputNumber
            v-model:value="catStore.window.scale"
            class="w-24"
            :max="500"
            :min="10"
          />

          <SpaceAddon>%</SpaceAddon>
        </SpaceCompact>
      </Flex>
    </ProListItem>

    <ProListItem :title="$t('pages.preference.cat.labels.windowRadius')">
      <SpaceCompact>
        <InputNumber
          v-model:value="catStore.window.radius"
          class="w-20"
          :min="0"
        />

        <SpaceAddon>%</SpaceAddon>
      </SpaceCompact>
    </ProListItem>

    <ProListItem
      :title="$t('pages.preference.cat.labels.opacity')"
      vertical
    >
      <Slider
        v-model:value="catStore.window.opacity"
        class="m-0!"
        :max="100"
        :min="10"
        :tooltip="{
          formatter(value) {
            return `${value}%`
          },
        }"
      />
    </ProListItem>
  </ProList>
</template>
