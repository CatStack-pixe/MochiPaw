import type { PhysicalPosition } from '@tauri-apps/api/dpi'

import { LogicalSize } from '@tauri-apps/api/dpi'
import { resolveResource, sep } from '@tauri-apps/api/path'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { message } from 'antdv-next'
import { isNil, round } from 'es-toolkit'
import { findKey, nth } from 'es-toolkit/compat'
import { ref } from 'vue'

import type { ModelBehaviorGroup, ModelBehaviorRef, ModelMotionInfo } from '@/stores/model'

import { useCatStore } from '@/stores/cat'
import { useModelStore } from '@/stores/model'
import { getCursorMonitor } from '@/utils/monitor'
import { isMac } from '@/utils/platform'

import live2d, { isLive2dLoadCancelledError } from '../utils/live2d'

const appWindow = getCurrentWebviewWindow()
const digitKeys = '1234567890'.split('') as readonly string[]
const letterKeys = 'QWERTYUIOPASDFGHJKLZXCVBNM'.split('') as readonly string[]

function waitForNextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

export interface ModelSize {
  width: number
  height: number
}

export function useModel() {
  const modelStore = useModelStore()
  const catStore = useCatStore()
  const modelSize = ref<ModelSize>()
  let typingExpressionTimer: ReturnType<typeof setTimeout> | undefined
  let nextTypingExpressionAt = 0
  let activeMotionBehaviorId: string | undefined
  let currentExpressionBehaviorId: string | undefined
  let activeMotionResetTimer: ReturnType<typeof setTimeout> | undefined

  function getBehaviorShortcut(index: number) {
    const primary = isMac ? 'Command' : 'Control'

    const modifierGroups = [
      [primary],
      [primary, 'Shift'],
      [primary, 'Alt'],
      [primary, 'Shift', 'Alt'],
    ]

    const tiers = [
      ...modifierGroups.map(modifiers => ({ modifiers, keys: digitKeys })),
      ...modifierGroups.map(modifiers => ({ modifiers, keys: letterKeys })),
    ]

    let nextIndex = index

    for (const tier of tiers) {
      if (nextIndex < tier.keys.length) {
        return [...tier.modifiers, tier.keys[nextIndex]].join('+')
      }

      nextIndex -= tier.keys.length
    }

    return ''
  }

  function getMotionShortcutId(modelId: string, groupName: string, index: number) {
    return `${modelId}:motion:${groupName}:${index}`
  }

  function getExpressionShortcutId(modelId: string, index: number) {
    return `${modelId}:expression:${index}`
  }

  function getBehaviorNameId(shortcutId: string) {
    return `${shortcutId}:name`
  }

  function ensureBehaviorName(id: string, label: string) {
    if (modelStore.behaviorNames[id]) return

    modelStore.behaviorNames[id] = label
  }

  function getBehaviorGroups(modelId: string) {
    modelStore.behaviorGroups[modelId] ??= [{
      id: 'default',
      name: 'default',
      items: [],
      rules: [],
    }]

    return modelStore.behaviorGroups[modelId]
  }

  function ensureDefaultBehaviorGroup(modelId: string, behaviorIds: string[]) {
    const groups = getBehaviorGroups(modelId)
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
  }

  function getBehaviorRef(id: string): ModelBehaviorRef | undefined {
    const [, type] = id.split(':')

    if (type !== 'motion' && type !== 'expression') return

    return {
      id,
      type,
    }
  }

  function getMotionById(id: string) {
    const parts = id.split(':')
    const groupName = parts[2]
    const index = Number(parts[3])

    if (!groupName || Number.isNaN(index)) return

    return modelStore.currentMotions
      .find(([currentGroupName]) => currentGroupName === groupName)?.[1][index]
  }

  function getExpressionIndexById(id: string) {
    const index = Number(id.split(':')[2])

    if (Number.isNaN(index) || !modelStore.currentExpressions[index]) return

    return index
  }

  async function handleLoad() {
    try {
      if (!modelStore.currentModel) return

      const { path } = modelStore.currentModel

      await resolveResource(path)

      const { width, height, motions, expressions } = await live2d.load(path)

      const nextMotions = Object.entries(motions)

      modelSize.value = { width, height }
      modelStore.currentMotions = nextMotions
      modelStore.currentExpressions = expressions

      await handleResize()

      const modelId = modelStore.currentModel.id

      const behaviorIds: string[] = []

      for (const [groupName, items] of nextMotions) {
        for (const [index, motion] of items.entries()) {
          const id = getMotionShortcutId(modelId, groupName, index)

          behaviorIds.push(id)
          ensureBehaviorName(getBehaviorNameId(id), motion.displayName ?? motion.name)
        }
      }

      for (const [index, expression] of expressions.entries()) {
        const id = getExpressionShortcutId(modelId, index)

        behaviorIds.push(id)
        ensureBehaviorName(
          getBehaviorNameId(id),
          expression.displayName ?? expression.name ?? `Expression ${index + 1}`,
        )
      }

      for (const [index, id] of behaviorIds.entries()) {
        if (modelStore.shortcuts[id]) continue

        const shortcut = getBehaviorShortcut(index)

        if (!shortcut) continue

        modelStore.shortcuts[id] = shortcut
      }

      ensureDefaultBehaviorGroup(modelId, behaviorIds)
    } catch (error) {
      if (isLive2dLoadCancelledError(error)) return

      message.error(String(error))
    }
  }

  function handleDestroy() {
    live2d.destroy()
  }

  async function handleResize(options: { syncScale?: boolean } = {}) {
    if (!modelSize.value) return

    const { width, height } = modelSize.value
    const expectedHeight = Math.ceil(innerWidth * (height / width))

    if (Math.abs(innerHeight - expectedHeight) > 1) {
      await appWindow.setSize(
        new LogicalSize({
          width: innerWidth,
          height: expectedHeight,
        }),
      )

      await waitForNextFrame()
    }

    live2d.resizeModel(modelSize.value)

    if (options.syncScale === false) return

    const size = await appWindow.size()

    catStore.window.scale = round((size.width / width) * 100)
  }

  const handlePress = (key: string, options: { triggerExpression?: boolean } = {}) => {
    if (options.triggerExpression) {
      handleTypingExpression()
    }

    const path = modelStore.supportKeys[key]

    if (!path) return

    const dirName = nth(path.split(sep()), -2)!
    const prevKey = findKey(modelStore.pressedKeys, (value) => {
      return value.includes(dirName)
    })

    if (prevKey) {
      handleRelease(prevKey)
    }

    modelStore.pressedKeys[key] = path
  }

  const handleRelease = (key: string) => {
    delete modelStore.pressedKeys[key]
  }

  function handleKeyChange(isLeft = true, pressed = true) {
    const id = isLeft ? 'CatParamLeftHandDown' : 'CatParamRightHandDown'

    live2d.setParameterValue(id, pressed)
  }

  function handleMouseChange(key: string, pressed = true) {
    const id = key === 'Left' ? 'ParamMouseLeftDown' : 'ParamMouseRightDown'

    live2d.setParameterValue(id, pressed)
  }

  function handleTypingExpression() {
    if (!catStore.model.behavior || !catStore.model.typingExpression || !modelStore.currentModel) {
      return
    }

    const now = Date.now()

    if (now < nextTypingExpressionAt) return

    const behavior = getRandomTypingBehavior()

    if (!behavior) return

    playBehavior(behavior)

    const delay = getTypingExpressionDelay()
    nextTypingExpressionAt = now + delay

    if (typingExpressionTimer) {
      clearTimeout(typingExpressionTimer)
    }

    typingExpressionTimer = setTimeout(() => {
      resetExpression()
    }, Math.max(600, delay * 0.6))
  }

  function getRandomTypingBehavior() {
    if (!modelStore.currentModel) return

    const groups = getBehaviorGroups(modelStore.currentModel.id)
    const selectedGroup = groups.find(group => group.id === catStore.model.typingBehaviorGroup)
      ?? groups.find(group => group.id === 'default')
    const refs = selectedGroup?.items
      .map(getBehaviorRef)
      .filter(item => item && isTypingBehaviorAvailable(item)) ?? []

    if (!refs.length) return

    return refs[Math.floor(Math.random() * refs.length)]
  }

  function isTypingBehaviorAvailable(behavior: ModelBehaviorRef) {
    if (behavior.type === 'motion') return Boolean(getMotionById(behavior.id))

    return getExpressionIndexById(behavior.id) !== undefined
  }

  function playMotionBehavior(id: string, motion: ModelMotionInfo, groupId?: string) {
    const behavior = getBehaviorRef(id)

    if (!behavior) {
      live2d.startMotion(motion)
      return
    }

    playBehavior(behavior, motion, groupId)
  }

  function playExpressionBehavior(id: string, index: number, groupId?: string) {
    const behavior = getBehaviorRef(id)

    if (!behavior) {
      live2d.setExpression(index)
      return
    }

    playBehavior(behavior, undefined, groupId)
  }

  function playBehavior(behavior: ModelBehaviorRef, motionOverride?: ModelMotionInfo, groupId?: string) {
    const group = getBehaviorRuleGroup(behavior.id, groupId)

    if (isBehaviorBlockedByRules(behavior.id, group)) return

    applyBehaviorRuleResets(behavior.id, group)

    if (behavior.type === 'motion') {
      const motion = motionOverride ?? getMotionById(behavior.id)

      if (!motion) return

      activeMotionBehaviorId = behavior.id

      if (activeMotionResetTimer) {
        clearTimeout(activeMotionResetTimer)
      }

      activeMotionResetTimer = setTimeout(() => {
        if (activeMotionBehaviorId === behavior.id) {
          activeMotionBehaviorId = undefined
        }
      }, 2000)

      const result = live2d.startMotion(motion as ModelMotionInfo) as unknown

      if (isPromiseLike(result)) {
        void result.finally(() => {
          if (activeMotionResetTimer) {
            clearTimeout(activeMotionResetTimer)
            activeMotionResetTimer = undefined
          }

          if (activeMotionBehaviorId === behavior.id) {
            activeMotionBehaviorId = undefined
          }
        })
      }

      return
    }

    const index = getExpressionIndexById(behavior.id)

    if (index === undefined) return

    currentExpressionBehaviorId = behavior.id
    live2d.setExpression(index)
  }

  function getBehaviorRuleGroup(behaviorId: string, groupId?: string): ModelBehaviorGroup | undefined {
    if (!modelStore.currentModel) return

    const groups = getBehaviorGroups(modelStore.currentModel.id)

    if (groupId) {
      const group = groups.find(group => group.id === groupId)

      if (group?.items.includes(behaviorId)) return group
    }

    const selectedGroup = groups.find(group => group.id === catStore.model.typingBehaviorGroup)

    if (selectedGroup?.items.includes(behaviorId)) return selectedGroup

    return groups.find(group => group.items.includes(behaviorId))
      ?? groups.find(group => group.id === 'default')
  }

  function getExclusiveBehaviorIds(behaviorId: string, group: ModelBehaviorGroup | undefined) {
    return group?.rules
      ?.filter(rule => rule.items.includes(behaviorId))
      .flatMap(rule => rule.items)
      .filter(id => id !== behaviorId) ?? []
  }

  function isBehaviorBlockedByRules(behaviorId: string, group: ModelBehaviorGroup | undefined) {
    const exclusiveIds = getExclusiveBehaviorIds(behaviorId, group)

    return Boolean(activeMotionBehaviorId && exclusiveIds.includes(activeMotionBehaviorId))
  }

  function applyBehaviorRuleResets(behaviorId: string, group: ModelBehaviorGroup | undefined) {
    const exclusiveIds = getExclusiveBehaviorIds(behaviorId, group)

    if (!currentExpressionBehaviorId || !exclusiveIds.includes(currentExpressionBehaviorId)) return

    resetExpression()
  }

  function resetExpression() {
    currentExpressionBehaviorId = undefined
    live2d.setExpression(0)
  }

  function isPromiseLike(value: unknown): value is Promise<unknown> {
    return Boolean(value && typeof (value as Promise<unknown>).finally === 'function')
  }

  function getTypingExpressionDelay() {
    const min = Math.max(0, catStore.model.typingExpressionMinDelay)
    const max = Math.max(min, catStore.model.typingExpressionMaxDelay)

    return (min + Math.random() * (max - min)) * 1000
  }

  async function handleMouseMove(cursorPoint: PhysicalPosition) {
    const monitor = await getCursorMonitor(cursorPoint)

    if (!monitor) return

    const { size, position } = monitor

    const xRatio = (cursorPoint.x - position.x) / size.width
    const yRatio = (cursorPoint.y - position.y) / size.height

    for (const id of [
      'ParamMouseX',
      'ParamMouseY',
      'ParamAngleX',
      'ParamAngleY',
      'ParamAngleZ',
      'ParamEyeBallX',
      'ParamEyeBallY',
    ]) {
      const range = live2d.getParameterValueRange(id)

      if (!range) continue

      const { min, max } = range

      if (isNil(min) || isNil(max)) continue

      const isXAxis = id.endsWith('X')
      const isYAxis = id.endsWith('Y')
      const isZAxis = id.endsWith('Z')

      let value: number

      if (isZAxis) {
        const dragX = 1 - 2 * xRatio
        const dragY = 1 - 2 * yRatio

        value = dragX * dragY * min
      } else {
        const ratio = isXAxis ? xRatio : yRatio

        value = max - ratio * (max - min)
      }

      if (!isYAxis && catStore.model.mouseMirror) {
        value *= -1
      }

      live2d.setParameterValue(id, value)
    }
  }

  async function handleAxisChange(id: string, value: number) {
    const range = live2d.getParameterValueRange(id)

    if (!range) return

    const { min, max } = range

    live2d.setParameterValue(id, Math.max(min, value * max))
  }

  return {
    modelSize,
    handlePress,
    handleRelease,
    handleLoad,
    handleDestroy,
    handleResize,
    handleKeyChange,
    handleMouseChange,
    handleMouseMove,
    handleAxisChange,
    playMotionBehavior,
    playExpressionBehavior,
  }
}
