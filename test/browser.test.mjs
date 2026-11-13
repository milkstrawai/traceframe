import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { chromium } from 'playwright'

import { launchBrowser } from '../src/browser.mjs'

const hardware = { featureStatus: { gpu_compositing: 'enabled' }, auxAttributes: { glRenderer: 'ANGLE (Test GPU)' } }
const software = { featureStatus: { gpu_compositing: 'disabled_software' }, auxAttributes: { glRenderer: 'ANGLE (SwiftShader Device)' } }
const config = { gpu: 'auto', scale: 2, video: { width: 640, height: 480 }, browser: 'test-chromium' }
const signal = new AbortController().signal
const linux = process.platform === 'linux'
// The window matches the recording's pixels, so DOM fullscreen keeps the viewport.
const baseArgs = ['--force-device-scale-factor=2', '--window-size=640,480', '--disable-accelerated-video-decode']
const gpuArgs = [...baseArgs, '--enable-gpu', ...(linux ? ['--use-angle=gl-egl'] : [])]
const softwareArgs = [...baseArgs, '--disable-gpu']

function stub(gpu = hardware) {
  const calls = { closes: 0, detaches: 0 }
  const session = { async send(method) { assert.equal(method, 'SystemInfo.getInfo'); return { gpu } }, async detach() { calls.detaches++ } }
  const browser = { async newBrowserCDPSession() { return session }, async close() { calls.closes++ } }
  return { browser, session, calls }
}

