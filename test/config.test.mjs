import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { createConfig } from '../src/config.mjs'

const base = {
  flow: fileURLToPath(new URL('../examples/fixture-flow.mjs', import.meta.url)),
  url: 'file:///tmp/fixture.html',
}

test('requires MP4 output paths', () => {
  assert.throws(() => createConfig({ ...base, output: 'recording.webm' }), /\.mp4 extension/)
})

test('returns a configuration error when called without options', () => {
  assert.throws(() => createConfig(), /A flow file is required/)
})

test('applies the draft preset', () => {
  const config = createConfig({ ...base, preset: 'draft' })
  assert.deepEqual([config.viewport, config.video, config.scale], [{ width: 1280, height: 800 }, { width: 1280, height: 800, fps: 30 }, 1])
})

test('sizes the video as the viewport times the scale', () => {
  const config = createConfig({ ...base, preset: 'draft', scale: 2 })
  assert.deepEqual(config.video, { width: 2560, height: 1600, fps: 30 })
})

test('rejects unsupported frame rates and negative post-roll lengths', () => {
  assert.throws(() => createConfig({ ...base, fps: 24 }), /FPS must be 30 or 60/)
  assert.throws(() => createConfig({ ...base, postRoll: -1 }), /Post-roll must be 0 or more seconds/)
})

test('rejects preset names that are not presets', () => {
  assert.throws(() => createConfig({ ...base, preset: 'constructor' }), /Unknown preset: constructor/)
})

test('accepts numbers only', () => {
  assert.throws(() => createConfig({ ...base, scale: '2' }), /Scale must be 1 or 2/)
  assert.throws(() => createConfig({ ...base, fps: '60' }), /FPS must be 30 or 60/)
})
