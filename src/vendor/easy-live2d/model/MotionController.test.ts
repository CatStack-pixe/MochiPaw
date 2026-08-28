import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Project tests use the Node test runner through tsx.
import test from 'node:test'

import type { ICubismModelSetting } from '@Framework/icubismmodelsetting'

import { Priority, Config } from '../utils/config'
import { MotionController } from './MotionController'

function createSetting(soundFile = 'voice.wav') {
  return {
    getMotionFileName: () => 'motion.motion3.json',
    getMotionSoundFileName: () => soundFile,
  } as unknown as ICubismModelSetting
}

function createMotion() {
  return {
    setEffectIds: () => {},
    setBeganMotionHandler: () => {},
    setFinishedMotionHandler: () => {},
  }
}

function createController(playVoice: (path: string, immediate: boolean) => Promise<void>) {
  const started: unknown[] = []
  const manager = {
    reserveMotion: () => true,
    setReservePriority: () => {},
    startMotionPriority: (motion: unknown) => {
      started.push(motion)
      return 1
    },
  }
  const vector = { toArray: () => [] }
  const controller = new MotionController(
    manager as never,
    vector as never,
    vector as never,
    () => createMotion() as never,
    playVoice,
  )

  return { controller, started }
}

test('plays the Sound entry using a redirected URL when a motion starts', async () => {
  const played: Array<{ path: string, immediate: boolean }> = []
  const { controller, started } = createController(async (path, immediate) => {
    played.push({ path, immediate })
  })

  controller.setContext(createSetting(), 'file:///models/', {
    Moc: '',
    Textures: [],
    Physics: '',
    Pose: '',
    Expressions: [],
    Motions: {},
    MotionSounds: { CAT: ['file:///redirected/voice.wav'] },
    UserData: '',
  })
  controller.loadMotionData('CAT', 0, new ArrayBuffer(0), createSetting())

  const previous = Config.MotionSound
  Config.MotionSound = true
  try {
    await controller.startMotion('CAT', 0, Priority.Normal)
  } finally {
    Config.MotionSound = previous
  }

  assert.equal(started.length, 1)
  assert.deepEqual(played, [{ path: 'file:///redirected/voice.wav', immediate: true }])
})

test('does not play motion audio when the feature is disabled or Sound is absent', async () => {
  const played: string[] = []
  const { controller } = createController(async path => {
    played.push(path)
  })
  const setting = createSetting('')
  controller.setContext(setting, 'file:///models/', {
    Moc: '',
    Textures: [],
    Physics: '',
    Pose: '',
    Expressions: [],
    Motions: {},
    MotionSounds: {},
    UserData: '',
  })
  controller.loadMotionData('CAT', 0, new ArrayBuffer(0), setting)

  const previous = Config.MotionSound
  try {
    Config.MotionSound = false
    await controller.startMotion('CAT', 0, Priority.Normal)
    Config.MotionSound = true
    await controller.startMotion('CAT', 0, Priority.Normal)
  } finally {
    Config.MotionSound = previous
  }

  assert.deepEqual(played, [])
})
