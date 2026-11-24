import { access, constants, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'

import { TraceframeError } from './errors.mjs'
import { withDeadline } from './deadline.mjs'

const { version: PLAYWRIGHT_VERSION } = createRequire(import.meta.url)('playwright/package.json')
const GRAPHICS_CHECK_TIMEOUT = 5_000
const GRAPHICS_DETACH_TIMEOUT = 1_000
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render|\bwarp\b/i

// Chromium launch arguments for hardware rendering, or for a caller that explicitly chooses software.
export function chromiumGpuArgs(mode = 'auto') {
  if (mode === 'off') return ['--disable-gpu', '--disable-accelerated-video-decode']
  if (mode !== 'auto') throw new TraceframeError('GPU must be auto or off.', { code: 'INVALID_CONFIG' })
  return [
    '--enable-gpu',
    ...(process.platform === 'linux' ? ['--use-angle=gl-egl'] : []),
    // Headless Linux cannot use GPU-decoded frames. Windows hardware decoding is unverified.
    ...(process.platform === 'darwin' ? [] : ['--disable-accelerated-video-decode']),
  ]
}

export async function launchBrowser(config, { handleSignals, signal }) {
  const baseArgs = [
    ...(config.scale === 2 ? ['--force-device-scale-factor=2'] : []),
    // The headless shell sizes DOM fullscreen from its window (800×600 pixels by default).
    // Match the recording's pixel size so a fullscreen page keeps the requested viewport.
    `--window-size=${config.video.width},${config.video.height}`,
  ]
  async function launch(mode) {
    try {
      return await chromium.launch({
        executablePath: config.browser,
        args: [...baseArgs, ...chromiumGpuArgs(mode)],
        handleSIGINT: handleSignals,
        handleSIGTERM: handleSignals,
        handleSIGHUP: handleSignals,
      })
    } catch (error) {
      throw missingBrowserError(error, config.browser) ?? error
    }
  }

  if (config.gpu === 'off') return { browser: await launch('off'), graphics: { hardwareAccelerated: false } }

  // Decide before navigation or ready(): application preparation runs only once.
  const candidate = await launch('auto')
    .catch(error => { if (error.code === 'PLAYWRIGHT_RUNTIME_MISSING') throw error })
  const graphics = candidate ? await inspectGraphics(candidate, signal) : { hardwareAccelerated: false, fallbackReason: 'gpu-launch-failed' }
  if (graphics.hardwareAccelerated) return { browser: candidate, graphics }
  if (graphics.fallbackReason === 'software-rendering') graphics.fallbackReason = await softwareReason()
  await candidate?.close()
  // The launch or check may have stopped because the caller cancelled.
  signal.throwIfAborted()
  return { browser: await launch('off'), graphics }
}

// Playwright's error for a missing browser executable, as one that says what to install; undefined for other errors.
export function missingBrowserError(error, executablePath) {
  if (!/Executable doesn't exist/i.test(error.message)) return undefined
  const message = executablePath
    ? `Configured browser executable is unavailable: ${executablePath}`
    : `Playwright Chromium is not installed. Run \`npx playwright@${PLAYWRIGHT_VERSION} install --only-shell chromium\`, or pass --browser to a Chrome executable.`
  return new TraceframeError(message, { code: 'PLAYWRIGHT_RUNTIME_MISSING', cause: error })
}

// Use only browser-reported information here. A caller-owned browser can run on another machine.
export async function inspectGraphics(browser, signal) {
  const unavailable = { hardwareAccelerated: false, fallbackReason: 'graphics-check-unavailable' }
  if (!browser) return unavailable
  let session
  try {
    const { gpu } = await withDeadline(async (deadline) => {
      const opened = await browser.newBrowserCDPSession()
      if (deadline.aborted) {
        // A session that opens after cancellation still belongs to this check.
        await opened.detach().catch(() => {})
        deadline.throwIfAborted()
      }
      session = opened
      return session.send('SystemInfo.getInfo')
    }, GRAPHICS_CHECK_TIMEOUT, new Error('Graphics check timed out.'), signal)
    const compositing = gpu.featureStatus?.gpu_compositing
    const renderer = gpu.auxAttributes?.glRenderer
    if (!compositing || !renderer) return unavailable
    if (!compositing.startsWith('enabled') || SOFTWARE_RENDERER.test(renderer)) return { hardwareAccelerated: false, fallbackReason: 'software-rendering' }
    return { hardwareAccelerated: true, renderer }
  } catch {
    return unavailable
  } finally {
    // Closing a managed Chromium while detach is pending can stall shutdown on Windows.
    // A disconnected browser can also leave detach pending indefinitely.
    if (session) await withDeadline(() => session.detach(), GRAPHICS_DETACH_TIMEOUT, new Error('Graphics detach timed out.')).catch(() => {})
  }
}

// Linux GPU rendering usually needs a /dev/dri/renderD* device that the account can open.
async function softwareReason() {
  if (process.platform !== 'linux') return 'software-rendering'
  const names = await readdir('/dev/dri').catch(() => [])
  for (const name of names.filter(name => name.startsWith('renderD'))) {
    if (await access(`/dev/dri/${name}`, constants.R_OK | constants.W_OK).then(() => true, () => false)) return 'software-rendering'
  }
  return 'gpu-device-unavailable'
}
