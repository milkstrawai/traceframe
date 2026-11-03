import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

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

test('native capture is explicit and requires a Traceframe-owned Linux browser', () => {
  assert.equal(createConfig(base).capture, 'playwright')
  assert.equal(createConfig({ ...base, capture: 'playwright' }).capture, 'playwright')
  assert.throws(() => createConfig({ ...base, capture: 'auto' }), /Capture must be playwright or native/)
  if (process.platform === 'linux') {
    assert.equal(createConfig({ ...base, capture: 'native' }).capture, 'native')
    assert.throws(() => createConfig({ ...base, capture: 'native', viewportWidth: 2 }), /at least 8/)
  } else {
    assert.throws(() => createConfig({ ...base, capture: 'native' }), /only on Linux/)
  }
})

test('sizes the video as the viewport times the scale', () => {
  const config = createConfig({ ...base, preset: 'draft', scale: 2 })
  assert.deepEqual(config.video, { width: 2560, height: 1600, fps: 30 })
})

test('native launch and diagnostics settings are explicit and native-only', () => {
  for (const options of [{ nativeGpu: 'auto' }, { nativeDiagnostics: true }]) {
    assert.throws(() => createConfig({ ...base, ...options }), /require native capture/)
    assert.throws(() => createPageConfig({ page, ...options }), /does not accept/)
  }
  if (process.platform !== 'linux') return
  const native = { ...base, capture: 'native' }
  assert.equal(createConfig(native).nativeGpu, 'auto')
  assert.equal(createConfig({ ...native, nativeGpu: 'disabled' }).nativeGpu, 'disabled')
  assert.equal(createConfig(native).nativeDiagnostics, false)
  assert.equal(createConfig({ ...native, nativeGpu: 'auto', nativeDiagnostics: true }).nativeDiagnostics, true)
  assert.throws(() => createConfig({ ...native, nativeGpu: 'hardware' }), /auto or disabled/)
  assert.throws(() => createConfig({ ...native, nativeDiagnostics: 'true' }), /must be a boolean/)
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
  assert.deepEqual(createPageConfig({ page, capture: 'playwright' }).video, config.video)
  assert.throws(() => createPageConfig({ page, capture: 'native' }), /requires a browser launched by record or the CLI/)
})

test('existing-page settings reject implicit browser setup and unfixed viewports', () => {
  assert.throws(() => createPageConfig(), { code: 'INVALID_CONFIG' })
  assert.throws(() => createPageConfig({ page: { ...page, viewportSize: () => null } }), /fixed viewport/)
  assert.throws(() => createPageConfig({ page: { ...page, isClosed: () => true } }), /closed/)
  for (const key of ['url', 'browser', 'storageState', 'readyTimeout', 'viewportWidth', 'viewportHeight', 'preset']) {
    assert.throws(() => createPageConfig({ page, [key]: 'unused' }), { code: 'INVALID_CONFIG', message: new RegExp(`does not accept ${key}`) })
  }
})

test('both recording paths normalize external audio with an explicit offset', () => {
  for (const configure of [(options) => createConfig({ ...base, ...options }), (options) => createPageConfig({ page, ...options })]) {
    assert.deepEqual(configure({ audio: { path: 'sound.wav' } }).audio, { path: resolve('sound.wav'), offset: 0 })
    assert.deepEqual(configure({ audio: { path: 'sound.wav', offset: -0.125 } }).audio, { path: resolve('sound.wav'), offset: -0.125 })
    const audio = () => ({ path: 'sound.wav' })
    assert.equal(configure({ audio }).audio, audio)
    for (const invalid of [null, true, 'sound.wav', {}, { path: '' }, { path: 4 }, { path: 'sound.wav', offset: '1' }, { path: 'sound.wav', offset: NaN }, { path: 'sound.wav', offset: Infinity }]) {
      assert.throws(() => configure({ audio: invalid }), { code: 'INVALID_CONFIG' })
    }
    assert.throws(() => configure({ output: 'same.mp4', audio: { path: 'same.mp4' } }), /different paths/)
    for (const name of ['capture.webm', 'capture.mkv', 'render.filter', 'failure.png']) {
      assert.throws(() => configure({ runDirectory: 'take', audio: { path: `take/${name}` } }), /reserved recording file/)
    }
  }
})
