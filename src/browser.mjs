import { addAbortListener } from 'node:events'
import { chromium } from 'playwright'

import { TraceframeError } from './errors.mjs'

export async function launchBrowser(config, { handleSignals, signal }) {
  const requested = config.gpu ?? 'default'
  const backend = config.gpuBackend ?? (process.platform === 'linux' ? 'gl-egl' : 'default')
  const baseArgs = config.scale === 2 ? ['--force-device-scale-factor=2'] : []
  const softwareArgs = ['--disable-gpu', '--disable-accelerated-video-decode']
  const gpuArgs = ['--enable-gpu', '--disable-accelerated-video-decode']
  if (backend !== 'default') gpuArgs.push(`--use-angle=${backend}`)
  if (process.platform === 'linux') gpuArgs.push('--ozone-platform=headless')

  async function open(args) {
    let browser
    let cancellation
    try {
      signal?.throwIfAborted()
      browser = await chromium.launch({
        executablePath: config.browser,
        args: [...baseArgs, ...args],
        handleSIGINT: handleSignals,
        handleSIGTERM: handleSignals,
        handleSIGHUP: handleSignals,
      })
      if (signal) cancellation = addAbortListener(signal, () => { void browser.close().catch(() => {}) })
      signal?.throwIfAborted()
      const page = await browser.newPage({ viewport: config.viewport, deviceScaleFactor: config.scale, storageState: config.storageState })
      const graphics = await inspectGraphics(browser, signal)
      signal?.throwIfAborted()
      return { browser, page, graphics: { requested, ...graphics } }
    } catch (error) {
      await browser?.close().catch(() => {})
      signal?.throwIfAborted()
      if (!/Executable doesn't exist/i.test(error.message)) throw error
      const message = config.browser
        ? `Configured browser executable is unavailable: ${config.browser}`
        : 'Playwright Chromium is not installed. Run `npx playwright@1.64.1 install --only-shell chromium`, or pass --browser to a Chrome executable.'
      throw new TraceframeError(message, { code: 'PLAYWRIGHT_RUNTIME_MISSING', cause: error })
    } finally {
      cancellation?.[Symbol.dispose]()
    }
  }

  if (requested !== 'auto') return open(requested === 'off' ? softwareArgs : [])

  let candidate
  let fallbackReason
  try {
    candidate = await open(gpuArgs)
    if (candidate.graphics.hardwareAccelerated === true) {
      candidate.graphics.requestedBackend = backend
      return candidate
    }
    fallbackReason = candidate.graphics.hardwareAccelerated === false ? 'software-rendering' : 'graphics-check-unavailable'
  } catch (error) {
    signal?.throwIfAborted()
    if (error.code === 'PLAYWRIGHT_RUNTIME_MISSING') throw error
    fallbackReason = 'gpu-launch-failed'
  }
  // Decide before navigation or ready(): application preparation runs only once.
  await candidate?.browser.close()
  const result = await open(softwareArgs)
  Object.assign(result.graphics, { requestedBackend: backend, fallbackReason })
  return result
}

export async function inspectGraphics(browser, signal) {
  let sessionPromise
  let timer
  let cancellation
  try {
    signal?.throwIfAborted()
    sessionPromise = browser.newBrowserCDPSession()
    const request = async () => {
      const session = await sessionPromise
      signal?.throwIfAborted()
      const { gpu } = await session.send('SystemInfo.getInfo')
      const compositing = gpu.featureStatus?.gpu_compositing ?? null
      const rasterization = gpu.featureStatus?.rasterization ?? null
      const renderer = gpu.auxAttributes?.glRenderer ?? null
      const software = /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render|\bwarp\b/i.test(renderer ?? '')
      return {
        hardwareAccelerated: compositing === null || !renderer ? null : compositing.startsWith('enabled') && !software,
        compositing,
        rasterization,
        renderer,
      }
    }
    return await Promise.race([
      request(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Graphics check timed out')), 5000) }),
      ...(signal ? [new Promise((_, reject) => { cancellation = addAbortListener(signal, () => reject(signal.reason)) })] : []),
    ])
  } catch {
    signal?.throwIfAborted()
    // Graphics metadata is best effort, including on caller-owned browsers.
    return { hardwareAccelerated: null, compositing: null, rasterization: null, renderer: null }
  } finally {
    clearTimeout(timer)
    cancellation?.[Symbol.dispose]()
    // Do not let a stalled diagnostic session block recording or cancellation.
    void sessionPromise?.then(session => session.detach()).catch(() => {})
  }
}
