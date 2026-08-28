import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- Project tests use the Node test runner through tsx.
import test from 'node:test'

import { CubismSetting } from './cubismSetting'

test('parses model resources used by 5.2 and 5.3 model3.json files', () => {
  const setting = new CubismSetting({
    modelJSON: {
      Version: 3,
      FileReferences: {
        Moc: 'model.moc3',
        Textures: ['texture.png'],
        Physics: 'model.physics3.json',
        Pose: 'model.pose3.json',
        UserData: 'model.userdata3.json',
        Expressions: [{ Name: 'Happy', File: 'happy.exp3.json' }],
        Motions: {
          Idle: [{ File: 'idle.motion3.json', Sound: 'idle.wav' }],
        },
      },
    },
  })

  assert.equal(setting.getModelFileName(), 'model.moc3')
  assert.equal(setting.getTextureFileName(0), 'texture.png')
  assert.equal(setting.getPhysicsFileName(), 'model.physics3.json')
  assert.equal(setting.getExpressionName(0), 'Happy')
  assert.equal(setting.getExpressionFileName(0), 'happy.exp3.json')
  assert.equal(setting.getMotionGroupName(0), 'Idle')
  assert.equal(setting.getMotionFileName('Idle', 0), 'idle.motion3.json')
  assert.equal(setting.getMotionSoundFileName('Idle', 0), 'idle.wav')
  assert.equal(setting.getPoseFileName(), 'model.pose3.json')
  assert.equal(setting.getUserDataFile(), 'model.userdata3.json')
})

test('treats optional model resources as absent without breaking path redirection', () => {
  const setting = new CubismSetting({
    modelJSON: {
      Version: 3,
      FileReferences: {
        Moc: 'model.moc3',
        Textures: ['texture.png'],
        Motions: {
          Idle: [{ File: 'idle.motion3.json' }],
        },
      },
    },
  })

  assert.equal(setting.getPhysicsFileName(), '')
  assert.equal(setting.getPoseFileName(), '')
  assert.equal(setting.getUserDataFile(), '')
  assert.equal(setting.getHitAreasCount(), 0)
  assert.doesNotThrow(() => setting.redirectPath(({ file }) => `/models/${file}`))
})

test('redirects motion sounds alongside motion files without inventing missing sounds', () => {
  const setting = new CubismSetting({
    modelJSON: {
      Version: 3,
      FileReferences: {
        Moc: 'model.moc3',
        Textures: [],
        Motions: {
          CAT: [
            { File: 'wave.motion3.json', Sound: 'wave.flac' },
            { File: 'idle.motion3.json' },
          ],
        },
      },
    },
  })

  setting.redirectPath(({ file }) => `/models/${file}`)

  assert.deepEqual(setting.redirPath.Motions, {
    CAT: ['/models/wave.motion3.json', '/models/idle.motion3.json'],
  })
  assert.deepEqual(setting.redirPath.MotionSounds, {
    CAT: ['/models/wave.flac'],
  })
})
