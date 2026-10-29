import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { createConfig, createPageConfig } from '../src/config.mjs'

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

test('rejects unsupported frame rates, negative post-roll lengths, and zero flow timeouts', () => {
  assert.throws(() => createConfig({ ...base, fps: 24 }), /FPS must be 30 or 60/)
  assert.throws(() => createConfig({ ...base, postRoll: -1 }), /Post-roll must be 0 or more seconds/)
  assert.throws(() => createConfig({ ...base, flowTimeout: 0 }), /Flow timeout must be more than 0 seconds/)
})

test('rejects preset names that are not presets', () => {
  assert.throws(() => createConfig({ ...base, preset: 'constructor' }), /Unknown preset: constructor/)
})

test('accepts numbers only', () => {
  assert.throws(() => createConfig({ ...base, scale: '2' }), /Scale must be 1 or 2/)
  assert.throws(() => createConfig({ ...base, fps: '60' }), /FPS must be 30 or 60/)
  assert.throws(() => createConfig({ ...base, flowTimeout: '300' }), /Flow timeout must be more than 0 seconds/)
})

const page = { viewportSize: () => ({ width: 640, height: 480 }), screencast: {}, isClosed: () => false }

test('existing-page settings use the caller viewport with explicit scale and fps', () => {
  const config = createPageConfig({ page })
  assert.deepEqual(config.video, { width: 640, height: 480, fps: 30 })
  assert.equal(config.flow, undefined)
  assert.equal(config.url, undefined)
  assert.deepEqual(createPageConfig({ page, scale: 2, fps: 60 }).video, { width: 1280, height: 960, fps: 60 })
})

test('existing-page settings reject implicit browser setup and unfixed viewports', () => {
  assert.throws(() => createPageConfig(), { code: 'INVALID_CONFIG' })
  assert.throws(() => createPageConfig({ page: { ...page, viewportSize: () => null } }), /fixed viewport/)
  assert.throws(() => createPageConfig({ page: { ...page, isClosed: () => true } }), /closed/)
  for (const key of ['url', 'browser', 'storageState', 'readyTimeout', 'viewportWidth', 'viewportHeight', 'preset']) {
    assert.throws(() => createPageConfig({ page, [key]: 'unused' }), { code: 'INVALID_CONFIG', message: new RegExp(`does not accept ${key}`) })
  }
})
