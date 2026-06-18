<script setup lang="ts">
import { emit } from '@tauri-apps/api/event'
import { Button, Empty, Input, Modal, Select } from 'antdv-next'
import { groupBy, isEmpty } from 'es-toolkit/compat'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import type { ModelBehaviorGroup, ModelBehaviorRule, ModelExpressionInfo, ModelMotionInfo } from '@/stores/model'

import { LISTEN_KEY } from '@/constants'
import { useModelStore } from '@/stores/model'
import { resolveModelExpressions, resolveModelMotions } from '@/utils/live2d'

import BehaviorItem from './components/behavior-item/index.vue'

const modelValue = defineModel<boolean>()
const modelStore = useModelStore()
const { t } = useI18n()
const currentGroupId = ref('default')

function getMotionShortcutId(groupName: string, index: number) {
  return `${modelStore.currentModel?.id}:motion:${groupName}:${index}`
}

function getExpressionShortcutId(index: number) {
  return `${modelStore.currentModel?.id}:expression:${index}`
}

function getMotionNameId(groupName: string, index: number) {
  return `${getMotionShortcutId(groupName, index)}:name`
}

function getExpressionNameId(index: number) {
  return `${getExpressionShortcutId(index)}:name`
}

function startMotion(id: string, motion: ModelMotionInfo) {
  emit(LISTEN_KEY.START_MOTION, {
    groupId: currentGroup.value?.id,
    id,
    motion,
  })
}

function setExpression(id: string, expression: ModelExpressionInfo, index: number) {
  emit(LISTEN_KEY.SET_EXPRESSION, {
    id,
    expression,
    groupId: currentGroup.value?.id,
    index,
  })
}

function getMotionDefaultLabel(motion: ModelMotionInfo, index: number) {
  return motion.displayName
    ?? motion.name
    ?? t('pages.preference.model.behaviorModal.labels.motionIndex', { index: index + 1 })
}

function getExpressionLabel(index: number) {
  return modelStore.currentExpressions[index]?.displayName
    ?? modelStore.currentExpressions[index]?.name
    ?? t('pages.preference.model.behaviorModal.labels.expressionIndex', { index: index + 1 })
}

function ensureBehaviorName(id: string, label: string) {
  if (modelStore.behaviorNames[id]) return

  modelStore.behaviorNames[id] = label
}

function ensureBehaviorNames() {
  for (const [groupName, motions] of modelStore.currentMotions) {
    for (const [index, motion] of motions.entries()) {
      ensureBehaviorName(getMotionNameId(groupName, index), getMotionDefaultLabel(motion, index))
    }
  }

  for (const [index] of modelStore.currentExpressions.entries()) {
    ensureBehaviorName(getExpressionNameId(index), getExpressionLabel(index))
  }
}

const currentModelGroups = computed(() => {
  if (!modelStore.currentModel) return []

  return ensureBehaviorGroups(modelStore.currentModel.id, getAllBehaviorIds())
})

const currentGroup = computed(() => {
  return currentModelGroups.value.find(group => group.id === currentGroupId.value)
    ?? currentModelGroups.value[0]
})

function ensureBehaviorGroups(modelId: string, behaviorIds: string[]) {
  modelStore.behaviorGroups[modelId] ??= []

  const groups = modelStore.behaviorGroups[modelId]
  let defaultGroup = groups.find(group => group.id === 'default')

  if (!defaultGroup) {
    defaultGroup = {
      id: 'default',
      name: 'default',
      items: [],
      rules: [],
    }
    groups.unshift(defaultGroup)
  }

  defaultGroup.rules ??= []

  const existing = new Set(defaultGroup.items)

  for (const id of behaviorIds) {
    if (existing.has(id)) continue

    defaultGroup.items.push(id)
    existing.add(id)
  }

  if (!groups.some(group => group.id === currentGroupId.value)) {
    currentGroupId.value = 'default'
  }

  return groups
}

