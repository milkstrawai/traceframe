import { chromium } from 'playwright'

import { TraceframeError } from './errors.mjs'
import { withDeadline } from './deadline.mjs'

const GRAPHICS_CHECK_TIMEOUT = 5_000
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render|\bwarp\b/i

export async function launchBrowser(config, { handleSignals, signal }) {
  const baseArgs = [
    ...(config.scale === 2 ? ['--force-device-scale-factor=2'] : []),
    // The headless shell sizes DOM fullscreen from its window (800×600 pixels by default).
    // Match the recording's pixel size so a fullscreen page keeps the requested viewport.
    `--window-size=${config.video.width},${config.video.height}`,
    // Keep video decoding in software: hardware decoding fails in headless Linux and added no captured frames on macOS.
    '--disable-accelerated-video-decode',
  ]
  async function launch(args) {
    try {
      return await chromium.launch({
        executablePath: config.browser,
        args: [...baseArgs, ...args],
        handleSIGINT: handleSignals,
        handleSIGTERM: handleSignals,
        handleSIGHUP: handleSignals,
      })
    } catch (error) {
      if (!/Executable doesn't exist/i.test(error.message)) throw error
      const message = config.browser
        ? `Configured browser executable is unavailable: ${config.browser}`
        : 'Playwright Chromium is not installed. Run `npx playwright@1.64.1 install --only-shell chromium`, or pass --browser to a Chrome executable.'
      throw new TraceframeError(message, { code: 'PLAYWRIGHT_RUNTIME_MISSING', cause: error })
    }
  }

  const softwareArgs = ['--disable-gpu']
  if (config.gpu === 'off') return { browser: await launch(softwareArgs), graphics: { hardwareAccelerated: false } }

  // Decide before navigation or ready(): application preparation runs only once.
  const candidate = await launch(['--enable-gpu', ...(process.platform === 'linux' ? ['--use-angle=gl-egl'] : [])])
    .catch(error => { if (error.code === 'PLAYWRIGHT_RUNTIME_MISSING') throw error })
  const { renderer, fallbackReason } = candidate ? await inspectGraphics(candidate, signal) : { fallbackReason: 'gpu-launch-failed' }
  if (!fallbackReason) return { browser: candidate, graphics: { hardwareAccelerated: true, renderer } }
  await candidate?.close()
  // The launch or check may have stopped because the caller cancelled.
  signal.throwIfAborted()
  return { browser: await launch(softwareArgs), graphics: { hardwareAccelerated: false, fallbackReason } }
}

// Returns the GPU renderer when hardware rendering is verified, otherwise why it was not.
async function inspectGraphics(browser, signal) {
  try {
    const { gpu } = await withDeadline(async () => {
      const session = await browser.newBrowserCDPSession()
      try {
        return await session.send('SystemInfo.getInfo')
      } finally {
        // A rejected browser is closed next, so do not wait for the session.
        session.detach().catch(() => {})
      }
    }, GRAPHICS_CHECK_TIMEOUT, new Error('Graphics check timed out.'), signal)
    const compositing = gpu.featureStatus?.gpu_compositing
    const renderer = gpu.auxAttributes?.glRenderer
    if (!compositing || !renderer) return { fallbackReason: 'graphics-check-unavailable' }
    if (!compositing.startsWith('enabled') || SOFTWARE_RENDERER.test(renderer)) return { fallbackReason: 'software-rendering' }
    return { renderer }
  } catch {
    return { fallbackReason: 'graphics-check-unavailable' }
  }
}
