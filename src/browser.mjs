import { chromium } from 'playwright'

import { TraceframeError } from './errors.mjs'
import { withDeadline } from './deadline.mjs'

const GRAPHICS_CHECK_TIMEOUT = 5_000

export async function launchBrowser(config, { handleSignals, signal }) {
  const baseArgs = [
    ...(config.scale === 2 ? ['--force-device-scale-factor=2'] : []),
    // The headless shell sizes DOM fullscreen from its window (800×600 pixels by default).
    // Match the recording so a fullscreen page keeps the requested viewport.
    `--window-size=${config.video.width},${config.video.height}`,
    // Keep video decoding in software: hardware decoding fails in headless Linux and added no captured frames on macOS.
    '--disable-accelerated-video-decode',
  ]
  async function launch(args) {
    signal.throwIfAborted()
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
  let fallbackReason = 'gpu-launch-failed'
  const candidate = await launch(['--enable-gpu', ...(process.platform === 'linux' ? ['--use-angle=gl-egl'] : [])])
    .catch(() => {})
  if (candidate) {
    const graphics = await inspectGraphics(candidate, signal)
    if (graphics.hardwareAccelerated) return { browser: candidate, graphics }
    await candidate.close()
    fallbackReason = graphics.hardwareAccelerated === false ? 'software-rendering' : 'graphics-check-unavailable'
  }
  // A cancelled launch or check also lands here; launch() then rethrows the cancellation.
  return { browser: await launch(softwareArgs), graphics: { hardwareAccelerated: false, fallbackReason } }
}

// Best effort: a failed, slow or cancelled check reports unknown graphics.
export async function inspectGraphics(browser, signal) {
  let session
  try {
    const { gpu } = await withDeadline(async (deadline) => {
      session = browser.newBrowserCDPSession()
      const cdp = await session
      deadline.throwIfAborted()
      return cdp.send('SystemInfo.getInfo')
    }, GRAPHICS_CHECK_TIMEOUT, new Error('Graphics check timed out.'), signal)
    const compositing = gpu.featureStatus?.gpu_compositing
    const renderer = gpu.auxAttributes?.glRenderer
    if (!compositing || !renderer) return { hardwareAccelerated: null }
    const software = /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render|\bwarp\b/i.test(renderer)
    return { hardwareAccelerated: compositing.startsWith('enabled') && !software, renderer }
  } catch {
    return { hardwareAccelerated: null }
  } finally {
    // Do not wait for a stalled session, and detach one that arrives after the deadline.
    void session?.then(cdp => cdp.detach()).catch(() => {})
  }
}
