import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { captureFlow } from '../src/capture.mjs'

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
    // The page stub supplies a JPEG header for geometry; no video decoding is involved.
    const data = Buffer.from('ffd8ffc00011080018002003012200021101031101ffd9', 'hex')
    const page = {
      context: () => ({ browser: () => undefined }),
      evaluate: async () => [32, 24, 1, 0, 0], mouse: { move: async () => {} },
      screenshot: async () => Buffer.from('synthetic screenshot'),
      screencast: {
        async start({ onFrame }) { await onFrame({ data, timestamp: Date.now(), viewportWidth: 32, viewportHeight: 24 }) },
        async stop() { stops++ },
      },
    }
    try {
      await assert.rejects(captureFlow({ directory, page, signal: controller.signal,
        config: { video: { width: 32, height: 24, fps: 60 }, viewport: { width: 32, height: 24 }, captureQuality: 95, flowTimeout: 1, postRoll: 0, runDirectory: directory },
        flow: { initialPointer: { x: 0, y: 0 }, async run() {
          if (scenario === 'flow fails') throw primary
          if (scenario === 'caller cancels') { controller.abort(primary); await new Promise(() => {}) }
        } },
      }), error => {
        if (scenario === 'caller cancels') assert.equal(error, primary)
        else if (scenario === 'flow fails') { assert.equal(error.code, 'FLOW_FAILED'); assert.equal(error.cause, primary) }
        else { assert.equal(error.code, 'CAPTURE_FAILED'); assert.equal(error.cause, disk) }
        assert.equal(error.diagnostics?.capturePath, undefined)
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

test('caller cancellation interrupts graphics inspection without changing the caller browser', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const started = Promise.withResolvers(), response = Promise.withResolvers()
  const controller = new AbortController(), reason = new Error('stop caller graphics check')
  const session = { send: () => { started.resolve(); return response.promise }, detach: t.mock.fn(async () => {}) }
  const browser = { newBrowserCDPSession: async () => session, close: t.mock.fn() }
  const page = {
    context: () => ({ browser: () => browser }),
    evaluate: async () => [32, 24, 1, 0, 0],
    mouse: { move: t.mock.fn() }, screencast: { start: t.mock.fn() },
  }
  const flow = { initialPointer: { x: 0, y: 0 }, run: t.mock.fn() }
  let failure
  const pending = captureFlow({ directory: tmpdir(), page, signal: controller.signal,
    config: { viewport: { width: 32, height: 24 } }, flow,
  }).catch(error => { failure = error })
  await started.promise
  controller.abort(reason)
  await nextTurn()
  try {
    assert.equal(failure, reason)
    assert.equal(browser.close.mock.callCount(), 0)
    assert.equal(session.detach.mock.callCount(), 1)
    assert.equal(page.mouse.move.mock.callCount(), 0)
    assert.equal(page.screencast.start.mock.callCount(), 0)
    assert.equal(flow.run.mock.callCount(), 0)
  } finally {
    response.resolve({ gpu: {} })
    t.mock.timers.tick(5000)
    await pending
  }
})