function getAllBehaviorIds() {
  const motionIds = modelStore.currentMotions.flatMap(([groupName, motions]) => {
    return motions.map((_, index) => getMotionShortcutId(groupName, index))
  })
  const expressionIds = modelStore.currentExpressions.map((_, index) => getExpressionShortcutId(index))

  return [...motionIds, ...expressionIds]
}

function addBehaviorGroup() {
  if (!modelStore.currentModel) return

  const groups = ensureBehaviorGroups(modelStore.currentModel.id, getAllBehaviorIds())
  const index = groups.length + 1
  const group: ModelBehaviorGroup = {
    id: `group-${Date.now()}`,
    name: `Group ${index}`,
    items: [],
    rules: [],
  }

  groups.push(group)
  currentGroupId.value = group.id
}

const behaviorOptions = computed(() => {
  return getAllBehaviorIds().map(id => ({
    label: modelStore.behaviorNames[`${id}:name`] ?? id,
    value: id,
  }))
})

const currentGroupRules = computed(() => {
  const group = currentGroup.value

  if (!group) return []

  group.rules ??= []

  return group.rules
})

function addBehaviorRule() {
  const group = currentGroup.value

  if (!group) return

  group.rules ??= []

  const index = group.rules.length + 1

  group.rules.push({
    id: `rule-${Date.now()}`,
    name: t('pages.preference.model.behaviorModal.labels.ruleIndex', { index }),
    items: [],
  })
}

function removeBehaviorRule(rule: ModelBehaviorRule) {
  const group = currentGroup.value

  if (!group?.rules) return

  group.rules = group.rules.filter(item => item.id !== rule.id)
}

function isBehaviorChecked(id: string) {
  return Boolean(currentGroup.value?.items.includes(id))
}

function setBehaviorChecked(id: string, checked: boolean) {
  const group = currentGroup.value

  if (!group) return

  if (checked) {
    if (!group.items.includes(id)) {
      group.items.push(id)
    }

    return
  }

  group.items = group.items.filter(item => item !== id)
}

watch(modelValue, async (open) => {
  if (!open || !modelStore.currentModel) return

  const motions = await resolveModelMotions(
    modelStore.currentModel.path,
    modelStore.currentMotions.flatMap(([, motions]) => motions),
  )

  modelStore.currentMotions = Object.entries(groupBy(motions, 'group'))

  if (!isEmpty(modelStore.currentExpressions)) {
    modelStore.currentExpressions = await resolveModelExpressions(
      modelStore.currentModel.path,
      modelStore.currentExpressions,
    )
  }

  ensureBehaviorNames()

  if (modelStore.currentModel) {
    ensureBehaviorGroups(modelStore.currentModel.id, getAllBehaviorIds())
  }
})
</script>

