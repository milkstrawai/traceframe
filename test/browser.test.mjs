import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { chromium } from 'playwright'

import { launchBrowser, inspectGraphics } from '../src/browser.mjs'

const hardware = { featureStatus: { gpu_compositing: 'enabled', rasterization: 'enabled' }, auxAttributes: { glRenderer: 'ANGLE (Test GPU)' } }
const software = { featureStatus: { gpu_compositing: 'disabled_software', rasterization: 'disabled_software' }, auxAttributes: { glRenderer: 'ANGLE (SwiftShader Device)' } }
const config = { scale: 2, viewport: { width: 320, height: 240 }, storageState: 'test-storage.json', browser: 'test-chromium' }

function stub(gpu = hardware) {
  const calls = { closes: 0, detaches: 0, pages: [] }
  const page = {}
  const session = { async send(method) { assert.equal(method, 'SystemInfo.getInfo'); return { gpu } }, async detach() { calls.detaches++ } }
  const browser = {
    async newPage(options) { calls.pages.push(options); return page },
    async newBrowserCDPSession() { return session },
    async close() { calls.closes++ },
  }
  return { browser, session, page, calls }
}

test('default launch preserves browser defaults and reports actual graphics', async (t) => {
  const s = stub(software)
  const launch = t.mock.method(chromium, 'launch', async () => s.browser)
  const result = await launchBrowser(config, { handleSignals: false })
  assert.equal(result.page, s.page)
  assert.equal(result.graphics.requested, 'default')
  assert.equal(result.graphics.hardwareAccelerated, false)
  assert.equal(result.graphics.fallbackReason, undefined)
  assert.deepEqual(launch.mock.calls[0].arguments[0], {
    executablePath: config.browser, args: ['--force-device-scale-factor=2'],
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
  })
  assert.deepEqual(s.calls.pages, [{ viewport: config.viewport, deviceScaleFactor: 2, storageState: config.storageState }])
  assert.equal(s.calls.detaches, 1)
  assert.equal(s.calls.closes, 0)
})

test('off forces software and does not attempt a GPU launch', async (t) => {
  const s = stub(software)
  const launch = t.mock.method(chromium, 'launch', async () => s.browser)
  const result = await launchBrowser({ ...config, scale: 1, gpu: 'off' }, { handleSignals: true })
  assert.deepEqual(launch.mock.calls[0].arguments[0].args, ['--disable-gpu', '--disable-accelerated-video-decode'])
  assert.equal(launch.mock.callCount(), 1)
  assert.equal(result.graphics.requested, 'off')
})

test('auto chooses the platform backend and accepts verified hardware', async (t) => {
  const s = stub()
  const launch = t.mock.method(chromium, 'launch', async () => s.browser)
  const result = await launchBrowser({ ...config, gpu: 'auto' }, { handleSignals: true })
  const args = launch.mock.calls[0].arguments[0].args
  assert.ok(args.includes('--enable-gpu'))
  assert.ok(args.includes('--disable-accelerated-video-decode'))
  assert.equal(args.includes('--use-angle=gl-egl'), process.platform === 'linux')
  assert.equal(args.includes('--ozone-platform=headless'), process.platform === 'linux')
  assert.equal(result.graphics.hardwareAccelerated, true)
  assert.equal(result.graphics.requestedBackend, process.platform === 'linux' ? 'gl-egl' : 'default')
  assert.equal(launch.mock.callCount(), 1)
  assert.equal(s.calls.closes, 0)
})

test('an explicit backend overrides platform selection', async (t) => {
  const s = stub()
  const launch = t.mock.method(chromium, 'launch', async () => s.browser)
  for (const gpuBackend of ['default', 'gl-egl', 'metal']) {
    const result = await launchBrowser({ ...config, gpu: 'auto', gpuBackend }, { handleSignals: true })
    const args = launch.mock.calls.at(-1).arguments[0].args
    assert.deepEqual(args.filter(arg => arg.startsWith('--use-angle=')), gpuBackend === 'default' ? [] : [`--use-angle=${gpuBackend}`])
    assert.equal(result.graphics.requestedBackend, gpuBackend)
  }
})

test('macOS and Windows auto launches leave backend selection to Chromium', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  const launch = t.mock.method(chromium, 'launch', async () => stub().browser)
  try {
    for (const value of ['darwin', 'win32']) {
      Object.defineProperty(process, 'platform', { ...platform, value })
      const result = await launchBrowser({ ...config, gpu: 'auto' }, { handleSignals: true })
      const args = launch.mock.calls.at(-1).arguments[0].args
      assert.equal(result.graphics.requestedBackend, 'default')
      assert.deepEqual(args, ['--force-device-scale-factor=2', '--enable-gpu', '--disable-accelerated-video-decode'])
    }
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
})

for (const failure of ['software', 'unavailable', 'launch', 'page']) {
  test(`auto falls back once when GPU ${failure} fails, closing rejected browsers`, async (t) => {
    const first = stub(software), second = stub(software)
    if (failure === 'unavailable') first.session.send = async () => { throw new Error('Unsupported protocol') }
    if (failure === 'page') first.browser.newPage = async () => { throw new Error('GPU process crashed') }
    const launch = t.mock.method(chromium, 'launch', async () => {
      if (launch.mock.callCount() === 0) {
        if (failure === 'launch') throw new Error('GPU unavailable')
        return first.browser
      }
      assert.equal(first.calls.closes, failure === 'launch' ? 0 : 1)
      return second.browser
    })
    const result = await launchBrowser({ ...config, gpu: 'auto' }, { handleSignals: true })
    assert.equal(result.page, second.page)
    assert.equal(result.graphics.hardwareAccelerated, false)
    assert.equal(result.graphics.fallbackReason, failure === 'software' ? 'software-rendering' : failure === 'unavailable' ? 'graphics-check-unavailable' : 'gpu-launch-failed')
    assert.equal(launch.mock.callCount(), 2)
    assert.deepEqual(launch.mock.calls[1].arguments[0].args, ['--force-device-scale-factor=2', '--disable-gpu', '--disable-accelerated-video-decode'])
    assert.equal(second.calls.closes, 0)
  })
}