// Stands in for /dev/dri: each entry maps to whether this account can open it, and null means no such directory.
function mockDevices(t, devices = { renderD128: true }) {
  t.mock.method(fs, 'readdir', async path => {
    if (path !== '/dev/dri' || !devices) throw new Error('ENOENT')
    return Object.keys(devices)
  })
  t.mock.method(fs, 'access', async (path, mode) => {
    if (mode !== (fs.constants.R_OK | fs.constants.W_OK) || !devices[path.split('/dev/dri/')[1]]) throw new Error('EACCES')
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
}

test('auto keeps a GPU browser whose hardware rendering is verified', async (t) => {
  const s = stub()
  const launch = t.mock.method(chromium, 'launch', async () => s.browser)
  const result = await launchBrowser(config, { handleSignals: false, signal })
  assert.equal(result.browser, s.browser)
  assert.deepEqual(result.graphics, { hardwareAccelerated: true, renderer: 'ANGLE (Test GPU)' })
  assert.deepEqual(launch.mock.calls.map(call => call.arguments[0]), [{
    executablePath: config.browser, args: gpuArgs, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
  }])
  assert.deepEqual(s.calls, { closes: 0, detaches: 1 })
})

test('off launches software rendering once without a GPU attempt or check', async (t) => {
  const s = stub()
  s.browser.newBrowserCDPSession = async () => assert.fail('off mode needs no graphics check')
  const launch = t.mock.method(chromium, 'launch', async () => s.browser)
  const result = await launchBrowser({ ...config, gpu: 'off' }, { handleSignals: true, signal })
  assert.equal(result.browser, s.browser)
  assert.deepEqual(result.graphics, { hardwareAccelerated: false })
  assert.deepEqual(launch.mock.calls.map(call => call.arguments[0].args), [softwareArgs])
})

const renderers = ['SwiftShader', 'llvmpipe', 'softpipe', 'lavapipe', 'Microsoft Basic Render Driver', 'ANGLE (Microsoft, D3D11 WARP Device)', 'Software Rasterizer']
// Only Linux checks GPU devices after software rendering.
const deviceUnavailable = linux ? 'gpu-device-unavailable' : 'software-rendering'
const failures = [
  ...renderers.map(renderer => ({ name: `the ${renderer} renderer`, gpu: { ...hardware, auxAttributes: { glRenderer: renderer } }, reason: 'software-rendering' })),
  { name: 'disabled compositing', gpu: software, reason: 'software-rendering' },
  { name: 'software rendering with one of two render nodes accessible', gpu: software, devices: { renderD128: false, renderD129: true }, reason: 'software-rendering' },
  { name: 'software rendering without an accessible render node', gpu: software, devices: { card1: true, renderD128: false }, reason: deviceUnavailable },
  { name: 'software rendering without /dev/dri', gpu: software, devices: null, reason: deviceUnavailable },
  // Other failures keep their reason even without GPU devices.
  { name: 'missing graphics metadata', gpu: { featureStatus: { gpu_compositing: 'enabled' } }, devices: null, reason: 'graphics-check-unavailable' },
  { name: 'a failed graphics check', check: async () => { throw new Error('Unsupported protocol') }, devices: null, reason: 'graphics-check-unavailable' },
  { name: 'a failed GPU launch', launch: new Error('GPU unavailable'), devices: null, reason: 'gpu-launch-failed' },
]
for (const failure of failures) {
  test(`auto falls back to software once after ${failure.name}`, async (t) => {
    mockDevices(t, failure.devices)
    const first = stub(failure.gpu), second = stub()
    if (failure.check) first.session.send = failure.check
    const launch = t.mock.method(chromium, 'launch', async () => {
      if (launch.mock.callCount() > 0) return second.browser
      if (failure.launch) throw failure.launch
      return first.browser
    })
    const result = await launchBrowser(config, { handleSignals: true, signal })
    assert.equal(result.browser, second.browser)
    assert.deepEqual(result.graphics, { hardwareAccelerated: false, fallbackReason: failure.reason })
    assert.deepEqual(launch.mock.calls.map(call => call.arguments[0].args), [gpuArgs, softwareArgs])
    assert.equal(first.calls.closes, failure.launch ? 0 : 1)
    assert.equal(second.calls.closes, 0)
  })
}

test('a failed software retry propagates its error with no further retries', async (t) => {
  mockDevices(t)
  const s = stub(software)
  const failure = new Error('software launch failed')
  const launch = t.mock.method(chromium, 'launch', async () => {
    if (launch.mock.callCount() === 0) return s.browser
    throw failure
  })
  await assert.rejects(launchBrowser(config, { handleSignals: true, signal }), error => error === failure)
  assert.equal(launch.mock.callCount(), 2)
  assert.equal(s.calls.closes, 1)
})

test('a missing executable reports how to install or configure Chromium without a software retry', async (t) => {
  const launch = t.mock.method(chromium, 'launch', async () => { throw new Error("Executable doesn't exist") })
  await assert.rejects(launchBrowser(config, { handleSignals: true, signal }), { code: 'PLAYWRIGHT_RUNTIME_MISSING', message: /Configured browser executable/ })
  assert.equal(launch.mock.callCount(), 1)
})

test('a missing bundled Chromium gives the install command for the pinned Playwright version', async (t) => {
  const { dependencies } = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'))
  t.mock.method(chromium, 'launch', async () => { throw new Error("Executable doesn't exist") })
  await assert.rejects(launchBrowser({ ...config, browser: undefined }, { handleSignals: true, signal }), {
    code: 'PLAYWRIGHT_RUNTIME_MISSING',
    message: `Playwright Chromium is not installed. Run \`npx playwright@${dependencies.playwright} install --only-shell chromium\`, or pass --browser to a Chrome executable.`,
  })
})

test('a stalled graphics check falls back after its deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const first = stub(), second = stub(), started = Promise.withResolvers()
  first.session.send = () => { started.resolve(); return new Promise(() => {}) }
  const launch = t.mock.method(chromium, 'launch', async () => launch.mock.callCount() === 0 ? first.browser : second.browser)
  const pending = launchBrowser(config, { handleSignals: true, signal })
  await started.promise
  t.mock.timers.tick(5000)
  const result = await pending
  assert.equal(result.browser, second.browser)
  assert.equal(result.graphics.fallbackReason, 'graphics-check-unavailable')
  assert.equal(first.calls.closes, 1)
})

test('cancellation during the graphics check closes the GPU browser and starts no fallback', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const s = stub(), started = Promise.withResolvers()
  const controller = new AbortController(), reason = new Error('stop during graphics check')
  s.session.send = () => { started.resolve(); return new Promise(() => {}) }
  const launch = t.mock.method(chromium, 'launch', async () => s.browser)
  const pending = launchBrowser(config, { handleSignals: true, signal: controller.signal })
  await started.promise
  controller.abort(reason)
  // Rejects at once, not at the 5-second graphics deadline.
  await assert.rejects(pending, error => error === reason)
  assert.equal(launch.mock.callCount(), 1)
  assert.equal(s.calls.closes, 1)
})

test('cancellation during the device check closes the GPU browser and starts no fallback', { skip: !linux }, async (t) => {
  const s = stub(software)
  const controller = new AbortController(), reason = new Error('stop during device check')
  // Cancels the run in the middle of the device check.
  mockDevices(t, { get renderD128() { controller.abort(reason); return true } })
  const launch = t.mock.method(chromium, 'launch', async () => s.browser)
  await assert.rejects(launchBrowser(config, { handleSignals: true, signal: controller.signal }), error => error === reason)
  assert.equal(launch.mock.callCount(), 1)
  assert.equal(s.calls.closes, 1)
})

test('a GPU launch that fails after cancellation starts no fallback', async (t) => {
  const controller = new AbortController(), reason = new Error('stop during launch')
  const launch = t.mock.method(chromium, 'launch', async () => { controller.abort(reason); throw new Error('browser closed during launch') })
  await assert.rejects(launchBrowser(config, { handleSignals: true, signal: controller.signal }), error => error === reason)
  assert.equal(launch.mock.callCount(), 1)
})