<template>
  <Modal
    v-model:open="modelValue"
    :cancel-text="false"
    centered
    :footer="null"
    force-render
    :title="$t('pages.preference.model.behaviorModal.title')"
    width="980px"
  >
    <div class="max-h-[70vh] flex flex-col gap-5 overflow-auto pr-1">
      <section class="b-1 b-solid b-border rounded-lg">
        <div class="bg-fill-sec flex items-center justify-between gap-3 px-4 py-3">
          <span class="font-medium text-sm">
            {{ $t('pages.preference.model.behaviorModal.labels.randomGroups') }}
          </span>

          <Button
            class="inline-flex items-center justify-center"
            size="small"
            @click="addBehaviorGroup"
          >
            <template #icon>
              <div class="i-lucide:plus" />
            </template>
          </Button>
        </div>

        <div class="grid gap-2 px-4 py-3">
          <div
            v-for="group in currentModelGroups"
            :key="group.id"
            class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2"
          >
            <Button
              class="inline-flex items-center justify-center"
              size="small"
              @click="currentGroupId = group.id"
            >
              <template #icon>
                <div :class="currentGroupId === group.id ? 'i-lucide:check' : 'i-lucide:circle'" />
              </template>
            </Button>

            <Input
              v-model:value="group.name"
              size="small"
            />
          </div>
        </div>

        <div class="b-t b-t-solid px-4 py-3 b-border">
          <div class="mb-3 flex items-center justify-between gap-3">
            <span class="font-medium text-sm">
              {{ $t('pages.preference.model.behaviorModal.labels.mutualExclusionRules') }}
            </span>

            <Button
              class="inline-flex items-center justify-center"
              size="small"
              @click="addBehaviorRule"
            >
              <template #icon>
                <div class="i-lucide:plus" />
              </template>
            </Button>
          </div>

          <Empty
            v-if="isEmpty(currentGroupRules)"
            :image="Empty.PRESENTED_IMAGE_SIMPLE"
          />

          <div
            v-else
            class="grid gap-2"
          >
            <div
              v-for="rule in currentGroupRules"
              :key="rule.id"
              class="grid grid-cols-[minmax(0,160px)_minmax(0,1fr)_auto] items-center gap-2"
            >
              <Input
                v-model:value="rule.name"
                size="small"
              />

              <Select
                v-model:value="rule.items"
                mode="multiple"
                :options="behaviorOptions"
                size="small"
              />

              <Button
                class="inline-flex items-center justify-center"
                danger
                size="small"
                @click="removeBehaviorRule(rule)"
              >
                <template #icon>
                  <div class="i-lucide:trash-2" />
                </template>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <div class="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <section class="min-w-0 flex flex-col gap-3">
          <div class="font-medium text-sm">
            {{ $t('pages.preference.model.behaviorModal.labels.motion') }}
          </div>

          <Empty
            v-if="isEmpty(modelStore.currentMotions)"
            :image="Empty.PRESENTED_IMAGE_SIMPLE"
          />

          <template v-else>
            <div
              v-for="([groupName, motions], groupIndex) in modelStore.currentMotions"
              :key="groupName"
            >
              <div class="mb-2">
                {{ $t('pages.preference.model.behaviorModal.labels.motionGroupIndex', { index: groupIndex + 1 }) }}
              </div>

              <div class="b-1 b-solid b-border rounded-lg">
                <BehaviorItem
                  v-for="(item, index) in motions"
                  :key="item.no"
                  v-model:name="modelStore.behaviorNames[getMotionNameId(groupName, index)]"
                  v-model:shortcut="modelStore.shortcuts[getMotionShortcutId(groupName, index)]"
                  :checked="isBehaviorChecked(getMotionShortcutId(groupName, index))"
                  @click="startMotion(getMotionShortcutId(groupName, index), item)"
                  @update:checked="setBehaviorChecked(getMotionShortcutId(groupName, index), $event)"
                />
              </div>
            </div>
          </template>
        </section>

        <section class="min-w-0 flex flex-col gap-3">
          <div class="font-medium text-sm">
            {{ $t('pages.preference.model.behaviorModal.labels.expression') }}
          </div>

          <Empty
            v-if="isEmpty(modelStore.currentExpressions)"
            :image="Empty.PRESENTED_IMAGE_SIMPLE"
          />

          <template v-else>
            <div class="b-1 b-solid b-border rounded-lg">
              <BehaviorItem
                v-for="(expression, index) in modelStore.currentExpressions"
                :key="expression.name"
                v-model:name="modelStore.behaviorNames[getExpressionNameId(index)]"
                v-model:shortcut="modelStore.shortcuts[getExpressionShortcutId(index)]"
                :checked="isBehaviorChecked(getExpressionShortcutId(index))"
                @click="setExpression(getExpressionShortcutId(index), expression, index)"
                @update:checked="setBehaviorChecked(getExpressionShortcutId(index), $event)"
              />
            </div>
          </template>
        </section>
      </div>
    </div>
  </Modal>
</template>
