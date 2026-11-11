import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

import { captureFlow } from '../src/capture.mjs'

// JPEG headers only: the stub pages supply frame geometry, and no video decoding is involved.
const jpeg32x24 = Buffer.from('ffd8ffc00011080018002003012200021101031101ffd9', 'hex')
const jpeg16x12 = Buffer.from('ffd8ffc0001108000c001003012200021101031101ffd9', 'hex')
const config = { video: { width: 32, height: 24, fps: 60 }, viewport: { width: 32, height: 24 }, captureQuality: 85, flowTimeout: 5, postRoll: 0 }
const frame = (data = jpeg32x24, viewportWidth = 32, viewportHeight = 24) => ({ data, timestamp: Date.now(), viewportWidth, viewportHeight })

// A caller page whose screencast delivers one 32×24 frame when it starts.
function stubPage(screencast) {
  return {
    evaluate: async () => [32, 24, 1, 0, 0], mouse: { move: async () => {} },
    screenshot: async () => Buffer.from('synthetic screenshot'),
    screencast: { async start({ onFrame }) { await onFrame(frame()) }, async stop() {}, ...screencast },
  }
}

for (const scenario of ['flow fails', 'caller cancels', 'writer fails']) {
  test(`${scenario}: a capture finalization failure preserves the appropriate reason`, async (t) => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'traceframe-failure-'))
    const primary = new Error('original flow failure')
    const disk = Object.assign(new Error('no space left'), { code: 'ENOSPC' })
    const controller = new AbortController()
    const open = fs.open
    const mock = t.mock.method(fs, 'open', (path, flags, ...args) => {
      if (path === join(directory, 'capture.mkv') && flags === 'r+') throw disk
      return open(path, flags, ...args)
    })
    syncBuiltinESMExports()
    let stops = 0
    const page = stubPage({ async stop() { stops++ } })
    try {
      await assert.rejects(captureFlow({ directory, page, signal: controller.signal,
        config: { ...config, flowTimeout: 1, runDirectory: directory },
        flow: { initialPointer: { x: 0, y: 0 }, async run() {
          if (scenario === 'flow fails') throw primary
          if (scenario === 'caller cancels') { controller.abort(primary); await new Promise(() => {}) }
        } },
      }), error => {
        if (scenario === 'caller cancels') assert.equal(error, primary)
        else if (scenario === 'flow fails') { assert.equal(error.code, 'FLOW_FAILED'); assert.equal(error.cause, primary) }
        else { assert.equal(error.code, 'CAPTURE_FAILED'); assert.equal(error.cause, disk) }
        assert.equal(error.diagnostics?.capturePath, undefined)
        // Internal failures keep their screenshot; caller cancellation skips it.
        assert.equal(error.diagnostics?.screenshotPath, scenario === 'caller cancels' ? undefined : join(directory, 'failure.png'))
        return true
      })
      assert.equal(stops, 1)
    } finally {
      mock.mock.restore()
      syncBuiltinESMExports()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
}

test('a frame size change stops the recording at once instead of truncating the export', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'traceframe-resize-'))
  let onFrame
  const page = stubPage({ async start(options) { onFrame = options.onFrame; await onFrame(frame()) } })
  try {
    await assert.rejects(captureFlow({ directory, page, config,
      flow: { initialPointer: { x: 0, y: 0 }, async run({ wait }) {
        await onFrame({ ...frame(), timestamp: Date.now() + 16 })
        await onFrame({ ...frame(jpeg16x12, 16, 12), timestamp: Date.now() + 33 })
        await wait(5)
      } },
    }), {
      code: 'CAPTURE_SIZE_CHANGED',
      message: 'Screencast frames changed size during recording, from 32×24 for a 32×24 viewport to 16×12 for a 16×12 viewport. Keep the page geometry fixed while recording.',
    })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('30 FPS recordings keep the larger in-flight frame allowance', async () => {
  // Playwright 1.64 uses fps only to let Chromium have 10 frames in flight above 30, otherwise 5.
  const directory = await fs.mkdtemp(join(tmpdir(), 'traceframe-screencast-fps-'))
  let requested
  const page = stubPage({ async start(options) { requested = options.fps; await options.onFrame(frame()) } })
  try {
    await captureFlow({ directory, page, flow: { initialPointer: { x: 0, y: 0 }, async run() {} }, config: { ...config, video: { ...config.video, fps: 30 } } })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
  assert.equal(requested, 60)
})

for (const stage of ['launch', 'page creation']) {
  test(`cancellation during the browser ${stage} closes it before navigation`, async (t) => {
    const controller = new AbortController(), reason = new Error(`stop during ${stage}`), calls = []
    const browser = {
      async newPage() { calls.push('newPage'); controller.abort(reason); return { async goto() { calls.push('goto') } } },
      async close() { calls.push('close') },
    }
    t.mock.method(chromium, 'launch', async () => { if (stage === 'launch') controller.abort(reason); return browser })
    await assert.rejects(captureFlow({ directory: tmpdir(), signal: controller.signal, config: { gpu: 'off', video: { width: 32, height: 24 } }, flow: {} }), error => error === reason)
    assert.deepEqual(calls, stage === 'launch' ? ['close'] : ['newPage', 'close'])
  })
}