test('a failed software retry propagates its error with no further retries', async (t) => {
  const s = stub(software)
  const failure = new Error('software launch failed')
  const launch = t.mock.method(chromium, 'launch', async () => {
    if (launch.mock.callCount() === 0) return s.browser
    throw failure
  })
  await assert.rejects(launchBrowser({ ...config, gpu: 'auto' }, { handleSignals: true }), error => error === failure)
  assert.equal(launch.mock.callCount(), 2)
  assert.equal(s.calls.closes, 1)
})

test('missing executables retain the installation error and are not retried', async (t) => {
  const launch = t.mock.method(chromium, 'launch', async () => { throw new Error("Executable doesn't exist") })
  await assert.rejects(launchBrowser({ ...config, gpu: 'auto' }, { handleSignals: true }), { code: 'PLAYWRIGHT_RUNTIME_MISSING', message: /Configured browser executable/ })
  assert.equal(launch.mock.callCount(), 1)
})

test('cancellation during GPU setup closes the browser and never starts a fallback', async (t) => {
  const s = stub()
  const controller = new AbortController(), reason = new Error('stop during setup')
  s.session.send = async () => { controller.abort(reason); return { gpu: hardware } }
  const launch = t.mock.method(chromium, 'launch', async () => s.browser)
  await assert.rejects(launchBrowser({ ...config, gpu: 'auto' }, { handleSignals: true, signal: controller.signal }), error => error === reason)
  assert.ok(s.calls.closes >= 1)
  assert.equal(launch.mock.callCount(), 1)
})

test('cancellation interrupts a stalled GPU graphics check without waiting for its deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const s = stub(), started = Promise.withResolvers()
  const controller = new AbortController(), reason = new Error('stop during graphics check')
  s.session.send = () => { started.resolve(); return new Promise(() => {}) }
  const launch = t.mock.method(chromium, 'launch', async () => s.browser)
  let failure
  const pending = launchBrowser({ ...config, gpu: 'auto' }, { handleSignals: true, signal: controller.signal })
    .catch(error => { failure = error })
  await started.promise
  controller.abort(reason)
  await nextTurn()
  try {
    assert.equal(failure, reason)
    assert.ok(s.calls.closes >= 1)
    assert.equal(s.calls.detaches, 1)
    assert.equal(launch.mock.callCount(), 1)
  } finally {
    t.mock.timers.tick(5000)
    await pending
  }
})

test('graphics identity rejects software renderers even when capability flags say enabled', async () => {
  for (const renderer of ['SwiftShader', 'llvmpipe', 'softpipe', 'lavapipe', 'Microsoft Basic Render Driver', 'ANGLE (Microsoft, D3D11 WARP Device)', 'Software Rasterizer']) {
    const s = stub({ ...hardware, auxAttributes: { glRenderer: renderer } })
    assert.equal((await inspectGraphics(s.browser)).hardwareAccelerated, false)
    assert.equal(s.calls.detaches, 1)
  }
  const s = stub({ featureStatus: { gpu_compositing: 'enabled' } })
  assert.equal((await inspectGraphics(s.browser)).hardwareAccelerated, null)
})

test('unavailable graphics metadata is nonfatal and detaches the CDP session', async () => {
  const s = stub()
  s.session.send = async () => { throw new Error('Unsupported protocol') }
  assert.equal((await inspectGraphics(s.browser)).hardwareAccelerated, null)
  assert.equal(s.calls.detaches, 1)
})

test('graphics checks and session detach cannot stall recording indefinitely', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const s = stub()
  s.session.send = async () => new Promise(() => {})
  s.session.detach = async () => { s.calls.detaches++; await new Promise(() => {}) }
  const pending = inspectGraphics(s.browser)
  await Promise.resolve()
  t.mock.timers.tick(5000)
  assert.equal((await pending).hardwareAccelerated, null)
  assert.equal(s.calls.detaches, 1)
})

for (const ending of ['timeout', 'abort']) {
  test(`a graphics session acquired after ${ending} is still detached`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const s = stub(), acquisition = Promise.withResolvers()
    s.browser.newBrowserCDPSession = () => acquisition.promise
    const controller = new AbortController(), reason = new Error('stop waiting for session')
    let result, failure
    const pending = inspectGraphics(s.browser, controller.signal).then(value => { result = value }, error => { failure = error })
    if (ending === 'abort') controller.abort(reason)
    else t.mock.timers.tick(5000)
    await nextTurn()
    try {
      if (ending === 'abort') assert.equal(failure, reason)
      else assert.equal(result.hardwareAccelerated, null)
      assert.equal(s.calls.detaches, 0)
    } finally {
      acquisition.resolve(s.session)
      t.mock.timers.tick(5000)
      await pending
      await nextTurn()
    }
    assert.equal(s.calls.detaches, 1)
    assert.equal(s.calls.closes, 0)
  })
}
